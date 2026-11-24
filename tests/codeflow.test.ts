import type { EngineInterface, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { resolveToggle } from '../hooks/lib/env'
import { newSessionTelemetry, observeThinkingBlock, newTurnTelemetry, sumUsage, totalInput } from '../hooks/lib/telemetry'
import {
  addRequest, aggregate, buildCompareReport, buildSpendReport, COMPACT_PER_RUN, compactedKey, compactLedger, contextKey,
  dayBefore, dayOf, isContextSnapshot, LEDGER_PREFIX, ledgerKey, mergeEntries, newLedgerEntry, parseSpendArgs,
  legacyCompactedKey, pruneLedger, readLedger, type ContextSnapshot, type LedgerEntry,
} from '../hooks/lib/ledger'
import { buildWhyReport } from '../hooks/lib/why'
import { estimateUsd, priceFor } from '../hooks/lib/prices'
import { endSpendSession, flushSpend, newSpendSession, recordStep } from '../hooks/lib/spend-session'

const usage = {
  model: 'test-model',
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 70,
  cache_creation_input_tokens: 5,
}

const completion = {
  turnId: 't1',
  answer: 'Original answer',
  durationMs: 1000,
  isAborted: false,
  reason: 'answer' as const,
  usage,
}

const start = { surface: 'terminal' as const, isInteractive: true, cwd: '/work' }
const command = { command: 'codeflow', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
const nativeSection = { id: 'intro', text: 'Native prompt', scope: 'shared' as const }
const compose = {
  model: 'test-model', promptModel: 'test-model', surfaces: ['terminal'] as const,
  tools: [], outputStyle: null, traits: [],
}

interface UsageState {
  usd: number
  rateLimits?: unknown[]
  breakdown?: unknown
}

function mockSession(on: On, variables: Record<string, string> = {}, cost: UsageState = { usd: 0.0123 }) {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, variables)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', ($, e) => {
    const detailed = e?.breakdown === 'summary' && cost.breakdown !== undefined
    return {
      value: {
        startedAt: 0,
        context: { tokens: 12_000, window: 200_000, percent: 6, ...(detailed ? { breakdown: cost.breakdown as never } : {}) },
        rateLimits: (cost.rateLimits ?? []) as never,
        cost: { usd: cost.usd },
      },
    }
  })
  on('prompt.compose', () => ({ sections: [nativeSection] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  mock.session(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return clock
}

test('toggle is passive by default, active only with opt-in', () => {
  expect(resolveToggle(undefined)).toEqual({ enabled: false, invalid: false })
  expect(resolveToggle('0')).toEqual({ enabled: false, invalid: false })
  expect(resolveToggle('1')).toEqual({ enabled: true, invalid: false })
  expect(resolveToggle('invalid')).toEqual({ enabled: false, invalid: true })
})

test('passive mode preserves native sections and counts tools', async ($, on) => {
  mockSession(on)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start(start)
  expect((await $.prompt.compose(compose)).sections).toEqual([nativeSection])
  await $.turn.start({ text: 'query', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'printf ok' })
  await $.turn.start({ text: 'subagent', turnId: 'child', agentId: 'a1' })
  await $.turn.complete({ ...completion, turnId: 'child', agentId: 'a1' })
  const ended = await $.turn.complete(completion)
  expect(ended.text).toContain('1 call(s)')
  expect(ended.text).toContain('new input 100')
  expect(ended.text).toContain('total input 175')
  expect(ended.text).toContain('context 6%')
})

test('active mode adds a session section to the prompt', async ($, on) => {
  mockSession(on, { CLAUDE_CODEFLOW_ENABLED: '1' })
  await $.session.start(start)
  const composed = await $.prompt.compose(compose)
  expect(composed.sections[0]).toEqual(nativeSection)
  expect(composed.sections[1]?.id).toBe('codeflow:operations')
  expect(composed.sections[1]?.scope).toBe('session')
  expect(composed.sections).toHaveLength(2)
})

test('active mode never changes a permission decision', async ($, on) => {
  mockSession(on, { CLAUDE_CODEFLOW_ENABLED: '1' })
  on('tool.check', ($, e) => {
    const input = e.input as { command?: string }
    return input.command?.includes('blocked')
      ? { decision: 'deny', reason: 'native rule' }
      : { decision: 'allow' }
  })
  await $.session.start(start)
  const denied = await $.tool.check({ tool: 'Bash', input: { command: 'printf blocked' } })
  expect(denied.decision).toBe('deny')
  expect(denied.reason).toBe('native rule')
  for (const command of ['cd app && git push', 'd=$(mktemp -d); rm -rf "$d"', "node -e \"fetch('http://127.0.0.1')\""]) {
    const result = await $.tool.check({ tool: 'Bash', input: { command } })
    expect(result.decision).toBe('allow')
  }
  const script = await $.tool.check({ tool: 'REPL', input: { code: 'process.exit(0)' } })
  expect(script.decision).toBe('allow')
})

test('output goes whole to the tool and only eligible read text in the transcript is reduced',
  { options: { maxFileLines: 2, maxToolResultChars: 120 } }, async ($, on) => {
    mockSession(on, { CLAUDE_CODEFLOW_ENABLED: '1' })
    const raw = ['line 1', 'line 2', 'fixture text '.repeat(100)].join('\n')
    on('tool.call', ($, e) => e.tool_use_id === 'failed1' ? { result: raw, isError: true } : { result: raw })
    await $.session.start(start)
    await $.turn.start({ text: 'read', turnId: 't1' })
    const read = await $.tool.call({ tool: 'Read', file_path: '/work/example.txt', tool_use_id: 'read1' })
    expect(read.result).toBe(raw)
    const readRow = await $.session.append({
      door: 'tool-result', uuid: 'row1', origin: { kind: 'tool', tool: 'Read' },
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read1', content: raw }] },
    })
    const shortened = readRow.message?.content[0]?.content
    expect(typeof shortened).toBe('string')
    expect((shortened as string).length).toBeLessThan(raw.length)
    const bash = await $.tool.call({ tool: 'Bash', command: 'printf ok', tool_use_id: 'bash1' })
    expect(bash.result).toBe(raw)
    const row = await $.session.append({
      door: 'tool-result', uuid: 'row2', origin: { kind: 'tool', tool: 'Bash' },
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash1', content: raw }] },
    })
    expect(row.message?.content[0]?.content).toBe(raw)
    await $.tool.call({ tool: 'Read', file_path: '/work/missing.txt', tool_use_id: 'failed1' })
    const failed = await $.session.append({
      door: 'tool-result', uuid: 'row3', origin: { kind: 'tool', tool: 'Read' },
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'failed1', is_error: true, content: raw }] },
    })
    expect(failed.message?.content[0]?.content).toBe(raw)
    await $.tool.call({ tool: 'Read', file_path: '/work/example.txt', tool_use_id: 'read2' })
    const parts = await $.session.append({
      door: 'tool-result', uuid: 'row4', origin: { kind: 'tool', tool: 'Read' },
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read2', content: [{ type: 'text', text: raw }] }] },
    })
    expect(parts.message?.content[0]?.content).toEqual([{ type: 'text', text: shortened }])
  })

test('thinking count keeps only counters', () => {
  const session = newSessionTelemetry()
  session.current = newTurnTelemetry('t1', 0)
  observeThinkingBlock(session, 'private fixture for counting only')
  expect(session.current?.thinking).toEqual({ blocks: 1, words: 5 })
  expect(JSON.stringify(session)).not.toContain('private fixture')
})

test('stash requires an explicit value and expires in the session', async ($, on) => {
  const clock = mockSession(on, { CLAUDE_CODEFLOW_ENABLED: '1' })
  await $.session.start(start)
  expect((await $.command.run({ ...command, args: 'stash counter' })).text).toContain('up to 2,000')
  await $.command.run({ ...command, args: 'stash counter 42 lines' })
  expect((await $.command.run({ ...command, args: 'recall counter' })).text).toBe('42 lines')
  await clock.advance(30 * 60 * 1000)
  expect((await $.command.run({ ...command, args: 'recall counter' })).text).toContain('expired')
})

