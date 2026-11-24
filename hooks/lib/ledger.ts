import type { EngineInterface } from 'claude-code'
import { costFor, estimateUsd, priceFor, type PriceTokens } from './prices'

export interface LedgerBucket {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  est?: number
}

export interface StartupSummary {
  sessions: number
  input: number
}

export interface PlanWindow {
  from: number
  to: number
  resetsAt?: string
}

export interface LedgerEntry {
  version: 1
  day: string
  sessionId: string
  project: string
  updatedAtMs: number
  costUsd: number | null
  rows: Record<string, LedgerBucket>
  merged?: string[]
  tag?: string
  startup?: StartupSummary
  plan?: Record<string, PlanWindow>
  mix?: Record<string, number>
}

export interface ContextSnapshot {
  version: 1
  project: string
  atMs: number
  model: string
  categories: Array<[string, number]>
  mcpServers: Array<[string, number]>
  memoryFiles: Array<[string, number]>
  skills: { count: number; tokens: number } | null
  agents: { count: number; tokens: number }
  uses?: number
}

export interface RequestResult {
  totalInput: number
}

export interface Figures {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUsd: number | null
  approxUsd: number
}

export const LEDGER_PREFIX = 'codeflow:ledger:v1:'
export const CONTEXT_PREFIX = 'codeflow:context:v1:'
export const LEDGER_RETENTION_DAYS = 30
export const COMPACT_PER_RUN = 25
export const SNAPSHOT_EVERY_MS = 300_000
export const MAX_SNAPSHOTS = 20
export const MAIN_AGENT = 'main'
export const UNKNOWN_SUBAGENT = 'subagent'
export const UNTAGGED = 'untagged'
export type SpendDimension = 'project' | 'day' | 'model' | 'agent' | 'tag'
export const SPEND_DIMENSIONS: readonly SpendDimension[] = ['project', 'day', 'model', 'agent', 'tag']
const DEFAULT_SPEND_DAYS = 7
const COMPACTED_ID = '~'
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function dayOf(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

export function dayBefore(nowMs: number, days: number): string {
  const date = new Date(nowMs)
  date.setDate(date.getDate() - days)
  return dayOf(date.getTime())
}

export function ledgerKey(day: string, sessionId: string): string {
  return LEDGER_PREFIX + day + ':' + sessionId
}

export function contextKey(project: string): string {
  return CONTEXT_PREFIX + project
}

export function legacyCompactedKey(day: string, project: string): string {
  return LEDGER_PREFIX + day + ':' + COMPACTED_ID + project
}

export function compactedKey(day: string, project: string, tag: string = UNTAGGED): string {
  return LEDGER_PREFIX + day + ':' + COMPACTED_ID + tag + '~' + project
}

export function rowKey(agent: string, model: string): string {
  return agent + '|' + model
}

export function splitRowKey(key: string): { agent: string; model: string } {
  const at = key.indexOf('|')
  return at === -1 ? { agent: key, model: 'unknown' } : { agent: key.slice(0, at), model: key.slice(at + 1) }
}

function sessionIdsOf(entry: LedgerEntry): string[] {
  return entry.merged ?? [entry.sessionId]
}

function distinctSessions(entries: LedgerEntry[]): number {
  return new Set(entries.flatMap(sessionIdsOf)).size
}

function emptyBucket(): LedgerBucket {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
}

export function newLedgerEntry(day: string, sessionId: string, project: string, nowMs: number): LedgerEntry {
  return { version: 1, day, sessionId, project, updatedAtMs: nowMs, costUsd: null, rows: {} }
}

function pick(raw: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function objectAt(raw: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = raw[key]
    if (value !== null && typeof value === 'object') return value as Record<string, unknown>
  }
  return null
}

export function fallbackTokens(bucket: LedgerBucket, mainLoop: boolean): PriceTokens {
  return {
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite5m: mainLoop ? 0 : bucket.cacheCreation,
    cacheWrite1h: mainLoop ? bucket.cacheCreation : 0,
  }
}

export function bucketEst(key: string, bucket: LedgerBucket): number {
  if (bucket.est !== undefined) return bucket.est
  const { agent, model } = splitRowKey(key)
  return costFor(priceFor(model, 0), fallbackTokens(bucket, agent === MAIN_AGENT))
}

export function recordRequest(
  entry: LedgerEntry,
  agent: string,
  model: string,
  usage: unknown,
  mainLoop: boolean,
): RequestResult | null {
  if (usage === null || typeof usage !== 'object') return null
  const raw = usage as Record<string, unknown>
  const input = pick(raw, ['input_tokens', 'inputTokens'])
  const output = pick(raw, ['output_tokens', 'outputTokens'])
  const cacheRead = pick(raw, ['cache_read_input_tokens', 'cacheReadInputTokens'])
  const creation = pick(raw, ['cache_creation_input_tokens', 'cacheCreationInputTokens'])
  if (input === null && output === null && cacheRead === null && creation === null) return null
  const split = objectAt(raw, ['cache_creation', 'cacheCreation'])
  const split5m = split === null ? null : pick(split, ['ephemeral_5m_input_tokens', 'ephemeral5mInputTokens'])
  const split1h = split === null ? null : pick(split, ['ephemeral_1h_input_tokens', 'ephemeral1hInputTokens'])
  const hasSplit = split5m !== null || split1h !== null
  const write5m = hasSplit ? split5m ?? 0 : mainLoop ? 0 : creation ?? 0
  const write1h = hasSplit ? split1h ?? 0 : mainLoop ? creation ?? 0 : 0
  const cacheCreation = creation ?? write5m + write1h
  const name = typeof raw.model === 'string' && raw.model !== ''
    ? raw.model
    : typeof model === 'string' && model !== '' ? model : 'unknown'
  const tokens: PriceTokens = {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  }
  const key = rowKey(agent, name)
  const existing = entry.rows[key]
  const previous = existing === undefined ? 0 : bucketEst(key, existing)
  const bucket = existing ?? emptyBucket()
  bucket.requests += 1
  bucket.input += tokens.input
  bucket.output += tokens.output
  bucket.cacheRead += tokens.cacheRead
  bucket.cacheCreation += cacheCreation
  bucket.est = previous + estimateUsd(name, tokens)
  entry.rows[key] = bucket
  return { totalInput: tokens.input + tokens.cacheRead + cacheCreation }
}

export function addRequest(
  entry: LedgerEntry,
  agent: string,
  model: string,
  usage: unknown,
  mainLoop: boolean = agent === MAIN_AGENT,
): boolean {
  return recordRequest(entry, agent, model, usage, mainLoop) !== null
}

function addCost(total: number | null, cost: number | null): number | null {
  if (total === null) return cost
  if (cost === null) return total
  return total + cost
}

function addStartup(total: StartupSummary | null, next: StartupSummary | undefined): StartupSummary | null {
  if (next === undefined) return total
  if (total === null) return { sessions: next.sessions, input: next.input }
  return { sessions: total.sessions + next.sessions, input: total.input + next.input }
}

function mergePlan(base: Record<string, PlanWindow> | undefined, extra: Record<string, PlanWindow> | undefined): Record<string, PlanWindow> | undefined {
  if (base === undefined && extra === undefined) return undefined
  const result: Record<string, PlanWindow> = {}
  const kinds = new Set([...Object.keys(base ?? {}), ...Object.keys(extra ?? {})])
  for (const kind of kinds) {
    const left = base?.[kind]
    const right = extra?.[kind]
    if (left !== undefined && right !== undefined) {
      if ((left.resetsAt ?? '') === (right.resetsAt ?? '')) {
        result[kind] = {
          from: Math.min(left.from, right.from),
          to: Math.max(left.to, right.to),
          ...(left.resetsAt === undefined ? {} : { resetsAt: left.resetsAt }),
        }
      } else {
        result[kind] = (left.resetsAt ?? '') > (right.resetsAt ?? '') ? left : right
      }
    } else {
      result[kind] = (left ?? right) as PlanWindow
    }
  }
  return result
}

function mergeMix(base: Record<string, number> | undefined, extra: Record<string, number> | undefined): Record<string, number> | undefined {
  if (base === undefined && extra === undefined) return undefined
  const result: Record<string, number> = { ...(base ?? {}) }
  for (const [name, value] of Object.entries(extra ?? {})) result[name] = (result[name] ?? 0) + value
  return result
}

export function mergeEntries(base: LedgerEntry, extra: LedgerEntry): LedgerEntry {
  const rows: Record<string, LedgerBucket> = {}
  const keys = new Set([...Object.keys(base.rows), ...Object.keys(extra.rows)])
  for (const key of keys) {
    const parts = [base.rows[key], extra.rows[key]].filter((bucket): bucket is LedgerBucket => bucket !== undefined)
    rows[key] = parts.reduce<LedgerBucket>((sum, bucket) => ({
      requests: sum.requests + bucket.requests,
      input: sum.input + bucket.input,
      output: sum.output + bucket.output,
      cacheRead: sum.cacheRead + bucket.cacheRead,
      cacheCreation: sum.cacheCreation + bucket.cacheCreation,
      est: (sum.est ?? 0) + bucketEst(key, bucket),
    }), { ...emptyBucket(), est: 0 })
  }
  const result: LedgerEntry = {
    ...base,
    rows,
    updatedAtMs: Math.max(base.updatedAtMs, extra.updatedAtMs),
    costUsd: addCost(base.costUsd, extra.costUsd),
    startup: addStartup(base.startup ?? null, extra.startup) ?? undefined,
  }
  const plan = mergePlan(base.plan, extra.plan)
  if (plan !== undefined) result.plan = plan
  const mix = mergeMix(base.mix, extra.mix)
  if (mix !== undefined) result.mix = mix
  return result
}

function isBucket(value: unknown): value is LedgerBucket {
  if (value === null || typeof value !== 'object') return false
  const bucket = value as Record<string, unknown>
  if (!['requests', 'input', 'output', 'cacheRead', 'cacheCreation'].every(field => typeof bucket[field] === 'number')) return false
  return bucket.est === undefined || (typeof bucket.est === 'number' && Number.isFinite(bucket.est))
}

function isStartup(value: unknown): value is StartupSummary {
  if (value === null || typeof value !== 'object') return false
  const startup = value as Record<string, unknown>
  return typeof startup.sessions === 'number' && typeof startup.input === 'number'
}

function isPlan(value: unknown): value is Record<string, PlanWindow> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(item => {
    if (item === null || typeof item !== 'object') return false
    const window = item as Record<string, unknown>
    return typeof window.from === 'number' && typeof window.to === 'number' &&
      (window.resetsAt === undefined || typeof window.resetsAt === 'string')
  })
}

