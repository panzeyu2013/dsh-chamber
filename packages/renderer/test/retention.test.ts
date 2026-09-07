import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideReclaimCandidates,
  shouldRunBackgroundPhase,
  VIEW_RECLAIM_GRACE_MS,
  type ReclaimDecisionInput,
} from '../src/retention.ts'

// N-ctx 视图保留策略（2026 性能整改，见 src/retention.ts 头注）：local 恒留、
// 隐藏壳上限 RETAINED_HIDDEN_VIEWS=1、回收候选 = 已 settle + 非
// active/pending/prewarm-inflight + 连续隐藏 ≥ VIEW_RECLAIM_GRACE_MS。
// App 接线（计时维护/回收动作/可见性补偿）不在本文件测试范围（React 组件
// 层，node 直跑不覆盖 DOM）。

const LOCAL = 'local'
const NOW = 1_000_000
const LONG_AGO = NOW - VIEW_RECLAIM_GRACE_MS - 1 // 超窗
const JUST_NOW = NOW - 1_000 // 安全窗内

function decide(over: Partial<ReclaimDecisionInput>): string[] {
  return decideReclaimCandidates({
    mountedViews: [],
    activeViewId: LOCAL,
    hiddenSince: {},
    settled: new Set(),
    pendingViewId: null,
    prewarmInflightId: null,
    localId: LOCAL,
    now: NOW,
    ...over,
  })
}

function hiddenFor(ids: string[], since: number): Record<string, number> {
  return Object.fromEntries(ids.map(id => [id, since]))
}

function settledSet(ids: string[]): Set<string> {
  return new Set(ids)
}

// ---- local 恒留与基本守卫 ----

test('local 永不回收（即使超窗且超限）', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b'],
    activeViewId: 'dsh-a',
    hiddenSince: hiddenFor([LOCAL, 'dsh-b'], LONG_AGO),
    settled: settledSet([LOCAL, 'dsh-a', 'dsh-b']),
  })
  assert.ok(!result.includes(LOCAL), 'local 绝不出现在回收集')
})

test('活动视图不回收', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a'],
    activeViewId: 'dsh-a',
    hiddenSince: hiddenFor(['dsh-a'], LONG_AGO),
    settled: settledSet(['dsh-a']),
  })
  assert.deepEqual(result, [])
})

test('在途切换意图（pending）不回收', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b'],
    activeViewId: LOCAL,
    pendingViewId: 'dsh-b',
    hiddenSince: hiddenFor(['dsh-a', 'dsh-b'], LONG_AGO),
    settled: settledSet(['dsh-a', 'dsh-b']),
  })
  assert.deepEqual(result, ['dsh-a'], 'pending 目标绝不回收，超限时回收另一个')
})

test('在途预热（prewarm inflight）不回收', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b'],
    activeViewId: LOCAL,
    prewarmInflightId: 'dsh-b',
    hiddenSince: hiddenFor(['dsh-a', 'dsh-b'], LONG_AGO),
    settled: settledSet(['dsh-a', 'dsh-b']),
  })
  assert.deepEqual(result, ['dsh-a'])
})

test('未 settle（booting/未上报）不回收', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b'],
    activeViewId: LOCAL,
    hiddenSince: hiddenFor(['dsh-a', 'dsh-b'], LONG_AGO),
    settled: settledSet(['dsh-a']), // dsh-b 未 settle
  })
  assert.deepEqual(result, ['dsh-a'], '尽力而为：可回收者照收，占位壳等 settle')
})

// ---- 60s 安全窗 ----

test('安全窗内（刚隐藏/settle 完）不回收', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b'],
    activeViewId: LOCAL,
    hiddenSince: hiddenFor(['dsh-a', 'dsh-b'], JUST_NOW),
    settled: settledSet(['dsh-a', 'dsh-b']),
  })
  assert.deepEqual(result, [])
})

test('超窗即进入候选', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b'],
    activeViewId: LOCAL,
    hiddenSince: hiddenFor(['dsh-a', 'dsh-b'], LONG_AGO),
    settled: settledSet(['dsh-a', 'dsh-b']),
  })
  assert.deepEqual(result, ['dsh-a'], '隐藏 2 超限 1，回收最久者')
})