test('registry and disk stay off; the ledger writes only its own keys', async ($, on) => {
  mockSession(on)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  let writes = 0
  on('fs.write', () => { writes += 1; return { value: undefined } })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  const keys = [...values.keys()]
  expect(keys.some(key => key.startsWith('codeflow:v2:'))).toBe(false)
  expect(keys.length > 0 && keys.every(key => key.startsWith(LEDGER_PREFIX))).toBe(true)
  expect(writes).toBe(0)
})
test('report reads only the chosen experiment and clears when the session changes', async ($, on) => {
  mockSession(on, { CLAUDE_CODEFLOW_RUN: 'slice-a' })
  const seed = { sessionId: 'unrelated', savedAtMs: 0, enabled: true, turns: [], peakContextPercent: null }
  const keys: string[] = []
  const values = new Map<string, unknown>([['codeflow:v2:slice-b:unrelated', seed]])
  on('store.keys', () => ({ value: [...values.keys()] }))
  on('store.get', ($, e) => { keys.push(e.key); return { value: values.get(e.key) } })
  on('store.set', ($, e) => { values.set(e.key, e.value); return { value: undefined } })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  await $.turn.complete(completion)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  const report = await $.command.run({ ...command, args: 'report' })
  expect(keys.some(key => key.startsWith('codeflow:v2:slice-b:'))).toBe(false)
  expect(report.text).toContain('Experiment slice-a')
  expect(report.text).toContain('Passive (1 session(s))')
  expect(report.text).toContain('Current session · 0/0')
})

test('missing tokens stay unavailable', () => {
  const first = newTurnTelemetry('t1', 0)
  first.usage = { input: 100, cacheRead: 70, cacheCreation: 5, output: 20 }
  const second = newTurnTelemetry('t2', 0)
  expect(totalInput(first.usage)).toBe(175)
  expect(sumUsage([first, second])?.input).toBe(null)
})

test('counts grouping from the tools proposed in the step', async ($, on) => {
  mockSession(on)
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', stopReason: 'tool_use', usage: null,
      toolUses: [{ name: 'Read', input: {} }, { name: 'Glob', input: {} }],
    }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) {
    void chunk
  }
  const ended = await $.turn.complete(completion)
  expect(ended.text).toContain('1 request(s) with multiple tools')
})

const DAY_MS = 24 * 60 * 60 * 1000
const dayA = '2026-11-22'
const dayB = '2026-11-23'

function ledgerFixture(): LedgerEntry[] {
  const e1 = newLedgerEntry(dayA, 's1', '/work/a', 1)
  e1.costUsd = 1.5
  addRequest(e1, 'main', 'opus', { input_tokens: 100, output_tokens: 10 })
  addRequest(e1, 'Explore', 'opus', { input_tokens: 50, output_tokens: 5 })
  const e2 = newLedgerEntry(dayA, 's2', '/work/b', 1)
  addRequest(e2, 'main', 'haiku', { input_tokens: 10 })
  const e3 = newLedgerEntry(dayB, 's1', '/work/a', 1)
  e3.costUsd = 2
  addRequest(e3, 'main', 'opus', { input_tokens: 200, cache_read_input_tokens: 300 })
  return [e1, e2, e3]
}