function isMix(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(item => typeof item === 'number' && Number.isFinite(item))
}

export function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (entry.version !== 1 || typeof entry.day !== 'string' || !DAY_PATTERN.test(entry.day)) return false
  if (typeof entry.sessionId !== 'string' || typeof entry.project !== 'string') return false
  if (typeof entry.updatedAtMs !== 'number') return false
  if (entry.costUsd !== null && typeof entry.costUsd !== 'number') return false
  if (entry.merged !== undefined && !(Array.isArray(entry.merged) && entry.merged.every(id => typeof id === 'string'))) return false
  if (entry.tag !== undefined && typeof entry.tag !== 'string') return false
  if (entry.startup !== undefined && !isStartup(entry.startup)) return false
  if (entry.plan !== undefined && !isPlan(entry.plan)) return false
  if (entry.mix !== undefined && !isMix(entry.mix)) return false
  if (entry.rows === null || typeof entry.rows !== 'object' || Array.isArray(entry.rows)) return false
  return Object.values(entry.rows as Record<string, unknown>).every(isBucket)
}

export function isContextSnapshot(value: unknown): value is ContextSnapshot {
  if (value === null || typeof value !== 'object') return false
  const snapshot = value as Record<string, unknown>
  return snapshot.version === 1 && typeof snapshot.project === 'string' && typeof snapshot.atMs === 'number' &&
    typeof snapshot.model === 'string' && Array.isArray(snapshot.categories) && Array.isArray(snapshot.mcpServers) &&
    Array.isArray(snapshot.memoryFiles) && snapshot.agents !== null && typeof snapshot.agents === 'object'
}

