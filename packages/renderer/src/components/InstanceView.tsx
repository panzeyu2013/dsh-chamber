/**
 * InstanceView — one dsh shell per instance (design 05 §1: N-ctx).
 * The container div hosts a full AppWebEntry (independent cordis ctx + full
 * ui-* tree, connected to this instance through the /api/i/<id> proxy via the
 * base-path parameterized connection client). shell.ts installs immutable
 * instance facts into each entry Context; once booted the shell stays mounted
 * and switching is pure CSS hide/show.
 *
 * 保留策略（2026 性能整改，05 §1/§4 偏差）：App 层不再让隐藏壳无限常驻——
 * 超限的隐藏壳由 App 先 disposeInstanceShell 再从 mountedViews 移除，本组件
 * 随之卸载（回收语义与注册表删除一致，aliveRef 的卸载丢弃逻辑同时覆盖两种
 * 回收路径）；重开 = 重新挂载 + 冷 boot + entry 重放。本组件自身从不
 * dispose shell——卸载只发生在 App 已处置之后。
 *
 * Switching is driven by the App layer wrapping the active-view change in a
 * View Transition (view-transition.ts): the previous view is captured as a
 * static snapshot that stays on screen until the incoming view is actually
 * painted — no black frame ever, including the incremental re-layout a hidden
 * shell pays on reveal when its content kept streaming while hidden (the
 * content-visibility render cache was invalidated by those DOM changes).
 *
 * This component owns the per-view loading state: a full-area same-tone veil
 * (`.instance-loading`, design 05 §4) shown while the shell boots. Perf T1
 * (2026-09, D1=A) dropped the layout-mimicking skeleton blocks (rail + sidebar
 * placeholders): the real sidebar width is layout-store persisted and
 * user-draggable, so a fixed 280px mock geometry mismatched widened instances
 * and could shift the main-area left edge on settle reveal (CLS on the
 * reduced-motion/degraded paths). The veil makes no geometric claim. It covers
 * the dsh in-shell boot page (z-index above the shell), so no opacity tricks
 * are needed. When the boot settles, the settle state is applied through a
 * second View Transition (veil → real UI, or the failure report + retry).
 * Background-booted views (idle prewarm, or a view the user left mid-boot)
 * use `.instance-pending`: visibility-only hidden, layout kept alive so the
 * vendor shells' measurement / IntersectionObserver machinery works during
 * boot.
 *
 * 2026-12（boot 死区收敛 W1/W2/W4）：遮罩不再是无出口的纯转圈。多来源导航
 * （侧栏）在**壳内部**，App 级失败覆盖层又只在已 settle 的失败时出现——于是
 * 未 settle 的 boot 会形成一段没有任何导航的死区（最长由 135s 收割放弃臂
 * 兜底）。本组件因此持有遮罩的三条诚实通道：
 *  - 来源未连接（boot 被推迟，W2）：遮罩直接是可操作态，给「连接」+ 切换来源；
 *  - 超过反馈窗仍未 settle（W1）：遮罩升级为可操作态——**不是**失败声明
 *    （失败由 App 覆盖层专有），只是把「还在等」变成「你可以走」；
 *  - 重试在途（W4）：如实播报同 id boot 尾的排队上限（`INSTANCE_TAIL_WAIT_CAP_MS`）。
 * 决策全部来自纯模块 `source-readiness.ts`，本组件只做接线与呈现。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { dismissVisibleRowCard } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import {
  bootInstanceShell, INSTANCE_TAIL_WAIT_CAP_MS, shellStateIdle,
  type ChamberTransport, type ShellState,
  isSettledShellState,
} from '../shell.ts'
import { runViewTransition } from '../view-transition.ts'
import {
  isTerminalUnreadyPhase, shouldAnnounceRetryQueue, veilShowsActions, veilState,
} from '../source-readiness.ts'
import { frameText, type FrameLocale } from '../locales.ts'

export interface InstanceViewProps {
  instanceId: string
  basePath: string
  /** Immutable non-secret transport identity bound to this exact boot ctx. */
  sourceFingerprint: string
  /** Immutable transport mechanism for open-in and other per-entry capability gates. */
  transport: ChamberTransport
  active: boolean
  /** 服务器显示名（骨架屏文案）。 */
  label: string
  /**
   * 框架文案语言（T16 2026-09-11 upstream-alignment）：框架没有 `t` 席位，
   * App 用 locales.ts 的 typed 字典按文档语言解析后传入（本组件只渲染，
   * 不自己读文档语言，保证同一帧内所有 chamber chrome 用同一语言）。
   */
  locale: FrameLocale
  /** boot settle 回调（成功或失败均触发）：App 用于预热队列推进。 */
  onSettled?: (instanceId: string) => void
  /**
   * Shell 状态上报（chamber 2026-08，05 §4 失败呈现修订）：每次 settle 落
   * 地后把最终 ShellState 报给 App——失败呈现（失败报告 + 重试 + 服务器
   * 切换）由 App 在活动视图上统一渲染（覆盖层），InstanceView 自身不再
   * 画失败面板。非活动视图的失败在激活时才呈现。
   */
  onStateChange?: (instanceId: string, state: ShellState) => void
  /**
   * 重试令牌：App 的失败覆盖层「重试」按钮递增它；变化时本视图复位
   * boot 状态并重新启动 shell（先前的 entry 已由 shell.ts 在失败分支
   * dispose，重 boot 干净）。
   */
  retryToken?: number
  /**
   * 来源就绪门（2026-09-10）：交给实例 shell 的取图重试——实例仍在启动时
   * （冷启动 / 重启跨越窗口）先等它就绪再取客户端插件图，而不是在固定预算用尽后
   * 静默少一片插件（`ui-chat` 会因此永久 PENDING、对话视图不注册）。
   */
  waitForServing?: (instanceId: string) => Promise<boolean>
  /**
   * 打开意图揭示门（2026-12，design 05 §2.2 修订；真机问题 1）：由 App 用共享纯规则
   * `shouldHoldViewVeil` 判定后传入的**最终判定**——遮罩在干净 settle 之后继续保留，
   * 直到该壳显示的会话就是要打开的那个为止（规则与两个输入都在 App：壳状态镜像 +
   * 原始 runtime current；本组件只负责合成 `!settled || holdVeil`）。冷 boot 期间官方
   * 初始导航策略会新建并打开一个 blank 会话，而排队中的 open 要等
   * session-controller 子 fiber + 一次 400ms 重试才分发；壳失败时 App 永远传 false
   * （失败呈现归 App 覆盖层所有），因此遮罩不会挂住。
   */
  holdVeil?: boolean
  /**
   * 来源当前相位（`ChamberServerAggregate.phase`，字符串口径与 boot-gap.ts 一致）。
   * 只做文案与动作的事实输入：本组件绝不从相位推断"是否失败"。
   */
  sourcePhase?: string
  /**
   * boot 被推迟（来源未连接，W2）：不启动 shell。相位离开 idle（用户点了
   * 「连接」）后本组件自动开始正常 boot。
   */
  bootDeferred?: boolean
  /**
   * 可切换的来源（除本视图外的全部来源；与失败覆盖层的 `.fatal-servers` 同款
   * "chamber 级逃生通道"）。空数组 = 不渲染切换行。
   */
  switchTargets?: ReadonlyArray<{ id: string; label: string }>
  /**
   * 遮罩动作：切换到另一来源。App 拥有导航与回收顺序（先切、落地后再拆，
   * 见 App 的 abandoned 账本）——本组件只上报意图。
   */
  onSwitchSource?: (targetId: string) => void
  /**
   * 遮罩动作：连接该来源（显式用户意图，与设置页 Connect 同语义；idle 的
   * 手动断开语义正是靠"只有显式动作才触碰"来守恒）。
   */
  onConnectSource?: () => void
  /**
   * 遮罩动作：重试 boot。**必须**走 App 的唯一入口 `retryView`（探测 + 隧道
   * 再试 + 令牌递增），本组件绝不自己重写那条序列。
   */
  onRequestRetry?: () => void
}