function storeMock(on: On, values: Map<string, unknown>) {
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.root', () => ({ value: '/work' }))
  on('store.keys', () => ({ value: [...values.keys()] }))
  on('store.get', ($, e) => ({ value: values.get(e.key) }))
  on('store.set', ($, e) => { values.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($, e) => { values.delete(e.key); return { value: undefined } })
}

test('spend ledger days are local calendar days and keys are namespaced', () => {
  expect(dayOf(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05')
  expect(dayOf(new Date(2026, 10, 23, 23, 59).getTime())).toBe('2026-11-23')
  expect(ledgerKey('2026-11-23', 's1')).toBe(LEDGER_PREFIX + '2026-11-23:s1')
})

test('spend ledger adds requests only when usage carries tokens', () => {
  const entry = newLedgerEntry(dayB, 's1', '/work/a', 0)
  expect(addRequest(entry, 'main', 'm1', { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 })).toBe(true)
  expect(addRequest(entry, 'main', 'm1', { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 3 })).toBe(true)
  expect(addRequest(entry, 'main', 'm1', null)).toBe(false)
  expect(addRequest(entry, 'main', 'm1', { model: 'x' })).toBe(false)
  expect(addRequest(entry, 'Explore', '', { model: 'm2', input_tokens: 4 })).toBe(true)
  expect(entry.rows['main|m1']).toMatchObject({ requests: 2, input: 11, output: 3, cacheRead: 5, cacheCreation: 3 })
  expect(entry.rows['Explore|m2']).toMatchObject({ requests: 1, input: 4, output: 0, cacheRead: 0, cacheCreation: 0 })
})

test('spend ledger merge sums rows and cost', () => {
  const a = newLedgerEntry(dayB, 's1', '/work/a', 1)
  a.costUsd = 0.5
  addRequest(a, 'main', 'm1', { input_tokens: 10 })
  const b = newLedgerEntry(dayB, 's1', '/work/a', 5)
  b.costUsd = 0.25
  addRequest(b, 'main', 'm1', { input_tokens: 4, output_tokens: 1 })
  const merged = mergeEntries(a, b)
  expect(merged.rows['main|m1']).toMatchObject({ requests: 2, input: 14, output: 1, cacheRead: 0, cacheCreation: 0 })
  expect(merged.costUsd).toBe(0.75)
  expect(merged.updatedAtMs).toBe(5)
  expect(mergeEntries(a, newLedgerEntry(dayB, 's1', '/work/a', 1)).costUsd).toBe(0.5)
})

test('spend ledger aggregates by project, day, model and agent', () => {
  const entries = ledgerFixture()
  const view = (by: Parameters<typeof aggregate>[1]) =>
    aggregate(entries, by).map(row => [row.label, row.sessions, row.requests, row.costUsd])
  expect(view('project')).toEqual([['/work/a', 1, 3, 3.5], ['/work/b', 1, 1, null]])
  expect(view('day')).toEqual([[dayB, 1, 1, 2], [dayA, 2, 3, 1.5]])
  expect(view('model')).toEqual([['opus', null, 3, null], ['haiku', null, 1, null]])
  expect(view('agent')).toEqual([['main', null, 3, null], ['Explore', null, 1, null]])
})

test('spend report has a header, one line per row and a USD figure only where cost exists', () => {
  const lines = buildSpendReport(ledgerFixture(), 'project', 7).split('\n')
  expect(lines[0]).toBe('Codeflow spend · last 7 day(s) · by project')
  expect(lines).toHaveLength(4)
  expect(lines[1]).toContain('/work/a · 1 session(s) · 3 request(s) · total input 650')
  expect(lines[1]).toContain('USD 3.50')
  expect(lines[2]).toContain('/work/b · 1 session(s) · 1 request(s)')
  expect(lines[2]).toContain('≈ USD')
  expect(lines[3]).toContain('Total · 2 session(s) · 4 request(s)')
  expect(lines[3]).toContain('USD 3.50')
  expect(buildSpendReport([], 'day', 3)).toBe('Codeflow spend · no recorded requests in the last 3 day(s)')
})

test('spend ledger records main and subagent requests by agent type', async ($, on) => {
  mockSession(on)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  const childUsage = { model: 'test-model', input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'a1' }))
  on('turn.step', async function* ($, e) {
    const used = e.agentId === undefined ? usage : e.agentId === 'a1' ? childUsage : { ...childUsage, input_tokens: 7 }
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage: used, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  await $.agent.spawn({ prompt: 'look around', subagentType: 'Explore' } as never)
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  for await (const chunk of $.turn.step({ turnId: 'child', index: 0, model: 'test-model', messageCount: 1, agentId: 'a1' })) void chunk
  for await (const chunk of $.turn.step({ turnId: 'child', index: 1, model: 'test-model', messageCount: 1, agentId: 'ghost' })) void chunk
  await $.turn.complete(completion)
  const stored = [...values.values()] as LedgerEntry[]
  expect(stored).toHaveLength(1)
  expect(stored[0]?.rows['main|test-model']).toMatchObject({ requests: 1, input: 100, output: 20, cacheRead: 70, cacheCreation: 5 })
  expect(stored[0]?.rows['Explore|test-model']).toMatchObject({ requests: 1, input: 40, output: 4, cacheRead: 0, cacheCreation: 0 })
  expect(stored[0]?.rows['subagent|test-model']).toMatchObject({ requests: 1, input: 7, output: 4, cacheRead: 0, cacheCreation: 0 })
  const report = await $.command.run({ ...command, args: 'spend agent' })
  expect(report.text).toContain('main · 1 request(s)')
  expect(report.text).toContain('Explore · 1 request(s)')
  expect(report.text).toContain('subagent · 1 request(s)')
  expect(report.text).toContain('Total · 1 session(s)')
})

test('spend ledger merges a stored entry for the same day and session', async ($, on) => {
  mockSession(on)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  const sessionId = 'sid-1'
  const day = dayOf(1000)
  const prior = newLedgerEntry(day, sessionId, '/work', 0)
  prior.costUsd = 0.5
  prior.rows['main|test-model'] = { requests: 2, input: 50, output: 5, cacheRead: 0, cacheCreation: 0 }
  values.set(ledgerKey(day, sessionId), prior)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  const merged = values.get(ledgerKey(day, sessionId)) as LedgerEntry
  expect(merged.rows['main|test-model']).toMatchObject({ requests: 3, input: 150, output: 25, cacheRead: 70, cacheCreation: 5 })
  expect(merged.costUsd).toBe(0.5)
})

test('spend ledger prune removes days older than 30 and keeps recent ones', async ($, on) => {
  mockSession(on)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  const now = 1000
  const old = newLedgerEntry(dayOf(now - 31 * DAY_MS), 'old', '/work', now)
  const recent = newLedgerEntry(dayOf(now - 29 * DAY_MS), 'recent', '/work', now)
  const today = newLedgerEntry(dayOf(now), 'today', '/work', now)
  values.set(ledgerKey(old.day, old.sessionId), old)
  values.set(ledgerKey(recent.day, recent.sessionId), recent)
  values.set(ledgerKey(today.day, today.sessionId), today)
  values.set('codeflow:v2:run:s', { keep: true })
  await $.session.start(start)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  expect([...values.keys()].sort()).toEqual([
    compactedKey(recent.day, recent.project),
    ledgerKey(today.day, today.sessionId),
    'codeflow:v2:run:s',
  ].sort())
})

test('spend ledger off writes nothing and answers with the off message', { options: { spendLedger: false } }, async ($, on) => {
  mockSession(on)
  let writes = 0
  on('store.set', () => { writes += 1; return { value: undefined } })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  const report = await $.command.run({ ...command, args: 'spend' })
  expect(writes).toBe(0)
  expect(report.text).toBe('The spend ledger is off. Enable spendLedger in the plugin options.')
})

test('spend ledger adds only the cost moved after a resumed entry was stored', async ($, on) => {
  const counter = { usd: 3 }
  mockSession(on, {}, counter)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  const day = dayOf(1000)
  const prior = newLedgerEntry(day, 'sid-1', '/work', 0)
  prior.costUsd = 1
  prior.rows['main|test-model'] = { requests: 1, input: 10, output: 0, cacheRead: 0, cacheCreation: 0 }
  values.set(ledgerKey(day, 'sid-1'), prior)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  counter.usd = 3.25
  await $.turn.complete(completion)
  const stored = values.get(ledgerKey(day, 'sid-1')) as LedgerEntry
  expect(stored.costUsd).toBe(1.25)
  expect(stored.rows['main|test-model']?.requests).toBe(2)
})

function fullFake(
  values: Map<string, unknown>,
  counter: { usd: number },
  agents: unknown[] = [],
  faults: { deletes?: boolean } = {},
  env: Record<string, string> = {},
) {
  return {
    clock: { now: async () => 1000 },
    session: {
      id: async () => 'sid-1',
      root: async () => '/work',
      usage: async () => ({ context: {}, rateLimits: [], cost: { usd: counter.usd } }),
    },
    agent: { list: async () => agents },
    env: { get: async (key: string) => env[key] },
    store: {
      keys: async () => [...values.keys()],
      get: async (key: string) => {
        for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
        return values.get(key)
      },
      set: async (key: string, value: unknown) => { values.set(key, JSON.parse(JSON.stringify(value))) },
      delete: async (key: string) => {
        if (faults.deletes) throw new Error('store unavailable')
        values.delete(key)
      },
    },
  } as unknown as EngineInterface
}

function sessionEntry(day: string, sessionId: string, project: string, input: number, model = 'm1'): LedgerEntry {
  const entry = newLedgerEntry(day, sessionId, project, 1)
  addRequest(entry, 'main', model, { input_tokens: input })
  return entry
}

test('spend ledger serialises concurrent steps into one entry', async () => {
  const values = new Map<string, unknown>()
  const counter = { usd: 0 }
  const fake = fullFake(values, counter)
  const spend = newSpendSession()
  spend.agentTypes.set('a1', 'Explore')
  const main = recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10, output_tokens: 1 })
  const child = recordStep(spend, fake, '/work', { agentId: 'a1', model: 'm1' }, { input_tokens: 4, output_tokens: 2 })
  await Promise.all([main, child])
  counter.usd = 0.5
  await flushSpend(spend, fake)
  const stored = [...values.values()] as LedgerEntry[]
  expect(stored).toHaveLength(1)
  expect(stored[0]?.rows).toMatchObject({
    'main|m1': { requests: 1, input: 10, output: 1, cacheRead: 0, cacheCreation: 0 },
    'Explore|m1': { requests: 1, input: 4, output: 2, cacheRead: 0, cacheCreation: 0 },
  })
  expect(stored[0]?.costUsd).toBe(0.5)
  expect(spend.dirty).toBe(false)
})

test('spend ledger keeps a step that lands after the session ended', async () => {
  const values = new Map<string, unknown>()
  const fake = fullFake(values, { usd: 0 })
  const spend = newSpendSession()
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10 })
  await endSpendSession(spend, fake)
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 5 })
  await flushSpend(spend, fake)
  const stored = values.get(ledgerKey(dayOf(1000), 'sid-1')) as LedgerEntry
  expect(stored.rows['main|m1']).toMatchObject({ requests: 2, input: 15, output: 0, cacheRead: 0, cacheCreation: 0 })
  expect(values.size).toBe(1)
})

test('spend ledger reads only the requested calendar days', async () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const values = new Map<string, unknown>()
  for (const days of [0, 1, 2, 40]) {
    const entry = sessionEntry(dayBefore(now, days), 's' + days, '/work', 1)
    values.set(ledgerKey(entry.day, entry.sessionId), entry)
  }
  const fake = fullFake(values, { usd: 0 })
  expect((await readLedger(fake, now, 1)).length).toBe(1)
  expect((await readLedger(fake, now, 2)).length).toBe(2)
  expect((await readLedger(fake, now, 3)).length).toBe(3)
  expect((await readLedger(fake, now, 30)).length).toBe(3)
})

test('spend ledger compaction folds old sessions per day and project and leaves yesterday and today alone', async () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const today = dayOf(now)
  const yesterday = dayBefore(now, 1)
  const older = dayBefore(now, 3)
  const older2 = dayBefore(now, 2)
  const values = new Map<string, unknown>()
  for (const entry of [
    sessionEntry(older, 's1', '/a', 10), sessionEntry(older, 's2', '/a', 20), sessionEntry(older, 's3', '/b', 5),
    sessionEntry(older2, 's4', '/a', 7), sessionEntry(yesterday, 's6', '/a', 2), sessionEntry(today, 's5', '/a', 1),
  ]) values.set(ledgerKey(entry.day, entry.sessionId), entry)
  const fake = fullFake(values, { usd: 0 })
  await compactLedger(fake, now, () => true)
  for (const id of ['s1', 's2', 's3']) expect(values.has(ledgerKey(older, id))).toBe(false)
  expect(values.has(ledgerKey(older2, 's4'))).toBe(false)
  expect(values.has(ledgerKey(yesterday, 's6'))).toBe(true)
  expect(values.has(ledgerKey(today, 's5'))).toBe(true)
  const a = values.get(compactedKey(older, '/a')) as LedgerEntry
  expect(a.merged).toEqual(['s1', 's2'])
  expect(a.merged).toHaveLength(2)
  expect(a.rows['main|m1']).toMatchObject({ requests: 2, input: 30, output: 0, cacheRead: 0, cacheCreation: 0 })
  expect((values.get(compactedKey(older, '/b')) as LedgerEntry).merged).toEqual(['s3'])
  expect((values.get(compactedKey(older2, '/a')) as LedgerEntry).merged).toEqual(['s4'])
  const snapshot = JSON.stringify([...values.entries()])
  await compactLedger(fake, now, () => true)
  expect(JSON.stringify([...values.entries()])).toBe(snapshot)
})