interface LedgerKeyParts {
  day: string
  id: string
}

function parseLedgerKey(key: string): LedgerKeyParts | null {
  if (!key.startsWith(LEDGER_PREFIX)) return null
  const rest = key.slice(LEDGER_PREFIX.length)
  const day = rest.slice(0, 10)
  if (!DAY_PATTERN.test(day) || rest.charAt(10) !== ':') return null
  return { day, id: rest.slice(11) }
}

export interface SpendRow extends Figures {
  label: string
  sessions: number | null
  startup: StartupSummary | null
}

interface Accumulator extends Figures {
  sessions: Set<string>
  startup: StartupSummary | null
}

function emptyAccumulator(): Accumulator {
  return {
    sessions: new Set<string>(),
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    costUsd: null,
    approxUsd: 0,
    startup: null,
  }
}

function addBucket(acc: Accumulator, bucket: LedgerBucket): void {
  acc.requests += bucket.requests
  acc.input += bucket.input
  acc.output += bucket.output
  acc.cacheRead += bucket.cacheRead
  acc.cacheCreation += bucket.cacheCreation
}

function totalTokens(row: Pick<Figures, 'input' | 'output' | 'cacheRead' | 'cacheCreation'>): number {
  return row.input + row.output + row.cacheRead + row.cacheCreation
}

