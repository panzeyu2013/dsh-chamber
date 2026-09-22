/**
 * I10 归因账本锁：每次应用内会话创建（含 blank）
 * 必须带触发路径标签，账本按来源与标签聚合，且**无标签外来源**（unknown = 0）是验收
 * 判据的第二半。纯函数 + 源文本锁，node 直跑。
 *
 * Run directly: node test/session-state/session-create-ledger.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SESSION_CREATION_ORIGINS,
  createSessionCreationLedger,
  publishSessionCreationInstrument,
} from '../../src/shared/session-create-ledger.ts'
import type { SessionCreationOrigin } from '../../src/shared/session-create-ledger.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const MUTATIONS = read('../../src/shared/session-mutations.ts')
const BRIDGE = read('../../src/shared/aggregate-store.ts')
// The sidebar create call site moves with its hook; the
// contract reads the shell plus the modules that own the locked text.
const SIDEBAR = read('../../src/client/SidebarRoot.tsx') + read('../../src/client/sidebar-root-sessions.ts')
const GIT = read('../../../dsh-chamber-client-ui-git/src/shared/coordinator.ts')

function entry(sourceId: string, origin: SessionCreationOrigin, blank = true) {
  return { sourceId, sessionId: 's-' + Math.random().toString(36).slice(2, 6), blank, origin, at: 1 }
}

test('the ledger aggregates per source and per origin, and counts blanks by label', () => {
  const ledger = createSessionCreationLedger()
  ledger.record(entry('a', 'user'))
  ledger.record(entry('a', 'user'))
  ledger.record(entry('a', 'boot-handoff'))
  ledger.record(entry('b', 'user', false))
  const counters = ledger.counters()
  assert.equal(counters.a.total, 3)
  assert.equal(counters.a.blank, 3)
  assert.equal(counters.a.byOrigin.user, 2)
  assert.equal(counters.a.byOrigin['boot-handoff'], 1)
  assert.equal(counters.b.total, 1)
  assert.equal(counters.b.blank, 0, 'a fork child is not a blank row')
  assert.deepEqual(ledger.blankByOrigin(), { 'boot-handoff': 1, 'boot-fallback': 0, prewarm: 0, user: 2, unknown: 0 })
  assert.equal(ledger.unlabeled(), 0)
})

test('unlabeled creations are visible (the instrument coverage half of the criterion)', () => {
  const ledger = createSessionCreationLedger()
  ledger.record(entry('a', 'unknown'))
  ledger.record(entry('a', 'user'))
  assert.equal(ledger.unlabeled(), 1)
  assert.equal(ledger.blankByOrigin().unknown, 1)
})

test('the ledger is bounded and its snapshot is a copy', () => {
  const ledger = createSessionCreationLedger({ limit: 3 })
  for (let i = 0; i < 5; i++) ledger.record(entry('a', 'user'))
  assert.equal(ledger.entries().length, 3)
  assert.equal(ledger.counters().a.total, 5, 'counters count every creation even when entries evict')
  const snapshot = ledger.counters()
  snapshot.a.total = 999
  assert.equal(ledger.counters().a.total, 5, 'callers cannot mutate the ledger through the snapshot')
})

test('the instrument publishes once and stays a live view (functions, not a snapshot)', () => {
  const host: Record<string, unknown> = {}
  publishSessionCreationInstrument(host)
  const first = host.__dshChamberSessionCreates
  publishSessionCreationInstrument(host)
  assert.equal(host.__dshChamberSessionCreates, first, 'idempotent')
  const instrument = first as { counters(): unknown; unlabeled(): number }
  assert.equal(typeof instrument.counters, 'function')
  assert.equal(typeof instrument.unlabeled(), 'number')
})

test('every create call site declares an origin, and the bridge records with the fact default', () => {
  // 调用点必须表态（用户点「+」/worktree saga 都是 user；boot/预热留给 App 层）。
  assert.match(SIDEBAR, /createSessionForSource\(server\.id, workspaceId, \{ origin: 'user' \}\)/)
  assert.equal((GIT.match(/origin: 'user'/g) ?? []).length, 5, 'every worktree create site is labelled')
  // 桥在**没有订阅者**时也记账：I10 的账本不是渲染的副产物。
  assert.match(BRIDGE, /sessionCreationLedger\.record\(\{/)
  assert.match(BRIDGE, /publishSessionCreationInstrument\(\)/)
  // 契约类型与默认值。
  // 标签是加法字段：未表态的调用方不发该键。
  assert.equal((MUTATIONS.match(/options\.origin === undefined \? \{\} : \{ origin: options\.origin \}/g) ?? []).length, 2)
  assert.doesNotMatch(MUTATIONS, /origin: options\.origin \?\? 'unknown'/)
  assert.deepEqual([...SESSION_CREATION_ORIGINS], ['boot-handoff', 'boot-fallback', 'prewarm', 'user', 'unknown'])
})
