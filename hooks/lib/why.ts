import { costFor, priceFor } from './prices'
import {
  aggregate, bucketEst, count, MAIN_AGENT, oneDecimal, percent, splitRowKey, usd,
  type ContextSnapshot, type LedgerBucket, type LedgerEntry, type PlanWindow,
} from './ledger'

function share(part: number, total: number): string {
  return count(total > 0 ? Math.round(part / total * 100) : 0)
}

function tokensOf(bucket: LedgerBucket): number {
  return bucket.input + bucket.output + bucket.cacheRead + bucket.cacheCreation
}

function topKey(totals: Map<string, number>): string | null {
  let best: string | null = null
  for (const [key, value] of totals) {
    if (best === null || value > (totals.get(best) ?? 0)) best = key
  }
  return best
}

function isCurrent(window: PlanWindow, nowMs: number): boolean {
  const reset = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt)
  return !(Number.isFinite(reset) && reset < nowMs)
}

function calibrationRate(entries: LedgerEntry[], nowMs: number): number | null {
  const withPlan = entries.flatMap(entry => {
    const window = entry.plan?.seven_day
    return window === undefined || !isCurrent(window, nowMs) ? [] : [{ entry, window }]
  })
  if (withPlan.length === 0) return null
  const latest = withPlan.map(item => item.window.resetsAt ?? '').sort().at(-1) ?? ''
  const group = withPlan.filter(item => (item.window.resetsAt ?? '') === latest)
  const span = Math.max(...group.map(item => item.window.to)) - Math.min(...group.map(item => item.window.from))
  const spent = group.reduce((sum, item) => sum + (item.entry.costUsd ?? 0), 0)
  return span >= 1 && spent > 0 ? span / spent : null
}

function latestWindow(entries: LedgerEntry[], kind: string, nowMs: number): number | null {
  const holder = entries
    .filter(entry => {
      const window = entry.plan?.[kind]
      return window !== undefined && isCurrent(window, nowMs)
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0]
  return holder?.plan?.[kind]?.to ?? null
}

function agentLine(entries: LedgerEntry[]): string | null {
  const agents = aggregate(entries, 'agent').filter(row => row.approxUsd > 0)
  if (agents.length === 0) return null
  const total = agents.reduce((sum, row) => sum + row.approxUsd, 0)
  const top = [...agents].sort((a, b) => b.approxUsd - a.approxUsd).slice(0, 6)
  return 'By agent: ' + top
    .map(row => `${row.label} ${share(row.approxUsd, total)}% (≈ USD ${usd(row.approxUsd)})`)
    .join(' · ')
}

function mixLine(entries: LedgerEntry[]): string | null {
  const mix = new Map<string, number>()
  for (const entry of entries) {
    for (const [name, value] of Object.entries(entry.mix ?? {})) mix.set(name, (mix.get(name) ?? 0) + value)
  }
  const total = [...mix.values()].reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  const sorted = [...mix.entries()].sort((a, b) => b[1] - a[1])
  const items: string[] = []
  let other = 0
  for (const [name, value] of sorted) {
    if (value / total < 0.01) other += value
    else items.push(`${name} ${share(value, total)}%`)
  }
  if (other > 0) items.push(`other ${share(other, total)}%`)
  return 'Main-loop context: ' + items.join(' · ') + ' (share of main-loop input tokens)'
}

function fixedLine(entries: LedgerEntry[], snapshots: ContextSnapshot[]): string | null {
  const projects = aggregate(entries, 'project').sort((a, b) => b.approxUsd - a.approxUsd)
  let snapshot: ContextSnapshot | undefined
  for (const project of projects) {
    snapshot = snapshots
      .filter(item => item.project === project.label)
      .sort((a, b) => b.atMs - a.atMs)[0]
    if (snapshot !== undefined) break
  }
  if (snapshot === undefined) return null
  const items: Array<[number, string]> = []
  for (const [server, tokens] of snapshot.mcpServers) items.push([tokens, `MCP ${server} ${count(tokens)} tok`])
  for (const [path, tokens] of snapshot.memoryFiles) items.push([tokens, `Memory ${path} ${count(tokens)} tok`])
  if (snapshot.skills !== null) {
    items.push([snapshot.skills.tokens, `Skills listing (${count(snapshot.skills.count)}) ${count(snapshot.skills.tokens)} tok`])
  }
  if (snapshot.agents.count > 0) {
    items.push([snapshot.agents.tokens, `Custom agents (${count(snapshot.agents.count)}) ${count(snapshot.agents.tokens)} tok`])
  }
  for (const [name, tokens] of snapshot.categories) {
    if (name === 'System prompt' || name === 'System tools') items.push([tokens, `${name} ${count(tokens)} tok`])
  }
  const largest = items.sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, text]) => text)
  const fixed = snapshot.categories.filter(([name]) => name !== 'Messages').reduce((sum, [, tokens]) => sum + tokens, 0)
  return 'Largest fixed items: ' + [...largest, `fixed context ${count(fixed)} tok per request`].join(' · ')
}

