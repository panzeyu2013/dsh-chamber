/**
 * 来源就绪门 / 遮罩判定的**行为**契约（source-readiness.ts）。
 *
 * 本文件持有可执行的行为断言：App/InstanceView 的源码文本 wiring 锁（只证明 SHAPE）
 * 不在此处；但终态相位词表的三份手抄（renderer / client-core / sidebar）由本文件末尾的
 * 源码文本 lockstep 互锁——它替代被删的 sidebar `serving-gate.ts` 姊妹门锚点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import {
  SERVING_TERMINAL_GRACE_MS,
  bootDeferralReasonForSource,
  decideServingGate,
  deferredBootReason,
  isTerminalUnreadyPhase,
  servingGatePhase,
  shouldAnnounceRetryQueue,
  shouldDeferBootForSource,
  graphGapKindFor,
} from '../../src/source-readiness.ts'
import { PRESENTATION_THRESHOLDS } from '@dsh-chamber/dsh-stream-state'

test('the window and grace values carry the numbers the design promises', () => {
  // The feedback window is the shared table's presentation section (one owner since P2).
  assert.equal(PRESENTATION_THRESHOLDS.veilActionsAfterMs, 10_000, 'design 05 §4.3: a 10s feedback window')
  assert.equal(SERVING_TERMINAL_GRACE_MS, 1_500, 'design 05 §4.3: a 1.5s terminal grace')
})

// ── 1. 纯决策 ──────────────────────────────────────────────────────────────

test('serving gate: ready serves, idle is unavailable, a terminal phase fast-fails after the grace only', () => {
  assert.equal(decideServingGate({ phase: 'ready', nowMs: 0, terminalSinceMs: null }).action, 'serve')
  // 相位缺失 = 投影里还没有该来源：事实未到 ≠ 手动断开，预算内继续等（调用方
  // 绝对截止兜底）。折叠值 'idle' 会把缺投影的来源秒判无图。
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
    'wait')
  assert.equal(
    decideServingGate({ phase: 'error', nowMs: 1000 + SERVING_TERMINAL_GRACE_MS, terminalSinceMs: first.terminalSinceMs }).action,
    'unavailable',
    'a persistent terminal phase must stop burning the boot budget')
  // 恢复：相位翻回 connecting 即清掉终态计时，绝不用旧终态判死。
  const recovered = decideServingGate({ phase: 'connecting', nowMs: 2000, terminalSinceMs: 1000 })
  assert.equal(recovered.action, 'wait')
  assert.equal(recovered.terminalSinceMs, null)
  // degraded = 重连在途（正在自愈）：门必须继续等，绝不判死。
  assert.equal(decideServingGate({ phase: 'degraded', nowMs: 0, terminalSinceMs: null }).action, 'wait')
  assert.equal(
    decideServingGate({ phase: 'degraded', nowMs: 100000, terminalSinceMs: 0 }).action,
    'wait',
    'a reconnecting source must keep its chance to serve the graph')
  assert.equal(isTerminalUnreadyPhase('error'), true)
  // 托管运行时的终态（stopped/restart-exhausted）同样是"再等也不会服务"，必须同样快判
  // （否则网关卡死要烧满 60s）。
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
  // 直接用原始相位会让网关形态的 stopped/restart-exhausted
  // 在 App 路径上不可达（global.d.ts 的相位拼写没有这两个值），两侧门判得不一样。
  assert.equal(servingGatePhase('idle', false), undefined, '投影未到 = 事实未到，不是手动断开')
  assert.equal(servingGatePhase('idle', true), 'idle', '投影到场的手动断开仍立即不可服务')
  assert.equal(servingGatePhase('stopped', true), 'stopped', '托管停机必须能进终态词表')
  assert.equal(servingGatePhase('ready', true), 'ready')
  assert.equal(decideServingGate({ phase: servingGatePhase('idle', false), nowMs: 0, terminalSinceMs: null }).action, 'wait')
  assert.equal(decideServingGate({ phase: servingGatePhase('stopped', true), nowMs: 0, terminalSinceMs: null }).action, 'wait',
    '终态仍走 1.5s 宽限（不是立即判死）')
})

test('a manual disconnect OR a ready-but-link-down transport defers the boot; unknown never does', () => {
  // C9 ①: two deferral facts, one pure decision. idle = user-intent terminal state; ready+link
  // down = the transport's grace window still says ready while the proxy fast-fails NEW
  // requests — a boot would only burn the whole 503 budget.
  assert.equal(shouldDeferBootForSource('idle', false), true)
  assert.equal(shouldDeferBootForSource('idle', true), true, 'idle stays deferred whatever the link says')
  assert.equal(shouldDeferBootForSource('ready', true), true, 'ready + down parks the boot')
  assert.equal(shouldDeferBootForSource('ready', false), false)
  // 值化裁决是 App 实际消费的入口（遮罩来路）；布尔谓词只是它的投影，两处不得漂移。
  assert.equal(bootDeferralReasonForSource('ready', true), 'link-down')
  assert.equal(bootDeferralReasonForSource('idle', true), 'manual-disconnect', 'idle wins over the link fact')
  assert.equal(bootDeferralReasonForSource('ready', false), null)
  for (const phase of ['connecting', 'degraded', 'error', 'stopped', 'restart-exhausted', undefined]) {
    assert.equal(shouldDeferBootForSource(phase, true), false, String(phase) + ' must still boot')
    assert.equal(shouldDeferBootForSource(phase, false), false, String(phase) + ' must still boot')
    assert.equal(bootDeferralReasonForSource(phase, true), null, String(phase) + ' owes no deferral reason')
  }
})

test('the deferred veil consumes the App-computed reason (copy/action), never a phase', () => {
  // Manual disconnect → 「未连接」+「连接」; ready + link down → 「链路不可用」+「重试」.
  // Not deferred is the normal boot path and owes no reason.
  assert.equal(deferredBootReason(false, 'link-down'), null)
  assert.equal(deferredBootReason(false, 'manual-disconnect'), null)
  assert.equal(deferredBootReason(true, 'manual-disconnect'), 'manual-disconnect')
  assert.equal(deferredBootReason(true, 'link-down'), 'link-down')
  // 契约外的来路缺席按手动断开兜底（App 的推迟集合与来路同源，正常不可达）。
  assert.equal(deferredBootReason(true, undefined), 'manual-disconnect')
})

test('P2-1: a non-ready DERIVED phase never re-labels a link-down deferral as a manual disconnect', () => {
  // gateway 托管折叠：原始 transport ready + link down ⇒ 派生 phase='stopped'（host/servers.ts 的
  // 托管折叠把 runtime 态并进 phase）。推迟来自链路 down，遮罩必须是「链路不可用」+「重试」；
  // 若从**派生相位**反推（非 ready ⇒ manual-disconnect）会误播「未连接」+「连接」（review P2-1）。
  const reason = bootDeferralReasonForSource('ready', true)
  assert.equal(reason, 'link-down')
  assert.equal(deferredBootReason(true, reason), 'link-down', 'the veil reason survives the derived-phase fold')
  // 派生相位（stopped/restarting）本身不是推迟事实：拿它当输入只会得到"不推迟"（或误判手动断开）。
  assert.equal(bootDeferralReasonForSource('stopped', true), null, 'a folded managed phase is not a deferral fact')
  assert.equal(bootDeferralReasonForSource('restarting', true), null)
  // 对照：真正的手动断开（原始相位 idle）仍是 manual-disconnect，且 idle 优先于链路事实。
  assert.equal(bootDeferralReasonForSource('idle', false), 'manual-disconnect')
  assert.equal(bootDeferralReasonForSource('idle', true), 'manual-disconnect')
})

test('every channel failure but the 404 "no graph injected" shape reaches the App as a degrade', () => {
  // 唯一对外裁决带 source id（kind，而非布尔投影）；本地实例形态单独收敛。
  assert.equal(graphGapKindFor('not-injected', 'local'), 'local-graph-not-injected',
    'the LOCAL instance always injects its graph — a 404 there is a chamber-side installation/seed fact (FIX 6)')
  assert.equal(graphGapKindFor('not-injected', 'ssh-a'), null,
    'a remote/gateway source may legitimately run without a graph — its exemption stays')
  assert.equal(graphGapKindFor('not-injected', 'gateway-x'), null)
  assert.equal(graphGapKindFor('graph-unreachable', 'local'), 'graph-unavailable')
  assert.equal(graphGapKindFor('graph-unreachable', 'ssh-a'), 'graph-unavailable')
  assert.equal(graphGapKindFor('anything-else', 'local'), 'graph-unavailable')
})

test('the retry queue note is honest: only an UNSETTLED predecessor queues a retry', () => {
  // boot 以失败 settle 后同 id 尾已释放，重试不排队——
  // 按"第几次尝试"播报会在最常见的"失败后重试"里撒谎。
  assert.equal(shouldAnnounceRetryQueue(false, false), false, 'no unsettled predecessor = no queue')
  assert.equal(shouldAnnounceRetryQueue(true, false), true)
  assert.equal(shouldAnnounceRetryQueue(true, true), false, 'a settled view needs no queue note')
  assert.equal(shouldAnnounceRetryQueue(false, true), false)
})

// ── 2. 源码文本契约（跨包终态词表 lockstep） ──────────────────────────────────

test('terminal-phase vocabulary lockstep: renderer / client-core / sidebar name one set', () => {
  const rendered = (source: string, re: RegExp): string[] => {
    const m = re.exec(source)
    assert.ok(m, 'the vocabulary site moved — re-derive this lockstep: ' + String(re))
    return [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!).sort()
  }
  /** The body of one top-level function: the regexes below must not be satisfied by a later function. */
  const body = (source: string, header: string): string => {
    const start = source.indexOf(header)
    assert.notEqual(start, -1, 'the vocabulary site moved — re-derive this lockstep: ' + header)
    const end = source.indexOf('\n}', start)
    assert.notEqual(end, -1, 'the vocabulary function no longer ends at a top-level brace: ' + header)
    return source.slice(start, end + 2)
  }
  const here = stripComments(readFileSync(new URL('../../src/source-readiness.ts', import.meta.url), 'utf8'))
  const core = stripComments(readFileSync(new URL('../../../dsh-chamber-client-core/src/managed-runtime.ts', import.meta.url), 'utf8'))
  const sidebar = stripComments(readFileSync(new URL('../../../dsh-chamber-client-ui-sidebar/src/client/server-section-model.ts', import.meta.url), 'utf8'))
  const rendererList = rendered(body(here, 'export function isTerminalUnreadyPhase'), /return ((?:phase === '[^']+'(?: \|\| )?)+)/)
  const coreList = rendered(core, /MANAGED_RUNTIME_DOWN_STATES = \[([^\]]+)\]/)
  const sidebarList = rendered(sidebar, /if \(((?:phase === '[^']+'(?: \|\| )?)+)\) return 'err'/)
  assert.deepEqual(rendererList, ['error', 'restart-exhausted', 'stopped'])
  assert.deepEqual(coreList, rendererList, 'client-core MANAGED_RUNTIME_DOWN_STATES drifted')
  assert.deepEqual(sidebarList, rendererList, 'sidebar sourceStatusKind err branch drifted')
})
