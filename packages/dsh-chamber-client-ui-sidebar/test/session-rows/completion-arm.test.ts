/**
 * stepCompletionArm — the N-ctx correction arm: the ONLY chamber-side state in
 * the completed-unread model (authority is the vendor's own
 * sessionStatus.completionUnread, carried on the channel row).
 *
 * Invariants pinned here:
 *   1. it never produces a completed bit on its own authority: when the official
 *      bit is set the arm is irrelevant (merge ORs them);
 *   2. row-keyed and never sweeping: with an official ctx report only its
 *      mainView-retained `current` row can arm (`factsOnly` absent); a facts-only
 *      source (`factsOnly`, never inferred from `current === undefined`) arms every
 *      row with a fresh host running→idle edge, still one arm per distinct row;
 *   3. memory-only signature (no storage, no clock, no watermarks, no facts);
 *   4. no second clearing rule: re-running, reading (the painted ctx source with that
 *      row as current, or the App's open intent for a facts-only source), or leaving
 *      an authoritative list (source retirement drops the whole table upstream);
 *   5. fail-closed: a stale report never arms, an absent report freezes both tables.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepCompletionArm, type CompletionArmStepInput } from '@dsh-chamber/dsh-chamber-client-core'

const BASE: CompletionArmStepInput = {
  current: 's1',
  rows: { s1: { running: false } },
  painted: false,
  listComplete: true,
  stale: false,
}

function step(
  arms: Record<string, boolean>,
  running: Record<string, boolean>,
  over: Partial<CompletionArmStepInput> = {},
) {
  return stepCompletionArm(arms, running, { ...BASE, ...over })
}

test('arms the hidden source current row on a fresh running→idle edge', () => {
  const next = step({}, { s1: true })
  assert.deepEqual(next.arms, { s1: true })
  assert.deepEqual(next.running, { s1: false }, 'the observed idle bit is remembered (undefined = never observed)')
  assert.equal(next.changed, true)
})

test('a steady idle row never arms (arming needs the edge, not the state)', () => {
  const next = step({}, {})
  assert.deepEqual(next.arms, {})
  assert.deepEqual(next.running, { s1: false }, 'the first observation records the seen idle state')
  assert.equal(next.changed, true, 'never-observed → observed-idle is a memory change')
  const again = step(next.arms, next.running, {})
  assert.deepEqual(again.arms, {})
  assert.equal(again.changed, false, 'a second identical idle step is silent')
})

test('the painted source is reading: no arm, and an armed current clears', () => {
  assert.deepEqual(step({}, { s1: true }, { painted: true }).arms, {})
  const cleared = step({ s1: true }, { s1: true }, { painted: true })
  assert.deepEqual(cleared.arms, {})
  assert.equal(cleared.changed, true)
})

test('reading does not sweep arms of OTHER rows (no second clearing rule)', () => {
  // Both rows stay in the authoritative list, so only the READ row may clear.
  const next = step({ s2: true }, { s1: true, s2: true }, {
    painted: true,
    current: 's1',
    rows: { s1: { running: false }, s2: { running: false } },
  })
  assert.deepEqual(next.arms, { s2: true })
})

test('re-running clears the arm', () => {
  const next = step({ s1: true }, { s1: true }, { rows: { s1: { running: true } } })
  assert.deepEqual(next.arms, {})
  assert.deepEqual(next.running, { s1: true })
  assert.equal(next.changed, true)
})

test('only the mainView-retained current row can arm (a non-current completion never arms)', () => {
  const next = step({}, { s2: true }, { rows: { s1: { running: false }, s2: { running: false } } })
  assert.deepEqual(next.arms, {})
})

test('no mainView retention (current undefined) never arms', () => {
  const next = step({}, { s1: true }, { current: undefined })
  assert.deepEqual(next.arms, {})
})

test('a stale report is never arm evidence but the edge memory still advances', () => {
  const next = step({}, { s1: true }, { stale: true })
  assert.deepEqual(next.arms, {})
  assert.deepEqual(next.running, { s1: false }, 'the edge memory still advances (idle observed)')
  assert.equal(next.changed, true)
})

test('an absent report freezes both tables', () => {
  const next = step({ s1: true }, { s1: true }, { rows: undefined })
  assert.deepEqual(next.arms, { s1: true })
  assert.deepEqual(next.running, { s1: true })
  assert.equal(next.changed, false)
})

test('an authoritative list drops rows that left it, arm and memory together', () => {
  const dropped = step({ s1: true }, { s1: true, s9: true }, { rows: { s9: { running: true } }, listComplete: true })
  assert.deepEqual(dropped.arms, {})
  assert.deepEqual(dropped.running, { s9: true })
  const kept = step({ s1: true }, { s1: true }, { rows: { s9: { running: true } }, listComplete: false })
  assert.deepEqual(kept.arms, { s1: true })
})

// ---------------------------------------------------------------------------
// Facts-only provenance (factsOnly): the vendor never covers these sources
// ---------------------------------------------------------------------------

test('factsOnly arms every row with a fresh host running→idle edge (never a sweep)', () => {
  const next = step({}, { a: true, b: true }, {
    current: undefined,
    rows: { a: { running: false }, b: { running: false } },
    factsOnly: true,
  })
  assert.deepEqual(next.arms, { a: true, b: true })
})

test('C1: the arm memory kept across a shell withdrawal arms the window completion from the facts edge', () => {
  // 桥面 report === undefined（facts 载体未换代）保留 prevRunning；撤回后判定侧读
  // virtualRuntimeReport（factsOnly=true，虚拟壳行只带 running）⇒ 同一份 running:true
  // 记忆 + 事实 idle 边沿仍武装蓝点（C1 要求「窗口内蓝点仍按 facts 逐行边沿武装」）。
  const kept = step({}, { s1: true }, {
    current: undefined, rows: { s1: { running: false } }, factsOnly: true,
  })
  assert.deepEqual(kept.arms, { s1: true }, '窗口内真完成必须武装蓝点')
  // 对照（修复前整代撤回清了记忆）：从未观察过的 idle 行不构成边沿 ⇒ 不武装——
  // 窗口完成点在蓝点面也一并丢（本修复去掉的形状）。
  const cleared = step({}, {}, {
    current: undefined, rows: { s1: { running: false } }, factsOnly: true,
  })
  assert.deepEqual(cleared.arms, {}, '记忆被清 ⇒ 首见 idle 不武装')
})

test('factsOnly is explicit: an official ctx with no current still arms nothing', () => {
  const next = step({}, { a: true }, {
    current: undefined,
    rows: { a: { running: false } },
  })
  assert.deepEqual(next.arms, {})
})

test('factsOnly never arms on a stale (decision-unusable) report', () => {
  const next = step({}, { a: true }, {
    current: undefined,
    rows: { a: { running: false } },
    factsOnly: true,
    stale: true,
  })
  assert.deepEqual(next.arms, {})
})

test('beforeBaseline arms a first-seen idle row only while the list counter is known and not ready', () => {
  const firstSeen = { a: { running: false, beforeBaseline: true } }
  const armed = step({}, {}, { current: undefined, rows: firstSeen, factsOnly: true, listKnown: true, listComplete: false })
  assert.deepEqual(armed.arms, { a: true })
  const ready = step({}, {}, { current: undefined, rows: firstSeen, factsOnly: true, listKnown: true, listComplete: true })
  assert.deepEqual(ready.arms, {}, 'a ready list is the authority: no beforeBaseline arm')
  const unknown = step({}, {}, { current: undefined, rows: firstSeen, factsOnly: true, listKnown: false, listComplete: false })
  assert.deepEqual(unknown.arms, {}, 'an UNKNOWN counter is not "not ready" — never arm on it (P1)')
  const absent = step({}, {}, { current: undefined, rows: firstSeen, factsOnly: true, listComplete: false })
  assert.deepEqual(absent.arms, {}, 'listKnown absent = unknown: the second arm stays closed')
  const seeded = step({}, {}, { current: undefined, rows: { a: { running: false } }, factsOnly: true, listKnown: true, listComplete: false })
  assert.deepEqual(seeded.arms, {}, 'a list-seeded row carries no beforeBaseline bit')
})

test('the App open intent clears that row for a facts-only source, even without a current', () => {
  const cleared = step({ a: true, b: true }, { a: false, b: false }, {
    current: undefined,
    rows: { a: { running: false }, b: { running: false } },
    factsOnly: true,
    readIntent: 'a',
  })
  assert.deepEqual(cleared.arms, { b: true })
  assert.equal(cleared.changed, true)
})

test('the open intent also suppresses a same-step arm for the row being read', () => {
  const next = step({}, { a: true }, {
    current: undefined,
    rows: { a: { running: false } },
    factsOnly: true,
    readIntent: 'a',
  })
  assert.deepEqual(next.arms, {})
  const beforeBaseline = step({}, {}, {
    current: undefined,
    rows: { a: { running: false, beforeBaseline: true } },
    factsOnly: true,
    listKnown: true,
    listComplete: false,
    readIntent: 'a',
  })
  assert.deepEqual(beforeBaseline.arms, {})
})

test('readIntent is inert for an official ctx source (no extra clearing rule)', () => {
  const next = step({ s1: true }, { s1: true }, { readIntent: 's1' })
  assert.deepEqual(next.arms, { s1: true })
})

test('factsOnly still honors the authoritative-list clear', () => {
  const next = step({ a: true }, { a: true }, {
    current: undefined,
    rows: {},
    factsOnly: true,
    listComplete: true,
  })
  assert.deepEqual(next.arms, {})
  assert.deepEqual(next.running, {})
})

test('an observed idle row is remembered, so a read never re-arms it as "first seen" (W11)', () => {
  // 首拍：首见 idle（列表基数已知未就绪）武装，并把**观察到的 false**写进 running 记忆。
  const first = step({}, {}, {
    current: undefined,
    rows: { a: { running: false, beforeBaseline: true } },
    factsOnly: true,
    listKnown: true,
    listComplete: false,
  })
  assert.deepEqual(first.arms, { a: true })
  assert.deepEqual(first.running, { a: false }, 'observed false must enter the memory (undefined = never observed)')
  // 点击读清：同一份记忆 + 同一行 ⇒ 第二支不再触发（旧实现只存 true，这里会复活）。
  const read = step(first.arms, first.running, {
    current: undefined,
    rows: { a: { running: false, beforeBaseline: true } },
    factsOnly: true,
    listKnown: true,
    listComplete: false,
    readIntent: 'a',
  })
  assert.deepEqual(read.arms, {}, 'a read clears the dot')
  assert.deepEqual(read.running, { a: false })
  // 再下一拍（意图仍在）：observed false 已粘住 ⇒ 不再以"从未观察"重新武装。
  const again = step(read.arms, read.running, {
    current: undefined,
    rows: { a: { running: false, beforeBaseline: true } },
    factsOnly: true,
    listKnown: true,
    listComplete: false,
  })
  assert.deepEqual(again.arms, {}, 'observed false is sticky: never re-armed as first-seen')
  assert.equal(again.changed, false, 'an unchanged false-only step is silent (exact running-memory comparison)')
})

test('the step is pure: inputs are never mutated', () => {
  const arms = { s2: true }
  const running = { s1: true }
  const rows = { s1: { running: false } }
  stepCompletionArm(arms, running, { ...BASE, rows })
  assert.deepEqual(arms, { s2: true })
  assert.deepEqual(running, { s1: true })
  assert.deepEqual(rows, { s1: { running: false } })
})