test('spend ledger compaction skips sessions already merged after an interrupted run', async () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const older = dayBefore(now, 3)
  const values = new Map<string, unknown>()
  const compacted = { ...newLedgerEntry(older, '~', '/a', 1), merged: ['s9'] }
  addRequest(compacted, 'main', 'm1', { input_tokens: 1 })
  values.set(compactedKey(older, '/a'), compacted)
  values.set(ledgerKey(older, 's9'), sessionEntry(older, 's9', '/a', 1000))
  values.set(ledgerKey(older, 's1'), sessionEntry(older, 's1', '/a', 10))
  await compactLedger(fullFake(values, { usd: 0 }), now, () => true)
  expect(values.has(ledgerKey(older, 's9'))).toBe(false)
  expect(values.has(ledgerKey(older, 's1'))).toBe(false)
  const result = values.get(compactedKey(older, '/a')) as LedgerEntry
  expect(result.merged).toEqual(['s9', 's1'])
  expect(result.rows['main|m1']).toMatchObject({ requests: 2, input: 11, output: 0, cacheRead: 0, cacheCreation: 0 })
})

test('spend ledger compaction handles at most COMPACT_PER_RUN sessions per run', async () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const older = dayBefore(now, 3)
  const values = new Map<string, unknown>()
  for (let index = 0; index < COMPACT_PER_RUN + 5; index += 1) {
    const id = 'k' + String(index).padStart(3, '0')
    values.set(ledgerKey(older, id), sessionEntry(older, id, '/p', 1))
  }
  const fake = fullFake(values, { usd: 0 })
  await compactLedger(fake, now, () => true)
  const remaining = [...values.keys()].filter(key => key.startsWith(LEDGER_PREFIX) && !key.includes(':~'))
  expect(remaining).toHaveLength(5)
  expect((values.get(compactedKey(older, '/p')) as LedgerEntry).merged).toHaveLength(COMPACT_PER_RUN)
  await compactLedger(fake, now, () => true)
  expect([...values.keys()].filter(key => !key.includes(':~'))).toHaveLength(0)
  expect((values.get(compactedKey(older, '/p')) as LedgerEntry).merged).toHaveLength(COMPACT_PER_RUN + 5)
})

test('spend ledger aggregates and reports compacted entries with their session count', () => {
  const compacted = { ...newLedgerEntry(dayA, '~', '/work/a', 1), merged: ['s1', 'x2'] }
  addRequest(compacted, 'main', 'opus', { input_tokens: 30 })
  const live = sessionEntry(dayA, 's3', '/work/a', 10, 'opus')
  const byProject = aggregate([compacted, live], 'project')
  expect(byProject).toHaveLength(1)
  expect(byProject[0]?.sessions).toBe(3)
  expect(aggregate([compacted, live], 'agent')[0]?.sessions).toBe(null)
  const lines = buildSpendReport([compacted, live], 'model', 7).split('\n')
  expect(lines[1]).not.toContain('session(s)')
  expect(lines[2]).toContain('Total · 3 session(s)')
})

test('spend command parses the dimension and the day count in either order', () => {
  expect(parseSpendArgs([])).toEqual({ by: 'project', days: 7 })
  expect(parseSpendArgs(['3'])).toEqual({ by: 'project', days: 3 })
  expect(parseSpendArgs(['AGENT'])).toEqual({ by: 'agent', days: 7 })
  expect(parseSpendArgs(['3', 'model'])).toEqual({ by: 'model', days: 3 })
  expect(parseSpendArgs(['model', '3'])).toEqual({ by: 'model', days: 3 })
  expect(parseSpendArgs(['99'])).toEqual({ by: 'project', days: 30 })
  for (const words of [['x'], ['0'], ['model', 'day'], ['model', 'agent', '3'], ['3', '4'], ['3.5']]) {
    expect(parseSpendArgs(words)).toBe(null)
  }
})

test('spend command answers invalid arguments with the usage line', async ($, on) => {
  mockSession(on)
  await $.session.start(start)
  const usageLine = 'Use /codeflow spend [project|day|model|agent|tag] [days].'
  for (const args of ['spend x', 'spend 0', 'spend model day', 'spend model agent 3']) {
    expect((await $.command.run({ ...command, args })).text).toBe(usageLine)
  }
})

test('spend ledger labels an agent missing from the spawn list from agent.list, asking once', async ($, on) => {
  mockSession(on)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  let asked = 0
  on('agent.list', () => { asked += 1; return { value: [{ id: 'x9', type: 'Plan' }] as never } })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  for await (const chunk of $.turn.step({ turnId: 'child', index: 0, model: 'test-model', messageCount: 1, agentId: 'x9' })) void chunk
  for await (const chunk of $.turn.step({ turnId: 'child', index: 1, model: 'test-model', messageCount: 1, agentId: 'x9' })) void chunk
  await $.turn.complete(completion)
  const stored = [...values.values()] as LedgerEntry[]
  expect(stored[0]?.rows['Plan|test-model']?.requests).toBe(2)
  expect(asked).toBe(1)
})

test('spend ledger records the model reported in usage over the step model', async ($, on) => {
  mockSession(on)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage: { ...usage, model: 'usage-model' }, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  const stored = [...values.values()] as LedgerEntry[]
  expect(Object.keys(stored[0]?.rows ?? {})).toEqual(['main|usage-model'])
})

