/**
 * 生产端锁（能力一览）：侧栏消费 `server.sessionFacts`（四级文案级联 +
 * `data-chamber-facts-mode`），桌面侧必须把它投影到聚合条目上，否则属性恒为
 * undefined、能力说明永不出现。本用例既锁映射语义（含"陈旧不得说成 full"、
 * "无快照不得臆造 full"），也锁**跨包词汇一致**。
 *
 * Run directly: node test/session-state/session-facts-mode.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sourceSessionFactsMode } from '../../src/session-facts-mode.ts'

const APP = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')
const SIDEBAR = readFileSync(
  fileURLToPath(new URL('../../../dsh-chamber-client-ui-sidebar/src/shared/aggregate-store.ts', import.meta.url)),
  'utf8',
)

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'ok', degradation: null, mode: 'sse', hostState: 'ready',
    serviceable: true, stale: false, cursor: 1, rows: {}, read: null, lastEventAt: 1,
    ...overrides,
  } as never
}

test('the mapping covers the four sidebar modes and never invents a mode', () => {
  assert.equal(sourceSessionFactsMode(undefined), undefined, '无快照 ⇒ 未知，不臆造 full')
  assert.equal(sourceSessionFactsMode(snapshot()), 'full')
  assert.equal(sourceSessionFactsMode(snapshot({ degradation: 'unavailable' })), 'degraded')
  assert.equal(sourceSessionFactsMode(snapshot({ verdict: 'degraded' })), 'degraded')
  assert.equal(sourceSessionFactsMode(snapshot({ verdict: 'legacy-gateway', degradation: 'legacy-gateway' })), 'legacy')
  assert.equal(sourceSessionFactsMode(snapshot({ verdict: 'degraded', degradation: 'watcher-disabled' })), 'disabled')
})

test('stale or unserviceable facts can never be reported as full', () => {
  assert.equal(sourceSessionFactsMode(snapshot({ stale: true })), 'degraded', '流断/静默/断连 ⇒ 受限')
  assert.equal(sourceSessionFactsMode(snapshot({ serviceable: false })), 'degraded', '不可服务 ⇒ 受限')
  // 关掉观察者的优先级高于 legacy：那台网关明确没有这条能力。
  assert.equal(sourceSessionFactsMode(snapshot({ verdict: 'legacy-gateway', degradation: 'watcher-disabled' })), 'disabled')
})

test('the App projects the mode onto every aggregate entry, after the entry literal', () => {
  assert.match(APP, /const factsMode = sourceSessionFactsMode\(sessionFacts\[id\]\)\n\s*if \(factsMode !== undefined\) entry\.sessionFacts = factsMode/)
  // 位置纪律：赋值必须在 entry 字面量之后（TDZ），且在 push 帮助函数内（local/远端/网关全覆盖）。
  const entryLiteral = APP.indexOf('const entry: ChamberServerAggregate = {')
  const assignment = APP.indexOf('entry.sessionFacts = factsMode')
  assert.ok(entryLiteral > 0 && assignment > entryLiteral, 'assignment must come after the entry literal')
})

test('the two packages agree on the mode vocabulary (cross-package lock)', () => {
  const sidebarUnion = (SIDEBAR.match(/export type SourceSessionFactsMode = ([^\n]+)/) ?? [])[1] ?? ''
  const rendererUnion = readFileSync(
    fileURLToPath(new URL('../../src/session-facts-mode.ts', import.meta.url)),
    'utf8',
  )
  const modes = (text: string): string[] => (text.match(/'([a-z]+)'/g) ?? []).map(m => m.replace(/'/g, ''))
  assert.deepEqual(
    modes(rendererUnion).slice(0, 4).sort(),
    modes(sidebarUnion).sort(),
    'renderer 的结构性联合必须与侧栏联合逐个相同（改名即红）',
  )
})