function entryScale(entry: LedgerEntry): number {
  const weight = Object.entries(entry.rows).reduce((sum, [key, bucket]) => sum + bucketEst(key, bucket), 0)
  return entry.costUsd !== null && entry.costUsd > 0 && weight > 0 ? entry.costUsd / weight : 1
}

function rebuildLine(entries: LedgerEntry[], spent: number): string | null {
  const totals = entries.reduce((sum, entry) => {
    if (entry.rebuild === undefined) return sum
    return {
      count: sum.count + entry.rebuild.count,
      tokens: sum.tokens + entry.rebuild.tokens,
      est: sum.est + entry.rebuild.est * entryScale(entry),
    }
  }, { count: 0, tokens: 0, est: 0 })
  if (totals.count === 0) return null
  return `Cache rebuilds: ${count(totals.count)} · ${count(totals.tokens)} tok · ≈ USD ${usd(totals.est)} write cost (${share(totals.est, spent)}% of spend)`
}

function delegationLine(entries: LedgerEntry[], spent: number): string {
  const mainTotals = new Map<string, number>()
  let subagentRows = false
  for (const entry of entries) {
    for (const [key, bucket] of Object.entries(entry.rows)) {
      const parts = splitRowKey(key)
      if (parts.agent === MAIN_AGENT) mainTotals.set(parts.model, (mainTotals.get(parts.model) ?? 0) + tokensOf(bucket))
    }
  }
  const mainModel = topKey(mainTotals)
  let subagent = 0
  let same = 0
  for (const entry of entries) {
    const rows = Object.entries(entry.rows)
    const scale = entryScale(entry)
    const entryTotals = new Map<string, number>()
    for (const [key, bucket] of rows) {
      const parts = splitRowKey(key)
      if (parts.agent === MAIN_AGENT) entryTotals.set(parts.model, (entryTotals.get(parts.model) ?? 0) + tokensOf(bucket))
    }
    const entryMain = topKey(entryTotals)
    for (const [key, bucket] of rows) {
      if (splitRowKey(key).agent === MAIN_AGENT) continue
      subagentRows = true
      const estimate = bucketEst(key, bucket) * scale
      subagent += estimate
      same += entryMain === null
        ? estimate
        : costFor(priceFor(entryMain, 0), {
          input: bucket.input,
          output: bucket.output,
          cacheRead: bucket.cacheRead,
          cacheWrite5m: 0,
          cacheWrite1h: bucket.cacheCreation,
        }) * scale
    }
  }
  if (!subagentRows) return 'Delegation: no subagent requests'
  return `Delegation: subagents ≈ USD ${usd(subagent)} (${share(subagent, spent)}% of spend); the same tokens on ${mainModel ?? 'the main model'} ≈ USD ${usd(same)}`
}

export function buildWhyReport(
  entries: LedgerEntry[],
  snapshots: ContextSnapshot[],
  calibrationEntries: LedgerEntry[],
  days: number,
  nowMs: number,
): string {
  if (entries.length === 0) return `Codeflow why · no recorded requests in the last ${days} day(s)`
  const allReal = entries.every(entry => entry.costUsd !== null && entry.costUsd > 0)
  const agentRows = aggregate(entries, 'agent')
  const approxSpent = agentRows.reduce((sum, row) => sum + row.approxUsd, 0)
  const spent = approxSpent
  const rate = calibrationRate(calibrationEntries, nowMs)
  const parts = [`Spent ${allReal ? 'USD' : '≈ USD'} ${usd(spent)}`]
  parts.push(rate === null
    ? 'plan share not measured yet'
    : `≈ ${oneDecimal(spent * rate)}% of the 7-day plan window (1% ≈ USD ${(1 / rate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, measured on this machine)`)
  const seven = latestWindow(calibrationEntries, 'seven_day', nowMs)
  if (seven !== null) parts.push(`7-day window at ${percent(seven)}%`)
  const five = latestWindow(calibrationEntries, 'five_hour', nowMs)
  if (five !== null) parts.push(`5-hour window at ${percent(five)}%`)
  const lines = [`Codeflow why · last ${days} day(s)`, parts.join(' · ')]
  const agents = agentLine(entries)
  if (agents !== null) lines.push(agents)
  const mix = mixLine(entries)
  if (mix !== null) lines.push(mix)
  const fixed = fixedLine(entries, snapshots)
  if (fixed !== null) lines.push(fixed)
  const rebuilds = rebuildLine(entries, spent)
  if (rebuilds !== null) lines.push(rebuilds)
  lines.push(delegationLine(entries, spent))
  return lines.join('\n')
}
