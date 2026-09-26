/**
 * InstanceView — one dsh shell per instance (N-ctx): the container hosts a full
 * AppWebEntry connected through the /api/i/<id> proxy; the shell stays mounted
 * and switching is pure CSS hide/show. 保留策略：超限隐藏壳由 App 先 dispose
 * 再卸载本组件——本组件从不 dispose shell。
 * The component owns the loading veil (`.instance-loading`): full-area, same-tone,
 * NO skeleton blocks (the real sidebar width is persisted and user-draggable, so
 * a fixed mock geometry would mismatch); settle applies a second View Transition.
 * Background views use `.instance-pending` (visibility-only, layout alive for
 * vendor measurement). The veil's three honest exits: not connected → actionable
 * connect face; past the feedback window → actionable, NOT a failure claim
 * (failure belongs to the App overlay); retry in flight → announce the same-id
 * tail wait cap.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { dismissVisibleRowCard } from '@dsh-chamber/dsh-chamber-client-core'
import {
  bootInstanceShell, INSTANCE_TAIL_WAIT_CAP_MS, shellStateIdle,
  readInstanceSessionStreamHealth, readInstanceOpeningFailure, rebuildInstanceSessionStream,
  type ChamberTransport, type ShellState,
  isSettledShellState,
} from '../shell.ts'
import { runViewTransition } from '../view-transition.ts'
import { createFrameCoalescer } from '../frame-coalescer.ts'
import {
  isTerminalUnreadyPhase, shouldAnnounceRetryQueue,
} from '../source-readiness.ts'
import { decidePresentation, planVeilTimer, PRESENTATION_THRESHOLDS } from '@dsh-chamber/dsh-stream-state'
import {
  readSessionSurfacePhase, SESSION_PHASE_ATTRIBUTE,
  SURFACE_SAMPLE_MIN_INTERVAL_MS,
  type SessionSurfacePhase,
} from '../session-surface.ts'
import { frameText, type FrameLocale } from '../locales.ts'
import { monotonicNow } from '../monotonic-now.ts'
import {
  advanceSessionOpenHealth, presentedSessionOpenRecoveryPhase,
  type SessionOpenHealth, type SessionOpenRecoveryPhase,
} from '../session-open-recovery.ts'
import { createSessionDeliveryOwner } from '../session-delivery-state.ts'
import { activeSymptomSinceMs, advanceContentStallStreak, openStallSymptomActive, stuckEvidenceForStreak, type ContentStallStreak } from '../session-content-stall.ts'
import { documentReloadBudgetStorage, shouldReloadDocument } from '../document-reload-budget.ts'
import { readRendererStallStrikes } from '../renderer-stall-evidence.ts'

interface InstanceViewProps {
  instanceId: string
  basePath: string
  /** Immutable non-secret transport identity bound to this exact boot ctx. */
  sourceFingerprint: string
  /** Immutable transport mechanism for open-in and other per-entry capability gates. */
  transport: ChamberTransport
  /**
   * 本视图是否是**屏上那一个**（App 的 `paintedView`，非选择 activeView）：
   * 本组件只消费该事实（可见性类 + 悬浮卡关闭 + settle 过渡判定），不感知切换意图。
   */
  active: boolean
  /** 服务器显示名（骨架屏文案）。 */
  label: string
  /** 框架文案语言：App 按文档语言解析后传入；本组件只渲染，不读文档语言。 */
  locale: FrameLocale
  /** boot settle 回调（成功或失败均触发）：App 用于预热队列推进。 */
  onSettled?: (instanceId: string) => void
  /** Shell 状态上报：每次 settle 后把最终 ShellState 报给 App；失败呈现由 App 统一渲染。 */
  onStateChange?: (instanceId: string, state: ShellState) => void
  /** 重试令牌：App 的失败覆盖层「重试」递增它；变化时复位 boot 状态并重启 shell。 */
  retryToken?: number
  /**
   * 页面恢复阶梯的 instance-reboot 执行端：由 App 递增该视图的 boot 令牌，
   * 走与失败覆盖层「重试」同一条干净重 boot 路径。缺省 = 不执行（仅记账）。
   */
  onRebootInstance?: (instanceId: string) => void
  /** 来源就绪门：实例仍在启动时先等它就绪再取客户端插件图，避免静默少一片插件
   *  （固定预算用尽会静默少一片，`ui-chat` 会因此永久 PENDING）。 */
  waitForServing?: (instanceId: string) => Promise<boolean>
  /**
   * 打开意图揭示门：App 用共享规则判定的**最终判定**——遮罩在干净 settle 后继续保留，
   * 直到壳显示要打开的会话。本组件只把事实交给共享 arbiter 并消费帧里的
   * `veilVisible`/`mode`/`reevaluateInMs`；壳失败时 App 永远传 false。
   */
  holdVeil?: boolean
  /**
   * 本次持有对应的**请求身份**（要打开的那个 session id；无在途请求时不传）。请求换代
   * 必须重置持有窗；同一个 id 重开不重置。
   */
  openIntentId?: string
  /** 来源当前相位；只做文案与动作的事实输入——本组件绝不从相位推断"是否失败"。 */
  sourcePhase?: string
  /** boot 被推迟（来源未连接）：不启动 shell；相位离开 idle 后自动正常 boot。 */
  bootDeferred?: boolean
  /** App 的全局失败覆盖层正在渲染：遮罩（及其按钮/文案）必须**离开 DOM**，否则仍可被
   *  Tab 聚焦、被读屏播报。 */
  failureOverlayVisible?: boolean
  /** 可切换的来源（chamber 级逃生通道）；空数组 = 不渲染切换行。 */
  switchTargets?: ReadonlyArray<{ id: string; label: string }>
  /** 遮罩动作：切换到另一来源；App 拥有导航与回收顺序，本组件只上报意图。 */
  onSwitchSource?: (targetId: string) => void
  /** 遮罩动作：连接该来源（显式用户意图；idle 的手动断开语义靠"只有显式动作才触碰"）。 */
  onConnectSource?: () => void
  /** 遮罩动作：重试 boot。**必须**走 App 的唯一入口 `retryView`，本组件不自己重写该序列。 */
  onRequestRetry?: () => void
  /** App's current session in this instance; the shell probe verifies it is still on stage. */
  currentSessionId?: string
  /** Known blank sessions legitimately have no history window to recover. */
  currentSessionKnownBlank?: boolean
}

