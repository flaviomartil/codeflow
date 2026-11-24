import type { EngineInterface } from 'claude-code'
import { snapshotContext, newSessionTelemetry } from './telemetry'
import {
  contextKey, dayOf, isLedgerEntry, ledgerKey, MAIN_AGENT, mergeEntries, newLedgerEntry, recordRequest,
  saveLedgerEntry, SNAPSHOT_EVERY_MS, UNKNOWN_SUBAGENT, type ContextSnapshot, type LedgerEntry, type PlanWindow,
} from './ledger'

const TAG_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/

export interface SpendSession {
  entry: LedgerEntry | null
  dirty: boolean
  lastCost: number | null
  today: string | null
  startupPending: boolean
  snapshotAtMs: number | null
  mainInputSince: number
  model: string | null
  lastCategories: Array<[string, number]> | null
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
    startupPending: false,
    snapshotAtMs: null,
    mainInputSince: 0,
    model: null,
    lastCategories: null,
    agentTypes: new Map<string, string>(),
    pending: Promise.resolve(),
  }
}

function enqueue<T>(spend: SpendSession, work: () => Promise<T>): Promise<T> {
  const result = spend.pending.then(work)
  spend.pending = result.then(() => undefined, () => undefined)
  return result
}

async function attempt<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch {
    return fallback
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

async function usageSnapshot($: EngineInterface, breakdown: boolean): Promise<Record<string, unknown> | null> {
  if (breakdown) {
    const detailed = asRecord(await attempt(() => $.session.usage({ breakdown: 'summary' }), null))
    if (detailed !== null) return detailed
  }
  return asRecord(await attempt(() => $.session.usage(), null))
}

function costOf(raw: Record<string, unknown> | null): number | null {
  return snapshotContext(raw, newSessionTelemetry())?.costUsd ?? null
}

function applyPlan(entry: LedgerEntry, raw: Record<string, unknown>): void {
  const limits = Array.isArray(raw.rateLimits) ? raw.rateLimits : []
  for (const limit of limits) {
    const item = asRecord(limit)
    if (item === null || typeof item.kind !== 'string' || typeof item.percentUsed !== 'number') continue
    if (!Number.isFinite(item.percentUsed)) continue
    const resetsAt = typeof item.resetsAt === 'string' ? item.resetsAt : undefined
    entry.plan ??= {}
    const current = entry.plan[item.kind]
    if (current === undefined || current.resetsAt !== resetsAt) {
      const window: PlanWindow = { from: item.percentUsed, to: item.percentUsed }
      if (resetsAt !== undefined) window.resetsAt = resetsAt
      entry.plan[item.kind] = window
    } else {
      current.to = item.percentUsed
    }
  }
}

function snapshotOf(raw: Record<string, unknown>, project: string, model: string, nowMs: number): ContextSnapshot | null {
  const context = asRecord(raw.context)
  const breakdown = asRecord(context?.breakdown)
  if (breakdown === null) return null
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.flatMap(item => asRecord(item) === null ? [] : [item as Record<string, unknown>]) : []
  const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
  const top = <T>(items: Array<[string, T]>, value: (item: T) => number): Array<[string, T]> =>
    items.sort((a, b) => value(b[1]) - value(a[1])).slice(0, 10)
  const categories = list(breakdown.categories)
    .filter(item => item.kind === 'used' && typeof item.name === 'string')
    .map((item): [string, number] => [item.name as string, num(item.tokens)])
  const servers = new Map<string, number>()
  for (const tool of list(breakdown.mcpTools)) {
    if (tool.isLoaded !== true || typeof tool.serverName !== 'string') continue
    servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + num(tool.tokens))
  }
  const memoryFiles = list(breakdown.memoryFiles)
    .filter(item => typeof item.path === 'string')
    .map((item): [string, number] => [item.path as string, num(item.tokens)])
  const skills = asRecord(breakdown.skills)
  const agents = list(breakdown.agents)
  return {
    version: 1,
    project,
    atMs: nowMs,
    model,
    categories,
    mcpServers: top([...servers.entries()], value => value),
    memoryFiles: top(memoryFiles, value => value),
    skills: skills === null ? null : { count: num(skills.includedSkills), tokens: num(skills.tokens) },
    agents: { count: agents.length, tokens: agents.reduce((sum, item) => sum + num(item.tokens), 0) },
  }
}

