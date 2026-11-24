import type { EngineInterface } from 'claude-code'
import { snapshotContext, newSessionTelemetry } from './telemetry'
import {
  addRequest, dayOf, isLedgerEntry, ledgerKey, MAIN_AGENT, mergeEntries, newLedgerEntry, saveLedgerEntry,
  UNKNOWN_SUBAGENT, type LedgerEntry,
} from './ledger'

export interface SpendSession {
  entry: LedgerEntry | null
  dirty: boolean
  lastCost: number | null
  today: string | null
  agentTypes: Map<string, string>
  pending: Promise<void>
}

export interface SpendStep {
  agentId?: string
  model: string
}

export function newSpendSession(): SpendSession {
  return {
    entry: null,
    dirty: false,
    lastCost: null,
    today: null,
    agentTypes: new Map<string, string>(),
    pending: Promise.resolve(),
  }
}

function enqueue<T>(spend: SpendSession, work: () => Promise<T>): Promise<T> {
  const result = spend.pending.then(work)
  spend.pending = result.then(() => undefined, () => undefined)
  return result
}

async function sessionCostUsd($: EngineInterface): Promise<number | null> {
  return snapshotContext(await $.session.usage().catch(() => null), newSessionTelemetry())?.costUsd ?? null
}

async function flushNow(spend: SpendSession, $: EngineInterface): Promise<void> {
  const entry = spend.entry
  if (entry === null || !spend.dirty) return
  const cost = await sessionCostUsd($)
  if (cost !== null) {
    const delta = Math.max(0, cost - (spend.lastCost ?? 0))
    entry.costUsd = (entry.costUsd ?? 0) + delta
    spend.lastCost = cost
  }
  entry.updatedAtMs = await $.clock.now()
  await saveLedgerEntry($, entry).catch(() => undefined)
  spend.dirty = false
}

async function rollLedger(spend: SpendSession, $: EngineInterface, cwd: string, day: string): Promise<LedgerEntry> {
  const first = spend.entry === null
  if (!first) await flushNow(spend, $)
  const sessionId = await $.session.id()
  const project = await $.session.root().catch(() => cwd)
  const now = await $.clock.now()
  if (spend.lastCost === null) spend.lastCost = (await sessionCostUsd($)) ?? 0
  const fresh = newLedgerEntry(day, sessionId, project, now)
  if (first) {
    const stored = await $.store.get(ledgerKey(day, sessionId)).catch(() => null)
    if (isLedgerEntry(stored)) {
      spend.entry = mergeEntries(stored, fresh)
      return spend.entry
    }
  }
  spend.entry = fresh
  return fresh
}

async function agentLabel(spend: SpendSession, $: EngineInterface, agentId: string): Promise<string> {
  const known = spend.agentTypes.get(agentId)
  if (known !== undefined) return known
  let type = UNKNOWN_SUBAGENT
  try {
    const agents = await $.agent.list()
    type = agents.find(agent => agent.id === agentId)?.type ?? UNKNOWN_SUBAGENT
  } catch {
    type = UNKNOWN_SUBAGENT
  }
  spend.agentTypes.set(agentId, type)
  return type
}

export async function markTurnDay(spend: SpendSession, $: EngineInterface): Promise<void> {
  spend.today = dayOf(await $.clock.now())
}

export function startSpendSession(spend: SpendSession, $: EngineInterface): Promise<void> {
  return enqueue(spend, async () => {
    spend.lastCost = (await sessionCostUsd($)) ?? 0
  })
}

export function recordStep(spend: SpendSession, $: EngineInterface, cwd: string, step: SpendStep, usage: unknown): Promise<void> {
  return enqueue(spend, async () => {
    if (spend.today === null) spend.today = dayOf(await $.clock.now())
    const day = spend.today
    let entry = spend.entry
    if (entry === null || entry.day !== day) entry = await rollLedger(spend, $, cwd, day)
    const agent = step.agentId === undefined ? MAIN_AGENT : await agentLabel(spend, $, step.agentId)
    if (addRequest(entry, agent, step.model, usage)) spend.dirty = true
  })
}

export function flushSpend(spend: SpendSession, $: EngineInterface): Promise<void> {
  return enqueue(spend, () => flushNow(spend, $))
}

export function endSpendSession(spend: SpendSession, $: EngineInterface): Promise<void> {
  return enqueue(spend, async () => {
    await flushNow(spend, $)
    spend.entry = null
    spend.dirty = false
    spend.lastCost = null
    spend.today = null
    spend.agentTypes.clear()
  })
}
