/**
 * panel-axis 单测：页面级面板轴（N-ctx 多实例）的发布/退役纪律——同内容静默、空数组作为
 * 「已挂载但无面板注册」的合法事实、冻结条目与稳定快照引用、监听隔离；以及「切到目标来源后
 * 由目标壳自己执行 selectPanel」的一次性意图——同步送达、每来源一条、TTL（注入单调钟）、
 * 消费即清、retire 保留在飞意图（TTL 兜底）、reset seam。末尾的源码文本锁钉住页面本地性（不落盘/无 DOM/
 * 无定时器/无 wire）。
 */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  PANEL_SELECT_INTENT_TTL_MS,
  __resetPanelAxisForTests,
  consumePanelSelect,
  getPanelAxesSnapshot,
  onPanelSelectRequest,
  publishPanelAxis,
  requestPanelSelect,
  retirePanelAxis,
  subscribePanelAxes,
  type PagePanelAxisEntry,
} from '../src/panel-axis.ts'

const schedules: PagePanelAxisEntry = { id: 'schedules', order: 10, label: '自动化任务' }

beforeEach(() => { __resetPanelAxisForTests() })

test('the initial page state is an empty, frozen record with a stable identity', () => {
  const initial = getPanelAxesSnapshot()
  assert.deepEqual(initial, {})
  assert.equal(Object.isFrozen(initial), true, 'a reader must not be able to write the shared empty state')
  assert.equal(getPanelAxesSnapshot(), initial, 'no change = the same reference')
})

test('publish: freezes the entry array and every entry (the snapshot never alias the publisher)', () => {
  const entries: PagePanelAxisEntry[] = [schedules]
  publishPanelAxis('ssh-a', entries)
  const snapshot = getPanelAxesSnapshot()
  assert.deepEqual(snapshot['ssh-a'], [schedules])
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot['ssh-a']), true)
  assert.equal(Object.isFrozen(snapshot['ssh-a'][0]), true, 'each entry is frozen too')
  // The publisher keeps its own mutable array: rewriting it must not cross the shared snapshot.
  entries.push({ id: 'extra', order: 20, label: 'X' })
  assert.deepEqual(snapshot['ssh-a'], [schedules], 'the shared snapshot is a frozen copy, not the caller array')
})

test('publish: identical content is silent (no notify, no snapshot swap)', () => {
  publishPanelAxis('ssh-a', [schedules])
  const before = getPanelAxesSnapshot()
  let calls = 0
  const off = subscribePanelAxes(() => { calls += 1 })
  // A brand-new array/entries with the SAME field values: the sidebar recomputes on every locale change.
  publishPanelAxis('ssh-a', [{ id: 'schedules', order: 10, label: '自动化任务' }])
  assert.equal(calls, 0, 'field-equal content must not wake the readers')
  assert.equal(getPanelAxesSnapshot(), before, 'no snapshot swap on a no-op publish')
  off()
})

test('publish: a content change rebuilds the snapshot and notifies once', () => {
  publishPanelAxis('ssh-a', [schedules])
  const before = getPanelAxesSnapshot()
  let calls = 0
  const off = subscribePanelAxes(() => { calls += 1 })
  publishPanelAxis('ssh-a', [{ ...schedules, label: 'Automation tasks' }])
  assert.equal(calls, 1)
  assert.notEqual(getPanelAxesSnapshot(), before)
  assert.deepEqual(getPanelAxesSnapshot()['ssh-a'], [{ id: 'schedules', order: 10, label: 'Automation tasks' }])
  off()
})

test('publish: an empty array is a real fact — mounted with no panel registrations keeps the key', () => {
  publishPanelAxis('ssh-a', [])
  const snapshot = getPanelAxesSnapshot()
  assert.equal(Object.hasOwn(snapshot, 'ssh-a'), true, 'the key means "this source reported", not "has panels"')
  assert.deepEqual(snapshot['ssh-a'], [])
  assert.equal(Object.isFrozen(snapshot['ssh-a']), true)
})

test('snapshot: every source keeps its own axis and source leave drops only its own key', () => {
  publishPanelAxis('local', [schedules])
  publishPanelAxis('ssh-b', [])
  assert.deepEqual(Object.keys(getPanelAxesSnapshot()).sort(), ['local', 'ssh-b'])
  retirePanelAxis('local')
  assert.deepEqual(Object.keys(getPanelAxesSnapshot()), ['ssh-b'])
})