export function bucketCosts(entry: LedgerEntry): Array<{ key: string; cost: number }> {
  const weighted = Object.entries(entry.rows).map(([key, bucket]) => ({ key, weight: bucketEst(key, bucket) }))
  const total = weighted.reduce((sum, item) => sum + item.weight, 0)
  return weighted.map(item => ({
    key: item.key,
    cost: entry.costUsd !== null && entry.costUsd > 0 && total > 0 ? entry.costUsd * item.weight / total : item.weight,
  }))
}

function labelOf(entry: LedgerEntry, by: SpendDimension): string {
  if (by === 'project') return entry.project
  if (by === 'day') return entry.day
  return entry.tag ?? UNTAGGED
}

export function aggregate(entries: LedgerEntry[], by: SpendDimension): SpendRow[] {
  const groups = new Map<string, Accumulator>()
  const group = (label: string): Accumulator => {
    const existing = groups.get(label)
    if (existing) return existing
    const created = emptyAccumulator()
    groups.set(label, created)
    return created
  }
  for (const entry of entries) {
    if (by === 'project' || by === 'day' || by === 'tag') {
      const acc = group(labelOf(entry, by))
      for (const id of sessionIdsOf(entry)) acc.sessions.add(id)
      acc.costUsd = addCost(acc.costUsd, entry.costUsd)
      for (const bucket of Object.values(entry.rows)) addBucket(acc, bucket)
      for (const item of bucketCosts(entry)) acc.approxUsd += item.cost
      acc.startup = addStartup(acc.startup, entry.startup)
      continue
    }
    for (const [key, bucket] of Object.entries(entry.rows)) {
      const parts = splitRowKey(key)
      const acc = group(by === 'model' ? parts.model : parts.agent)
      for (const id of sessionIdsOf(entry)) acc.sessions.add(id)
      addBucket(acc, bucket)
    }
    for (const item of bucketCosts(entry)) {
      const parts = splitRowKey(item.key)
      group(by === 'model' ? parts.model : parts.agent).approxUsd += item.cost
    }
  }
  const countsSessions = by === 'project' || by === 'day' || by === 'tag'
  return [...groups.entries()]
    .map(([label, acc]) => ({
      label,
      sessions: countsSessions ? acc.sessions.size : null,
      requests: acc.requests,
      input: acc.input,
      output: acc.output,
      cacheRead: acc.cacheRead,
      cacheCreation: acc.cacheCreation,
      costUsd: acc.costUsd,
      approxUsd: acc.approxUsd,
      startup: countsSessions ? acc.startup : null,
    }))
    .sort((a, b) => totalTokens(b) - totalTokens(a) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

const UNAVAILABLE_NUMBER = 'Unavailable'

export function count(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : UNAVAILABLE_NUMBER
}

export function percent(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

export function oneDecimal(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

export function usd(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function spendLine(label: string, sessions: number | null, row: Figures, grand: number): string {
  const parts = [label]
  if (sessions !== null) parts.push(sessions.toLocaleString('en-US') + ' session(s)')
  parts.push(
    count(row.requests) + ' request(s)',
    'total input ' + count(row.input + row.cacheRead + row.cacheCreation),
    'new input ' + count(row.input),
    'cache read ' + count(row.cacheRead),
    'cache created ' + count(row.cacheCreation),
    'output ' + count(row.output),
    percent(grand === 0 ? 0 : (totalTokens(row) / grand) * 100) + '% of tokens',
  )
  if (row.costUsd !== null && row.costUsd > 0) parts.push('USD ' + usd(row.costUsd))
  else if (row.approxUsd > 0) parts.push('≈ USD ' + usd(row.approxUsd))
  return parts.join(' · ')
}

interface Totals extends Figures {
  startup: StartupSummary | null
  sessions: number
}

function totalsOf(rows: SpendRow[], entries: LedgerEntry[]): Totals {
  const sums = rows.reduce<Figures>((acc, row) => ({
    requests: acc.requests + row.requests,
    input: acc.input + row.input,
    output: acc.output + row.output,
    cacheRead: acc.cacheRead + row.cacheRead,
    cacheCreation: acc.cacheCreation + row.cacheCreation,
    costUsd: null,
    approxUsd: acc.approxUsd + row.approxUsd,
  }), { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: null, approxUsd: 0 })
  return {
    ...sums,
    costUsd: entries.reduce<number | null>((sum, entry) => addCost(sum, entry.costUsd), null),
    startup: entries.reduce<StartupSummary | null>((sum, entry) => addStartup(sum, entry.startup), null),
    sessions: distinctSessions(entries),
  }
}

export function buildSpendReport(entries: LedgerEntry[], by: SpendDimension, days: number): string {
  const rows = aggregate(entries, by)
  if (rows.length === 0) return 'Codeflow spend · no recorded requests in the last ' + days + ' day(s)'
  const grand = rows.reduce((sum, row) => sum + totalTokens(row), 0)
  const totals = totalsOf(rows, entries)
  const lines = [
    'Codeflow spend · last ' + days + ' day(s) · by ' + by,
    ...rows.map(row => spendLine(row.label, row.sessions, row, grand)),
    spendLine('Total', totals.sessions, totals, grand),
  ]
  return lines.join('\n')
}

function perRequest(value: number, requests: number): number {
  return requests === 0 ? 0 : Math.round(value / requests)
}

function compareLine(label: string, sessions: number | null, row: Figures, startup: StartupSummary | null): string {
  const prompt = row.input + row.cacheRead + row.cacheCreation
  const parts = [label]
  if (sessions !== null) parts.push(sessions.toLocaleString('en-US') + ' session(s)')
  parts.push(
    count(row.requests) + ' request(s)',
    'input/request ' + count(perRequest(prompt, row.requests)),
    'cache hit ' + oneDecimal(prompt === 0 ? 0 : (row.cacheRead / prompt) * 100) + '%',
    'output/request ' + count(perRequest(row.output, row.requests)),
  )
  if (startup !== null && startup.sessions > 0) {
    parts.push('startup context ' + count(Math.round(startup.input / startup.sessions)))
  }
  if (row.costUsd !== null && row.costUsd > 0) {
    parts.push('USD/request ' + usd(row.costUsd / row.requests))
  } else if (row.approxUsd > 0 && row.requests > 0) {
    parts.push('≈ USD/request ' + usd(row.approxUsd / row.requests))
  }
  return parts.join(' · ')
}

export function buildCompareReport(entries: LedgerEntry[], by: SpendDimension, days: number): string {
  const rows = aggregate(entries, by)
  if (rows.length === 0) return 'Codeflow compare · no recorded requests in the last ' + days + ' day(s)'
  const totals = totalsOf(rows, entries)
  return [
    'Codeflow compare · last ' + days + ' day(s) · by ' + by,
    ...rows.map(row => compareLine(row.label, row.sessions, row, row.startup)),
    compareLine('Total', totals.sessions, totals, totals.startup),
  ].join('\n')
}

export function parseSpendArgs(
  words: string[],
  fallback: SpendDimension = 'project',
): { by: SpendDimension; days: number } | null {
  if (words.length > 2) return null
  let by: SpendDimension | null = null
  let days: number | null = null
  for (const word of words) {
    const lower = word.toLowerCase()
    if ((SPEND_DIMENSIONS as readonly string[]).includes(lower)) {
      if (by !== null) return null
      by = lower as SpendDimension
    } else if (/^\d+$/.test(word)) {
      if (days !== null) return null
      const value = Number(word)
      if (value < 1) return null
      days = Math.min(LEDGER_RETENTION_DAYS, value)
    } else {
      return null
    }
  }
  return { by: by ?? fallback, days: days ?? DEFAULT_SPEND_DAYS }
}

export async function readLedger($: EngineInterface, nowMs: number, days: number): Promise<LedgerEntry[]> {
  const oldest = dayBefore(nowMs, days - 1)
  const keys = await $.store.keys().catch(() => [] as string[])
  const entries: LedgerEntry[] = []
  for (const key of keys) {
    if (!key.startsWith(LEDGER_PREFIX)) continue
    const value = await $.store.get(key).catch(() => null)
    if (!isLedgerEntry(value) || value.day < oldest) continue
    entries.push(value)
  }
  const foldKey = (entry: LedgerEntry) => JSON.stringify([entry.day, entry.project, entry.tag ?? UNTAGGED])
  const folded = new Map<string, Set<string>>()
  for (const entry of entries) {
    if (entry.merged === undefined) continue
    const ids = folded.get(foldKey(entry)) ?? new Set<string>()
    for (const id of entry.merged) ids.add(id)
    folded.set(foldKey(entry), ids)
  }
  return entries.filter(entry => entry.merged !== undefined || !folded.get(foldKey(entry))?.has(entry.sessionId))
}

export async function readSnapshots($: EngineInterface): Promise<ContextSnapshot[]> {
  const keys = await $.store.keys().catch(() => [] as string[])
  const snapshots: ContextSnapshot[] = []
  for (const key of keys) {
    if (!key.startsWith(CONTEXT_PREFIX)) continue
    const value = await $.store.get(key).catch(() => null)
    if (isContextSnapshot(value)) snapshots.push(value)
  }
  return snapshots
}

export async function saveLedgerEntry($: EngineInterface, entry: LedgerEntry): Promise<void> {
  await $.store.set(ledgerKey(entry.day, entry.sessionId), entry)
}

export async function pruneLedger($: EngineInterface, nowMs: number, hasTime: () => boolean): Promise<void> {
  const oldest = dayBefore(nowMs, LEDGER_RETENTION_DAYS - 1)
  if (!hasTime()) return
  const keys = await $.store.keys().catch(() => [] as string[])
  for (const key of keys) {
    const parts = parseLedgerKey(key)
    if (parts === null || parts.day >= oldest) continue
    if (!hasTime()) return
    await $.store.delete(key).catch(() => undefined)
  }
  const snapshots: Array<{ key: string; atMs: number; uses: number }> = []
  for (const key of keys) {
    if (!key.startsWith(CONTEXT_PREFIX)) continue
    if (!hasTime()) return
    const value = await $.store.get(key).catch(() => null)
    if (!isContextSnapshot(value)) continue
    if (dayOf(value.atMs) < oldest) {
      if (!hasTime()) return
      await $.store.delete(key).catch(() => undefined)
      continue
    }
    snapshots.push({ key, atMs: value.atMs, uses: value.uses ?? 1 })
  }
  snapshots.sort((a, b) => b.uses - a.uses || b.atMs - a.atMs)
  for (const stale of snapshots.slice(MAX_SNAPSHOTS)) {
    if (!hasTime()) return
    await $.store.delete(stale.key).catch(() => undefined)
  }
}

function newCompacted(day: string, project: string, tag: string | undefined, nowMs: number): LedgerEntry {
  const entry: LedgerEntry = { ...newLedgerEntry(day, COMPACTED_ID, project, nowMs), merged: [] }
  if (tag !== undefined) entry.tag = tag
  return entry
}

export async function compactLedger($: EngineInterface, nowMs: number, hasTime: () => boolean): Promise<void> {
  const yesterday = dayBefore(nowMs, 1)
  if (!hasTime()) return
  const keys = await $.store.keys().catch(() => [] as string[])
  const candidates: string[] = []
  for (const key of keys) {
    const parts = parseLedgerKey(key)
    if (parts === null || parts.day >= yesterday || parts.id.startsWith(COMPACTED_ID)) continue
    candidates.push(key)
    if (candidates.length === COMPACT_PER_RUN) break
  }
  const groups = new Map<string, { day: string; project: string; tag: string | undefined; keys: string[]; entries: LedgerEntry[] }>()
  for (const key of candidates) {
    if (!hasTime()) return
    const value = await $.store.get(key).catch(() => null)
    if (!isLedgerEntry(value)) continue
    const groupKey = JSON.stringify([value.day, value.project, value.tag ?? UNTAGGED])
    const group = groups.get(groupKey) ?? { day: value.day, project: value.project, tag: value.tag, keys: [], entries: [] }
    group.keys.push(key)
    group.entries.push(value)
    groups.set(groupKey, group)
  }
  for (const group of groups.values()) {
    if (!hasTime()) return
    const key = compactedKey(group.day, group.project, group.tag ?? UNTAGGED)
    const existing = await $.store.get(key).catch(() => null)
    const current = isLedgerEntry(existing) ? existing : newCompacted(group.day, group.project, group.tag, nowMs)
    const known = new Set(current.merged ?? [])
    if (group.tag === undefined) {
      const legacy = await $.store.get(legacyCompactedKey(group.day, group.project)).catch(() => null)
      if (isLedgerEntry(legacy)) for (const id of legacy.merged ?? []) known.add(id)
    }
    const fresh = group.entries.filter(entry => !known.has(entry.sessionId))
    if (fresh.length > 0) {
      let result = current
      for (const entry of fresh) result = mergeEntries(result, entry)
      result = { ...result, merged: [...(current.merged ?? []), ...fresh.map(entry => entry.sessionId)] }
      const saved = await $.store.set(key, result).then(() => true, () => false)
      if (!saved) continue
    }
    for (const sessionKey of group.keys) await $.store.delete(sessionKey).catch(() => undefined)
  }
}
