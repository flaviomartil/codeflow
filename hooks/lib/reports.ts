import type { EngineInterface } from 'claude-code'
import {
  buildCompareReport, buildSpendReport, dayBefore, LEDGER_RETENTION_DAYS, readLedger, readSnapshots,
  SPEND_DIMENSIONS, type SpendDimension,
} from './ledger'
import { buildWhyReport } from './why'

export type ReportKind = 'spend' | 'compare' | 'why'

export interface SpendToolRequest {
  kind: ReportKind
  by: SpendDimension
  days: number
}

export const SPEND_OFF = 'The spend ledger is off. Enable spendLedger in the plugin options.'
export const SPEND_USAGE = 'Use /codeflow spend [project|day|model|agent|tag] [days].'
export const COMPARE_USAGE = 'Use /codeflow compare [project|day|model|agent|tag] [days].'
export const WHY_USAGE = 'Use /codeflow why [days].'
export const SPEND_TOOL_USAGE = 'Use report: why, spend or compare.'
export const SPEND_NEEDS_PERMISSION = 'Codeflow spend report needs permission. Allow mcp__codeflow__spend_report in your Claude Code permissions to use it.'
export const SPEND_DENIED = 'Codeflow spend report is denied by a permission rule.'
export const SPEND_FAILED = 'Codeflow could not read the spend ledger.'

const REPORTS: readonly ReportKind[] = ['why', 'spend', 'compare']

export function parseSpendToolInput(input: Record<string, unknown>): SpendToolRequest | null {
  const report = input.report
  if (typeof report !== 'string' || !(REPORTS as readonly string[]).includes(report)) return null
  const kind = report as ReportKind
  const requested = typeof input.by === 'string' ? input.by.toLowerCase() : ''
  const by = (SPEND_DIMENSIONS as readonly string[]).includes(requested)
    ? requested as SpendDimension
    : kind === 'compare' ? 'tag' : 'project'
  const fallbackDays = kind === 'why' ? 1 : 7
  const days = typeof input.days === 'number' && Number.isFinite(input.days)
    ? Math.min(LEDGER_RETENTION_DAYS, Math.max(1, Math.round(input.days)))
    : fallbackDays
  return { kind, by, days }
}

export function spendToolArguments(call: unknown): Record<string, unknown> {
  const fields = (call !== null && typeof call === 'object' ? call : {}) as Record<string, unknown>
  const input: Record<string, unknown> = {}
  for (const key of ['report', 'by', 'days']) {
    if (fields[key] !== undefined) input[key] = fields[key]
  }
  return input
}

export async function spendText($: EngineInterface, kind: ReportKind, by: SpendDimension, days: number): Promise<string> {
  const now = await $.clock.now()
  const all = await readLedger($, now, LEDGER_RETENTION_DAYS)
  const oldest = dayBefore(now, days - 1)
  const entries = all.filter(entry => entry.day >= oldest)
  if (kind === 'why') {
    const snapshots = await readSnapshots($)
    return buildWhyReport(entries, snapshots, all, days, now)
  }
  return kind === 'compare' ? buildCompareReport(entries, by, days) : buildSpendReport(entries, by, days)
}