test('retire: drops only the axis; an in-flight intent survives for the next mount (TTL-bounded)', () => {
  let calls = 0
  const off = subscribePanelAxes(() => { calls += 1 })
  retirePanelAxis('ssh-a')
  assert.equal(calls, 0, 'an unknown source is a silent no-op')

  publishPanelAxis('ssh-a', [schedules])
  assert.equal(calls, 1)
  // A click (arm) followed by the old shell's asynchronous teardown must NOT lose the
  // intent: the target's next boot consumes it. Retirement therefore keeps pending.
  requestPanelSelect({ sourceId: 'ssh-a', panelId: 'schedules' }, 1_000)
  retirePanelAxis('ssh-a')
  assert.equal(calls, 2)
  assert.deepEqual(getPanelAxesSnapshot(), {})
  assert.deepEqual(consumePanelSelect('ssh-a', 1_001), { panelId: 'schedules', at: 1_000 },
    'the in-flight intent survives the old generation teardown (new mount consumes it, original at preserved)')
  assert.equal(consumePanelSelect('ssh-a', 1_001), undefined, 'consumed once')
  // It is still bounded by the TTL: a stale survival cannot fire on a much later mount.
  requestPanelSelect({ sourceId: 'ssh-b', panelId: 'schedules' }, 1_000)
  retirePanelAxis('ssh-b')
  assert.equal(consumePanelSelect('ssh-b', 1_000 + PANEL_SELECT_INTENT_TTL_MS + 1), undefined,
    'retire does not extend the intent lifetime')
  retirePanelAxis('ssh-a')
  assert.equal(calls, 2, 'a second retire changes nothing')
  off()
})

test('subscribe: one throwing axis listener cannot break the others or the publisher', () => {
  const originalError = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    const order: string[] = []
    const offThrow = subscribePanelAxes(() => {
      order.push('throw')
      throw new Error('axis boom')
    })
    const offAfter = subscribePanelAxes(() => { order.push('after') })
    assert.doesNotThrow(
      () => publishPanelAxis('ssh-a', [schedules]),
      'a bad listener must never propagate to the publisher',
    )
    assert.deepEqual(order, ['throw', 'after'], 'every remaining listener still runs')
    assert.equal(logged.length, 1, 'the isolated listener error is reported, not silently swallowed')
    assert.match(String(logged[0][0]), /\[dsh-chamber\] panel-axis subscriber threw:/)
    offThrow()
    offAfter()
  } finally {
    console.error = originalError
  }
})

test('subscribe: the returned unsubscribe is idempotent and stops notifications', () => {
  let calls = 0
  const off = subscribePanelAxes(() => { calls += 1 })
  publishPanelAxis('ssh-a', [schedules])
  assert.equal(calls, 1)
  off()
  off()
  publishPanelAxis('ssh-a', [{ ...schedules, order: 11 }])
  assert.equal(calls, 1, 'no notification after unsubscribe')
})

test('requestPanelSelect: stores one pending per source and delivers synchronously to select listeners', () => {
  const seen: string[] = []
  const offFirst = onPanelSelectRequest(request => { seen.push('first:' + request.sourceId + '/' + request.panelId) })
  const offSecond = onPanelSelectRequest(request => { seen.push('second:' + request.sourceId + '/' + request.panelId) })
  requestPanelSelect({ sourceId: 'ssh-b', panelId: 'schedules' }, 5_000)
  assert.deepEqual(seen, ['first:ssh-b/schedules', 'second:ssh-b/schedules'], 'delivered synchronously, no microtask hop')
  offFirst()
  offFirst()
  requestPanelSelect({ sourceId: 'ssh-a', panelId: 'schedules' }, 5_001)
  assert.deepEqual(seen.slice(2), ['second:ssh-a/schedules'], 'unsubscribe is idempotent and per-listener')
  offSecond()
})

test('requestPanelSelect: a throwing select listener cannot block the next one', () => {
  const originalError = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    const seen: string[] = []
    const offThrow = onPanelSelectRequest(() => { throw new Error('select boom') })
    const offOk = onPanelSelectRequest(request => { seen.push(request.panelId) })
    assert.doesNotThrow(() => requestPanelSelect({ sourceId: 'ssh-a', panelId: 'schedules' }, 1))
    assert.deepEqual(seen, ['schedules'], 'the request still reaches the target shell')
    assert.equal(logged.length, 1)
    assert.match(String(logged[0][0]), /\[dsh-chamber\] panel-select subscriber threw:/)
    offThrow()
    offOk()
  } finally {
    console.error = originalError
  }
})

test('pending: one intent per source — a newer request replaces the older one, sources stay independent', () => {
  requestPanelSelect({ sourceId: 'ssh-a', panelId: 'old' }, 1_000)
  requestPanelSelect({ sourceId: 'ssh-b', panelId: 'b-panel' }, 1_100)
  requestPanelSelect({ sourceId: 'ssh-a', panelId: 'new' }, 1_200)
  assert.deepEqual(consumePanelSelect('ssh-a', 1_200), { panelId: 'new', at: 1_200 }, 'the newer intent wins')
  assert.deepEqual(consumePanelSelect('ssh-b', 1_200), { panelId: 'b-panel', at: 1_100 }, 'another source keeps its own pending')
  assert.equal(consumePanelSelect('ssh-b', 1_200), undefined)
})