export default function InstanceView({
  instanceId, basePath, sourceFingerprint, transport, active, label, locale, onSettled, onStateChange,
  retryToken, waitForServing, holdVeil, openIntentId, onRebootInstance,
  sourcePhase, bootDeferred, failureOverlayVisible, switchTargets, onSwitchSource, onConnectSource, onRequestRetry,
  currentSessionId, currentSessionKnownBlank,
}: InstanceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const startedRef = useRef(false)
  /** 每次 boot 尝试的令牌：丢弃被重试取代的迟到 settle。 */
  const bootTokenRef = useRef(0)
  // 卸载门控：视图回收后在途 boot 的迟到 settle 一律丢弃，否则陈旧终态会写进 App
  // 的 shellStates，在 remove→re-add 窗口给新视图盖上虚假失败覆盖层。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  // settle 到达时读最新可见性（active = App 的 paintedView，不能吃闭包旧值）。
  const activeRef = useRef(active)
  activeRef.current = active
  const [shell, setShell] = useState<ShellState>(() => shellStateIdle(instanceId, basePath))
  /** 本次尝试开始时刻；null 仅在尚未发起这次尝试（含 bootDeferred）时。 */
  const bootStartedAtRef = useRef<number | null>(null)
  /** 已等待毫秒（仅未 settle 时按秒推进）。 */
  const [waitedMs, setWaitedMs] = useState(0)
  /** 渲染期镜像的 settle 事实（重试 effect 在复位**之前**读它，避免闭包依赖）。 */
  const settledRef = useRef(false)
  settledRef.current = isSettledShellState(shell)
  /** 本次尝试是否排在上一次未 settle 的 boot 后面（诚实播报）；失败后重试不排队。 */
  const queuedBehindPredecessorRef = useRef(false)
  /** **本次持有**开始时刻（遮罩兜底窗基准）：必须是持有起点而非 shell settle 时刻，
   *  否则温壳上窗口第一帧就过期。落成 state 以保证依赖数组自洽。 */
  const [holdStartedAt, setHoldStartedAt] = useState<number | null>(null)
  /** 容器内观察到的会话根相位（`[data-phase]` 的 DOM 事实，非 App 镜像）。 */
  const [surfacePhase, setSurfacePhase] = useState<SessionSurfacePhase>('absent')
  /** 相位为 absent 时的**连续缺失起点**：靠它避免"遮罩→露壳→遮罩"闪动；
   *  null = 当前不是 absent（或窗口未开）。 */
  const [absentSince, setAbsentSince] = useState<number | null>(null)
  /** 兜底释放窗到期后的重渲染触发器；决策本身仍是纯函数（可测）。 */
  const [surfaceFallbackTick, setSurfaceFallbackTick] = useState(0)
  /** The mask's only visible fact: the phase the 1 Hz sample derives. The fresh
   *  health object itself stays in the ref, so a sample inside a threshold window
   *  cannot re-render the view. */
  const [sessionOpenPhase, setSessionOpenPhase] = useState<SessionOpenRecoveryPhase>('quiet')
  // Sessions the ladder reports as host-stall exhausted. The map is a Set: the page
  // has NO content-stall producer (the gateway facts cursor is not assistant
  // content), so exhaustion over an open face is always a host-responsiveness fact
  // and never earns the content copy.
  const [hostStallSessions, setHostStallSessions] = useState<ReadonlySet<string>>(new Set())
  const sessionOpenHealthRef = useRef<SessionOpenHealth | null>(null)
  const deliveryOwnerRef = useRef(createSessionDeliveryOwner())
  const deliveryEpisodeRef = useRef(new Map<string, { episode: number; state: string }>())
  /** Desktop-observed stalls: the page never sees its own stopped frame loop. */
  const scheduleStallRef = useRef<ContentStallStreak | null>(null)
  const inputBlockStallRef = useRef<ContentStallStreak | null>(null)
  /** The streak start a resync was already dispatched for ("tried, not concluded"). */
  const resyncDispatchedForRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    // The delivery ladder ledger is PAGE-lifetime, never boot-lifetime: an
    // instance-reboot is one of its own levers, so recreating the owner here would
    // hand every boot a fresh quota while the observer's cumulative silence keeps
    // the streak old - one reboot per boot cycle, forever. Only the per-boot run
    // episode state resets; quotas, cooldowns, streaks and the "tried" conclusion
    // survive the reboot they authorized (a cleared symptom deletes the record on
    // its own).
    deliveryEpisodeRef.current.clear()
  }, [retryToken])

  // The ladder ledger is page-lifetime, but a record belongs to the session it was
  // observed for: a switch must drop the previous session's cooldowns/quota, or a
  // fresh streak on return is suppressed by a stale one (this is forget's only caller).
  const observedSessionRef = useRef(currentSessionId)
  useEffect(() => {
    const previous = observedSessionRef.current
    observedSessionRef.current = currentSessionId
    if (previous !== undefined && previous !== currentSessionId) deliveryOwnerRef.current.forget(previous)
  }, [currentSessionId])

  // This seat belongs to the page frame, outside the vendor conversation
  // header. A header that never renders cannot hide the recovery controls.
  useEffect(() => {
    if (!active || !isSettledShellState(shell) || currentSessionId === undefined) {
      // One lifetime policy for every transient: evidence collected while this view
      // was not the sampled seat is not usable after resume. Clearing only the open
      // clock let a pre-gap content streak fire the ladder the moment it was painted.
      sessionOpenHealthRef.current = null
      scheduleStallRef.current = null
      inputBlockStallRef.current = null
      resyncDispatchedForRef.current = undefined
      // The exhaustion map is per sampled seat: a stale entry would render a false
      // banner for one commit when returning to that session.
      setHostStallSessions(previous => (previous.size === 0 ? previous : new Set()))
      setSessionOpenPhase('quiet')
      return
    }
    const sample = (): void => {
      const observed = readInstanceSessionStreamHealth(instanceId, currentSessionId)
      const at = monotonicNow()
      const health = advanceSessionOpenHealth(sessionOpenHealthRef.current, currentSessionId, observed, at)
      sessionOpenHealthRef.current = health
      // Terminal opening evidence is a page fact independent of the concrete
      // session face: read for the presented target only, and only while it is
      // loading — the one state the fact speaks about.
      const nextOpeningFailure = observed?.openState === 'loading'
        && readInstanceOpeningFailure(instanceId, currentSessionId)
      // The phase is derived HERE, from the same inputs the render used to
      // recompute it from: storing it (and not the fresh per-second object) keeps
      // every sample inside a threshold window render-free.
      const nextPhase = presentedSessionOpenRecoveryPhase(
        health, currentSessionId, currentSessionKnownBlank === true, nextOpeningFailure,
      )
      setSessionOpenPhase(previous => (previous === nextPhase ? previous : nextPhase))
      if (document.visibilityState === 'hidden') {
        // Hidden is a gap like a seat switch: evidence sampled before an arbitrary
        // hidden period is not usable after resume, or the first visible sample can
        // fire reboot/reload on pre-gap streaks. Re-anchor instead of freezing.
        scheduleStallRef.current = null
        inputBlockStallRef.current = null
        resyncDispatchedForRef.current = undefined
        return
      }
      if (health === null) return
      // The episode ordinal mints the chamber-namespace run id until a host run
      // key exists; the owner keys every stall decision on that identity.
      const tracked = deliveryEpisodeRef.current.get(currentSessionId) ?? { episode: 0, state: 'cold' }
      const observedState = observed?.openState ?? 'missing'
      if (observedState === 'open' && tracked.state !== 'open') tracked.episode += 1
      tracked.state = observedState
      deliveryEpisodeRef.current.set(currentSessionId, tracked)
      // The desktop probe reports strikes in WALL time; convert the age once into
      // the page's monotonic streak (same duration-first rule as the observers).
      const strikeNow = Date.now()
      const strikes = readRendererStallStrikes(strikeNow)
      const strikeAge = strikes.observedAt === undefined ? undefined : strikeNow - strikes.observedAt
      scheduleStallRef.current = advanceContentStallStreak(
        scheduleStallRef.current, currentSessionId,
        strikes.scheduleStrikes > 0 && strikeAge !== undefined ? strikeAge : undefined, at)
      inputBlockStallRef.current = advanceContentStallStreak(
        inputBlockStallRef.current, currentSessionId,
        strikes.inputBlockStrikes > 0 && strikeAge !== undefined ? strikeAge : undefined, at)
      const scheduleStallStart = scheduleStallRef.current?.sessionId === currentSessionId
        ? scheduleStallRef.current.start : undefined
      const inputBlockStart = inputBlockStallRef.current?.sessionId === currentSessionId
        ? inputBlockStallRef.current.start : undefined
      // Only symptoms that are ACTIVE this tick contribute their streak. While the
      // session is open the open-health streak is not a symptom at all (it has no
      // age by construction), so a content stall must carry its own start.
      const openEvidence = observed === null ? undefined : {
        state: observed.openState,
        openInFlight: observed.openInFlight,
        resyncInFlight: observed.resyncInFlight,
        resyncAvailable: observed.resyncAvailable,
        // The header heals an error through the concrete per-session resync;
        // when that route is unusable (target not on the presented main view, or
        // no reachable face), the page's own resync is the automatic lever the
        // delivery owner may dispatch.
        healRoute: observed.healRoute,
      }
      // The page's automatic ladder no longer treats a `loading` face as a
      // symptom: an opening still in flight is the host's to finish and a parked
      // one is the user's decision (the evidence-backed notice below), never a
      // timer's. The face's in-flight bits still block every automatic tier
      // through the `escalationBlocked` input below.
      const openSymptomEvidence = observed?.openState === 'loading' ? undefined : openEvidence
      const openStallActive = openStallSymptomActive(openSymptomEvidence)
      const symptomSinceMs = activeSymptomSinceMs({
        openSince: health.since,
        openStallActive,
        scheduleStallStart,
        inputBlockStart,
      })
      // The page tried a resync for this exact streak and the symptom survived it:
      // that is the caller-owned conclusion the upper tiers require. The tiers'
      // own afterMs gates (reboot 90s / reload 120s) still decide when they are due.
      // DELIVERY_EFFICACY: instance-reboot requires "the instance is stalled while
      // the frame counter still advances" and document-reload requires a stalled
      // frame counter - a content-channel stall is not that evidence. Content-only
      // stalls therefore stay at resync + the visible host-stall notice, while an
      // unresolvable OPEN stall (loading, nothing in flight) may escalate.
      const stuckEvidence = (openStallActive || scheduleStallStart !== undefined || inputBlockStart !== undefined)
        && stuckEvidenceForStreak({
          streakStart: symptomSinceMs,
          resyncDispatchedFor: resyncDispatchedForRef.current,
        })
      const decision = deliveryOwnerRef.current.observe({
        sessionId: currentSessionId,
        chamberRun: { sourceFingerprint, generation: retryToken ?? 0, sessionId: currentSessionId, episode: tracked.episode },
        evidence: {
          symptomSinceMs,
          ...(scheduleStallStart === undefined ? {} : { scheduleStalled: true }),
          ...(inputBlockStart === undefined ? {} : { inputBlocked: true }),
          ...(stuckEvidence ? { stuckEvidence: true } : {}),
          ...(openSymptomEvidence === undefined ? {} : { open: openSymptomEvidence }),
        },
        // An in-flight open OR a disposing rebuild blocks every automatic tier,
        // exactly as the ladder derived before the loading face was dropped.
        escalationBlocked: observed?.resyncInFlight === true || observed?.openInFlight === true,
      }, at, { commit: false })
      setHostStallSessions(previous => {
        const present = previous.has(currentSessionId)
        if (decision.hostStall) {
          if (present) return previous
          const next = new Set(previous)
          next.add(currentSessionId)
          return next
        }
        if (present) {
          const next = new Set(previous)
          next.delete(currentSessionId)
          return next
        }
        return previous
      })
      // The owner planned WITHOUT committing: each action is accounted only once it
      // actually ran, so an unavailable resync never authorizes a stronger tier.
      if (decision.action?.tier === 'resync') {
        if (rebuildInstanceSessionStream(instanceId, currentSessionId)) {
          deliveryOwnerRef.current.markDispatched(currentSessionId, 'resync', at)
          resyncDispatchedForRef.current = symptomSinceMs
        }
      } else if (decision.action?.tier === 'instance-reboot') {
        deliveryOwnerRef.current.markDispatched(currentSessionId, 'instance-reboot', at)
        onRebootInstance?.(instanceId)
      } else if (decision.action?.tier === 'document-reload') {
        deliveryOwnerRef.current.markDispatched(currentSessionId, 'document-reload', at)
        // The wall clock is deliberate: the budget must survive the reload, and the
        // page's monotonic clock restarts with every document.
        if (shouldReloadDocument(documentReloadBudgetStorage(), Date.now())) window.location.reload()
      }
    }
    sample()
    const timer = setInterval(sample, 1_000)
    return () => clearInterval(timer)
  }, [active, shell.booted, shell.error, currentSessionId, instanceId])

  useEffect(() => {
    // 来源未连接时绝不启动 shell（一次注定吃满 503 预算的 boot 不该发生）。
    if (bootDeferred === true) return
    if (startedRef.current || shell.booted || shell.booting) return
    const el = containerRef.current
    // 先取容器再置位 started：ref 未挂载时若置位，本视图将永远不再尝试 boot。
    if (el === null) return
    startedRef.current = true
    bootStartedAtRef.current = Date.now()
    setWaitedMs(0)
    // 本次尝试令牌：被重试取代的旧 boot 迟到 settle 不得覆盖新状态。
    const bootToken = bootTokenRef.current + 1
    bootTokenRef.current = bootToken
    void bootInstanceShell(instanceId, basePath, el, setShell, sourceFingerprint, transport, {
      waitForServing,
      // 结算后补发的事实（5s 探针判词、延迟簇失败）必须到达 **App**：shell 的
      // onState 是本视图的 React setter，只发它 App 的 shellStates 镜像收不到，
      // 而横幅/侧栏投射/自愈都读它。只由过栅栏的结算后路径调用。
      onRepublish: onStateChange === undefined ? undefined : (id, next) => onStateChange(id, next),
    }).then((next) => {
      // 卸载后到达或被更新尝试取代的迟到 settle 一律丢弃（避免污染重加视图判定）。
      if (!aliveRef.current || bootToken !== bootTokenRef.current) return
      // 屏上视图用 View Transition 落位，后台 boot 即时落位；键 'settle' 与切换流隔离
      // （被同键吞并会导致骨架 veil 永驻），同视图连续 settle 单槽合并。
      if (activeRef.current) runViewTransition(() => setShell(next), 'settle')
      else setShell(next)
      onSettled?.(instanceId)
      // 失败呈现由 App 统一负责（覆盖层）：每次 settle 上报最终状态。
      onStateChange?.(instanceId, next)
    })
  }, [instanceId, basePath, sourceFingerprint, transport, shell, onSettled, onStateChange, waitForServing, bootDeferred])

  // 重试令牌：递增 → 复位 boot 状态 → boot effect 观察 shell 变化重新启动。
  const lastRetryTokenRef = useRef(retryToken)
  useEffect(() => {
    if (retryToken === lastRetryTokenRef.current) return
    lastRetryTokenRef.current = retryToken
    // 复位前取样：仅上一次尝试未 settle 时，这次重试才会等在 boot 尾上。
    queuedBehindPredecessorRef.current = !settledRef.current
    startedRef.current = false
    // 立刻清掉上一代的可见秒数，避免重置帧仍画旧值。
    setWaitedMs(0)
    const next = shellStateIdle(instanceId, basePath)
    setShell(next)
    onStateChange?.(instanceId, next)
  }, [retryToken, instanceId, basePath, onStateChange])

  // 已等待时长：只在未 settle 且 boot 已发起时走秒（用户才能判断慢还是死）。
  useEffect(() => {
    if (isSettledShellState(shell) || bootDeferred === true) return
    const timer = setInterval(() => {
      const startedAt = bootStartedAtRef.current
      if (startedAt !== null) setWaitedMs(Date.now() - startedAt)
    }, 1000)
    return () => { clearInterval(timer) }
  }, [shell.booted, shell.error, bootDeferred, retryToken])

  const settled = isSettledShellState(shell)
  // 遮罩 = boot 期（未 settle）**或** App 判定的打开意图揭示门。会话面绘制信号以壳
  // 自己的 DOM 事实为准（`session-surface.ts`）：会话根画到 `active` 即揭幕；
  // hero/settling 保持；absent（降级形态）以 2s 兜底、hero/settling 只留 70s 外层保险。
  // **窗口基准是本次持有的起点**，绝不是 shell 的 settle 时刻（温壳上后者早已过期）。
  // 第三个合取项是 App 的失败覆盖层事实（模态；覆盖层在场时遮罩退出 DOM）。
  const surfaceHoldActive = settled && holdVeil === true && failureOverlayVisible !== true
  // 持有窗开闭：上升沿复位相位并记本次持有时钟；窗口关闭/重试即清空。
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
    // 下面这行相位复位是与 leaf 时钟门重复的保险（真正的硬保证是"时钟未建立绝不释放"）；
    // openIntentId 进依赖：请求换代 = 新的一次持有，窗口从这一帧重新起算（同 id 不重置）。
  }, [surfaceHoldActive, retryToken, openIntentId])
  // ONE decision for everything the user sees: the veil classification, the surface
  // hold and the fallback timer's re-arm moment come from this single frame over the
  // shared threshold table. One clock read: releaseAtMonoMs is absolute and
  // planVeilTimer gets the SAME moment the frame was computed with.
  const frameNowMs = monotonicNow()
  const presentation = decidePresentation(
    {
      settled,
      bootDeferred: bootDeferred === true,
      waitedMs,
      holdForOpenIntent: holdVeil === true,
      surfacePhase,
      holdStartedAtMs: holdStartedAt,
      absentSinceMs: absentSince,
      nowMs: frameNowMs,
      failureOverlayVisible: failureOverlayVisible === true,
    },
    // The thresholds come from the shared table (one owner; no module-local copies to drift).
    PRESENTATION_THRESHOLDS,
  )
  // 相位观察器在**整个持有窗**内运行：释放是"电平"而非"闩锁"——官方初始导航可能先显示
  // 真实会话（active）再复用/新建 blank 会话（回 hero），此时空白"新会话"仍必须被遮住；
  // 首次释放即断开会把相位永久冻结在 active。窗口结束即断开，绝不为整个生命周期挂观察器。
  useEffect(() => {
    if (!surfaceHoldActive) return
    const el = containerRef.current
    if (el === null) return
    // 采样合并：boot 窗口 DOM 变更密集，"每次变更排一帧"等于每帧一次 setState。
    // 合并器保证首变更下一帧、其后每 SURFACE_SAMPLE_MIN_INTERVAL_MS 一次、尾部必采。
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
    // deps 只认持有窗、容器更换与请求换代：释放是电平翻转，观察器必须继续活着；
    // openIntentId 重订阅是为换代时立刻重采相位。
  }, [surfaceHoldActive, retryToken, openIntentId])
  // 兜底时钟（与判定窗同基准 = 本次持有起点）：absent 2s 即揭；hero/settling 保持，
  // 只留 70s 外层保险（> 68s 排队预算）。延时扣除已走过部分，避免把持有拖长。
  // The frame's releaseAtMonoMs is ABSOLUTE: the timer delay is the distance from
  // frameNowMs; planVeilTimer refuses a 0 ms held timer and a non-finite delay means
  // "hold until the next state change". The tick only re-renders at the deadline.
  useEffect(() => {
    const delay = planVeilTimer(presentation, frameNowMs)
    if (!Number.isFinite(delay)) return
    const handle = setTimeout(
      () => setSurfaceFallbackTick(tick => tick + 1),
      delay,
    )
    return () => { clearTimeout(handle) }
  }, [presentation.veil, presentation.releaseAtMonoMs, frameNowMs, surfaceFallbackTick])
  const veilActions = presentation.actions
  // The veil is the frame's answer, verbatim: shellHeld covers the TENANT while the
  // veil is HELD, while the boot face stays until the shell settles even when actionable.
  const veilHeld = presentation.veil === 'held'
  const veilVisible = veilHeld || (!settled && presentation.veil === 'actionable')
  // 只有前一次尝试尚未 settle 时重试才排队；推迟态没有 boot 在跑，不播报。
  const retryQueued = presentation.mode !== 'deferred'
    && shouldAnnounceRetryQueue(queuedBehindPredecessorRef.current, settled)
  const waitedSeconds = String(Math.round(waitedMs / 1000))
  const retryQueueSeconds = String(Math.round(INSTANCE_TAIL_WAIT_CAP_MS / 1000))
  // hostStallSessions is the delivery ladder's exhaustion fact. The ladder can run
  // out of levers over an open, healthy face (schedule/input stalls are host
  // responsiveness, not content): the generic failed copy is the correct one, and
  // with no content producer there is no content-copy case at all.
  const openRecovery: SessionOpenRecoveryPhase = currentSessionId !== undefined && hostStallSessions.has(currentSessionId)
    ? 'failed'
    : sessionOpenPhase
  const sourceFailed = isTerminalUnreadyPhase(sourcePhase)
  // 遮罩在已 settle 的壳上仍可见，就是揭示门在持有它；隐藏判定耦合的是**合成后**的
  // veilHeld：帧 actionable/released 时同一 commit 里壳也恢复可见，绝不"遮罩没了壳还藏着"。
  const shellHeld = settled && veilHeld
  const viewClass = active
    ? 'instance-view'
    : settled
      ? 'instance-view instance-hidden'
      : 'instance-view instance-pending'

  // 视图离开活动态后套 .instance-pending/.instance-hidden，而行悬浮卡被 portal 到
  // document.body——它不在本视图 DOM 内，visibility/pointer-events 都管不到它，指针
  // 停在卡上时切视图会让卡画在新视图之上。因此在同一 commit（useLayoutEffect）显式关掉
  // 页级唯一那张卡；只认 active 的 true→false 跳变（后台挂载本就是非活动态，按"非活动
  // 即关"会误关用户正悬停的卡）。dismissVisibleRowCard() 无卡时是 no-op。
  const wasActiveRef = useRef(active)
  useLayoutEffect(() => {
    if (wasActiveRef.current === active) return
    wasActiveRef.current = active
    if (!active) dismissVisibleRowCard()
  }, [active])

  return (
    <div className={shellHeld ? `${viewClass} instance-veil-held` : viewClass} data-instance={instanceId}>
      {/* 每次重试换一个容器元素：挂死尝试的 AppWebEntry 仍持有旧容器，复用会让新 boot
          页追加进已有 root（"一容器一 root"不变量）；旧容器随 key 变更被摘除。 */}
      <div key={retryToken ?? 0} ref={containerRef} className="instance-shell" />
      {active && settled && !veilVisible && failureOverlayVisible !== true && openRecovery !== 'quiet' && (
        <div className="instance-session-open-recovery" data-chamber-session-open-recovery={openRecovery}
          role={openRecovery === 'waiting' ? 'status' : 'alert'}>
          <span>{frameText(locale, openRecovery === 'failed' ? 'sessionOpen.failed' : 'sessionOpen.waiting')}</span>
        </div>
      )}
      {/* a11y：动作出现后遮罩不是"纯忙"区域——aria-busy 会把区域的更新播报压后，
          正好盖住我们要用户看见的重试/连接/切换；排队文案在反馈窗之外，同样必须
          立刻播报（本节选位置必须是 JSX children，不能塞进条件表达式的表达式位置）。 */}
      {veilVisible && (
        <div className="instance-loading" aria-busy={veilActions || retryQueued ? false : true}>
          <div className="instance-loading-main">
            {/* a11y: the spinner is pure decoration — the adjacent title already
                announces the state; aria-busy on the veil carries the busy fact. */}
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
            {/* 超过反馈窗后遮罩变为可操作——**不是**失败声明（失败由 App 覆盖层专有）。 */}
            {veilActions && presentation.mode === 'loading-stuck' && (
              <div className="instance-loading-elapsed">
                {frameText(locale, 'boot.elapsed', { seconds: waitedSeconds })}
              </div>
            )}
            {/* 排队事实一成立就播报——它挂在反馈窗外，否则"点了重试先等 10s 无解释"。 */}
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