test('spend ledger starts a second entry when a turn starts on the next day', async ($, on) => {
  const clock = mockSession(on)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  await clock.advance(DAY_MS)
  await $.turn.start({ text: 'next day', turnId: 't2' })
  for await (const chunk of $.turn.step({ turnId: 't2', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete({ ...completion, turnId: 't2' })
  const first = values.get(ledgerKey(dayOf(1000), 'sid-1')) as LedgerEntry
  const second = values.get(ledgerKey(dayOf(1000 + DAY_MS), 'sid-1')) as LedgerEntry
  expect(values.size).toBe(2)
  expect(first.rows['main|test-model']?.requests).toBe(1)
  expect(second.rows['main|test-model']?.requests).toBe(1)
})

test('spend ledger baselines the cost at session start', async ($, on) => {
  const counter = { usd: 4 }
  mockSession(on, {}, counter)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  counter.usd = 4.3
  await $.turn.complete(completion)
  const stored = [...values.values()] as LedgerEntry[]
  expect(Math.abs((stored[0]?.costUsd ?? 0) - 0.3)).toBeLessThan(1e-9)
})

test('spend ledger records the session cost of a single request', async ($, on) => {
  const counter = { usd: 0 }
  mockSession(on, {}, counter)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  counter.usd = 0.5
  await $.turn.complete(completion)
  const stored = [...values.values()] as LedgerEntry[]
  expect(stored).toHaveLength(1)
  expect(stored[0]?.costUsd).toBe(0.5)
})

test('spend ledger compaction interrupted before its deletes is not double counted and finishes on the next run', async () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const older = dayBefore(now, 3)
  const values = new Map<string, unknown>()
  values.set(ledgerKey(older, 's1'), sessionEntry(older, 's1', '/a', 10))
  values.set(ledgerKey(older, 's2'), sessionEntry(older, 's2', '/a', 20))
  const broken = fullFake(values, { usd: 0 }, [], { deletes: true })
  await compactLedger(broken, now, () => true)
  expect(values.has(compactedKey(older, '/a'))).toBe(true)
  expect(values.has(ledgerKey(older, 's1'))).toBe(true)
  const seen = await readLedger(broken, now, 7)
  expect(seen).toHaveLength(1)
  expect(seen[0]?.rows['main|m1']?.input).toBe(30)
  const report = buildSpendReport(seen, 'project', 7).split('\n')
  expect(report[1]).toContain('/a · 2 session(s)')
  expect(report[2]).toContain('Total · 2 session(s)')
  await compactLedger(fullFake(values, { usd: 0 }), now, () => true)
  expect(values.has(ledgerKey(older, 's1'))).toBe(false)
  expect(values.has(ledgerKey(older, 's2'))).toBe(false)
  const finished = values.get(compactedKey(older, '/a')) as LedgerEntry
  expect(finished.merged).toEqual(['s1', 's2'])
  expect(finished.rows['main|m1']?.input).toBe(30)
  expect(await readLedger(fullFake(values, { usd: 0 }), now, 7)).toHaveLength(1)
})

test('spend ledger prune and compaction stop before touching the store when time is out', async () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const values = new Map<string, unknown>()
  values.set(ledgerKey(dayBefore(now, 40), 'x'), sessionEntry(dayBefore(now, 40), 'x', '/a', 1))
  values.set(ledgerKey(dayBefore(now, 3), 's1'), sessionEntry(dayBefore(now, 3), 's1', '/a', 10))
  const before = JSON.stringify([...values.entries()])
  const fake = fullFake(values, { usd: 0 })
  await pruneLedger(fake, now, () => false)
  await compactLedger(fake, now, () => false)
  expect(JSON.stringify([...values.entries()])).toBe(before)
  await pruneLedger(fake, now, () => true)
  expect(values.has(ledgerKey(dayBefore(now, 40), 'x'))).toBe(false)
  expect(values.has(ledgerKey(dayBefore(now, 3), 's1'))).toBe(true)
})

test('spend ledger counts a session spanning two days once in the project view and in the total', () => {
  const entries = ledgerFixture()
  expect(aggregate(entries, 'project').find(row => row.label === '/work/a')?.sessions).toBe(1)
  expect(buildSpendReport(entries, 'project', 7)).toContain('Total · 2 session(s)')
})

test('spend ledger dates the project label from session.root, also after a subagent starts a new day', async ($, on) => {
  const clock = mockSession(on)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  await clock.advance(DAY_MS)
  await $.turn.start({ text: 'background', turnId: 'child', agentId: 'a1' })
  for await (const chunk of $.turn.step({ turnId: 'child', index: 0, model: 'test-model', messageCount: 1, agentId: 'a1' })) void chunk
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  const second = values.get(ledgerKey(dayOf(1000 + DAY_MS), 'sid-1')) as LedgerEntry
  expect(second.project).toBe('/work')
  expect(second.rows['subagent|test-model']?.requests).toBe(1)
})

test('spend ledger baselines the cost at the first step when no session start was seen', async ($, on) => {
  const counter = { usd: 4 }
  mockSession(on, {}, counter)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  counter.usd = 4.3
  for await (const chunk of $.turn.step({ turnId: 't1', index: 1, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  const stored = [...values.values()] as LedgerEntry[]
  expect(Math.abs((stored[0]?.costUsd ?? 0) - 0.3)).toBeLessThan(1e-9)
  expect(stored[0]?.rows['main|test-model']?.requests).toBe(2)
})

function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9)
}

function estOf(entry: LedgerEntry, key: string): number {
  return entry.rows[key]?.est ?? -1
}

test('prices use the longest prefix, the Haiku 5.5 tier and the cache write rates', () => {
  expect(priceFor('claude-opus-5-5', 0)).toEqual({ input: 4, output: 20, cacheRead: 0.2, write5m: 5, write1h: 8 })
  expect(priceFor('claude-opus-5', 0)).toEqual({ input: 5, output: 25, cacheRead: 0.5, write5m: 6.25, write1h: 10 })
  expect(priceFor('claude-opus-5-5-20261101', 0)).toEqual(priceFor('claude-opus-5-5', 0))
  expect(priceFor('claude-haiku-5-5', 100_000)).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, write5m: 0.125, write1h: 0.2 })
  expect(priceFor('claude-haiku-5-5', 100_001)).toEqual({ input: 0.5, output: 2.5, cacheRead: 0.05, write5m: 0.625, write1h: 1 })
  expect(priceFor('claude-haiku-4-5', 500_000)).toEqual({ input: 1, output: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 })
  expect(priceFor('some-other-model', 0)).toEqual({ input: 3, output: 15, cacheRead: 0.3, write5m: 3.75, write1h: 6 })
  expect(priceFor('claude-fable-5-2-x', 0).input).toBe(8)
  near(estimateUsd('claude-opus-5-5', { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 1_000_000, cacheWrite1h: 0 }), 5)
  near(estimateUsd('claude-opus-5-5', { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 1_000_000 }), 8)
})