function applyMix(entry: LedgerEntry, categories: Array<[string, number]>, mainInput: number): boolean {
  const used = categories.reduce((sum, [, tokens]) => sum + tokens, 0)
  if (used <= 0) return false
  entry.mix ??= {}
  for (const [name, tokens] of categories) {
    const share = mainInput * tokens / used
    if (share > 0) entry.mix[name] = (entry.mix[name] ?? 0) + share
  }
  return true
}

async function readTag($: EngineInterface): Promise<string | undefined> {
  const value = await attempt(() => $.env.get('CLAUDE_CODEFLOW_TAG'), undefined)
  return typeof value === 'string' && TAG_PATTERN.test(value) ? value : undefined
}

async function flushNow(spend: SpendSession, $: EngineInterface, allowSnapshot: boolean): Promise<void> {
  const entry = spend.entry
  if (entry === null || !spend.dirty) return
  const now = await $.clock.now()
  const due = allowSnapshot && (spend.snapshotAtMs === null || now - spend.snapshotAtMs >= SNAPSHOT_EVERY_MS)
  const raw = await usageSnapshot($, due)
  const cost = costOf(raw)
  if (cost !== null) {
    const delta = Math.max(0, cost - (spend.lastCost ?? 0))
    entry.costUsd = (entry.costUsd ?? 0) + delta
    spend.lastCost = cost
  }
  if (raw !== null) applyPlan(entry, raw)
  if (due && raw !== null) {
    const snapshot = snapshotOf(raw, entry.project, spend.model ?? 'unknown', now)
    if (snapshot !== null) {
      if (applyMix(entry, snapshot.categories, spend.mainInputSince)) spend.mainInputSince = 0
      spend.lastCategories = snapshot.categories
      await attempt(() => $.store.set(contextKey(entry.project), snapshot), undefined)
      spend.snapshotAtMs = now
    }
  }
  entry.updatedAtMs = now
  await saveLedgerEntry($, entry).catch(() => undefined)
  spend.dirty = false
}

async function rollLedger(spend: SpendSession, $: EngineInterface, cwd: string, day: string): Promise<LedgerEntry> {
  const first = spend.entry === null
  if (!first) await flushNow(spend, $, false)
  const sessionId = await $.session.id()
  const project = await attempt(() => $.session.root(), cwd)
  const tag = await readTag($)
  const now = await $.clock.now()
  if (spend.lastCost === null) spend.lastCost = costOf(await usageSnapshot($, false)) ?? 0
  const fresh = newLedgerEntry(day, sessionId, project, now)
  if (tag !== undefined) fresh.tag = tag
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
    const cost = costOf(await usageSnapshot($, false))
    spend.lastCost = cost ?? 0
    spend.startupPending = cost === null || cost === 0
  })
}

export function recordStep(spend: SpendSession, $: EngineInterface, cwd: string, step: SpendStep, usage: unknown): Promise<void> {
  return enqueue(spend, async () => {
    if (spend.today === null) spend.today = dayOf(await $.clock.now())
    const day = spend.today
    let entry = spend.entry
    if (entry === null || entry.day !== day) entry = await rollLedger(spend, $, cwd, day)
    const mainLoop = step.agentId === undefined
    const agent = mainLoop ? MAIN_AGENT : await agentLabel(spend, $, step.agentId ?? '')
    const recorded = recordRequest(entry, agent, step.model, usage, mainLoop)
    if (recorded === null) return
    spend.dirty = true
    if (mainLoop) {
      spend.mainInputSince += recorded.totalInput
      spend.model = step.model
      if (spend.startupPending) {
        spend.startupPending = false
        if (entry.startup === undefined) entry.startup = { sessions: 1, input: recorded.totalInput }
      }
    }
  })
}

export function flushSpend(spend: SpendSession, $: EngineInterface): Promise<void> {
  return enqueue(spend, () => flushNow(spend, $, true))
}

export function endSpendSession(spend: SpendSession, $: EngineInterface): Promise<void> {
  return enqueue(spend, async () => {
    if (spend.entry !== null && spend.lastCategories !== null && spend.mainInputSince > 0) {
      if (applyMix(spend.entry, spend.lastCategories, spend.mainInputSince)) {
        spend.mainInputSince = 0
        spend.dirty = true
      }
    }
    await flushNow(spend, $, false)
    spend.entry = null
    spend.dirty = false
    spend.lastCost = null
    spend.today = null
    spend.startupPending = false
    spend.snapshotAtMs = null
    spend.mainInputSince = 0
    spend.model = null
    spend.lastCategories = null
    spend.agentTypes.clear()
  })
}
