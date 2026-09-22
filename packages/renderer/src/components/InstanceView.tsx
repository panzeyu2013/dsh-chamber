/**
 * InstanceView — one dsh shell per instance (design 05: N-ctx).
 * The container div hosts a full AppWebEntry (independent cordis ctx + full
 * ui-* tree, connected to this instance through the /api/i/<id> proxy via the
 * base-path parameterized connection client). shell.ts installs immutable
 * instance facts into each entry Context; once booted the shell stays mounted
 * and switching is pure CSS hide/show.
 * 保留策略（design 05 / 偏差）：App 层不让隐藏壳无限常驻——
 * 超限的隐藏壳由 App 先 disposeInstanceShell 再从 mountedViews 移除，本组件
 * 随之卸载（回收语义与注册表删除一致，aliveRef 的卸载丢弃逻辑同时覆盖两种
 * 回收路径）；重开 = 重新挂载 + 冷 boot + entry 重放。本组件自身从不
 * dispose shell——卸载只发生在 App 已处置之后。
 * Switching is driven by the App layer wrapping the active-view change in a
 * View Transition (view-transition.ts): the previous view is captured as a
 * static snapshot that stays on screen until the incoming view is actually
 * painted — no black frame ever, including the incremental re-layout a hidden
 * shell pays on reveal when its content kept streaming while hidden (the
 * content-visibility render cache was invalidated by those DOM changes).
 * This component owns the per-view loading state: a full-area same-tone veil
 * (`.instance-loading`, design 05) shown while the shell boots. It carries no
 * layout-mimicking skeleton blocks (rail + sidebar placeholders): the real
 * sidebar width is layout-store persisted and
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
 * 遮罩不是无出口的纯转圈。多来源导航
 * （侧栏）在**壳内部**，App 级失败覆盖层又只在已 settle 的失败时出现——于是
 * 未 settle 的 boot 会形成一段没有任何导航的死区（最长由 135s 收割放弃臂
 * 兜底）。本组件因此持有遮罩的三条诚实通道：
 *  - 来源未连接（boot 被推迟）：遮罩直接是可操作态，给「连接」+ 切换来源；
 *  - 超过反馈窗仍未 settle：遮罩升级为可操作态——**不是**失败声明
 *    （失败由 App 覆盖层专有），只是把「还在等」变成「你可以走」；
 *  - 重试在途：如实播报同 id boot 尾的排队上限（`INSTANCE_TAIL_WAIT_CAP_MS`）。
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
import { createFrameCoalescer } from '../frame-coalescer.ts'
import {
  isTerminalUnreadyPhase, shouldAnnounceRetryQueue, VEIL_ACTIONS_AFTER_MS,
} from '../source-readiness.ts'
import { decidePresentation } from '@dsh-chamber/dsh-stream-state'
import {
  readSessionSurfacePhase, SESSION_PHASE_ATTRIBUTE,
  SURFACE_ABSENT_FALLBACK_MS,
  SURFACE_MAX_HOLD_MS,
  SURFACE_SAMPLE_MIN_INTERVAL_MS,
  type SessionSurfacePhase,
} from '../session-surface.ts'
import { frameText, type FrameLocale } from '../locales.ts'

/**
 * 单调时基：持有时钟与相位计窗都只做差值比较，绝不能
 * 受墙钟步进影响——NTP 校时/休眠唤醒把 `Date.now()` 拉回 10 分钟，会让"70s 外层保险"
 * 的定时器到期后算出负 elapsed、判定拒绝释放，而一次性定时器不会重臂：那次持有的有界
 * 出口就此静默消失。`performance.now()` 在渲染器里恒在，缺失时退回墙钟（测试/异常环境）。
 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

interface InstanceViewProps {
  instanceId: string
  basePath: string
  /** Immutable non-secret transport identity bound to this exact boot ctx. */
  sourceFingerprint: string
  /** Immutable transport mechanism for open-in and other per-entry capability gates. */
  transport: ChamberTransport
  /**
   * 本视图是否是**屏上那一个**（由 App 的 `paintedView` 驱动，不是选择
   * activeView）：选择与绘制分离后，点击目标但目标首帧未就绪期间旧视图仍是唯一
   * 可见面。本组件只消费该事实（可见性类 + 悬浮卡关闭 + settle 过渡节判定），
   * 不感知切换意图。
   */
  active: boolean
  /** 服务器显示名（骨架屏文案）。 */
  label: string
  /**
   * 框架文案语言：框架没有 `t` 席位，
   * App 用 locales.ts 的 typed 字典按文档语言解析后传入（本组件只渲染，
   * 不自己读文档语言，保证同一帧内所有 chamber chrome 用同一语言）。
   */
  locale: FrameLocale
  /** boot settle 回调（成功或失败均触发）：App 用于预热队列推进。 */
  onSettled?: (instanceId: string) => void
  /**
   * Shell 状态上报：每次 settle 落
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
   * 来源就绪门：交给实例 shell 的取图重试——实例仍在启动时
   * （冷启动 / 重启跨越窗口）先等它就绪再取客户端插件图，而不是在固定预算用尽后
   * 静默少一片插件（`ui-chat` 会因此永久 PENDING、对话视图不注册）。
   */
  waitForServing?: (instanceId: string) => Promise<boolean>
  /**
   * 打开意图揭示门：由 App 用共享纯规则
   * `shouldHoldViewVeil` 判定后传入的**最终判定**——遮罩在干净 settle 之后继续保留，
   * 直到该壳显示的会话就是要打开的那个为止（规则与两个输入都在 App：壳状态镜像 +
   * 原始 runtime current；本组件不自己合成遮罩可见性——它只把事实交给共享 arbiter
   * （`decidePresentation`）并消费帧里的 `veilVisible`/`mode`/`reevaluateInMs`，合成式与
   * 相位窗口都在那一个所有者处）。冷 boot 期间官方
   * 初始导航策略会新建并打开一个 blank 会话，而排队中的 open 要等
   * session-controller 子 fiber + 一次 400ms 重试才分发；壳失败时 App 永远传 false
   * （失败呈现归 App 覆盖层所有），因此遮罩不会挂住。
   */
  holdVeil?: boolean
  /**
   * 本次持有对应的**请求身份**（`openIntents[viewId]`，即要打开的那个 session id；无在途
   * 请求时不传）。持有窗必须随"请求换代"重置：同一视图里"点 A 未结束又点 B"会**替换**
   * 意图而不产生持有上升沿，若沿用 A 的窗口起点，新请求可能只剩很短（极端时立即过期）的
   * 兜底窗。同一个 id 重开不重置——那是同一个请求。
   */
  openIntentId?: string
  /**
   * 来源当前相位（`ChamberServerAggregate.phase`，字符串口径与 boot-gap.ts 一致）。
   * 只做文案与动作的事实输入：本组件绝不从相位推断"是否失败"。
   */
  sourcePhase?: string
  /**
   * boot 被推迟（来源未连接）：不启动 shell。相位离开 idle（用户点了
   * 「连接」）后本组件自动开始正常 boot。
   */
  bootDeferred?: boolean
  /**
   * App 的全局失败覆盖层正在渲染（`activeShellError !== null`）：覆盖层是模态的
   * 失败报告，此时遮罩（及其按钮/文案）必须**离开 DOM**——否则它仍可被 Tab 聚焦、
   * 被读屏播报（overlay 只保证视觉不透明；veil 自身是 view 隔离层，两者在过渡
   * 落地前的一两个帧内不同步）。
   */
  failureOverlayVisible?: boolean
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
  retryToken, waitForServing, holdVeil, openIntentId,
  sourcePhase, bootDeferred, failureOverlayVisible, switchTargets, onSwitchSource, onConnectSource, onRequestRetry,
}: InstanceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const startedRef = useRef(false)
  /** 每次 boot 尝试的令牌：丢弃被重试取代的迟到 settle。 */
  const bootTokenRef = useRef(0)
  // 卸载门控：视图被回收（注册表删除）后，在途 boot
  // 的 settle 仍会经 .then 回调——若不经门控上报，陈旧终态（如取消 boot 的
  // "shell disposed"）会写进 App 的 shellStates，在 remove→re-add 窗口内对
  // 新挂载视图的骨架屏盖上一个虚假的"实例启动失败"覆盖层。卸载即丢弃。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  // settle 时读取最新可见性（active = App 的 paintedView，读数必须在 settle
  // 到达时取，不能吃闭包里的旧值——持有窗内 settle 与揭示是两拍）。
  const activeRef = useRef(active)
  activeRef.current = active
  const [shell, setShell] = useState<ShellState>(() => shellStateIdle(instanceId, basePath))
  /** 本次尝试的开始时刻（已等待时长的基准）。null 只出现在"尚未发起这一次尝试"
   *  时——包括 boot 被推迟（`bootDeferred`）；首次 boot 之后每次重试都会重设它，
   *  不会回到 null。 */
  const bootStartedAtRef = useRef<number | null>(null)
  /** 已等待毫秒（仅未 settle 时按秒推进）。 */
  const [waitedMs, setWaitedMs] = useState(0)
  /** 渲染期镜像的 settle 事实（重试 effect 在复位**之前**读它，避免闭包依赖）。 */
  const settledRef = useRef(false)
  settledRef.current = isSettledShellState(shell)
  /**
   * 本次尝试是否排在"上一次未 settle 的 boot"后面（诚实播报的事实）。
   * 只有上一次尝试从未 settle 时同 id boot 尾才会挡住这次重试；失败后重试
   * 不排队，绝不能播报排队文案。
   */
  const queuedBehindPredecessorRef = useRef(false)
  /**
   * **本次持有**开始的时刻（遮罩兜底窗的基准）。必须是持有起点而**不是** shell 的
   * settle 时刻——温壳上 settle 早已是几分钟前，用它会令窗口在第一帧就过期、揭示门在
   * 温壳上整体失效。落成 state 而非 ref：依赖数组自洽。
   */
  const [holdStartedAt, setHoldStartedAt] = useState<number | null>(null)
  /** 容器内观察到的会话根相位（`[data-phase]` 的 DOM 事实，非 App 镜像）。 */
  const [surfacePhase, setSurfacePhase] = useState<SessionSurfacePhase>('absent')
  /**
   * 相位为 absent 时的**连续缺失起点**。会话根中途短暂
   * 消失（插件重注册、会话切换空档）不能让遮罩按"持有起点 + 2s"立刻揭幕、下一帧又回遮
   * ——那是"遮罩→露壳→遮罩"的闪动。null = 当前不是 absent（或窗口未开）。
   */
  const [absentSince, setAbsentSince] = useState<number | null>(null)
  /** 兜底释放窗到期后的重渲染触发器；决策本身仍是纯函数（可测）。 */
  const [surfaceFallbackTick, setSurfaceFallbackTick] = useState(0)

  useEffect(() => {
    // 来源未连接（手动断开）时绝不启动 shell——遮罩自身就是可操作态，
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
    // 本次尝试的令牌：重试后旧 boot 若迟到 settle，
    // 不得覆盖新尝试已经落地的健康状态。
    const bootToken = bootTokenRef.current + 1
    bootTokenRef.current = bootToken
    void bootInstanceShell(instanceId, basePath, el, setShell, sourceFingerprint, transport, {
      waitForServing,
      // 结算后补发的事实（5s 探针判词、延迟簇失败）必须到达 **App**：
      // shell 的 onState 形参是本视图的 React setter，只发它
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
      // settle 落地：屏上视图（activeRef = App 的 paintedView）用 View
      // Transition（骨架 → 内容/失败报告，或揭幕后的内容更新）；
      // 后台 boot（预热）即时落位——用户点击切换时的过渡由 App 层覆盖。
      // 键 'settle'：与视图切换流跨键隔离——settle 若被同键吞并
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
  // 等了多久，否则用户无法判断是慢还是死。
  useEffect(() => {
    if (isSettledShellState(shell) || bootDeferred === true) return
    const timer = setInterval(() => {
      const startedAt = bootStartedAtRef.current
      if (startedAt !== null) setWaitedMs(Date.now() - startedAt)
    }, 1000)
    return () => { clearInterval(timer) }
  }, [shell.booted, shell.error, bootDeferred, retryToken])

  const settled = isSettledShellState(shell)
  // 遮罩 = boot 期（未 settle）**或** App 判定的
  // 打开意图揭示门。判定规则（含"壳已经显示请求的会话就不遮"与"壳失败不遮"）在
  // sidebar 包 shared/open-intent.ts 内单测覆盖。
  // 会话面绘制信号：揭示门的"继续持有"以壳自己的 DOM 事实为准（`session-surface.ts`），
  // 不只由 App 侧两个异步镜像事实（runtimeFacts.current / aggregates 的 blank 行）决定
  // ——它们迟到或抖动时遮罩会挂在已渲染的壳上，最长烧满 open 预算（单次 8s、排队 68s），
  // 正是"白屏 / 直接显示载入中"交替的来源：
  // 会话根画到 `active`（真实会话面）即揭幕；hero/settling 保持遮罩（不闪空白"新
  // 会话"），absent（观察不到会话根，降级形态）以 2s 兜底、hero/settling 只留 70s
  // 外层保险——**窗口基准是本次持有的起点**，绝不是 shell 的 settle 时刻（温壳上后者
  // 早已是几分钟前，用它会让持有窗第一帧就过期、揭示门整体失效）。
  // 锚点是已登记的上游触点（scripts/upstream/mobile-anchors.mjs 的 data-phase）。
  // 第三个合取项仍是 App 拥有的失败覆盖层事实（模态；覆盖层在场时遮罩退出 DOM）。
  const surfaceHoldActive = settled && holdVeil === true && failureOverlayVisible !== true
  // 持有窗的开闭 —— 全模块唯一的时基来源。上升沿复位相位（上一代的 active 不得
  // 用于新持有）+ 记本次持有时钟；窗口关闭/重试即清空。观察器与兜底时钟都以它为界。
  useEffect(() => {
    if (!surfaceHoldActive) {
      setHoldStartedAt(null)
      setAbsentSince(null)
      return
    }
    const now = monotonicNow()
    setSurfacePhase('absent')
    setAbsentSince(now)
    setHoldStartedAt(now)
    // 下面这行相位复位只是**与 leaf 时钟门重复的保险**——真正的
    // 硬保证是 shouldReleaseVeilForSurface 里"时钟未建立绝不释放"；删掉本行不会立刻回归，
    // 删掉 leaf 那条才会（wiring 锁与 leaf 用例分别钉住两边）。
    // openIntentId（请求身份）进依赖：请求换代 = 新的一次持有，窗口从这一帧重新起算
    // （同 id 重开时身份不变，不重置）。
  }, [surfaceHoldActive, retryToken, openIntentId])
  //  ONE decision for everything the user sees: the boot veil's classification, the
  // surface hold and the fallback timer's re-arm
  // moment all come from this single frame, so the three can
  // not disagree — they are one computation over one threshold table.
  const presentation = decidePresentation(
    {
      settled,
      bootDeferred: bootDeferred === true,
      waitedMs,
      holdForOpenIntent: holdVeil === true,
      surfacePhase,
      holdStartedAtMs: holdStartedAt,
      absentSinceMs: absentSince,
      nowMs: monotonicNow(),
      failureOverlayVisible: failureOverlayVisible === true,
    },
    {
      veilActionsAfterMs: VEIL_ACTIONS_AFTER_MS,
      // Both read from their owners, not re-typed: the arbiter's table is data.
      surfaceMaxHoldMs: SURFACE_MAX_HOLD_MS,
      surfaceAbsentFallbackMs: SURFACE_ABSENT_FALLBACK_MS,
    },
  )
  // 相位观察器在**整个持有窗**内运行（不因一次释放而断开）。释放是"电平"而不是
  // "闩锁"：官方初始导航可能先显示持久化的真实会话（active）再复用/新建 blank 会话
  // （相位回 hero），此时空白"新会话"仍必须被遮住——观察器一旦在首次释放时断开，相位
  // 就永远冻结在 active，遮罩再也回不来。来回抖动被
  // 持有窗本身（open 生命周期 ≤ 8s / 外层 70s）限制；窗口结束即断开，绝不为整个生命
  // 周期挂 subtree 观察器。相位只在 rAF 节流后落 state。
  useEffect(() => {
    if (!surfaceHoldActive) return
    const el = containerRef.current
    if (el === null) return
    // 采样合并：boot 窗口里 DOM 变更密集，
    // "每次变更排一帧" 等于每帧一次 setState（React 同步 commit 就发生在 rAF
    // 回调里）。合并器保证"首个变更下一帧、其后每
    // SURFACE_SAMPLE_MIN_INTERVAL_MS 一次、尾部必采"，相位语义不变。
    const sampler = createFrameCoalescer({
      minIntervalMs: SURFACE_SAMPLE_MIN_INTERVAL_MS,
      sample: (): void => {
        const next = readSessionSurfacePhase(el)
        setSurfacePhase(prev => (prev === next ? prev : next))
        // 连续缺失起点只在"缺席开始"那一帧落一次，根回来后清空；同值返回原引用不触发渲染。
        setAbsentSince(prev => {
          if (next !== 'absent') return prev === null ? prev : null
          return prev === null ? monotonicNow() : prev
        })
      },
    })
    sampler.request()
    const observer = new MutationObserver(() => sampler.request())
    observer.observe(el, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [SESSION_PHASE_ATTRIBUTE],
    })
    return () => {
      observer.disconnect()
      sampler.cancel()
    }
    // deps 只认持有窗、容器更换与请求换代：释放是一次"电平翻转"，观察器必须继续活着
    // （注释里那句"不因一次释放而断开"要字面成立），把 surfaceRelease 放进依赖只会白白
    // teardown/重订阅；openIntentId 需要重订阅，是为了换代时立刻重采一次相位（否则新请求
    // 的窗口会停在复位后的 'absent' 上等下一次 DOM 变更）。
  }, [surfaceHoldActive, retryToken, openIntentId])
  // 兜底时钟（两档上界，与判定窗同基准 = 本次持有起点）。absent = 观察不到会话根
  // （ui-chat 未注册等降级形态）2s 即揭；hero/settling = 保持，只留 70s 外层保险（> 68s
  // 排队预算，正常路径由 App 的 open 生命周期先释放意图）。延时扣除已走过部分，避免
  // "窗口已到期但定时器未到"把持有拖长。
  useEffect(() => {
    if (!surfaceHoldActive || holdStartedAt === null) return
    // The delay IS the frame's own re-arm moment; recomputing it here from thresholds
    // would be a second copy that could drift from the judge's.
    const delay = presentation.reevaluateInMs
    // A non-finite moment means the frame already settled the question (revealed, or
    // deferred/unbounded): arming setTimeout(Infinity) would fire immediately and spin,
    // so arm nothing — a state change re-renders through this effect anyway.
    if (!Number.isFinite(delay)) return
    const handle = setTimeout(
      () => setSurfaceFallbackTick(tick => tick + 1),
      delay,
    )
    return () => { clearTimeout(handle) }
    // surfaceFallbackTick 进依赖是加固：定时器若被浏览器提前触发（或判定
    // 因别的原因此刻不放行），"没有释放"的 tick 必须重臂一次，否则本次持有的外层保险
    // 就此消失。单调钟下重臂不会空转：真正到期后判定必然放行，持有窗随之关闭。
  }, [surfaceHoldActive, holdStartedAt, absentSince, surfacePhase, surfaceFallbackTick])
  const veilActions = presentation.actions
  // The veil is the frame's answer, verbatim: shown while booting, while a held intent
  // has not released, and never under the failure overlay.
  const veilVisible = presentation.veilVisible
  // 只有**前一次尝试尚未 settle**时重试才排队；那种情况必须如实播报。
  // 推迟态（来源未连接）例外：那儿根本没有 boot 在跑，"排队"会和「未连接 + 连接」
  // 自相矛盾。
  const retryQueued = presentation.mode !== 'deferred'
    && shouldAnnounceRetryQueue(queuedBehindPredecessorRef.current, settled)
  const waitedSeconds = String(Math.round(waitedMs / 1000))
  const retryQueueSeconds = String(Math.round(INSTANCE_TAIL_WAIT_CAP_MS / 1000))
  const sourceFailed = isTerminalUnreadyPhase(sourcePhase)
  // 遮罩在**已 settle** 的壳上仍然可见，就是打开意图
  // 揭示门在持有它（boot 期 settled 为假）——这段时间遮罩是唯一可见面，租客整体
  // 不可见。判断耦合的是合成后的 veilVisible 而不是 holdVeil 入参：会话面
  // 信号一旦释放遮罩，同一 commit 里壳也跟着恢复可见，绝不出现"遮罩没了壳还藏着"。
  // 类挂在**外层视图 div** 上——容器 div 的 JSX 被 baseline-harvest 用例逐字钉住。
  const shellHeld = settled && veilVisible
  const viewClass = active
    ? 'instance-view'
    : settled
      ? 'instance-view instance-hidden'
      : 'instance-view instance-pending'

  // 视图一离开活动态就套上 .instance-pending /
  // .instance-hidden（上面 viewClass），而行悬浮卡被 portal 到 document.body——
  // 它**不在**本视图 DOM 内，所以 visibility:hidden + pointer-events:none 既不会
  // 把卡藏起来，也不会给卡送来任何指针事件：指针停在卡上时切视图，卡会一直画在
  // 新视图之上，直到下一次指针移动（判据见
  // docs/design/06-sidebar-enhancements.md  的视图隐藏关闭条）。
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
    <div className={shellHeld ? `${viewClass} instance-veil-held` : viewClass} data-instance={instanceId}>
      {/* 每次重试换一个容器元素：上一个尝试若挂死,
          它的 AppWebEntry 仍持有旧容器——复用同一个 div 会让第二次尝试把新的
          boot 页/React root 追加进已有 root 的容器里（shell.ts 头注的
          "一容器一 root" 不变量）。旧容器随 key 变更被 React 摘除，挂死尝试
          写进的是已脱离文档的节点。 */}
      <div key={retryToken ?? 0} ref={containerRef} className="instance-shell" />
      {/* a11y：动作出现后遮罩不是"纯忙"区域——`aria-busy`
          会把区域的更新播报压后，正好盖住我们要用户看见的重试/连接/切换。
          （本节选位置必须是 JSX children，不能塞进 `{veilVisible && (…)}` 的
          表达式位置——那是不合法语法。）
          排队文案同理：它在反馈窗**之外**，若容器仍是 aria-busy=true，读屏会把
          这条恰好该立刻播报的更新压到 10s 后。 */}
      {veilVisible && (
        <div className="instance-loading" aria-busy={veilActions || retryQueued ? false : true}>
          <div className="instance-loading-main">
            {/* a11y: the spinner is pure
                decoration — the adjacent title already announces the state, so
                it must stay out of the accessibility tree
                (aria-busy on the veil carries the busy fact). */}
            <div className="instance-loading-spinner" aria-hidden="true" />
            <div className="instance-loading-title">
              {presentation.mode === 'deferred'
                ? frameText(locale, 'boot.deferred', { label })
                : frameText(locale, 'boot.loading', { label })}
            </div>
            <div className="instance-loading-hint">
              {presentation.mode === 'deferred'
                ? frameText(locale, 'boot.deferredHint')
                : frameText(locale, 'boot.loadingHint')}
            </div>
            {/* 超过反馈窗后，遮罩把"还在等"变成"你可以走"——**不是**失败
                声明（失败由 App 的 .fatal-overlay 专有，两者结构互斥）。 */}
            {veilActions && presentation.mode === 'loading-stuck' && (
              <div className="instance-loading-elapsed">
                {frameText(locale, 'boot.elapsed', { seconds: waitedSeconds })}
              </div>
            )}
            {/* 排队事实一成立就播报——它挂在反馈窗（`VEIL_ACTIONS_AFTER_MS`）之外：
                "点了重试却先等 10 秒看不到任何解释"正是这条文案要消除的形态
                （放进动作块会让它恰好晚 10s 出现）。 */}
            {retryQueued && (
              <div className="instance-loading-note" role="status">
                {frameText(locale, 'boot.retryQueued', { seconds: retryQueueSeconds })}
              </div>
            )}
            {veilActions && (
              <div className="instance-loading-actions" role="status">
                {presentation.mode === 'deferred' ? (
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
            {veilActions && presentation.mode === 'loading-stuck' && (
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