test('addRequest accumulates the estimate with and without the cache write split', () => {
  const entry = newLedgerEntry(dayB, 's1', '/a', 0)
  addRequest(entry, 'main', 'claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 })
  near(estOf(entry, 'main|claude-opus-5-5'), 6)
  addRequest(entry, 'main', 'claude-opus-5-5', {
    input_tokens: 0,
    cache_creation_input_tokens: 2_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  })
  near(estOf(entry, 'main|claude-opus-5-5'), 19)
  addRequest(entry, 'main', 'claude-opus-5-5', { input_tokens: 0, cache_creation_input_tokens: 1_000_000 })
  near(estOf(entry, 'main|claude-opus-5-5'), 27)
  expect(entry.rows['main|claude-opus-5-5']?.cacheCreation).toBe(3_000_000)
})

test('approximate cost follows the list-price weight of each row and falls back when there is no real cost', () => {
  const priced = newLedgerEntry(dayB, 's1', '/a', 0)
  priced.costUsd = 1
  addRequest(priced, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  addRequest(priced, 'Explore', 'claude-haiku-5-5', { input_tokens: 1_000_000 })
  const byAgent = aggregate([priced], 'agent')
  const main = byAgent.find(row => row.label === 'main')?.approxUsd ?? -1
  const explore = byAgent.find(row => row.label === 'Explore')?.approxUsd ?? -1
  near(main, 8 / 8.5)
  near(explore, 0.5 / 8.5)
  near(main + explore, 1)
  const raw = newLedgerEntry(dayB, 's2', '/a', 0)
  addRequest(raw, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  near(aggregate([raw], 'model')[0]?.approxUsd ?? -1, 8)
  expect(aggregate([raw], 'model')[0]?.costUsd).toBe(null)
  const old = newLedgerEntry(dayB, 's3', '/a', 0)
  old.rows['main|claude-opus-5-5'] = { requests: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }
  near(aggregate([old], 'model')[0]?.approxUsd ?? -1, 4)
})

test('spend report marks estimated model and agent costs with an approximation sign', () => {
  const raw = newLedgerEntry(dayB, 's1', '/a', 0)
  addRequest(raw, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  expect(buildSpendReport([raw], 'agent', 7)).toContain('≈ USD 8.00')
  expect(buildSpendReport([raw], 'model', 7)).toContain('≈ USD 8.00')
  const real = { ...raw, costUsd: 1 }
  const project = buildSpendReport([real], 'project', 7)
  expect(project).toContain('USD 1.00')
  expect(project).not.toContain('≈')
})

test('tag from the environment is stored on a new entry, an invalid tag is ignored and a stored tag is kept', async ($, on) => {
  mockSession(on, { CLAUDE_CODEFLOW_TAG: 'proxy-on' })
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  expect((values.get(ledgerKey(dayOf(1000), 'sid-1')) as LedgerEntry).tag).toBe('proxy-on')
})

test('an invalid tag is ignored and a merged stored entry keeps its own tag', async ($, on) => {
  mockSession(on, { CLAUDE_CODEFLOW_TAG: 'bad tag!' })
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  const prior = newLedgerEntry(dayOf(1000), 'sid-1', '/work', 0)
  prior.tag = 'old'
  prior.costUsd = 0
  values.set(ledgerKey(dayOf(1000), 'sid-1'), prior)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  expect((values.get(ledgerKey(dayOf(1000), 'sid-1')) as LedgerEntry).tag).toBe('old')
})

test('tags aggregate separately and compaction keeps them apart', async () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const older = dayBefore(now, 3)
  const values = new Map<string, unknown>()
  const tagged = (id: string, tag: string | undefined) => {
    const entry = sessionEntry(older, id, '/a', 10)
    if (tag !== undefined) entry.tag = tag
    return entry
  }
  for (const entry of [tagged('s1', 'a'), tagged('s2', 'b'), tagged('s3', undefined)]) {
    values.set(ledgerKey(entry.day, entry.sessionId), entry)
  }
  const fake = fullFake(values, { usd: 0 })
  expect(aggregate([tagged('x', 'a'), tagged('y', 'a'), tagged('z', 'b')], 'tag').map(row => [row.label, row.sessions])).toEqual([['a', 2], ['b', 1]])
  await compactLedger(fake, now, () => true)
  expect(values.has(compactedKey(older, '/a', 'a'))).toBe(true)
  expect(values.has(compactedKey(older, '/a', 'b'))).toBe(true)
  expect(values.has(compactedKey(older, '/a', 'untagged'))).toBe(true)
  expect((values.get(compactedKey(older, '/a', 'a')) as LedgerEntry).tag).toBe('a')
  expect((values.get(compactedKey(older, '/a', 'untagged')) as LedgerEntry).tag).toBe(undefined)
})

test('startup context is recorded once from the first main request of a fresh session', async ($, on) => {
  mockSession(on, {}, { usd: 0 })
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    const used = e.agentId === undefined
      ? { model: 'test-model', input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 70, cache_creation_input_tokens: 5 }
      : { model: 'test-model', input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage: used, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 'child', agentId: 'a1' })
  for await (const chunk of $.turn.step({ turnId: 'child', index: 0, model: 'test-model', messageCount: 1, agentId: 'a1' })) void chunk
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  for await (const chunk of $.turn.step({ turnId: 't1', index: 1, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  const stored = [...values.values()] as LedgerEntry[]
  expect(stored[0]?.startup).toEqual({ sessions: 1, input: 175 })
})

test('startup context is not recorded when the session already cost money at start', async ($, on) => {
  mockSession(on, {}, { usd: 2 })
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  const stored = [...values.values()] as LedgerEntry[]
  expect(stored[0]?.startup).toBe(undefined)
})

test('startup context is summed by merge and by compaction', () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const older = dayBefore(now, 3)
  const a = sessionEntry(older, 's1', '/a', 10)
  a.startup = { sessions: 1, input: 100 }
  const b = sessionEntry(older, 's2', '/a', 10)
  b.startup = { sessions: 1, input: 300 }
  expect(mergeEntries(a, b).startup).toEqual({ sessions: 2, input: 400 })
  expect(mergeEntries(a, sessionEntry(older, 's3', '/a', 1)).startup).toEqual({ sessions: 1, input: 100 })
  const values = new Map<string, unknown>([[ledgerKey(older, 's1'), a], [ledgerKey(older, 's2'), b]])
  return compactLedger(fullFake(values, { usd: 0 }), now, () => true).then(() => {
    expect((values.get(compactedKey(older, '/a')) as LedgerEntry).startup).toEqual({ sessions: 2, input: 400 })
  })
})

test('compare report shows each column per tag, the total and the approximations', () => {
  const a = newLedgerEntry(dayB, 's1', '/x', 0)
  a.tag = 'a'
  a.costUsd = 1
  a.rows['main|m1'] = { requests: 2, input: 100, output: 10, cacheRead: 300, cacheCreation: 100 }
  a.startup = { sessions: 1, input: 400 }
  const b = newLedgerEntry(dayB, 's2', '/x', 0)
  b.tag = 'b'
  b.rows['main|m1'] = { requests: 1, input: 50, output: 5, cacheRead: 0, cacheCreation: 0 }
  const lines = buildCompareReport([a, b], 'tag', 7).split('\n')
  expect(lines[0]).toBe('Codeflow compare · last 7 day(s) · by tag')
  expect(lines[1]).toBe('a · 1 session(s) · 2 request(s) · input/request 250 · cache hit 60.0% · output/request 5 · startup context 400 · USD/request 0.50')
  expect(lines[2]).toBe('b · 1 session(s) · 1 request(s) · input/request 50 · cache hit 0.0% · output/request 5 · ≈ USD/request 0.0002')
  expect(lines[3]).toBe('Total · 2 session(s) · 3 request(s) · input/request 183 · cache hit 54.5% · output/request 5 · startup context 400 · USD/request 0.3333')
  expect(lines[2]).not.toContain('startup context')
  expect(buildCompareReport([], 'tag', 3)).toBe('Codeflow compare · no recorded requests in the last 3 day(s)')
  const byModel = buildCompareReport([a, b], 'model', 7).split('\n')
  expect(byModel[1]).not.toContain('session(s)')
})

test('compare command defaults to tag, takes a dimension and a day count, and rejects bad arguments', async ($, on) => {
  mockSession(on, { CLAUDE_CODEFLOW_TAG: 'proxy-on' })
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  const byTag = await $.command.run({ ...command, args: 'compare' })
  expect(byTag.text).toContain('Codeflow compare · last 7 day(s) · by tag')
  expect(byTag.text).toContain('proxy-on · 1 session(s) · 1 request(s)')
  const byModel = await $.command.run({ ...command, args: 'compare model 3' })
  expect(byModel.text).toContain('Codeflow compare · last 3 day(s) · by model')
  expect(byModel.text).toContain('test-model · 1 request(s)')
  const usageLine = 'Use /codeflow compare [project|day|model|agent|tag] [days].'
  for (const args of ['compare x', 'compare 0', 'compare model day', 'compare tag 3 4']) {
    expect((await $.command.run({ ...command, args })).text).toBe(usageLine)
  }
})

test('parseSpendArgs accepts tag and takes a fallback dimension', () => {
  expect(parseSpendArgs(['TAG'])).toEqual({ by: 'tag', days: 7 })
  expect(parseSpendArgs([], 'tag')).toEqual({ by: 'tag', days: 7 })
  expect(parseSpendArgs(['model'], 'tag')).toEqual({ by: 'model', days: 7 })
})

interface CaptureState {
  usd: number
  now: number
  rateLimits: unknown[]
  breakdown: unknown
  breakdownCalls: number
}

function captureState(overrides: Partial<CaptureState> = {}): CaptureState {
  return { usd: 0, now: 1000, rateLimits: [], breakdown: undefined, breakdownCalls: 0, ...overrides }
}

function captureFake(values: Map<string, unknown>, state: CaptureState): EngineInterface {
  return {
    clock: { now: async () => state.now },
    session: {
      id: async () => 'sid-1',
      root: async () => '/work',
      usage: async (args?: { breakdown?: string }) => {
        const detailed = args?.breakdown === 'summary'
        if (detailed) state.breakdownCalls += 1
        return {
          context: { tokens: 1, window: 2, percent: 1, ...(detailed ? { breakdown: state.breakdown } : {}) },
          rateLimits: state.rateLimits,
          cost: { usd: state.usd },
        }
      },
    },
    agent: { list: async () => [] },
    env: { get: async () => undefined },
    store: {
      keys: async () => [...values.keys()],
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, JSON.parse(JSON.stringify(value))) },
      delete: async (key: string) => { values.delete(key) },
    },
  } as unknown as EngineInterface
}

const breakdownA = {
  categories: [
    { name: 'System prompt', tokens: 3000, kind: 'used' },
    { name: 'System tools', tokens: 6000, kind: 'used' },
    { name: 'Messages', tokens: 1000, kind: 'used' },
    { name: 'Skills', tokens: 500, kind: 'free' },
  ],
  mcpTools: [
    { name: 'a', serverName: 'github', tokens: 100, isLoaded: true },
    { name: 'b', serverName: 'github', tokens: 200, isLoaded: true },
    { name: 'c', serverName: 'hidden', tokens: 900, isLoaded: false },
  ],
  memoryFiles: Array.from({ length: 11 }, (_, index) => ({ path: `/m/${index}.md`, type: 'project', tokens: 100 + index })),
  skills: { totalSkills: 4, includedSkills: 3, tokens: 400 },
  agents: [{ name: 'x', tokens: 50 }, { name: 'y', tokens: 70 }],
}

const breakdownB = {
  categories: [
    { name: 'System prompt', tokens: 1000, kind: 'used' },
    { name: 'Messages', tokens: 3000, kind: 'used' },
  ],
  mcpTools: [],
  memoryFiles: [],
  agents: [],
}

test('main-loop cache writes without a split are priced at the 1-hour rate and subagent writes at the 5-minute rate', () => {
  const main = newLedgerEntry(dayB, 's1', '/a', 0)
  addRequest(main, 'main', 'claude-opus-5-5', { input_tokens: 0, cache_creation_input_tokens: 1_000_000 })
  near(estOf(main, 'main|claude-opus-5-5'), 8)
  const child = newLedgerEntry(dayB, 's1', '/a', 0)
  addRequest(child, 'Explore', 'claude-opus-5-5', { input_tokens: 0, cache_creation_input_tokens: 1_000_000 }, false)
  near(estOf(child, 'Explore|claude-opus-5-5'), 5)
  const old = newLedgerEntry(dayB, 's2', '/a', 0)
  old.rows['main|claude-opus-5-5'] = { requests: 1, input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 }
  old.rows['Explore|claude-opus-5-5'] = { requests: 1, input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 }
  const byAgent = aggregate([old], 'agent')
  near(byAgent.find(row => row.label === 'main')?.approxUsd ?? -1, 8)
  near(byAgent.find(row => row.label === 'Explore')?.approxUsd ?? -1, 5)
})

test('plan windows are set, updated and replaced when resetsAt changes', async () => {
  const state = captureState({ rateLimits: [{ kind: 'seven_day', percentUsed: 2, resetsAt: 'R1' }] })
  const values = new Map<string, unknown>()
  const fake = captureFake(values, state)
  const spend = newSpendSession()
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10 })
  await flushSpend(spend, fake)
  expect(spend.entry?.plan).toEqual({ seven_day: { from: 2, to: 2, resetsAt: 'R1' } })
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10 })
  state.rateLimits = [{ kind: 'seven_day', percentUsed: 5, resetsAt: 'R1' }]
  await flushSpend(spend, fake)
  expect(spend.entry?.plan).toEqual({ seven_day: { from: 2, to: 5, resetsAt: 'R1' } })
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10 })
  state.rateLimits = [{ kind: 'seven_day', percentUsed: 1, resetsAt: 'R2' }]
  await flushSpend(spend, fake)
  expect(spend.entry?.plan).toEqual({ seven_day: { from: 1, to: 1, resetsAt: 'R2' } })
})

