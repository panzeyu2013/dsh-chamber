/**
 * 来源就绪门 / 遮罩判定的**行为**契约（source-readiness.ts、retention.ts）。
 *
 * 2026-12 清理：本文件承接原 boot-deadzone 接线锁文件里的纯判据部分——App/InstanceView
 * 的源码文本 wiring 锁（只证明 SHAPE）已按裁决全部移除；这里只保留可执行的行为断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SERVING_TERMINAL_GRACE_MS,
  VEIL_ACTIONS_AFTER_MS,
  decideServingGate,
  isDeferredReclaimDue,
  isTerminalUnreadyPhase,
  servingGatePhase,
  shouldAnnounceRetryQueue,
  shouldDeferBootForSource,
  shouldReportGraphUnavailable,
  veilShowsActions,
  veilState,
} from '../../src/source-readiness.ts'
import { VIEW_RECLAIM_GRACE_MS } from '../../src/retention.ts'

test('the window and grace values carry the numbers the design promises', () => {
  assert.equal(VEIL_ACTIONS_AFTER_MS, 10_000, 'design 05 §4.1: a 10s feedback window')
  assert.equal(SERVING_TERMINAL_GRACE_MS, 1_500, 'design 05 §4.1: a 1.5s terminal grace')
  assert.equal(VIEW_RECLAIM_GRACE_MS, 60_000, 'design 05 §4.1: deferred mounts reclaim on the 60s hidden grace')
})

// ── 1. 纯决策 ──────────────────────────────────────────────────────────────

test('serving gate: ready serves, idle is unavailable, a terminal phase fast-fails after the grace only', () => {
  assert.equal(decideServingGate({ phase: 'ready', nowMs: 0, terminalSinceMs: null }).action, 'serve')
  // 相位缺失 = 投影里还没有该来源：事实未到 ≠ 手动断开，预算内继续等（调用方
  // 绝对截止兜底）。2026-12 独立复核修正：折叠值 'idle' 曾让缺投影的来源被秒判无图。
  assert.equal(decideServingGate({ phase: undefined, nowMs: 0, terminalSinceMs: null }).action, 'wait')
  // 手动断开：boot 本就被推迟，门必须立刻判不可服务，不烧预算。
  assert.equal(decideServingGate({ phase: 'idle', nowMs: 0, terminalSinceMs: null }).action, 'unavailable')
  // 连接中：继续等（绝对截止由调用方兜底）。
  assert.equal(decideServingGate({ phase: 'connecting', nowMs: 0, terminalSinceMs: null }).action, 'wait')
  // 终态：宽限内等待（给点击触发的即时重连翻相位的机会），超宽限立刻不可服务。
  const first = decideServingGate({ phase: 'error', nowMs: 1000, terminalSinceMs: null })
  assert.equal(first.action, 'wait', 'an error must not be judged at the first observation')
  assert.equal(first.terminalSinceMs, 1000)
  assert.equal(
    decideServingGate({ phase: 'error', nowMs: 1000 + SERVING_TERMINAL_GRACE_MS - 1, terminalSinceMs: first.terminalSinceMs }).action,
    'wait',
  )
  assert.equal(
    decideServingGate({ phase: 'error', nowMs: 1000 + SERVING_TERMINAL_GRACE_MS, terminalSinceMs: first.terminalSinceMs }).action,
    'unavailable',
    'a persistent terminal phase must stop burning the boot budget',
  )
  // 恢复：相位翻回 connecting 即清掉终态计时，绝不用旧终态判死。
  const recovered = decideServingGate({ phase: 'connecting', nowMs: 2000, terminalSinceMs: 1000 })
  assert.equal(recovered.action, 'wait')
  assert.equal(recovered.terminalSinceMs, null)
  // degraded = 重连在途（正在自愈）：门必须继续等，绝不判死。
  assert.equal(decideServingGate({ phase: 'degraded', nowMs: 0, terminalSinceMs: null }).action, 'wait')
  assert.equal(
    decideServingGate({ phase: 'degraded', nowMs: 100000, terminalSinceMs: 0 }).action,
    'wait',
    'a reconnecting source must keep its chance to serve the graph',
  )
  assert.equal(isTerminalUnreadyPhase('error'), true)
  // 托管运行时的终态与 sidebar 姊妹门（serving-gate.ts 的 TERMINAL_PHASES）同词汇：
  // 再等也不会服务，必须同样快判（否则网关卡死要烧满 60s；2026-12 复核 MINOR）。
  assert.equal(isTerminalUnreadyPhase('stopped'), true)
  assert.equal(isTerminalUnreadyPhase('restart-exhausted'), true)
  for (const phase of ['stopped', 'restart-exhausted']) {
    const seen = decideServingGate({ phase, nowMs: 0, terminalSinceMs: null })
    assert.equal(seen.action, 'wait', phase + ' must get the reconnect grace too')
    assert.equal(
      decideServingGate({ phase, nowMs: SERVING_TERMINAL_GRACE_MS, terminalSinceMs: seen.terminalSinceMs }).action,
      'unavailable',
      phase + ' must stop burning the boot budget',
    )
  }
  assert.equal(isTerminalUnreadyPhase('degraded'), false)
  assert.equal(isTerminalUnreadyPhase('connecting'), false)
  assert.equal(isTerminalUnreadyPhase(undefined), false)
})

test('serving gate: 投影缺席 → undefined（预算内等）；投影在场 → 合并派生相位（终态可达）', () => {
  // 2026-12 二轮独立复核 F1：直接用原始相位会让网关形态的 stopped/restart-exhausted
  // 在 App 路径上不可达（原始 SshPhase 没有这两个值），两侧门判得不一样。
  assert.equal(servingGatePhase('idle', false), undefined, '投影未到 = 事实未到，不是手动断开')
  assert.equal(servingGatePhase('idle', true), 'idle', '投影到场的手动断开仍立即不可服务')
  assert.equal(servingGatePhase('stopped', true), 'stopped', '托管停机必须能进终态词表')
  assert.equal(servingGatePhase('ready', true), 'ready')
  assert.equal(decideServingGate({ phase: servingGatePhase('idle', false), nowMs: 0, terminalSinceMs: null }).action, 'wait')
  assert.equal(decideServingGate({ phase: servingGatePhase('stopped', true), nowMs: 0, terminalSinceMs: null }).action, 'wait',
    '终态仍走 1.5s 宽限（不是立即判死）')
})

test('only a manual disconnect defers the boot; an unknown projection never does', () => {
  assert.equal(shouldDeferBootForSource('idle'), true)
  for (const phase of ['connecting', 'ready', 'degraded', 'error', undefined]) {
    assert.equal(shouldDeferBootForSource(phase), false, String(phase) + ' must still boot')
  }
})

test('veil state: the feedback window upgrades to actionable, and settling always wins', () => {
  assert.equal(veilState({ deferred: false, settled: false, waitedMs: 0 }), 'loading')
  assert.equal(veilState({ deferred: false, settled: false, waitedMs: VEIL_ACTIONS_AFTER_MS - 1 }), 'loading')
  assert.equal(veilState({ deferred: false, settled: false, waitedMs: VEIL_ACTIONS_AFTER_MS }), 'loading-stuck')
  // 未连接来源：立即是可操作态（本来就没有 boot 在跑，不必等反馈窗）。
  assert.equal(veilState({ deferred: true, settled: false, waitedMs: 0 }), 'boot-deferred')
  // settle 永远是终局：遮罩不再给动作，失败呈现归 App 覆盖层（结构互斥）。
  assert.equal(veilState({ deferred: false, settled: true, waitedMs: 0 }), 'settled')
  assert.equal(veilState({ deferred: true, settled: true, waitedMs: 0 }), 'settled')
  assert.equal(veilShowsActions('loading-stuck'), true)
  assert.equal(veilShowsActions('boot-deferred'), true)
  assert.equal(veilShowsActions('loading'), false)
  assert.equal(veilShowsActions('settled'), false)
})

test('every channel failure but the 404 "no graph injected" shape reaches the App as a degrade', () => {
  assert.equal(shouldReportGraphUnavailable('not-injected'), false,
    'gateway/mobile shapes legitimately run without a graph — never a degrade')
  assert.equal(shouldReportGraphUnavailable('graph-unreachable'), true)
  assert.equal(shouldReportGraphUnavailable('anything-else'), true, 'unknown states fail toward honesty')
})

test('the retry queue note is honest: only an UNSETTLED predecessor queues a retry', () => {
  // 2026-12 复核 F3：boot 以失败 settle 后同 id 尾已释放，重试不排队——
  // 按"第几次尝试"播报会在最常见的"失败后重试"里撒谎。
  assert.equal(shouldAnnounceRetryQueue(false, false), false, 'no unsettled predecessor = no queue')
  assert.equal(shouldAnnounceRetryQueue(true, false), true)
  assert.equal(shouldAnnounceRetryQueue(true, true), false, 'a settled view needs no queue note')
  assert.equal(shouldAnnounceRetryQueue(false, true), false)
})

test('the deferred reclaim decision only takes never-settled, unhidden, unheld mounts', () => {
  const due = (over: Partial<Parameters<typeof isDeferredReclaimDue>[0]> = {}) => isDeferredReclaimDue({
    deferred: true,
    settled: false,
    busy: false,
    settingsTarget: false,
    hiddenSinceMs: 1_000,
    nowMs: 1_000 + VIEW_RECLAIM_GRACE_MS,
    graceMs: VIEW_RECLAIM_GRACE_MS,
    ...over,
  })
  assert.equal(due(), true, 'a never-settled deferred mount past the hidden grace is reclaimed')
  assert.equal(due({ nowMs: 1_000 + VIEW_RECLAIM_GRACE_MS - 1 }), false, 'inside the grace nothing happens')
  assert.equal(due({ hiddenSinceMs: undefined }), false, 'without a hidden clock it is invisible — never guess')
  assert.equal(due({ deferred: false }), false, 'a normal view belongs to retention')
  // 已 settle 的推迟壳是真壳：回 retention 常规候选窗，绝不在推迟臂被二次回收。
  assert.equal(due({ settled: true }), false)
  assert.equal(due({ busy: true }), false, 'a displayed/pending view is never reclaimed')
  // 设置面板正在编辑的来源：拆壳 = 面板面消失（design 05 §5 的面板 hold）。
  assert.equal(due({ settingsTarget: true }), false,
    'without this guard the settings panel is pinned on "starting this instance" (2026-12 review MAJOR)')
})

// ── 2. App 接线（源码文本契约） ─────────────────────────────────────────────