export default function InstanceView({
  instanceId, basePath, sourceFingerprint, transport, active, label, locale, onSettled, onStateChange,
  retryToken, waitForServing, holdVeil,
  sourcePhase, bootDeferred, switchTargets, onSwitchSource, onConnectSource, onRequestRetry,
}: InstanceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const startedRef = useRef(false)
  /** 每次 boot 尝试的令牌：丢弃被重试取代的迟到 settle。 */
  const bootTokenRef = useRef(0)
  // 卸载门控（2026-08 review 加固）：视图被回收（注册表删除）后，在途 boot
  // 的 settle 仍会经 .then 回调——若不经门控上报，陈旧终态（如取消 boot 的
  // "shell disposed"）会写进 App 的 shellStates，在 remove→re-add 窗口内对
  // 新挂载视图的骨架屏盖上一个虚假的"实例启动失败"覆盖层。卸载即丢弃。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  // settle 时读取最新可见性（boot 期间视图可能被点击激活——避免用闭包里的旧值）。
  const activeRef = useRef(active)
  activeRef.current = active
  const [shell, setShell] = useState<ShellState>(() => shellStateIdle(instanceId, basePath))
  /** 本次尝试的开始时刻（已等待时长的基准）。null 只出现在"尚未发起这一次尝试"
   *  时——包括 boot 被推迟（`bootDeferred`）；首次 boot 之后每次重试都会重设它，
   *  不会回到 null（2026-12 复核：旧注释写成"尚未发起 = boot 被推迟"，失真）。 */
  const bootStartedAtRef = useRef<number | null>(null)
  /** 已等待毫秒（仅未 settle 时按秒推进）。 */
  const [waitedMs, setWaitedMs] = useState(0)
  /** 渲染期镜像的 settle 事实（重试 effect 在复位**之前**读它，避免闭包依赖）。 */
  const settledRef = useRef(false)
  settledRef.current = isSettledShellState(shell)
  /**
   * 本次尝试是否排在"上一次未 settle 的 boot"后面（W4 诚实播报的事实）。
   * 只有上一次尝试从未 settle 时同 id boot 尾才会挡住这次重试；失败后重试
   * 不排队，绝不能播报排队文案（2026-12 复核 F3）。
   */
  const queuedBehindPredecessorRef = useRef(false)

  useEffect(() => {
    // W2：来源未连接（手动断开）时绝不启动 shell——遮罩自身就是可操作态，
    // 一次注定吃满 503 预算的 boot 不该发生。相位离开 idle（用户点了
    // 「连接」）会让 bootDeferred 翻假，本 effect 随之重跑。
    if (bootDeferred === true) return
    if (startedRef.current || shell.booted || shell.booting) return
    const el = containerRef.current
    // 先取容器再置位：ref 挂载前（理论上首帧不可能，防御）不置 started，
    // 否则容器一旦为 null，本视图永远不再尝试 boot。
    if (el === null) return
    startedRef.current = true
    bootStartedAtRef.current = Date.now()
    setWaitedMs(0)
    // 本次尝试的令牌（2026-12 复查 MINOR）：重试后旧 boot 若迟到 settle，
    // 不得覆盖新尝试已经落地的健康状态。
    const bootToken = bootTokenRef.current + 1
    bootTokenRef.current = bootToken
    void bootInstanceShell(instanceId, basePath, el, setShell, sourceFingerprint, transport, {
      waitForServing,
      // 结算后补发的事实（5s 探针判词、延迟簇失败）必须到达 **App**（2026-12
      // BLOCKER 修复）：shell 的 onState 形参是本视图的 React setter，只发它
      // 就只重渲染本视图（settled 已为真，DOM 无变化），App 的 shellStates 镜像
      // ——横幅、侧栏/连接页投射、每 ready 世代一次的自愈全都读它——永远收不到。
      // 因此单列一条 App 向的汇道，且只由这条**过栅栏的结算后路径**调用：boot
      // 自身的结算前发布（before、被取代/阻塞的失败）仍不进 App 镜像。
      onRepublish: onStateChange === undefined ? undefined : (id, next) => onStateChange(id, next),
    }).then((next) => {
      // 卸载后到达的 settle 一律丢弃（视图已回收，App 已清理该视图状态；
      // 陈旧上报会污染重加视图的失败覆盖层判定）；被更新的尝试取代的迟到
      // settle 同样丢弃。
      if (!aliveRef.current || bootToken !== bootTokenRef.current) return
      // settle 落地：可见视图用 View Transition（骨架 → 内容/失败报告）；
      // 后台 boot（预热）即时落位——用户点击切换时的过渡由 App 层覆盖。
      // 键 'settle'（perf T2）：与视图切换流跨键隔离——settle 若被同键吞并
      // 会导致骨架 veil 永驻；同视图连续 settle（重试链）单槽合并。
      if (activeRef.current) runViewTransition(() => setShell(next), 'settle')
      else setShell(next)
      onSettled?.(instanceId)
      // 失败呈现由 App 统一负责（覆盖层）：每次 settle 上报最终状态。
      onStateChange?.(instanceId, next)
    })
  }, [instanceId, basePath, sourceFingerprint, transport, shell, onSettled, onStateChange, waitForServing, bootDeferred])

  // 重试令牌：App 失败覆盖层的「重试」→ 递增令牌 → 复位 boot 状态，boot
  // effect 观察 shell 变化重新启动。
  const lastRetryTokenRef = useRef(retryToken)
  useEffect(() => {
    if (retryToken === lastRetryTokenRef.current) return
    lastRetryTokenRef.current = retryToken
    // 复位之前取样：上一次尝试若已 settle（成功或失败），同 id boot 尾已释放，
    // 这次重试不排队；只有未 settle 的前代才会让这次尝试等在尾上。
    queuedBehindPredecessorRef.current = !settledRef.current
    startedRef.current = false
    // 立刻清掉上一代的可见秒数：只在下一次 boot effect 里清会让重置那一帧
    // 仍画着旧值（可能 ≥10s，短暂出现一个不属于本次尝试的"已等待"）。
    setWaitedMs(0)
    const next = shellStateIdle(instanceId, basePath)
    setShell(next)
    onStateChange?.(instanceId, next)
  }, [retryToken, instanceId, basePath, onStateChange])

  // 已等待时长：只在未 settle 且 boot 已发起时走秒——「仍在加载」必须能显示
  // 等了多久（W1），否则用户无法判断是慢还是死。
  useEffect(() => {
    if (isSettledShellState(shell) || bootDeferred === true) return
    const timer = setInterval(() => {
      const startedAt = bootStartedAtRef.current
      if (startedAt !== null) setWaitedMs(Date.now() - startedAt)
    }, 1000)
    return () => { clearInterval(timer) }
  }, [shell.booted, shell.error, bootDeferred, retryToken])

  const settled = isSettledShellState(shell)
  // 2026-12（design 05 §2.2 修订）：遮罩 = boot 期（未 settle）**或** App 判定的
  // 打开意图揭示门。判定规则（含"壳已经显示请求的会话就不遮"与"壳失败不遮"）在
  // sidebar 包 shared/open-intent.ts 内单测覆盖；遮罩的生命周期由 open promise
  // 自身界定（dispatchOpen 8s 预算 + App 的 finally 释放），不会出现挂住的加载层。
  const veilVisible = !settled || holdVeil === true
  // W1/W2/W4：遮罩呈现分类（决策全在 source-readiness.ts）。这里**不改**
  // veilVisible 的合成——它属于会话意图门（holdVeil）与本地 boot 状态的契约。
  const veil = veilState({ deferred: bootDeferred === true, settled, waitedMs })
  const veilActions = veilShowsActions(veil)
  // W4：只有**前一次尝试尚未 settle**时重试才排队；那种情况必须如实播报。
  // 推迟态（来源未连接）例外：那儿根本没有 boot 在跑，"排队"会和「未连接 + 连接」
  // 自相矛盾（2026-12 复核 MINOR-2：App 覆盖层重试后来源转 idle 可以走到这里）。
  const retryQueued = veil !== 'boot-deferred'
    && shouldAnnounceRetryQueue(queuedBehindPredecessorRef.current, settled)
  const waitedSeconds = String(Math.round(waitedMs / 1000))
  const retryQueueSeconds = String(Math.round(INSTANCE_TAIL_WAIT_CAP_MS / 1000))
  const sourceFailed = isTerminalUnreadyPhase(sourcePhase)
  const viewClass = active
    ? 'instance-view'
    : settled
      ? 'instance-view instance-hidden'
      : 'instance-view instance-pending'

  // chamber (2026-12 悬浮卡修复): 视图一离开活动态就套上 .instance-pending /
  // .instance-hidden（上面 viewClass），而行悬浮卡被 portal 到 document.body——
  // 它**不在**本视图 DOM 内，所以 visibility:hidden + pointer-events:none 既不会
  // 把卡藏起来，也不会给卡送来任何指针事件：指针停在卡上时切视图，卡会一直画在
  // 新视图之上，直到下一次指针移动（判据是仓内用例：
  // packages/renderer/test/wiring/hover-card-view-hide-wiring.test.ts；设计侧见
  // docs/design/06-sidebar-enhancements.md §7 的视图隐藏关闭条）。
  // 因此在**同一个 commit**（useLayoutEffect = 绘制前）显式关掉页级唯一那张卡。
  // 只认 active 的 true→false 跳变：后台预热/后台 boot 的视图挂载时本就是非活动
  // 态，若按"非活动即关"会把活动视图里用户正悬停的卡误关。
  // dismissVisibleRowCard() 不接收句柄——它只关当前持有页级槽位的那台状态机，
  // 没有卡打开时是 no-op（sidebar 包 shared/hover-intent.ts）。
  const wasActiveRef = useRef(active)
  useLayoutEffect(() => {
    if (wasActiveRef.current === active) return
    wasActiveRef.current = active
    if (!active) dismissVisibleRowCard()
  }, [active])

  return (
    <div className={viewClass} data-instance={instanceId}>
      {/* 每次重试换一个容器元素（2026-12 复查 MAJOR）：上一个尝试若挂死，
          它的 AppWebEntry 仍持有旧容器——复用同一个 div 会让第二次尝试把新的
          boot 页/React root 追加进已有 root 的容器里（shell.ts 头注的
          "一容器一 root" 不变量）。旧容器随 key 变更被 React 摘除，挂死尝试
          写进的是已脱离文档的节点。 */}
      <div key={retryToken ?? 0} ref={containerRef} className="instance-shell" />
      {/* a11y（2026-12 复核 F8）：动作出现后遮罩不再是"纯忙"区域——`aria-busy`
          会把区域的更新播报压后，正好盖住我们要用户看见的重试/连接/切换。
          （本节选位置必须是 JSX children，不能塞进 `{veilVisible && (…)}` 的
          表达式位置——那是不合法语法，2026-12 复核 BLOCKER。） */}
      {veilVisible && (
        <div className="instance-loading" aria-busy={veilActions ? false : true}>
          <div className="instance-loading-main">
            {/* a11y (2026-09-11 upstream-alignment nit): the spinner is pure
                decoration — the adjacent title already announces the state, so
                it must stay out of the accessibility tree
                (aria-busy on the veil carries the busy fact). */}
            <div className="instance-loading-spinner" aria-hidden="true" />
            <div className="instance-loading-title">
              {veil === 'boot-deferred'
                ? frameText(locale, 'boot.deferred', { label })
                : frameText(locale, 'boot.loading', { label })}
            </div>
            <div className="instance-loading-hint">
              {veil === 'boot-deferred'
                ? frameText(locale, 'boot.deferredHint')
                : frameText(locale, 'boot.loadingHint')}
            </div>
            {/* W1：超过反馈窗后，遮罩把"还在等"变成"你可以走"——**不是**失败
                声明（失败由 App 的 .fatal-overlay 专有，两者结构互斥）。 */}
            {veilActions && veil === 'loading-stuck' && (
              <div className="instance-loading-elapsed">
                {frameText(locale, 'boot.elapsed', { seconds: waitedSeconds })}
              </div>
            )}
            {/* W4：排队事实一成立就播报——它挂在反馈窗（`VEIL_ACTIONS_AFTER_MS`）之外：
                "点了重试却先等 10 秒看不到任何解释"正是这条文案要消除的形态
                （2026-12 复核：放进动作块会让它恰好晚 10s 出现）。 */}
            {retryQueued && (
              <div className="instance-loading-note" role="status">
                {frameText(locale, 'boot.retryQueued', { seconds: retryQueueSeconds })}
              </div>
            )}
            {veilActions && (
              <div className="instance-loading-actions" role="status">
                {veil === 'boot-deferred' ? (
                  <Button variant="primary" onClick={() => onConnectSource?.()}>
                    {frameText(locale, 'action.connect')}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => onRequestRetry?.()}>
                    {frameText(locale, 'action.retry')}
                  </Button>
                )}
              </div>
            )}
            {veilActions && veil === 'loading-stuck' && (
              <div className="instance-loading-note">
                {sourceFailed
                  ? frameText(locale, 'boot.sourceFailedHint')
                  : frameText(locale, 'boot.stuckHint')}
              </div>
            )}
            {veilActions && switchTargets !== undefined && switchTargets.length > 0 && (
              <div className="instance-loading-servers">
                <span className="muted small">{frameText(locale, 'action.switchServer')}</span>
                {switchTargets.map(target => (
                  <Button key={target.id} variant="outline" onClick={() => onSwitchSource?.(target.id)}>
                    {target.label !== '' ? target.label : target.id}
                  </Button>
                ))}
              </div>
            )}
            {veilActions && (
              <div className="instance-loading-reload">{frameText(locale, 'boot.reloadHint')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