test('plan windows merge by resetsAt and compaction keeps them', () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const older = dayBefore(now, 3)
  const a = sessionEntry(older, 's1', '/a', 1)
  a.plan = { seven_day: { from: 2, to: 5, resetsAt: 'R1' } }
  a.mix = { Messages: 10 }
  const b = sessionEntry(older, 's2', '/a', 1)
  b.plan = { seven_day: { from: 3, to: 9, resetsAt: 'R1' } }
  b.mix = { Messages: 5, 'System prompt': 2 }
  expect(mergeEntries(a, b).plan).toEqual({ seven_day: { from: 2, to: 9, resetsAt: 'R1' } })
  expect(mergeEntries(a, b).mix).toEqual({ Messages: 15, 'System prompt': 2 })
  const c = sessionEntry(older, 's3', '/a', 1)
  c.plan = { seven_day: { from: 1, to: 1, resetsAt: 'R2' } }
  expect(mergeEntries(a, c).plan).toEqual({ seven_day: { from: 1, to: 1, resetsAt: 'R2' } })
  const values = new Map<string, unknown>([[ledgerKey(older, 's1'), a], [ledgerKey(older, 's2'), b]])
  return compactLedger(captureFake(values, captureState()), now, () => true).then(() => {
    const compacted = values.get(compactedKey(older, '/a')) as LedgerEntry
    expect(compacted.plan).toEqual({ seven_day: { from: 2, to: 9, resetsAt: 'R1' } })
    expect(compacted.mix).toEqual({ Messages: 15, 'System prompt': 2 })
  })
})

test('context mix attributes main-loop input to each category by its share of the snapshot and resets the counter', async () => {
  const state = captureState({ breakdown: breakdownA })
  const values = new Map<string, unknown>()
  const fake = captureFake(values, state)
  const spend = newSpendSession()
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 1000 })
  await flushSpend(spend, fake)
  expect(spend.entry?.mix).toMatchObject({ Messages: 100, 'System prompt': 300, 'System tools': 600 })
  state.breakdown = breakdownB
  state.now += 600_000
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 2000 })
  await flushSpend(spend, fake)
  const mix = spend.entry?.mix ?? {}
  near(mix.Messages ?? -1, 1600)
  near(mix['System prompt'] ?? -1, 800)
  near(mix['System tools'] ?? -1, 600)
  expect(spend.mainInputSince).toBe(0)
})

test('snapshot cadence: first flush, not again within five minutes, no breakdown at session end, day change is plain', async () => {
  const state = captureState({ breakdown: breakdownA })
  const values = new Map<string, unknown>()
  const fake = captureFake(values, state)
  const spend = newSpendSession()
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10 })
  await flushSpend(spend, fake)
  expect(state.breakdownCalls).toBe(1)
  state.now += 60_000
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10 })
  await flushSpend(spend, fake)
  expect(state.breakdownCalls).toBe(1)
  state.now += 600_000
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10 })
  await flushSpend(spend, fake)
  expect(state.breakdownCalls).toBe(2)
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 30 })
  await endSpendSession(spend, fake)
  expect(state.breakdownCalls).toBe(2)
  expect(spend.mainInputSince).toBe(0)
  expect(spend.entry).toBe(null)
  const stored = values.get(ledgerKey(dayOf(state.now), 'sid-1')) as LedgerEntry
  expect(stored.mix).toMatchObject({ Messages: 6, 'System prompt': 18, 'System tools': 36 })
  const dayChange = newSpendSession()
  const clock = captureState({ breakdown: breakdownA })
  const days = captureFake(new Map<string, unknown>(), clock)
  await recordStep(dayChange, days, '/work', { model: 'm1' }, { input_tokens: 10 })
  clock.now += 86_400_000 + 600_000
  await recordStep(dayChange, days, '/work', { model: 'm1' }, { input_tokens: 10 })
  expect(clock.breakdownCalls).toBe(0)
})
test('per-project snapshot keeps loaded MCP tools and the top ten memory files, and old snapshots are pruned', async () => {
  const state = captureState({ breakdown: breakdownA })
  const values = new Map<string, unknown>()
  const fake = captureFake(values, state)
  const spend = newSpendSession()
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10 })
  await flushSpend(spend, fake)
  const snapshot = values.get(contextKey('/work')) as ContextSnapshot
  expect(isContextSnapshot(snapshot)).toBe(true)
  expect(snapshot.mcpServers).toEqual([['github', 300]])
  expect(snapshot.memoryFiles).toHaveLength(10)
  expect(snapshot.memoryFiles[0]).toEqual(['/m/10.md', 110])
  expect(snapshot.skills).toEqual({ count: 3, tokens: 400 })
  expect(snapshot.agents).toEqual({ count: 2, tokens: 120 })
  expect(snapshot.categories).toEqual([['System prompt', 3000], ['System tools', 6000], ['Messages', 1000]])
  const now = Date.UTC(2026, 10, 23, 12)
  values.set(contextKey('/old'), { ...snapshot, project: '/old', atMs: now - 40 * DAY_MS })
  values.set(contextKey('/fresh'), { ...snapshot, project: '/fresh', atMs: now })
  await pruneLedger(fake, now, () => true)
  expect(values.has(contextKey('/old'))).toBe(false)
  expect(values.has(contextKey('/fresh'))).toBe(true)
})

const WHY_NOW = Date.UTC(2026, 10, 23, 12)

const whyFixtureSnapshot: ContextSnapshot = {
  version: 1,
  project: '/w',
  atMs: 1,
  model: 'claude-fable-5-2',
  categories: [['System prompt', 3000], ['System tools', 6000], ['Messages', 1000]],
  mcpServers: [['github', 300]],
  memoryFiles: [['/m/CLAUDE.md', 110]],
  skills: { count: 3, tokens: 400 },
  agents: { count: 2, tokens: 120 },
}

