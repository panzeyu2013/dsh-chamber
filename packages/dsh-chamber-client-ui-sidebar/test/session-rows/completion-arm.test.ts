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
 *   4. no second clearing rule: re-running, reading (the ATTENDED ctx source — painted ∧
 *      pageForeground — with that row as current, or the App's open intent for a
 *      facts-only source), or leaving an authoritative list (source retirement drops the
 *      whole table upstream);
 *   5. fail-closed: a stale report never arms, an absent report freezes both tables.
 *
 * 注意力 2 元（v3 注意力模型）：attended = painted && foreground。屏上但应用在后台不算
 * 「在读」——那类完成必须留点（返回前台即清）；foreground 是页面注意力事实（应用激活 ∧
 * 文档可见 ∧ 壳窗口可见未遮挡），不是桥选择。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepCompletionArm, type CompletionArmStepInput } from '@dsh-chamber/dsh-chamber-client-core'

const BASE: CompletionArmStepInput = {
  current: 's1',
  rows: { s1: { running: false } },
  painted: false,
  // helper 默认「窗口在前台」：既有用例只表达 painted 维度；注意力维度的负例显式传
  // foreground: false（v3 A2：旧用例体不变、标题不动）。
  foreground: true,
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

// 标题逐字保留：remote-state-injection-matrix 的 four-surface-consistency live 证据按
// 标题原文匹配；注意力维度由 helper 默认 foreground: true 保持旧语义，新维度用下方
// 独立新用例。
test('the painted source is reading: no arm, and an armed current clears', () => {
  assert.deepEqual(step({}, { s1: true }, { painted: true }).arms, {})
  const cleared = step({ s1: true }, { s1: true }, { painted: true })
  assert.deepEqual(cleared.arms, {})
  assert.equal(cleared.changed, true)
})

// ---------------------------------------------------------------------------
// 注意力维度（v3 注意力模型）：attended = painted && foreground
// 用户裁决：返回前台即清、ack 不做；屏上但应用在后台的完成必须留点。
// ---------------------------------------------------------------------------

test('a painted source in the app background arms its current row (foreground is attention, not painted)', () => {
  // 屏上仍是该来源，但应用不在前台 ⇒ 用户没在看：新鲜 running→idle 边沿必须武装。
  const next = step({}, { s1: true }, { painted: true, foreground: false })
  assert.deepEqual(next.arms, { s1: true })
  assert.equal(next.changed, true)
  // 同拍也不得当作「已读」清除：background 不是 reading。
  const kept = step({ s1: true }, { s1: true }, { painted: true, foreground: false })
  assert.deepEqual(kept.arms, { s1: true }, 'background foreground never clears an armed row')
})

test('the reading predicate is attended (painted ∧ foreground), never painted alone', () => {
  const paintedOnly = step({ s1: true }, { s1: true }, { painted: true, foreground: false })
  assert.deepEqual(paintedOnly.arms, { s1: true }, 'painted but the app is in the background: not reading')
  const attended = step({ s1: true }, { s1: true }, { painted: true, foreground: true })
  assert.deepEqual(attended.arms, {}, 'attended: the armed current clears')
  assert.equal(attended.changed, true)
})

test('returning to the foreground clears the arm a background completion made', () => {
  const armed = step({}, { s1: true }, { painted: true, foreground: false })
  assert.deepEqual(armed.arms, { s1: true })
  // 回前台且同一 current 仍被 paint：attended 命中 ⇒ 返回即清（不引入第二清除规则）。
  const cleared = step(armed.arms, armed.running, { painted: true, foreground: true })
  assert.deepEqual(cleared.arms, {})
  assert.equal(cleared.changed, true)
})

test('a painted facts-only source in the app background arms every row edge', () => {
  // factsOnly = 无官方 ctx 上报的 provenance；painted 但应用在后台 ⇒ attended=false，
  // 逐行 host running→idle 边沿必须武装（首见 running 只播种，不算边沿）。
  const seeded = step({}, { s1: true }, {
    painted: true, foreground: false, factsOnly: true, current: undefined,
    rows: { s1: { running: true } },
  })
  assert.deepEqual(seeded.arms, {}, 'the first observation is not an edge')
  const armed = step(seeded.arms, seeded.running, {
    painted: true, foreground: false, factsOnly: true, current: undefined,
  })
  assert.deepEqual(armed.arms, { s1: true })
  assert.equal(armed.changed, true)
})

test('only the attended current row clears: other rows and a background source keep their arms', () => {
  const rows = { s1: { running: false }, s2: { running: false } }
  const attended = step({ s1: true, s2: true }, { s1: true, s2: true }, {
    painted: true, foreground: true, current: 's1', rows,
  })
  assert.deepEqual(attended.arms, { s2: true }, 'attended clears only its current row (no sweep)')
  const background = step({ s1: true, s2: true }, { s1: true, s2: true }, {
    painted: true, foreground: false, current: 's1', rows,
  })
  assert.deepEqual(background.arms, { s1: true, s2: true }, 'the app in the background is not reading: nothing clears')
})

test('stale / freeze / list-departure / re-running invariants hold unchanged under the attention model', () => {
  // stale：后台也不武装（stale 报告不是完成证据），running 记忆仍推进。
  const stale = step({}, { s1: true }, { painted: true, foreground: false, stale: true })
  assert.deepEqual(stale.arms, {})
  assert.deepEqual(stale.running, { s1: false })
  // freeze：无报告两表冻结（前台/后台同）。
  const frozen = step({ s1: true }, { s1: true }, { painted: true, foreground: false, rows: undefined })
  assert.deepEqual(frozen.arms, { s1: true })
  assert.deepEqual(frozen.running, { s1: true })
  assert.equal(frozen.changed, false)
  // 离表：权威列表删行（后台亦然）。
  const dropped = step({ s1: true }, { s1: true }, { painted: true, foreground: false, rows: {}, listComplete: true })
  assert.deepEqual(dropped.arms, {})
  // re-running：重跑清臂（后台亦然）。
  const rerunning = step({ s1: true }, { s1: true }, {
    painted: true, foreground: false, rows: { s1: { running: true } },
  })
  assert.deepEqual(rerunning.arms, {})
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
