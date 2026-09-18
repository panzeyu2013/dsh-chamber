/**
 * boot 死区收敛（2026-12：W1 遮罩可操作化 / W2 相位感知 / W4 重试诚实）。
 *
 * 真机问题：远程来源未就绪时点开会话，活动视图停在全窗遮罩上——多来源导航
 * （侧栏）在壳内部，App 级失败覆盖层只在已 settle 的失败时出现，所以一个未
 * settle 的 boot 会形成一段**没有任何导航**的死区（最长由 135s 收割放弃臂
 * 兜底）。本文件钉两件事：
 *
 *  1. `source-readiness.ts` 的纯决策（可直测）：相位→就绪门（含托管终态）、推迟
 *     集合、推迟回收裁决、遮罩分类、重试排队事实、W3 上浮边界。
 *  2. 设计承诺的**数值**（10s 反馈窗 / 1.5s 终态宽限 / 60s 隐藏宽限）：值本身被钉住，
 *     改常数必须同时改文档与用例。
 *  3. App / InstanceView 的**接线**：两者无法被 node 测试导入（App 要渲染整个壳），
 *     所以接线用源码文本契约（`source-text.ts` 的 stripComments + normalize：
 *     注释剥离 + 空白折叠，避免被注释或换行满足）；关键函数用 `sliceFrom` 取**函数
 *     体内**文本，避免"全文件出现过"式的空过（连接 CTA、推迟臂、放弃臂、遮罩各门）。
 *  4. **可解析性**：裸源码上挡"JSX 注释落进表达式位"这一类语法回归（真正的解析门是
 *     `check:typecheck`；文本锁挡不住全部形状）。
 *  5. **CSS 规则体**（不是只有选择器）：滚动兜底与动作行排版被削成空壳同样会让
 *     遮罩动作不可达。
 *
 * 绿色只证明"形 + 决策"，行为由上面的纯测试与 shell / host-graph / frame-locale 套件
 * 覆盖；本文件不替代 check:typecheck。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SERVING_TERMINAL_GRACE_MS,
  VEIL_ACTIONS_AFTER_MS,
  decideServingGate,
  isDeferredReclaimDue,
  isTerminalUnreadyPhase,
  shouldAnnounceRetryQueue,
  shouldDeferBootForSource,
  veilShowsActions,
  veilState,
} from '../../src/source-readiness.ts'
import { shouldReportGraphUnavailable } from '../../src/source-readiness.ts'
import { VIEW_RECLAIM_GRACE_MS } from '../../src/retention.ts'
import { normalize, stripComments } from '../support/source-text.ts'

/** Comment-stripped, whitespace-collapsed source: the semantic text of a file. */
const read = (rel: string): string =>
  normalize(stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')))

/** 取 `from` 到其后第一个 `to` 之间的文本：把锁钉在**具体函数体内**，
 *  而不是"全文件出现过这个字符串"（2026-12 复核 MAJOR-3：`void ssh.connect`
 *  在 ensureRemoteConnected 里也有一份，全文件存在性检查指不对函数）。 */
const sliceFrom = (text: string, from: string, to: string): string => {
  const i = text.indexOf(from)
  if (i < 0) return ''
  const j = text.indexOf(to, i + from.length)
  return j < 0 ? text.slice(i) : text.slice(i, j)
}

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
  const graph = read('../../src/host-graph.ts')
  assert.ok(graph.includes("import { shouldReportGraphUnavailable } from './source-readiness.ts'"))
  assert.ok(graph.includes('if (shouldReportGraphUnavailable(state)) {'),
    'the W3 boundary must be the pure predicate, not an inline literal')
  assert.ok(graph.includes('deps.onGraphUnavailable?.('))
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

test('the App gate consumes the pure decision and keeps the absolute deadline', () => {
  const app = read('../../src/App.tsx')
  assert.ok(app.includes("import { decideServingGate, isDeferredReclaimDue, shouldDeferBootForSource } from './source-readiness.ts'"),
    'the App must consume the pure module')
  assert.ok(app.includes('const SERVING_WAIT_MS = BOOT_TIMEOUT_MS'), 'the gate must reuse the boot budget')
  assert.ok(app.includes('const decision = decideServingGate({ phase, nowMs: Date.now(), terminalSinceMs: terminalSince })'),
    'the gate must consult the pure decision')
  assert.ok(app.includes("if (decision.action === 'unavailable') { resolve(false); return }"))
  assert.ok(app.includes('terminalSince = decision.terminalSinceMs'), 'the terminal clock is the only carried state')
  assert.ok(app.includes('const deadline = Date.now() + SERVING_WAIT_MS'), 'the absolute deadline must survive')
})

test('a deferred (idle) boot is exempt from the boot clock and reclaimed once hidden', () => {
  const app = read('../../src/App.tsx')
  assert.ok(app.includes('const deferredBootIds = useMemo(() => {'), 'the deferral set is render-derived, not a ref mirror')
  assert.ok(app.includes('const rawId = rawInstanceIdFromSourceId(server.id)'),
    'the deferral fact must come from the raw projection, never from the "?? idle" collapse')
  assert.ok(app.includes('if (shouldDeferBootForSource(remoteStatus[rawId]?.phase)) ids.add(server.id)'))
  assert.ok(app.includes('}, [servers, remoteStatus])'), 'a late/failed projection must re-evaluate deferral')
  // 起表分支（函数内取文本）：只跳过起表、绝不删表，并且必须 continue——
  // 少了 continue 会被 135s 放弃臂误判成"实例启动超时"（复核 MAJOR-2 的反向用例）。
  const stampBranch = sliceFrom(app, 'if (deferredBootRef.current.has(id)) {',
    'if (viewBootStartedAtRef.current[id] === undefined)')
  assert.ok(stampBranch.includes('hiddenSinceRef.current[id] = now'),
    'a deferred view must get a mount-time hiddenSince (else it is never reclaimed — review F1)')
  assert.ok(stampBranch.includes('continue'),
    'the deferred branch must skip the boot-clock stamp entirely (else a false 135s timeout)')
  assert.equal(stampBranch.includes('delete'), false, 'an existing stamp must survive, never be deleted')
  assert.ok(app.includes('}, [mountedViews, deferredBootSignature, reclaimHiddenViews])'),
    'mount-time stamping depends on the deferred signature (dropping it re-opens the F1 leak)')
  // 放弃臂：整车豁免必须消失，且循环体内不得再出现 deferred 事实（与相邻写法无关）。
  // 切片必须覆盖**整个循环体**（到下一个循环头为止）：只切到 const wasHarvest 的话，
  // 在那个锚点之后再插一条 deferred 豁免会逃逸（2026-12 复核 A2b）。
  const abandonLoop = sliceFrom(app, 'for (const id of mountedViews) { if (settledViewIds.has(id)) continue',
    'for (const id of mountedViews) { if (!isDeferredReclaimDue(')
  assert.ok(abandonLoop.length > 0, 'the abandon loop keeps judging every unsettled mount by its stamp')
  assert.equal(abandonLoop.includes('deferredBootRef'), false,
    'no deferred exemption inside the abandon loop (a hung boot whose source went idle stays watched)')
  assert.ok(app.includes('&& !(deferredBootRef.current.has(id) && !isSettledShellState(shellStates[id]))'),
    'only a never-settled deferred view is "no shell at all" — a settled one still occupies the warm slot')
  assert.ok(app.includes('[...deferredBootRef.current].filter(id => !settledViewIds.has(id))'),
    'only never-settled deferred ids leave the retention input (settled ones stay normal candidates)')
  assert.ok(app.includes('mountedViews.filter(id => !unsettledDeferredIds.has(id))'))
  // 裁决走纯函数且事实齐备：删掉 settingsTarget 一行会让设置面板钉死（复核 MAJOR）。
  const arm = sliceFrom(app, 'isDeferredReclaimDue({', "reclaimView(id, 'retention')")
  for (const fact of ['deferred:', 'settled:', 'busy:', 'settingsTarget: id === settingsTargetRef.current', 'graceMs: VIEW_RECLAIM_GRACE_MS']) {
    assert.ok(arm.includes(fact), 'the deferred arm must weigh ' + fact)
  }
  assert.ok(app.includes("reclaimView(id, 'retention')"))
  // 面板 hold 必须钉在**唯一拆除入口**上（2026-12 复核 MAJOR：只锁推迟臂的事实列表
  // 时，删掉 reclaimView 里的守卫或保留循环里的跳过都能全绿通过）。
  assert.ok(app.includes('if (id === settingsTargetRef.current) return'),
    'reclaimView must refuse the source the settings panel is editing (every teardown path)')
  assert.ok(app.includes('if (id === settingsTargetRef.current) continue'),
    'the retention candidate loop keeps its own hold')
})

test('the veil escape switches first and reclaims only after the switch lands', () => {
  const app = read('../../src/App.tsx')
  assert.ok(app.includes('const switchSourceFromVeil = useCallback((fromViewId: string, targetId: string) => {'))
  assert.ok(app.includes('if (fromViewId === targetId) return'), 'an identity switch is a no-op')
  assert.ok(app.includes('!liveServerIdsRef.current.has(targetId)) return'),
    'a retired target must not create an abandonment mark')
  assert.ok(app.includes('abandonedViewsRef.current.add(fromViewId) try { selectView(targetId)'),
    'the mark is recorded before the switch, and a synchronous throw revokes it')
  assert.ok(app.includes('catch (error) { abandonedViewsRef.current.delete(fromViewId)'))
  assert.ok(app.includes('abandonedViewsRef.current.delete(viewId)'),
    'selectView revokes the mark (the user came back to that view)')
  assert.ok(app.includes("if (id === activeView || id === pendingViewRef.current) continue reclaimView(id, 'retention')"),
    'the disposal arm runs only after the view left the active slot')
  // 显式连接：锁在**函数体内**——全文件存在性会被 ensureRemoteConnected 里的同名
  // 字符串满足，而那条路径对 idle 源是 no-op（2026-12 复核 MAJOR-3）。
  const connect = sliceFrom(app, 'const connectSourceFromVeil', '}, [])')
  assert.ok(connect.includes('rawInstanceIdFromSourceId(viewId)'), 'the connect path resolves the raw id')
  assert.ok(connect.includes('ssh.connect(rawId)'), 'an explicit connect is a user action, not an auto-touch')
  assert.equal(connect.includes('ensureRemoteConnected'), false,
    'the phase-filtered auto-touch is a silent no-op for an idle source — never the connect CTA')
})

test('the App hands the view the decided facts and the App-owned callbacks', () => {
  const app = read('../../src/App.tsx')
  assert.ok(app.includes('sourcePhase={servers.find(server => server.id === viewId)?.phase}'))
  assert.ok(app.includes('bootDeferred={deferredBootIds.has(viewId)}'))
  assert.ok(app.includes('switchTargets={servers'), 'the view receives an already-decided target list')
  assert.ok(app.includes('onSwitchSource={targetId => switchSourceFromVeil(viewId, targetId)}'))
  assert.ok(app.includes('onConnectSource={() => connectSourceFromVeil(viewId)}'))
  assert.ok(app.includes('onRequestRetry={() => retryView(viewId)}'), 'retry must stay the single App entry')

})

// ── 3. InstanceView 接线 ───────────────────────────────────────────────────

test('the view composes the pure decisions and owns no retry/reconnect sequence', () => {
  const view = read('../../src/components/InstanceView.tsx')
  assert.ok(view.includes('isTerminalUnreadyPhase, shouldAnnounceRetryQueue, veilShowsActions, veilState,'),
    'the view imports the decisions, not a copy of them')
  assert.ok(view.includes("from '../source-readiness.ts'"))
  assert.ok(view.includes('const veil = veilState({ deferred: bootDeferred === true, settled, waitedMs })'))
  // settle 判据走 shell.ts 的唯一实现（回退成只比 booted 会恢复 W4 的排队谎报）。
  assert.equal((view.match(/isSettledShellState\(shell\)/g) ?? []).length, 3,
    'the view\'s three settle checks share the shell.ts predicate')
  assert.ok(view.includes('isSettledShellState,') && view.includes("from '../shell.ts'"))
  assert.ok(view.includes('const veilActions = veilShowsActions(veil)'))
  assert.ok(view.includes("const retryQueued = veil !== 'boot-deferred' && shouldAnnounceRetryQueue(queuedBehindPredecessorRef.current, settled)"),
    'the queue fact is the pure decision, gated off for a source that is not even booting')
  assert.ok(view.includes('queuedBehindPredecessorRef.current = !settledRef.current'),
    'the queue fact is sampled before the retry resets the local state (review F3)')
  // 推迟守卫 + 依赖：相位离开 idle 后 effect 必须自己重跑，否则 boot 永不开始。
  assert.ok(view.includes('if (bootDeferred === true) return'))
  assert.ok(view.includes('waitForServing, bootDeferred])'))
  // 动作只上报意图：重试/连接/切换的序列都在 App。
  assert.ok(view.includes('onClick={() => onRequestRetry?.()}'))
  assert.ok(view.includes('onClick={() => onConnectSource?.()}'))
  assert.ok(view.includes('onClick={() => onSwitchSource?.(target.id)}'))
  assert.ok(!view.includes('probeRemoteReady') && !view.includes('ensureRemoteConnected') && !view.includes('ssh.connect'),
    'the view must never hand-roll the retry/reconnect sequence')
  // 慢与死必须能区分：已等待时长可读，且只在"卡住"态出现（loading 态不报秒数）。
  assert.ok(view.includes("frameText(locale, 'boot.elapsed', { seconds: waitedSeconds })"))
  assert.equal(view.split("veilActions && veil === 'loading-stuck' && (").length - 1, 2,
    'both the elapsed line and the stuck/source-failed hint must stay gated on loading-stuck')
  // 排队事实一成立就可见：它绝不能挂在反馈窗门（veilActions）之下——那会让它恰好晚 10s。
  // 位置断言（索引顺序）而非存在性：把注释重新嵌回 `{veilActions && (…)}` 块内
  // 仍能满足"有 {retryQueued && ("（2026-12 复核 MINOR-5 的逃逸点）。
  const noteAt = view.indexOf('{retryQueued && (')
  const windowAt = view.indexOf('{veilActions && (')
  assert.ok(noteAt >= 0, 'the queue fact must render at all')
  assert.ok(windowAt >= 0, 'the feedback-window action block must exist')
  assert.ok(noteAt < windowAt, 'the queue note must sit OUTSIDE (before) the feedback-window gates')
  assert.ok(view.includes("const retryQueued = veil !== 'boot-deferred'"),
    'no queue note while the source is not connected (nothing is booting — review MINOR-2)')
  assert.equal(view.includes('{veilActions && retryQueued'), false)
  // 反馈窗门本身要锁数量：把它改成恒真门会让动作从第 0 秒就出现。
  assert.equal((view.match(/\{veilActions &&/g) ?? []).length, 5,
    'five render gates stay bound to the feedback window (elapsed / actions / stuck hint / switch row / reload hint)')
  assert.equal(view.includes('{true && ('), false, 'an action block must never be gated on a literal true')
  // 来源失败文案必须走纯判据（改成只比 error 会漏掉两个托管终态）。
  assert.ok(view.includes('const sourceFailed = isTerminalUnreadyPhase(sourcePhase)'))
  // 动作行要有 live-region 播报（a11y：动作出现本身是状态变化）。
  assert.ok(view.includes('<div className="instance-loading-actions" role="status">'))
  // 等待秒数按真实时钟推进：1s tick + 从 boot 起点重算（节流也只是推迟展示，不会算错）。
  const ticker = sliceFrom(view, 'const timer = setInterval(() => {', '}, [shell.booted')
  assert.ok(ticker.includes('Date.now() - startedAt'), 'elapsed time must be recomputed from the boot start, not counted')
  assert.ok(ticker.includes('1000'), 'the visible window advances on a 1s tick')
  // 切换行：没有目标就不画（空行会让人以为有可切换的来源），且必须渲染**全部**目标
  // （`slice(0, 1)` 只显示第一个也能满足"非空"断言——2026-12 复核 R2）。
  assert.ok(view.includes('switchTargets !== undefined && switchTargets.length > 0 && ('))
  assert.ok(view.includes('switchTargets.map(target => ('),
    'every decided switch target must be rendered, not a prefix')
  // 重试复位必须同时清掉可见秒数（只在下一次 boot effect 里清会闪一帧旧值）。
  assert.equal((view.match(/setWaitedMs\(0\)/g) ?? []).length, 2,
    'both the boot start and the retry reset clear the visible clock')
  // 遮罩合成与 holdVeil 语义不变——本轮只加呈现分支。
  assert.ok(view.includes('const veilVisible = !settled || holdVeil === true'))
})

test('the veil stays parseable-by-construction and the busy fact tracks actionability', () => {
  // 2026-12 复核 BLOCKER：`{cond && ( {/* comment */} <div/> )}` 是不合法语法
  // （JSX 注释只在 children 位合法），而**所有**触碰本文件的测试都按源码文本读它，
  // 于是这个语法错误穿过了 11/11 + 8/8 + 13/13 全绿。裸源码（不 stripComments）
  // 上钉住这条形状；真正的解析门是 `check:typecheck`（CI，本工作树无依赖跑不了）。
  const raw = readFileSync(fileURLToPath(new URL('../../src/components/InstanceView.tsx', import.meta.url)), 'utf8')
  // 形状不限 `veilVisible` 这个名字（改名即失效是 2026-12 复核 NIT-2 的指摘）；
  // 真正的解析门仍是 `check:typecheck`（CI），这里只挡这一类回归。
  assert.doesNotMatch(raw, /\{\s*[\w.]+\s*&&\s*\(\s*\{/,
    'a comment/expression must never open a JSX expression right after "{cond && ("')
  const view = read('../../src/components/InstanceView.tsx')
  assert.ok(view.includes('aria-busy={veilActions ? false : true}'),
    'the busy fact must drop once the veil is actionable (review F8)')
})

test('the actionable veil chrome is actually styled (unstyled actions would be unreachable)', () => {
  const css = read('../../src/styles.css')
  for (const cls of ['instance-loading-actions', 'instance-loading-servers', 'instance-loading-elapsed', 'instance-loading-note', 'instance-loading-reload']) {
    const selector = '.' + cls
    assert.ok(css.includes(selector + ',') || css.includes(selector + ' {'),
      selector + ' must appear as a selector (deleting the rule leaves the actions unstyled)')
  }
  // 规则体也要锁：空壳选择器（规则体被削成 display:block）比没有规则更糟——动作仍不可达。
  const mainRule = sliceFrom(css, '.instance-loading-main {', '}')
  assert.ok(mainRule.includes('overflow-y: auto'),
    'a short window must be able to scroll the action rows into view (review F9)')
  assert.ok(mainRule.includes('safe center'), 'overflow must not clip both ends of the centered column')
  const actionsRule = sliceFrom(css, '.instance-loading-actions, .instance-loading-servers {', '}')
  assert.ok(actionsRule.includes('display: flex') && actionsRule.includes('flex-wrap: wrap'),
    'the action rows must stay a wrapping flex row (unstyled buttons would overflow)')
  // 其余规则体也要锁：削成空壳会让对应元素失去排版（选择器还在，测试仍绿）。
  // 三类文本行共用同一条规则（逗号选择器），按合并选择器取体。
  const textRule = sliceFrom(css, '.instance-loading-elapsed, .instance-loading-note, .instance-loading-reload {', '}')
  assert.ok(textRule.includes('max-width') && textRule.includes('font-size'),
    'the veil text rows must keep their typography (a gutted body leaves them unstyled)')
})