function whyFixture(): { entries: LedgerEntry[] } {
  const first = newLedgerEntry(dayB, 's1', '/w', 1)
  first.costUsd = 2
  addRequest(first, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  addRequest(first, 'Explore', 'claude-haiku-5-5', { input_tokens: 1_000_000 })
  first.plan = { seven_day: { from: 0, to: 2, resetsAt: 'R' }, five_hour: { from: 10, to: 12 } }
  first.mix = { Messages: 300, 'System prompt': 100 }
  const second = newLedgerEntry(dayB, 's2', '/w', 2)
  second.costUsd = 2
  addRequest(second, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  second.plan = { seven_day: { from: 2, to: 10, resetsAt: 'R' } }
  second.mix = { Messages: 600 }
  return { entries: [first, second] }
}

test('why report prints every line with the calibrated plan share and the delegation numbers', () => {
  const { entries } = whyFixture()
  const lines = buildWhyReport(entries, [whyFixtureSnapshot], entries, 1, WHY_NOW).split('\n')
  expect(lines).toEqual([
    'Codeflow why · last 1 day(s)',
    'Spent USD 4.00 · ≈ 10.0% of the 7-day plan window (1% ≈ USD 0.40, measured on this machine) · 7-day window at 10% · 5-hour window at 12%',
    'By agent: main 97% (≈ USD 3.8824) · Explore 3% (≈ USD 0.1176)',
    'Main-loop context: Messages 90% · System prompt 10% (share of main-loop input tokens)',
    'Largest fixed items: System tools 6,000 tok · System prompt 3,000 tok · Skills listing (3) 400 tok · MCP github 300 tok · Custom agents (2) 120 tok · fixed context 9,000 tok per request',
    'Delegation: subagents ≈ USD 0.1176 (3% of spend); the same tokens on claude-fable-5-2 ≈ USD 1.8824',
  ])
})

test('why report says when the plan share is not measured and estimates the spend without real cost', () => {
  const { entries } = whyFixture()
  const thin = entries.map(entry => ({ ...entry, plan: entry.plan?.five_hour ? { seven_day: { from: 5, to: 5.5, resetsAt: 'R' } } : undefined }))
  expect(buildWhyReport(entries, [], thin, 1, WHY_NOW)).toContain('Spent USD 4.00 · plan share not measured yet · 7-day window at 5.5%')
  const noPlan = entries.map(entry => ({ ...entry, plan: undefined }))
  expect(buildWhyReport(noPlan, [], noPlan, 1, WHY_NOW).split('\n')[1]).toBe('Spent USD 4.00 · plan share not measured yet')
  const estimated = newLedgerEntry(dayB, 's3', '/w', 1)
  addRequest(estimated, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  expect(buildWhyReport([estimated], [], [estimated], 1, WHY_NOW).split('\n')[1]).toBe('Spent ≈ USD 8.00 · plan share not measured yet')
})

test('why report omits the snapshot and mix lines when there is nothing to say, and names the no-subagent case', () => {
  const { entries } = whyFixture()
  const mainOnly = entries.map(entry => ({ ...entry, rows: { 'main|claude-fable-5-2': entry.rows['main|claude-fable-5-2'] ?? { requests: 1, input: 1, output: 0, cacheRead: 0, cacheCreation: 0 } }, mix: undefined }))
  const lines = buildWhyReport(mainOnly, [], mainOnly, 1, WHY_NOW).split('\n')
  expect(lines.some(line => line.startsWith('Largest fixed items'))).toBe(false)
  expect(lines.some(line => line.startsWith('Main-loop context'))).toBe(false)
  expect(lines.some(line => line.startsWith('By agent: main'))).toBe(true)
  expect(lines.at(-1)).toBe('Delegation: no subagent requests')
  expect(buildWhyReport([], [], [], 3, WHY_NOW)).toBe('Codeflow why · no recorded requests in the last 3 day(s)')
})

test('why command accepts no argument or a day count and rejects anything else', async ($, on) => {
  mockSession(on)
  const values = new Map<string, unknown>()
  storeMock(on, values)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', stopReason: 'end_turn', usage, toolUses: [] }
  })
  await $.session.start(start)
  await $.turn.start({ text: 'query', turnId: 't1' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })) void chunk
  await $.turn.complete(completion)
  const today = await $.command.run({ ...command, args: 'why' })
  expect(today.text).toContain('Codeflow why · last 1 day(s)')
  expect(today.text).toContain('Spent USD')
  const week = await $.command.run({ ...command, args: 'why 7' })
  expect(week.text).toContain('Codeflow why · last 7 day(s)')
  for (const args of ['why x', 'why 0', 'why 3 4', 'why model']) {
    expect((await $.command.run({ ...command, args })).text).toBe('Use /codeflow why [days].')
  }
})

test('snapshots are capped at the twenty most recent per run of pruning', async () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const values = new Map<string, unknown>()
  const base = await captureSnapshotSeed()
  for (let index = 0; index < 25; index += 1) {
    values.set(contextKey('p' + index), { ...base, project: 'p' + index, atMs: now - index * 60_000 })
  }
  await pruneLedger(captureFake(values, captureState()), now, () => true)
  const kept = [...values.keys()].filter(key => key.startsWith('codeflow:context:v1:')).sort()
  expect(kept).toHaveLength(20)
  expect(values.has(contextKey('p19'))).toBe(true)
  expect(values.has(contextKey('p20'))).toBe(false)
})

async function captureSnapshotSeed(): Promise<ContextSnapshot> {
  const state = captureState({ breakdown: breakdownA })
  const values = new Map<string, unknown>()
  const fake = captureFake(values, state)
  const spend = newSpendSession()
  await recordStep(spend, fake, '/work', { model: 'm1' }, { input_tokens: 10 })
  await flushSpend(spend, fake)
  return values.get(contextKey('/work')) as ContextSnapshot
}

test('a plan window whose resetsAt has passed is neither printed nor used for the share', () => {
  const entry = newLedgerEntry(dayB, 's1', '/w', 1)
  entry.costUsd = 2
  addRequest(entry, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  entry.plan = { seven_day: { from: 0, to: 4, resetsAt: '2020-01-01T00:00:00.000Z' } }
  const stale = buildWhyReport([entry], [], [entry], 1, WHY_NOW).split('\n')[1] ?? ''
  expect(stale).toBe('Spent USD 2.00 · plan share not measured yet')
  entry.plan = { seven_day: { from: 0, to: 4, resetsAt: '2099-01-01T00:00:00.000Z' } }
  const current = buildWhyReport([entry], [], [entry], 1, WHY_NOW).split('\n')[1] ?? ''
  expect(current).toBe('Spent USD 2.00 · ≈ 4.0% of the 7-day plan window (1% ≈ USD 0.50, measured on this machine) · 7-day window at 4%')
})

test('a real cost of zero counts as unknown for apportioning and falls back to the estimates', () => {
  const entry = newLedgerEntry(dayB, 's1', '/a', 1)
  entry.costUsd = 0
  addRequest(entry, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  addRequest(entry, 'Explore', 'claude-haiku-5-5', { input_tokens: 1_000_000 })
  const byAgent = aggregate([entry], 'agent')
  near(byAgent.find(row => row.label === 'main')?.approxUsd ?? -1, 8)
  near(byAgent.find(row => row.label === 'Explore')?.approxUsd ?? -1, 0.5)
})

test('an old-format folded key is read so its sessions are not folded again, and each session counts once', async () => {
  const now = Date.UTC(2026, 10, 23, 12)
  const older = dayBefore(now, 3)
  const legacy = { ...newLedgerEntry(older, '~', '/a', now), merged: ['s1'] }
  addRequest(legacy, 'main', 'm1', { input_tokens: 10 })
  const values = new Map<string, unknown>([
    [legacyCompactedKey(older, '/a'), legacy],
    [ledgerKey(older, 's1'), sessionEntry(older, 's1', '/a', 10)],
    [ledgerKey(older, 's2'), sessionEntry(older, 's2', '/a', 20)],
  ])
  const fake = captureFake(values, captureState())
  const between = await readLedger(fake, now, 7)
  expect(between).toHaveLength(2)
  expect(buildSpendReport(between, 'project', 7)).toContain('Total · 2 session(s)')
  await compactLedger(fake, now, () => true)
  const folded = values.get(compactedKey(older, '/a')) as LedgerEntry
  expect(folded.merged).toEqual(['s2'])
  expect(folded.rows['main|m1']?.input).toBe(20)
  expect(values.has(ledgerKey(older, 's1'))).toBe(false)
  expect(values.has(ledgerKey(older, 's2'))).toBe(false)
  const after = await readLedger(fake, now, 7)
  expect(after).toHaveLength(2)
  expect(buildSpendReport(after, 'project', 7)).toContain('Total · 2 session(s)')
})

test('fixed items come from the highest-spend project that has a snapshot', () => {
  const big = newLedgerEntry(dayB, 's1', '/big', 1)
  big.costUsd = 10
  addRequest(big, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  const small = newLedgerEntry(dayB, 's2', '/small', 1)
  small.costUsd = 1
  addRequest(small, 'main', 'claude-fable-5-2', { input_tokens: 1_000_000 })
  const snapshot = { ...whyFixtureSnapshot, project: '/small' }
  const lines = buildWhyReport([big, small], [snapshot], [big, small], 1, WHY_NOW).split('\n')
  const fixed = lines.find(line => line.startsWith('Largest fixed items')) ?? ''
  expect(fixed).toContain('MCP github 300 tok')
  expect(fixed).toContain('fixed context 9,000 tok per request')
  expect(buildWhyReport([big], [], [big], 1, WHY_NOW)).not.toContain('Largest fixed items')
})

test('subagent cache writes are repriced at the main model 1-hour rate in the delegation line', () => {
  const entry = newLedgerEntry(dayB, 's1', '/a', 1)
  addRequest(entry, 'main', 'claude-fable-5-5', { input_tokens: 1_000_000 })
  addRequest(entry, 'Explore', 'claude-haiku-5-5', { input_tokens: 0, cache_creation_input_tokens: 1_000_000 }, false)
  const delegation = buildWhyReport([entry], [], [entry], 1, WHY_NOW).split('\n').at(-1) ?? ''
  expect(delegation).toBe('Delegation: subagents ≈ USD 0.625 (6% of spend); the same tokens on claude-fable-5-5 ≈ USD 20.00')
})