test('恰好等于安全窗边界即可回收（≥ 语义，2026 评审修正）', () => {
  // 判别构造：A 恰在边界（now - GRACE）、B 超窗更久、C 仍在窗内；隐藏 3
  // 超限 2 → 候选须含 A。若实现是严格大于（>），A 被排除、只回收 B——
  // 本测试钉住与 docs「≥60s」一致的语义（旧单视图构造经 excess==0 早退，
  // 从未触达边界过滤，标题与实现矛盾）。
  const atBoundary = NOW - VIEW_RECLAIM_GRACE_MS
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b', 'dsh-c'],
    activeViewId: LOCAL,
    hiddenSince: {
      'dsh-a': atBoundary,
      'dsh-b': atBoundary - 1,
      'dsh-c': JUST_NOW,
    },
    settled: settledSet(['dsh-a', 'dsh-b', 'dsh-c']),
  })
  assert.deepEqual(result, ['dsh-b', 'dsh-a'], '最久者先回收，恰好等于边界者随超限量回收')
})

// ---- 保留上限 ----

test('隐藏 1 个超窗不回收（未超限）', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a'],
    activeViewId: LOCAL,
    hiddenSince: hiddenFor(['dsh-a'], LONG_AGO),
    settled: settledSet(['dsh-a']),
  })
  assert.deepEqual(result, [])
})

test('隐藏 3 个超窗只回收差额（最久 2 个）', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b', 'dsh-c'],
    activeViewId: LOCAL,
    hiddenSince: {
      'dsh-a': NOW - 400_000,
      'dsh-b': NOW - 300_000,
      'dsh-c': NOW - 200_000,
    },
    settled: settledSet(['dsh-a', 'dsh-b', 'dsh-c']),
  })
  assert.deepEqual(result, ['dsh-a', 'dsh-b'], '按 hiddenSince 升序回收最久者')
})

test('最久者优先（乱序输入仍按计时排序）', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-c', 'dsh-b', 'dsh-a'],
    activeViewId: 'dsh-c',
    hiddenSince: {
      'dsh-a': NOW - 400_000,
      'dsh-b': NOW - 300_000,
    },
    settled: settledSet(['dsh-a', 'dsh-b', 'dsh-c']),
  })
  assert.deepEqual(result, ['dsh-a'], '活动视图 dsh-c 不计入隐藏')
})

test('无隐藏键（从未计时）的视图不回收，其余超窗者照常回收', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b'],
    activeViewId: LOCAL,
    hiddenSince: { 'dsh-b': LONG_AGO },
    settled: settledSet(['dsh-a', 'dsh-b']),
  })
  assert.deepEqual(result, ['dsh-b'], 'dsh-a 无 hiddenSince 排除；超限仍回收超窗的 dsh-b')
})

test('全部无隐藏键（挂载后从未 settle/切走）不回收', () => {
  const result = decide({
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b'],
    activeViewId: LOCAL,
    hiddenSince: {},
    settled: settledSet(['dsh-a', 'dsh-b']),
  })
  assert.deepEqual(result, [])
})

// ---- 幂等与确定性 ----

test('幂等：同一输入两次调用输出一致', () => {
  const input: ReclaimDecisionInput = {
    mountedViews: [LOCAL, 'dsh-a', 'dsh-b', 'dsh-c'],
    activeViewId: LOCAL,
    hiddenSince: hiddenFor(['dsh-a', 'dsh-b', 'dsh-c'], LONG_AGO),
    settled: settledSet(['dsh-a', 'dsh-b', 'dsh-c']),
    pendingViewId: null,
    prewarmInflightId: null,
    localId: LOCAL,
    now: NOW,
  }
  assert.deepEqual(decideReclaimCandidates(input), decideReclaimCandidates(input))
})

test('空输入/无挂载安全', () => {
  assert.deepEqual(decide({}), [])
  assert.deepEqual(decide({ mountedViews: [LOCAL], activeViewId: LOCAL }), [])
})

// ---- 后台相位门控 ----

test('shouldRunBackgroundPhase：仅 visible 放行', () => {
  assert.equal(shouldRunBackgroundPhase('visible'), true)
  assert.equal(shouldRunBackgroundPhase('hidden'), false)
})