test('consumePanelSelect: fresh within the TTL, expired after it (injected clock), consume-once either way', () => {
  requestPanelSelect({ sourceId: 'ssh-a', panelId: 'schedules' }, 10_000)
  assert.deepEqual(consumePanelSelect('ssh-a', 10_000), { panelId: 'schedules', at: 10_000 }, 'the injected now controls freshness and the original at rides out (no real clock read)')
  assert.equal(consumePanelSelect('ssh-a', 10_000), undefined, 'consume clears the slot')

  requestPanelSelect({ sourceId: 'ssh-a', panelId: 'schedules' }, 10_000)
  assert.deepEqual(consumePanelSelect('ssh-a', 10_000 + PANEL_SELECT_INTENT_TTL_MS), { panelId: 'schedules', at: 10_000 }, 'the TTL boundary is inclusive')
  requestPanelSelect({ sourceId: 'ssh-a', panelId: 'schedules' }, 10_000)
  assert.equal(consumePanelSelect('ssh-a', 10_000 + PANEL_SELECT_INTENT_TTL_MS + 1), undefined, 'past the TTL = dropped')
  assert.equal(consumePanelSelect('ssh-a', 10_000 + PANEL_SELECT_INTENT_TTL_MS + 2), undefined, 'the expired intent was cleared')
})

test('consumePanelSelect: an already-mounted target consumes the pending intent, so boot cannot replay it', () => {
  const off = onPanelSelectRequest(request => {
    if (request.sourceId !== 'ssh-a') return
    assert.deepEqual(consumePanelSelect(request.sourceId, 7_000), { panelId: request.panelId, at: 7_000 })
  })
  requestPanelSelect({ sourceId: 'ssh-a', panelId: 'schedules' }, 7_000)
  assert.equal(consumePanelSelect('ssh-a', 7_000), undefined, 'the mounted shell already took it (no boot replay)')
  off()
})

test('the TTL literal and the per-source snapshot references are pinned (bail-out premise)', () => {
  assert.equal(PANEL_SELECT_INTENT_TTL_MS, 15_000, 'the lifetime is a deliberate, locked decision')
  publishPanelAxis('local', [schedules])
  const before = getPanelAxesSnapshot()
  const localRef = before['local']
  publishPanelAxis('ssh-b', [{ id: 'schedules', order: 10, label: 'Automation tasks' }])
  const after = getPanelAxesSnapshot()
  assert.notEqual(after, before, 'the record is rebuilt when any source changes')
  assert.equal(after['local'], localRef,
    'an unchanged source keeps the SAME array reference (useSyncExternalStore bail-out premise)')
  assert.equal(after['ssh-b'][0]?.label, 'Automation tasks')
  retirePanelAxis('ssh-b')
  assert.equal(getPanelAxesSnapshot()['local'], localRef,
    'retiring another source keeps the unchanged reference too')
})

test('__resetPanelAxisForTests: clears axes, pending, listeners and the snapshot', () => {
  publishPanelAxis('ssh-a', [schedules])
  requestPanelSelect({ sourceId: 'ssh-a', panelId: 'schedules' }, 1)
  let calls = 0
  subscribePanelAxes(() => { calls += 1 })
  onPanelSelectRequest(() => { calls += 1 })
  const before = getPanelAxesSnapshot()
  __resetPanelAxisForTests()
  assert.deepEqual(getPanelAxesSnapshot(), {})
  assert.notEqual(getPanelAxesSnapshot(), before)
  assert.equal(consumePanelSelect('ssh-a', 2), undefined, 'pending is cleared too')
  publishPanelAxis('ssh-b', [])
  assert.equal(calls, 0, 'both listener sets are cleared')
})

test('panel-axis: page-local only (no persistence, no DOM, no timers, no wire)', () => {
  const text = readFileSync(fileURLToPath(new URL('../src/panel-axis.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|JSON\.stringify|postMessage|fetch\(/,
    'the panel axis is a page-memory fact: never persisted, never crosses the wire')
  assert.doesNotMatch(text, /document\.|window\.|addEventListener/,
    'no DOM: the sidebar renders it; this module only owns the page-level ledger')
  assert.doesNotMatch(text, /setTimeout|setInterval|queueMicrotask/,
    'the intent TTL is judged by the consumer-injected monotonic clock; the module owns no timer')
  assert.doesNotMatch(text, /from '@dsh-chamber\//,
    'no wire/kernel package import: the singleton guard is the only dependency')
})
