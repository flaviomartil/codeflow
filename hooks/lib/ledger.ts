import type { EngineInterface } from 'claude-code'

export interface LedgerBucket {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
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
}

export const LEDGER_PREFIX = 'codeflow:ledger:v1:'
export const LEDGER_RETENTION_DAYS = 30
export const COMPACT_PER_RUN = 25
export const MAIN_AGENT = 'main'
export const UNKNOWN_SUBAGENT = 'subagent'
export type SpendDimension = 'project' | 'day' | 'model' | 'agent'
export const SPEND_DIMENSIONS: readonly SpendDimension[] = ['project', 'day', 'model', 'agent']
const DEFAULT_SPEND_DAYS = 7
const COMPACTED_ID = '~'
const DAY_MS = 24 * 60 * 60 * 1000
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

export function compactedKey(day: string, project: string): string {
  return LEDGER_PREFIX + day + ':' + COMPACTED_ID + project
}

export function rowKey(agent: string, model: string): string {
  return agent + '|' + model
}

function sessionIdsOf(entry: LedgerEntry): string[] {
  return entry.merged ?? [entry.sessionId]
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

export function addRequest(entry: LedgerEntry, agent: string, model: string, usage: unknown): boolean {
  if (usage === null || typeof usage !== 'object') return false
  const raw = usage as Record<string, unknown>
  const input = pick(raw, ['input_tokens', 'inputTokens'])
  const output = pick(raw, ['output_tokens', 'outputTokens'])
  const cacheRead = pick(raw, ['cache_read_input_tokens', 'cacheReadInputTokens'])
  const cacheCreation = pick(raw, ['cache_creation_input_tokens', 'cacheCreationInputTokens'])
  if (input === null && output === null && cacheRead === null && cacheCreation === null) return false
  const name = typeof raw.model === 'string' && raw.model !== ''
    ? raw.model
    : typeof model === 'string' && model !== '' ? model : 'unknown'
  const key = rowKey(agent, name)
  const bucket = entry.rows[key] ?? emptyBucket()
  bucket.requests += 1
  bucket.input += input ?? 0
  bucket.output += output ?? 0
  bucket.cacheRead += cacheRead ?? 0
  bucket.cacheCreation += cacheCreation ?? 0
  entry.rows[key] = bucket
  return true
}

function addCost(total: number | null, cost: number | null): number | null {
  if (total === null) return cost
  if (cost === null) return total
  return total + cost
}

export function mergeEntries(base: LedgerEntry, extra: LedgerEntry): LedgerEntry {
  const rows: Record<string, LedgerBucket> = {}
  for (const source of [base.rows, extra.rows]) {
    for (const [key, bucket] of Object.entries(source)) {
      const sum = rows[key] ?? emptyBucket()
      rows[key] = {
        requests: sum.requests + bucket.requests,
        input: sum.input + bucket.input,
        output: sum.output + bucket.output,
        cacheRead: sum.cacheRead + bucket.cacheRead,
        cacheCreation: sum.cacheCreation + bucket.cacheCreation,
      }
    }
  }
  return {
    ...base,
    rows,
    updatedAtMs: Math.max(base.updatedAtMs, extra.updatedAtMs),
    costUsd: addCost(base.costUsd, extra.costUsd),
  }
}

function isBucket(value: unknown): value is LedgerBucket {
  if (value === null || typeof value !== 'object') return false
  const bucket = value as Record<string, unknown>
  return ['requests', 'input', 'output', 'cacheRead', 'cacheCreation'].every(field => typeof bucket[field] === 'number')
}

export function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (entry.version !== 1 || typeof entry.day !== 'string' || !DAY_PATTERN.test(entry.day)) return false
  if (typeof entry.sessionId !== 'string' || typeof entry.project !== 'string') return false
  if (typeof entry.updatedAtMs !== 'number') return false
  if (entry.costUsd !== null && typeof entry.costUsd !== 'number') return false
  if (entry.merged !== undefined && !(Array.isArray(entry.merged) && entry.merged.every(id => typeof id === 'string'))) return false
  if (entry.rows === null || typeof entry.rows !== 'object' || Array.isArray(entry.rows)) return false
  return Object.values(entry.rows as Record<string, unknown>).every(isBucket)
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

export interface SpendRow {
  label: string
  sessions: number | null
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUsd: number | null
}

interface Accumulator {
  sessions: Set<string>
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUsd: number | null
}

function emptyAccumulator(): Accumulator {
  return { sessions: new Set<string>(), requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: null }
}

function addBucket(acc: Accumulator, bucket: LedgerBucket): void {
  acc.requests += bucket.requests
  acc.input += bucket.input
  acc.output += bucket.output
  acc.cacheRead += bucket.cacheRead
  acc.cacheCreation += bucket.cacheCreation
}

function totalTokens(row: Pick<SpendRow, 'input' | 'output' | 'cacheRead' | 'cacheCreation'>): number {
  return row.input + row.output + row.cacheRead + row.cacheCreation
}

function splitRowKey(key: string): { agent: string; model: string } {
  const at = key.indexOf('|')
  return at === -1 ? { agent: key, model: 'unknown' } : { agent: key.slice(0, at), model: key.slice(at + 1) }
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
    if (by === 'project' || by === 'day') {
      const acc = group(by === 'project' ? entry.project : entry.day)
      for (const id of sessionIdsOf(entry)) acc.sessions.add(id)
      acc.costUsd = addCost(acc.costUsd, entry.costUsd)
      for (const bucket of Object.values(entry.rows)) addBucket(acc, bucket)
      continue
    }
    for (const [key, bucket] of Object.entries(entry.rows)) {
      const parts = splitRowKey(key)
      addBucket(group(by === 'model' ? parts.model : parts.agent), bucket)
    }
  }
  const countsSessions = by === 'project' || by === 'day'
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
    }))
    .sort((a, b) => totalTokens(b) - totalTokens(a) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

const UNAVAILABLE_NUMBER = 'Unavailable'

function count(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : UNAVAILABLE_NUMBER
}

function percent(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function usd(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function spendLine(
  label: string,
  sessions: number | null,
  row: Pick<SpendRow, 'requests' | 'input' | 'output' | 'cacheRead' | 'cacheCreation' | 'costUsd'>,
  grand: number,
): string {
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
  if (row.costUsd !== null) parts.push('USD ' + usd(row.costUsd))
  return parts.join(' · ')
}

export function buildSpendReport(entries: LedgerEntry[], by: SpendDimension, days: number): string {
  const rows = aggregate(entries, by)
  if (rows.length === 0) return 'Codeflow spend · no recorded requests in the last ' + days + ' day(s)'
  const grand = rows.reduce((sum, row) => sum + totalTokens(row), 0)
  const total = rows.reduce<Accumulator>((acc, row) => {
    acc.requests += row.requests
    acc.input += row.input
    acc.output += row.output
    acc.cacheRead += row.cacheRead
    acc.cacheCreation += row.cacheCreation
    return acc
  }, emptyAccumulator())
  total.costUsd = entries.reduce<number | null>((sum, entry) => addCost(sum, entry.costUsd), null)
  const sessions = new Set(entries.flatMap(sessionIdsOf)).size
  const lines = [
    'Codeflow spend · last ' + days + ' day(s) · by ' + by,
    ...rows.map(row => spendLine(row.label, row.sessions, row, grand)),
    spendLine('Total', sessions, total, grand),
  ]
  return lines.join('\n')
}

export function parseSpendArgs(words: string[]): { by: SpendDimension; days: number } | null {
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
  return { by: by ?? 'project', days: days ?? DEFAULT_SPEND_DAYS }
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
  const folded = new Map<string, Set<string>>()
  for (const entry of entries) {
    if (entry.merged === undefined) continue
    const groupKey = JSON.stringify([entry.day, entry.project])
    const ids = folded.get(groupKey) ?? new Set<string>()
    for (const id of entry.merged) ids.add(id)
    folded.set(groupKey, ids)
  }
  return entries.filter(entry => {
    if (entry.merged !== undefined) return true
    return !folded.get(JSON.stringify([entry.day, entry.project]))?.has(entry.sessionId)
  })
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
}

function newCompacted(day: string, project: string, nowMs: number): LedgerEntry {
  return { ...newLedgerEntry(day, COMPACTED_ID, project, nowMs), merged: [] }
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
  const groups = new Map<string, { day: string; project: string; keys: string[]; entries: LedgerEntry[] }>()
  for (const key of candidates) {
    if (!hasTime()) return
    const value = await $.store.get(key).catch(() => null)
    if (!isLedgerEntry(value)) continue
    const groupKey = JSON.stringify([value.day, value.project])
    const group = groups.get(groupKey) ?? { day: value.day, project: value.project, keys: [], entries: [] }
    group.keys.push(key)
    group.entries.push(value)
    groups.set(groupKey, group)
  }
  for (const group of groups.values()) {
    if (!hasTime()) return
    const key = compactedKey(group.day, group.project)
    const existing = await $.store.get(key).catch(() => null)
    const current = isLedgerEntry(existing) ? existing : newCompacted(group.day, group.project, nowMs)
    const known = new Set(current.merged ?? [])
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
