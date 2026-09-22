/**
 * dsh-chamber bridge host（design 05 /）：页面唯一入口宿主。
 * 首屏 = 本地实例的完整 dsh shell（纯 dsh UI，无 chamber 外壳）；多来源
 * session/workspace 导航在 dsh 原生侧边栏内由 chamber 自研插件承担
 * （05 ）。本组件只负责数据层与 N-ctx 编排：
 * - 控制面 /health 与 /api/connections 轮询；
 * - 桌面 ssh 实例装载与状态投影订阅（隧道 URL 永不进 renderer）；
 * - 每实例 workspace/session 聚合（instance-api unary，05 ）；
 * - 本地实例自动启动、注册表远程实例自动连接；
 * - N-ctx shell 挂载（local 常驻，其他来源按需挂载/空闲预热；hide/show
 *   切换经 View Transition 包装（view-transition.ts）：旧视图 visibility+
 *   `content-visibility:hidden` 即时隐去（跳过 style/layout/paint 并缓存
 *   渲染状态），切换与骨架→内容过渡由 `startViewTransition` 的静态旧视图
 *   快照遮盖 reveal 重排——无黑帧、无闪烁；见 styles.css `.instance-hidden`）。
 *   **保留策略（2026 性能整改，05 / 偏差）**：隐藏壳不再无限常驻——
 *   除 local 恒留外至多保留 RETAINED_HIDDEN_VIEWS 个，超限回收已 settle 且
 *   连续隐藏 ≥60s 的最久者（retention.ts）；回收仅拆 UI 壳（dispose shell），
 *   实例进程/连接/后台任务不受影响，重开走冷 boot；
 * - chamberBridge 投影发布（05 ）：轮询状态合并为 ChamberServerAggregate[]
 *   供侧边栏插件消费；onOpenSession 通道驱动会话打开。
 * 会话打开请求来自侧边栏插件（经 chamberBridge，05 ）：onOpenSession
 * 通道驱动 openSession 切 shell 并分发；打开终态（成功或预算耗尽失败）经
 * reportOpenSessionOutcome 回报每个侧边栏 shell——失败落在被点击的会话
 * 行内呈现，不再是单向通道的 console-only 盲区（）。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  createHarvestView,
  createMapLedgerView,
  createSetLedgerView,
  projectHarvest,
  dispatchSource,
  epochOf,
  projectAbandonedTargets,
  projectAutoPrewarmed,
  projectDegradedRetried,
  projectHiddenSince,
  projectPrewarmSuppressed,
  reincarnate,
  retainSourceIds,
  waitForCondition,
  type SourceEvent,
  type SourceRegistry,
} from '@dsh-chamber/dsh-stream-state'
import api, { type ConnectionSummary, type HealthResponse } from './api.ts'
import {
  armOpenIntent,
  chamberBridge,
  clearOpenIntents,
  deriveArchivedSessions,
  deriveServerWorkspaces,
  emptyAggregate,
  // R8 意图预热（blueprint ）：纯策略函数，接线在下方 drainPrewarm / 订阅 effect。
  emptyIntentPrewarmBudget,
  fetchInstanceSnapshot,
  fetchManagedRuntimeState,
  forgetPendingArchives,
  forgetPendingSessions,
  forgetPendingWorkspaces,
  getInstanceClient,
  getOpenIntentsSnapshot,
  instanceSnapshotSignature,
  isInstanceUnavailable,
  managedRuntimeDown,
  mergeRuntimeFacts,
  projectableCurrent,
  reconcilePendingSessions,
  deriveUnread,
  releaseInstanceClient,
  releaseOpenIntent,
  // ).
  reconcileCompletedFacts,
  serversProjectionSignature,
  shouldHoldViewVeil,
  subscribeOpenIntent,
  refreshPendingArchives,
  sweepPendingArchives,
  sweepPendingSessions,
  sweepPendingWorkspaces,
  withPendingArchives,
  withSessionEcho,
  withWorkspaceEcho,
  type ChamberServerAggregate,
  type InstanceAggregate,
  type IntentPrewarmBudget,
  type InstanceRuntimeReport,
  type PluginGraphDiagnostic,
  type RuntimeFactsOverlay,
  type SessionArchiveLedger,
  type SessionEchoLedger,
  type WorkspaceEchoLedger,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import type { SessionFacts } from './notification-edges.ts'
import { createCompleteLedger } from './complete-ledger.ts'
// I3/I4 仪器（plan ）：徽标回读与通知决定账本（只读、有界、发布为函数视图）。
import { notificationLedger, publishNotificationInstrument } from './notification-ledger.ts'
// I8：预热命中率仪表（attempt/hit/cancelled）。
import { recordPrewarm } from './prewarm-ledger.ts'
// WS-C（）：gateway session-state 只读事实源 + 未读 v2 落盘
// + 派生投影 + 通知第二入口 + 行刷新提示。全部浏览器安全、无 Node import。
import { createSessionFactsSource, type SessionFactsSnapshot, type SessionFactsSource } from './session-facts-source.ts'
// W6：SSH/dsh 远端的无壳观察者（实例自己的远程协议，经控制面实例代理）。
import { createSourceMuxFacts } from './source-mux-facts.ts'
// R19 生产端：probe 判定 → 侧栏档位（无快照即缺席 = 未知）。
import { sourceSessionFactsMode } from './session-facts-mode.ts'
import {
  advanceReadMark,
  browserUnreadStorage,
  loadClientInstallId,
  loadUnread,
  maxWatermark,
  mergeReadMarks,
  saveUnread,
  type UnreadStorageLike,
} from './unread-store.ts'
import { deriveSourceUnread, sameBooleanMap as sameBooleanLedger, viewingReadWatermark } from './unread-derivation.ts'
import { completionWatermark, nextNotifiedWatermark, shouldNotifyWatermark } from './watermark.ts'
import { pruneSourceList, pruneSourceRecord, pruneSourceSet } from './source-registry.ts'
import { LOCAL_INSTANCE_ID } from './local-instance.ts'
import { shouldDispatchRefreshHint } from './source-refresh-hint.ts'
import {
  acknowledgeRendererDelivery,
  authoritativeSourceRetirements,
  canReplayRosterIntents,
  classifyRosterGatedSource,
  deliveryMatchesCurrentSource,
  enqueueBoundedRosterIntent,
  parseAuthoritativeSourceFingerprint,
  SerialIntentRunner,
  SourceOwnershipRegistry,
  settlePendingDeepLinkActivation,
  subscribeRosterBeforeRefresh,
  type RendererDeliveryCoordinates,
  type SourceOwnershipToken,
} from './deep-link-activation.ts'
import { openInstanceSession, reconnectInstanceConnection, disposeAllShells, disposeInstanceShell, isSettledShellState, type ShellState } from './shell.ts'
// T15 (): the official Button atom (U
// ui-primitives/src/Button.tsx) replaces the chamber's own `.btn` chrome in
// every frame-level failure screen. Imported BY DEEP SOURCE PATH, the form the
// chamber ui-layout / ui-sidebar / settings-bridge tables already use for an
// internal module: the package BARREL also carries the primitives' markdown /
// CodeBlock families, and the T15-round measurement on this build had the barrel
// import move ~87 KB of them into the MAIN graph (main graph raw 1,226,775 →
// 1,313,736 at that measurement, i.e. within 2.7% of the C6 warn gate) while the
// deep path leaves them in the chamber entry. The main graph evaluates before App
// mount, which is exactly what the C3 note in chamber-entry.ts keeps
// ui-primitives out of.
// ): the round's notes quoted the T15-round
// figures as if they were current. Re-measured with `pnpm run build:renderer` on
// the final review-fix tree (all round fixes applied): main graph raw 1,228,157
// · chamber entry raw 1,989,208. The entry therefore sits
// 0.5% under its 2 MB warn gate, and the main graph ~9% under its 1.35 MB one
// (check-chunk-budgets.mjs) — the deep path matters at least as much as it did
// when T15 chose it. The ~87 KB barrel delta is a property of the barrel, not of
// this round's edits.
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import {
  frameText, readDocumentLocale, subscribeDocumentLocale,
  type FrameKey, type FrameLocale,
} from './locales.ts'
import { BOOT_TIMEOUT_MS } from './boot-budget.ts'
// The self-heal decision lives in the shared container (see dispatchLifecycle): the
// retired `degraded-retry.ts` planner and its module are gone, and the rules it owned
// are covered by test/lifecycle/degraded-retry-decision.test.ts against the container.
// Settled-boot gap → render decision (design 05  「降级呈现」). The pure module
// owns the copy key, the retry verdict and the "will the self-heal re-mount
// this?" rule; the frame only maps its keys through `t`.
import { bootGapNotice, isRetryableBootGap, toServerBootGap, type ShellDegradedKind } from './boot-gap.ts'
import { setPageActiveSource } from './page-language.ts'
import { runViewTransition, type PaintIntent } from './view-transition.ts'
// W3 揭示门（纯叶子，node 直测）：持有窗/立即揭示的全部规则都在那里，本文件只做接线。
import { revealHoldRemainingMs, revealHoldStartedAt, shouldReveal } from './reveal-gate.ts'
import { captureSidebarScrollAnchor, restoreSidebarScroll } from './sidebar-scroll-sync.ts'
import {
  AggregateRefreshQueue,
  commitAggregateFailure,
  commitAggregatePull,
  invalidateRemovedAggregateSources,
  isFallbackDerivedView,
  isSnapshotStale,
  planAggregateRefreshes,
  refreshPullStillCurrent,
  remoteRetiredSourceIds,
  retireSelectedSource,
  shouldDropUnverifiedRunningFacts,
  shouldRebaselineFallbackView,
  shouldReconnectStaleMounted,
  shouldRetainPushedAggregate,
  withoutRemovedSourceIds,
  withoutRemovedSourceKeys,
  reconnectStalenessMsForTransport,
  AGGREGATE_RECONNECT_HTTP_STALE_MS,
  AGGREGATE_RECONNECT_SSH_STALE_MS,
} from './aggregate-refresh.ts'
import {
  createSessionLivenessState,
  markSessionLivenessReconnect,
  markSessionLivenessReconnectNoop,
  planSessionLiveness,
  type SessionLivenessSourceInput,
} from './session-liveness.ts'
import { errorMessage } from './status.ts'
import type { SshInstanceSpec, SshStatusProjection, TransportKind } from './global.d.ts'
import {
  instanceBasePath,
  instanceConnected,
  rawInstanceIdFromSourceId,
  sourceIdForInstance,
  sourceIdForRawInstance,
  sourceIdForTransport,
} from './transport-source.ts'
import {
  shouldRunBackgroundPhase,
  VIEW_RECLAIM_TICK_MS,
} from './retention.ts'
import { decideServingGate, servingGatePhase, shouldDeferBootForSource } from './source-readiness.ts'
import { harvestSatisfied } from './baseline-harvest.ts'
import InstanceView from './components/InstanceView.tsx'
import { useBadgeCount } from './app-hooks/use-badge-count.ts'
import { useBridgeSubscriptions } from './app-hooks/use-bridge-subscriptions.ts'
import { useViewScheduler } from './app-hooks/use-view-scheduler.ts'
import { PERF_MARKS, perfMark } from './perf-marks.ts'

/**
 * Staleness watchdog cadence for aggregate snapshots. Also the staleness
 * threshold: a ready source whose last PUSHED snapshot is older than this is
 * presumed to have a dead push channel and is re-pulled from the authority.
 */
const AGGREGATE_FALLBACK_POLL_MS = 30_000
/** Minimum gap between two connection reconnects of one stale MOUNTED source
 * (S2): the watchdog may mark a healthy-but-quiet producer stale on recency
 * alone, so a failed (or unnecessary) reconnect must not retry every tick. */
const AGGREGATE_RECONNECT_BACKOFF_MS = 60_000
/** Staleness thresholds for the S2 reconnect arm live in aggregate-refresh.ts
 * (per transport: http ≈2min tight heal, ssh ≈5min last-resort heal — see
 * {@link AGGREGATE_RECONNECT_HTTP_STALE_MS} / {@link AGGREGATE_RECONNECT_SSH_STALE_MS}
 * and {@link reconnectStalenessMsForTransport}). Both are deliberately ABOVE
 * the 30s pull threshold: the App cannot distinguish a frozen push channel
 * from a healthy-but-quiet one (producers only push on content changes), and
 * every reconnect replays baselines. The unary pull keeps its own 30s cadence
 * untouched. */
/** Re-request floor for session-list refresh dispatch (design 24 ): a
 *  refresh re-runs the OFFICIAL session.list of the mounted ctx; while ghost
 *  rows of purged sessions stay pending, requests are floored to one per
 *  coalescing window per source (the official refreshList single-flight bounds
 *  concurrency; this bounds sequential churn when the refresh keeps failing on
 *  a busy source). Suppressed dispatches never lose the ids — they stay in the
 *  per-source pending set and re-evaluate on the next push. The archive-manager
 *  dialog additionally requests one on every purge settle (immediate path,
 *  not stamped here — deliberate cross-package decoupling,  notes the
 *  overlap). */
/** Bounded wave over whatever edge-triggered refresh set a poll produces. */
const AGGREGATE_POLL_CONCURRENCY = 4
/** First-screen retry: a transient aggregate snapshot failure (0.1.2 wire:
 * workspace.list was deleted upstream — the snapshot derives from
 * session/list cwd facts) is retried quickly (bounded), instead of waiting
 * out the 30s staleness watchdog. */
const AGGREGATE_RETRY_MS = 3_000
const AGGREGATE_RETRY_LIMIT = 5
/** 空闲预热的挂载并发上限（2026 性能整改：3→1）——同一时刻至多一个"用户
 * 没看但已在后台 boot 全量 UI"的壳；配合保留策略（retention.ts）把稳态
 * 壳数压到 local + 活动 + ≤1 隐藏 + ≤1 预热中，且仅前台推进。 */
const MAX_PREWARMED_REMOTE_VIEWS = 1
/** 问题 B：gateway 托管 dsh 状态轮询周期（仅前台，见 managed-runtime.ts）。 */
const MANAGED_RUNTIME_POLL_MS = 15_000
/** 单次托管 dsh 状态探针上限：悬挂的代理请求不得堵死轮询（单飞守卫）。 */
const MANAGED_RUNTIME_PROBE_TIMEOUT_MS = 10_000
/** 连接行（label/dshPort）低频轮询：状态本身走推送，行字段极少变化。 */
const CONNECTIONS_POLL_MS = 30_000
/** Cold-start roster failures retry quickly before the 30s steady-state poll. */
const REMOTE_ROSTER_RETRY_MS = 1_000
const REMOTE_ROSTER_RETRY_LIMIT = 5
/** A transient listener-ready IPC failure must not strand main's held intent forever. */
const LISTENER_READY_RETRY_MS = 500
const LISTENER_READY_RETRY_LIMIT = 5
const MAX_PENDING_ROSTER_NOTIFICATION_OPENS = 64


/** Stable empty list for boots whose failure carries no loader entries (T15). */
const NO_FAILED_ENTRIES: readonly string[] = []

type DeepLinkDelivery = RendererDeliveryCoordinates & {
  /** Raw id is retained while the first authoritative v2 kind roster is unavailable. */
  rawInstanceId: string
  /** Canonical source id once resolved through the authoritative roster. */
  sourceId: string | null
  sourceFingerprint: string
}
type NotificationOpenDelivery = RendererDeliveryCoordinates & {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
}
/**
 * 通知组装请求（唯一组装点 emitSessionNotification 的入参，）：
 * origin 只是诊断（两个事实入口：壳通道边沿 / watcher 完成边沿）；watermark 是
 * host 域内容水位，进 renderer 身份键（主进程 claim 键的第五元组）。
 */
type SessionNotificationRequest = {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
  kind: 'complete' | 'ask' | 'request'
  watermark?: number
}

/**
 * The ready/not-ready partition of all known sources, driven solely by the
 * authoritative transport state. Shared by the edge-triggered aggregate poll
 * and the staleness watchdog.
 */
function collectReadySourceIds(
  health: HealthResponse | null,
  remoteStatus: Record<string, SshStatusProjection>,
  remoteInstances: SshInstanceSpec[],
): { ready: string[]; notReady: string[] } {
  const ready: string[] = []
  const notReady: string[] = []
  if (instanceConnected('local', health, remoteStatus, LOCAL_INSTANCE_ID)) ready.push(LOCAL_INSTANCE_ID)
  else notReady.push(LOCAL_INSTANCE_ID)
  for (const instance of remoteInstances) {
    const id = sourceIdForInstance(instance)
    if (instanceConnected(instance.kind, health, remoteStatus, instance.id)) ready.push(id)
    else notReady.push(id)
  }
  return { ready, notReady }
}

/**
 * 轮询状态 → chamberBridge 投影（05 ）：local + 每个注册表远程实例一条。
 * connected 只看权威状态（本地 /health dsh；远程隧道 phase）；workspaces
 * 只在对应聚合 state==='ok' 时派生（否则空数组，不显示陈旧数据）；拉取
 * 失败时把错误文本带上 aggregateError（UI 区分「拉取失败」与「无工作区」）。
 */

/** Per-source dsh version fact. D2: the LOCAL instance comes from the desktop
 *  bridge (`window.dshChamber.dshVersion`); remote instances stay absent
 *  until a remote version probe is wired (the old in-ctx host-producer
 *  channel was removed — host.describe was deleted upstream). */
type HostFacts = { dshVersion?: string }

// 同形布尔表比较（账本 identity 闸；避免无变化时换 state 对象）：实现已单源到
// ./unread-derivation.ts 的 sameBooleanMap（本文件以别名 sameBooleanLedger 复用它）。

/**
 * facts 行 → 侧栏渲染字段 overlay（）：
 * 只过**渲染字段**（pending / runningSubagents），判定字段（updatedAt /
 * completedAt / lastTurnEnd）刻意不过桥（derive.ts 的反 churn 纪律）。
 * 只有 verdict ok 且 serviceable 的未读事实才参与——forward-skew / 停机 /
 * legacy 一律返回 undefined，回到 channel-only（不静默假装有事实）。
 */
function factsOverlay(snapshot: SessionFactsSnapshot | undefined): RuntimeFactsOverlay | undefined {
  if (snapshot === undefined || snapshot.verdict !== 'ok' || snapshot.serviceable === false) return undefined
  const overlay: Record<string, { pending?: 'approval' | 'plan-review' | 'question'; runningSubagents?: number; factAt?: number }> = {}
  for (const row of Object.values(snapshot.rows)) {
    const pending = row.pendingKind === 'approval'
      ? 'approval' as const
      : row.pendingKind === 'question' ? 'question' as const : undefined
    // I5：factAt 也是渲染字段（这一行有多新），因此只带它的行同样要过桥。
    if (pending === undefined && row.subagentCount <= 0 && !(row.factAt > 0)) continue
    overlay[row.sessionId] = {
      ...(pending !== undefined ? { pending } : {}),
      ...(row.subagentCount > 0 ? { runningSubagents: row.subagentCount } : {}),
      ...(row.factAt > 0 ? { factAt: row.factAt } : {}),
    }
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined
}

function deriveServers(
  health: HealthResponse | null,
  connections: ConnectionSummary[] | null,
  remoteInstances: SshInstanceSpec[],
  remoteStatus: Record<string, SshStatusProjection>,
  aggregates: Record<string, InstanceAggregate>,
  hostFacts: Record<string, HostFacts | undefined>,
  runtimeFacts: Record<string, InstanceRuntimeReport | undefined>,
  completedBySource: Record<string, Record<string, boolean>>,
  activeViewId: string,
  pluginDiagnostics: Record<string, PluginGraphDiagnostic | undefined>,
  // ）：降级事实要过投影给侧栏来源行与连接页，
  // 所以 shellStates 与 pluginDiagnostics 一样是 derive 的输入——只读
  // `degraded`，失败态（error）不进这条投影。
  shellStates: Record<string, ShellState | undefined>,
  managedRuntime: Record<string, string | null>,
  workspaceEcho: WorkspaceEchoLedger,
  // ）：会话创建回声账本，与会话状态
  // 同一汇合点并入（见下方 withSessionEcho 的调用与 shared/session-echo.ts）。
  sessionEcho: SessionEchoLedger,
  // ）。它必须最先施加——归档会
  // 把同一 id 的会话回声行一并藏掉（即使那条回声还没退休）。
  sessionArchive: SessionArchiveLedger,
  openIntents: Readonly<Record<string, string>>,
  // T16 (): the local source's fallback label is
  // frame copy (the connection row may carry no label), so it comes from the
  // frame's dictionary in the locale the frame renders in.
  locale: FrameLocale,
  // overlay 的来源；判定输入不过桥，见 factsOverlay）。刻意追加在参数表末尾：
  // 既有接线锁按 completedBySource/paintedView/pluginDiagnostics 的文本锚点
  // 钉 current 投影（veil-layering-invariants.test.ts），不重排既有参数。
  sessionFacts: Record<string, SessionFactsSnapshot | undefined>,
): ChamberServerAggregate[] {
  const servers: ChamberServerAggregate[] = []
  const now = Date.now()
  const push = (
    kind: ChamberServerAggregate['kind'],
    transport: ChamberServerAggregate['transport'],
    id: string,
    label: string,
    sourceFingerprint: string,
    rawId?: string,
    statusKind?: TransportKind,
  ): void => {
    const statusKey = kind === 'local' ? id : (rawId ?? id)
    const transportPhase = kind === 'local'
      ? (health?.dsh?.status ?? 'unknown')
      : (remoteStatus[statusKey]?.phase ?? 'idle')
    // 问题 B 修复（）：gateway 形态的 ready 只证明 gateway 进程活着
    // （desktop 的就绪探针读的就是 `/chamber/runtime/status`），托管 dsh 是
    // 独立进程。把它的 connectionState 投影进该源——phase 走侧栏既有的状态点
    // （status.stopped/error/restartExhausted 文案已存在），终态停机时
    // connected=false 让动作入口按既有语义禁用而不是"可点但背后不可用"。
    // 探针缺失/未知一律 fail open（不拿缺失的探针隐藏健康来源）。
    // **只在该源的传输确实可用时**才认这条事实：`phase` 是"托管态 ∪ 传输态"的
    // 合并值，而两套词表都含 `error`——若让消费者重新分类合并后的 phase，
    // SSH/隧道失败会被误诊为"托管 dsh 停机"（）。
    const runtimeState = kind === 'gateway' ? managedRuntime[id] : null
    const transportUsable = kind === 'local'
      ? transportPhase === 'ready'
      : transportPhase === 'ready' || transportPhase === 'degraded'
    const managedDown = kind === 'gateway' && transportUsable && managedRuntimeDown(runtimeState)
    // 托管态的**瞬态**（starting/restarting）同样投影进 phase：此时隧道是好的、
    // 但 dsh 还没起来，绿点会撒谎（）。degraded 保持传输态
    // （设计 17 既有语义：degraded 仍可交互）。
    const managedTransient = kind === 'gateway' && transportUsable
      && (runtimeState === 'starting' || runtimeState === 'restarting')
    const phase = managedDown || managedTransient ? runtimeState! : transportPhase
    let workspaces: ChamberServerAggregate['workspaces'] = []
    const aggregate = aggregates[id]
    // 托管态瞬态（starting/restarting）同样不可用：dsh 还没服务，动作入口只会
    // 503（与终态停机同一理由，）。phase 已携带忙碌点。
    const connected = !managedDown && !managedTransient && instanceConnected(
      kind === 'local' ? 'local' : (statusKind ?? kind),
      health,
      remoteStatus,
      statusKey,
    )
    let archivedSessions: ChamberServerAggregate['archivedSessions']
    let archiveSetKnown: ChamberServerAggregate['archiveSetKnown']
    if (connected && aggregate !== undefined && aggregate.state === 'ok') {
      // 当前会话事实只给活动来源：blank（新建未首发的）会话行只在正在查看的
      // 来源投影（06  全局单选纪律）——否则每个已挂载来源都会冒出它的
      // 空"新建会话"行。其他来源 blank 行照旧不进入导航列表。
      // chamber (2026-12，design 05 §2.2 修订)：该来源还有在途 open、且官方运行时
      // 当前选中的**不是**用户要打开的那个会话时，不投影 current——冷 boot 期间官方
      // 初始导航策略会先给自己选中一个 blank 会话，此刻投影它就会渲染出一行高亮的
      // "新会话"，下一次分发（最多 400ms 后）又消失，正是真机问题的可见形态。
      // 幂等重开（current 已经就是要打开的那个会话）不受影响：投影本就正确，
      // 为一次分发把高亮摘掉再装回去是纯闪烁、零信息。
      const current = projectableCurrent(
        activeViewId,
        id,
        runtimeFacts[id]?.current,
        openIntents[id],
      )
      // Positional contract of deriveServerWorkspaces (derive.ts): (snapshot,
      // serverId, ungroupedTitle, currentSessionId?, now?). P4-4 review (2026-
      // 09) surfaced a pre-existing mis-binding masked by the old 3-param
      // vendor overlay — `current` must ride the currentSessionId slot so the
      // blank-row currentness branch (and the sidebar ghost-key arming on the
      // REAL source id) actually fires; the ungrouped bucket title is
      // display-only (''), overridden by the sidebar's own t('list.ungrouped').
      // chamber (2026-12, design 05 §2.2 revision): the workspace-creation echo
      // rides the SAME projection pass — one choke point for every workspace
      // row (derived or echoed), so the echo needs no second copy inside the
      // aggregate. `withWorkspaceEcho` is identity-preserving for an absent or
      // empty ledger, leaving this derive byte-identical to before.
      workspaces = deriveServerWorkspaces(
        // 顺序是契约：①归档墓碑先把本页刚归档的 id 并进归档集（可见性规则只认这个
        // 字段，回声行也一并被它过滤）；②工作区回声补齐可能刚建的工作区行；③会话
        // 回声再按 workspaceId/路径把新建的会话挂进那一行。三步都只做纯投影。
        withSessionEcho(
          withWorkspaceEcho(withPendingArchives(aggregate, sessionArchive[id]), workspaceEcho[id]),
          sessionEcho[id],
        ),
        id,
        '',
        current,
      )
      // Archive-manager metadata (design 24 revision ): archived rows
      // of this source's snapshot ride the same aggregate; the manager UI
      // never issues its own session read. archiveSetKnown is the provenance
      // tri-state: the mounted baseline reports an authoritative set (even
      // when empty); the unary-fallback view reports NOT known — consumers
      // must never read its set as "no archived sessions" (it may be empty OR
      // the remembered authoritative set,  F3(b)).
      archivedSessions = deriveArchivedSessions(aggregate)
      archiveSetKnown = aggregate.archiveSetKnown === true
    }
    const entry: ChamberServerAggregate = {
      id,
      sourceFingerprint,
      kind,
      transport,
      ...(rawId === undefined ? {} : { rawId }),
      label,
      connected,
      phase,
      ...(managedDown ? { managedRuntimeDown: true } : {}),
      workspaces,
      ...(archivedSessions === undefined ? {} : { archivedSessions, archiveSetKnown }),
      aggregateReady: aggregate !== undefined && aggregate.state === 'ok',
      updatedAt: now,
    }
    // 运行时事实附加闸（）：connected 仍是主闸，
    // 但**未读事实与 facts overlay 破例**——断连来源仍附只读事实并标
    // stale:true，消费者（todo-attention）按 stale 出「离线未读」条目；没有
    // 事实时两条参数调用的结果与改动前逐字节一致（mergeRuntimeFacts 兼容锁）。
    // App 自持的完成未读点（completedBySource）与通道上报并集：蓝点以派生
    // 投影为准（deriveSourceUnread；它无视后台来源 shell 的陈旧 selected），
    // vendor 的 completed 作兜底保留。合并为纯函数 mergeRuntimeFacts（shared/
    // derive.ts，单测覆盖）。
    // R19 能力一览（plan W4）：把该来源事实的 probe 判定投影进聚合条目。无快照时
    // 保持缺席（侧栏把缺席读作未知；臆造 full 会让能力说明在未知状态下撒谎）。
    // 位置纪律：必须在 entry 字面量**之后**（否则 TDZ 直接抛）。
    const factsMode = sourceSessionFactsMode(sessionFacts[id])
    if (factsMode !== undefined) entry.sessionFacts = factsMode
    if (connected) {
      const dshVersion = hostFacts[id]?.dshVersion
      if (dshVersion !== undefined) entry.dshVersion = dshVersion
    }
    const overlay = factsOverlay(sessionFacts[id])
    const sourceLedger = completedBySource[id]
    const hasLedger = sourceLedger !== undefined && Object.values(sourceLedger).some(value => value === true)
    if (connected || hasLedger || overlay !== undefined) {
      const merged = mergeRuntimeFacts(
        runtimeFacts[id],
        sourceLedger,
        overlay,
        connected ? undefined : true,
      )
      if (merged !== undefined) entry.runtime = merged
    }
    if (aggregate !== undefined && aggregate.state === 'error') {
      // ): this fallback is frame-owned copy —
      // it is rendered verbatim by the sidebar's source alert and the archive
      // dialog (ServerSection.tsx role="alert", ArchiveManagerDialog.tsx), i.e.
      // it crosses the frame→plugin boundary as a finished string, so it must
      // come from the frame dictionary in the frame's locale like every other
      // audited string (the previous round's audit missed it).
      entry.aggregateError = aggregate.error ?? frameText(locale, 'error.unknown')
    }
    if (pluginDiagnostics[id] !== undefined) entry.pluginDiagnostic = pluginDiagnostics[id]
    // Settled-boot gap（）：结构化事实过桥，渲染方（侧栏来源行 / 连接页）
    // 各出各的文案；生产者的诊断句子不过界。
    const bootGap = shellStates[id]?.degraded
    if (bootGap !== undefined && bootGap !== null) entry.bootGap = toServerBootGap(bootGap)
    servers.push(entry)
  }
  push('local', 'local', LOCAL_INSTANCE_ID,
    (connections ?? [])[0]?.label ?? frameText(locale, 'source.local'), 'local')
  for (const instance of remoteInstances) {
    // The persisted/runtime target kind is independent of the transport.
    // `ssh` is accepted only as the legacy spelling of a dsh target.
    const targetKind: 'dsh' | 'gateway' = instance.kind === 'gateway' ? 'gateway' : 'dsh'
    push(
      targetKind,
      instance.transport,
      sourceIdForInstance(instance),
      instance.label,
      instance.sourceFingerprint,
      instance.id,
      instance.kind,
    )
  }
  return servers
}

interface ErrorBoundaryState {
  error: Error | null
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer] component error:', error, info)
    // 崩溃屏替换 children = 所有视图卸载，但 AppWebEntry ctx 不随之消失：
    // 必须在此 dispose 全部 shell（entries 清空），重试后的重 boot 才不会
    // 用新 entry 覆盖未销毁的旧 ctx（僵尸 ctx，05  无僵尸不变量）。
    disposeAllShells()
  }

  render(): React.ReactNode {
    if (this.state.error) {
      // T16 (): frame copy rides the typed locale
      // dictionary; a class component reads the locale through the module
      // reader (it cannot own a hook).
      const locale = readDocumentLocale()
      return (
        <div className="fatal">
          <div className="fatal-title">{frameText(locale, 'error.ui.title')}</div>
          <div className="fatal-message">{String(this.state.error?.message || this.state.error)}</div>
          {/* T15 (2026-09-11 upstream-alignment): the official Button atom —
              the chamber-invented `.btn` chrome (and its own palette entry) is
              gone. */}
          <Button
            variant="outline"
            onClick={() => {
              this.setState({ error: null })
            }}
          >
            {frameText(locale, 'action.retry')}
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * 单调时基（W3 揭示门；照 InstanceView.tsx:65-75 的既有理由与实现）：持有窗只做差值
 * 比较，绝不能受墙钟步进影响——NTP 校时/休眠唤醒把 `Date.now()` 拉回 10 分钟，会让
 * "已持有 1s"的算术算出负 elapsed，一次性到期定时器就可能不再重臂。`performance.now()`
 * 在渲染器里恒在，缺失时退回墙钟（测试/异常环境）。
 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

export default function App() {
  // T16 (): the frame owns no `t` seat, so it
  // renders its own copy from the typed dictionary in locales.ts, in the locale
  // the DOCUMENT declares — `<html lang>` is written by the booted shell's
  // official locale service (syncDocumentLanguage), and the subscription makes a
  // locale change inside dsh re-render the frame chrome (the same value
  // readDocumentLocale() reads, so out-of-render copy cannot drift from it).
  const locale = useSyncExternalStore(subscribeDocumentLocale, readDocumentLocale)
  const t = useCallback((key: FrameKey, params?: Readonly<Record<string, string>>) =>
    frameText(locale, key, params), [locale])
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  // 健康失败首次出现的时间戳：致命屏要求错误**持续**存在（宽容瞬时抖动/
  // SSE 重连窗口），否则首帧成功后的会话中途失联会被陈旧 health 永远掩盖。
  const [healthErrorAt, setHealthErrorAt] = useState<number | null>(null)
  // 连接行初始 null = "尚未拉到首轮"（404 映射空数组 = 权威"无本地行"）；
  // 两种状态区分后，首启（无行）才会触发本地实例自动启动。
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null)
  const [remoteInstances, setRemoteInstances] = useState<SshInstanceSpec[]>([])
  // false means no authoritative desktop instances_get result belongs to the
  // current roster generation yet. Deep-link remote activation is held until
  // this becomes true; a rejection leaves it false so a later retry can replay.
  const [remoteRosterSettled, setRemoteRosterSettled] = useState(false)
  const remoteRosterSettledRef = useRef(false)
  // At most one renderer activation is useful: view switching is
  // last-intent-wins. This fixed-size slot prevents a failed roster from
  // growing a second unbounded queue behind main's already-bounded queue.
  const pendingDeepLinkDeliveryRef = useRef<DeepLinkDelivery | null>(null)
  // Notification opens carry a session id and cannot collapse to a source-only
  // last intent. Preserve them in order, but mirror main's 64-entry bound.
  const pendingRosterNotificationOpensRef = useRef<NotificationOpenDelivery[]>([])
  // Last-started roster pull wins. An instances-changed event increments this
  // generation before the replacement pull so an older response cannot revive
  // a removed source or prematurely settle the new generation.
  const remoteRosterRefreshSeqRef = useRef(0)
  // Async work that has left the roster-pending FIFO captures an exact object
  // owner. Only active sources occupy the registry; retirement deletes the
  // current object and an authoritative re-add activates a fresh one.
  const sourceLifecyclesRef = useRef<SourceOwnershipRegistry | null>(null)
  sourceLifecyclesRef.current ??= new SourceOwnershipRegistry([LOCAL_INSTANCE_ID])

  const acknowledgeDeepLink = useCallback(async (delivery: RendererDeliveryCoordinates): Promise<void> => {
    const deepLink = window.dshChamber?.deepLink
    if (deepLink === undefined) throw new Error('deep-link ACK bridge unavailable')
    const acknowledged = await acknowledgeRendererDelivery(
      delivery,
      (deliveryId, attempt) => deepLink.ack(deliveryId, attempt),
    )
    if (!acknowledged) {
      console.warn(`[renderer] ignored stale deep-link ACK ${delivery.deliveryId}/${delivery.attempt}`)
    }
  }, [])

  const acknowledgeNotificationOpen = useCallback(async (delivery: RendererDeliveryCoordinates): Promise<void> => {
    const notifications = window.dshChamber?.notifications
    if (notifications === undefined) throw new Error('notification ACK bridge unavailable')
    const acknowledged = await acknowledgeRendererDelivery(
      delivery,
      (deliveryId, attempt) => notifications.ack(deliveryId, attempt),
    )
    if (!acknowledged) {
      console.warn(`[notifications] ignored stale open ACK ${delivery.deliveryId}/${delivery.attempt}`)
    }
  }, [])

  const reportDeepLinkAckFailure = useCallback((delivery: RendererDeliveryCoordinates, error: unknown): void => {
    console.error(`[renderer] deep-link ACK exhausted retries (${delivery.deliveryId}/${delivery.attempt}):`, error)
  }, [])

  const reportNotificationAckFailure = useCallback((delivery: RendererDeliveryCoordinates, error: unknown): void => {
    console.error(`[notifications] open ACK exhausted retries (${delivery.deliveryId}/${delivery.attempt}):`, error)
  }, [])
  const [remoteStatus, setRemoteStatus] = useState<Record<string, SshStatusProjection>>({})
  // 视图：'local' | '<kind>-<id>'。N-ctx 常驻语义（05 /）自 2026 性能
  // 整改起收窄为保留策略（retention.ts）：local 恒留；隐藏非 local 壳最多
  // 保留 RETAINED_HIDDEN_VIEWS 个，超限回收"已 settle + 连续隐藏 ≥60s"的
  // 最久者（回收 = dispose shell + 卸载壳；实例进程/连接/后台任务不受影响，
  // 重开走冷 boot + entry 重放——见 reclaimView）。会话保活由实例侧承担，
  // UI 壳不再无限常驻。
  const [activeView, setActiveView] = useState<string>(LOCAL_INSTANCE_ID)
  /**
   * W3 延迟揭示（）：**屏上真正可见的那个视图**。与 activeView（选择）
   * 分离——点击只改选择，painted 由下方揭示 effect 在「目标首帧可用」时经既有
   * 'view' 过渡键收敛。为什么必须分离（事实）：`view-transition.ts:6-11` 的语义是
   * "新状态渲染就绪后动画才开始"，冷 boot 的"新状态首帧"就是遮罩本身——VT 单独
   * 做不到"boot 期保持旧视图"。两者相等 = 稳态；不等 = 一次在途揭示（至多一个）。
   * 判定规则见纯叶子 `reveal-gate.ts`（node 直测）。
   * 驱动面（只有这些消费者读 painted，其余一律读选择语义的 activeView）：
   * `InstanceView active=`（可见性）、hover 卡关闭、保留回收的"展示中"保护、
   * `deriveServers.projectableCurrent`（侧栏高亮跟随屏上来源）、hiddenSince 起表。
   * **阅读/蓝点武装（:4044/:4075/:4093-4107）也应当读 painted**——本轮的 App.tsx
   * 写权限冻结在 runtime-facts handler 与 completedBySource 账本之外，那三处留给
   * 接管这两个区域的 WS-C 按同一条语义替换。
   */
  const [paintedView, setPaintedView] = useState<string>(LOCAL_INSTANCE_ID)
  const [mountedViews, setMountedViews] = useState<string[]>([LOCAL_INSTANCE_ID])
  // Views mounted only by background prewarm. User selection removes the id
  // from this set, freeing one of the idle-prewarm slots while keeping
  // the user-opened N-ctx shell resident.
  // The incarnation fence uses the ownership registry's REAL fingerprint (the registry
  // tracks it per view), so a re-registered source gets a fresh record and a
  // reclaim/re-mount cycle keeps its history - the distinction this container exists to
  // express. `undefined` (the registry has not captured the view yet) falls back to the
  // id, matching "one record per view" until the registry catches up.
  // Declared BEFORE the ledger views below: they close over it, and their useMemo
  // dependency arrays read it during render, so a later declaration would be a TDZ
  // error in a real browser (the node suites strip types and never render App).
  const dispatchLifecycle = useCallback((viewId: string, event: SourceEvent, capturedEpoch?: number) => {
    let registry = sourceLedgerStoreRef.current
    let epoch = capturedEpoch ?? epochOf(registry, viewId)
    if (epoch === undefined) {
      // The authoritative roster refresh pre-registers every source through
      // reincarnate(), so this lazy path only covers an event that beats that refresh
      // (or a local view). It is the ONLY place the ownership fingerprint is read -
      // an event no longer recomputes it, and it must never resurrect a retired
      // generation.
      const fingerprint = sourceLifecyclesRef.current?.capture(viewId)?.fingerprint ?? viewId
      registry = reincarnate(registry, { sourceId: viewId, fingerprint })
      epoch = epochOf(registry, viewId)
    }
    if (epoch === undefined) return undefined
    // `retryableGap` is the SAME table the retired degraded-retry planner used
    // (`isRetryableBootGap`), passed as data: the registry owns the decision, the App
    // keeps owning the table it supplies.
    const reduction = dispatchSource(
      registry,
      viewId,
      { ...event, epoch },
      { reclaimGraceMs: 0, retryableGap: (kind) => isRetryableBootGap(kind as ShellDegradedKind) },
    )
    // A dropped event (superseded epoch / unregistered source) returns the SAME
    // registry reference, so this write cannot resurrect or mutate a retired life.
    sourceLedgerStoreRef.current = reduction.registry
    return reduction.effects[0]?.effect
  }, [])
  //  a Set LEDGER view - reads project the container, and each add/delete becomes
  // one event. The Set shape is why this cannot be the assignment-translating view the
  // record ledgers use: add/delete are method calls. Iteration is snapshot-based, so
  // the three sweep loops that delete while iterating stay safe (see the adapter).
  const autoPrewarmedRef = useMemo(() => ({
    current: createSetLedgerView({
      read: () => projectAutoPrewarmed(sourceLedgerStoreRef.current),
      onAdd: (id) => dispatchLifecycle(id, { kind: 'prewarmStarted' }),
      onDelete: (id) => dispatchLifecycle(id, { kind: 'prewarmForgotten' }),
    }),
  }), [dispatchLifecycle])
  // 保留策略：被回收（闲置隐藏壳超限回收）的源禁止自动预热，直到用户主动
  // 点开（selectView 清除）或来源从注册表删除（retireSources 清除）——否则
  // prewarmEligible 会立刻把刚回收的源重新 boot，回收空转（见 reclaimView）。
  const prewarmSuppressedRef = useMemo(() => ({
    current: createSetLedgerView({
      read: () => projectPrewarmSuppressed(sourceLedgerStoreRef.current),
      // add = retention just suppressed this source; delete = the suppression entry
      // is gone (user opened it, or the registry dropped it). Neither asks for a boot
      // - the re-boot decision is the prewarm drain's, not this ledger's.
      onAdd: (id) => dispatchLifecycle(id, { kind: 'prewarmSuppressed' }),
      onDelete: (id) => dispatchLifecycle(id, { kind: 'prewarmSuppressionForgotten' }),
    }),
  }), [dispatchLifecycle])
  // 设置面板目标来源（design 05 ，）：面板渲染的是**选中
  // 来源自己的 boot ctx 台账**，所以该来源的壳必须挂载着。面板打开期间由 App
  // 保证两件事——未挂载则后台挂载（不切 active view），已挂载则排除出保留策略
  // 回收候选（否则隐藏 60s 后壳被拆，面板正在编辑的设置面随之消失）。面板关闭
  // (`undefined`) 即撤除这两条保证。
  const settingsTargetRef = useRef<string | undefined>(undefined)
  // 首屏基线收割（design 05  / baseline-harvest.ts）：ready 但从未挂载过的
  // 来源在后台预热槽里挂一次，拿到首个权威推送即回收——否则它稳态停留在
  // unary 兜底视图（合成分组 + 空归档集）直到用户点击。harvestStateRef 是
  // 每源账本（尝试次数/退避/是否已满足），harvestIntentRef 记录"当前这次挂载
  // 是收割挂载"（提交推送、boot 失败、用户点开三条路径据此分流）。
  //  the harvest slots are container-backed. Every call site reads a whole record,
  // runs a baseline-harvest PURE function, and stores the result back, so the view
  // accepts the finished record (the policy functions stay where they are; storage
  // has one owner).
  const harvestStateRef = useMemo(() => ({
    current: createHarvestView({
      read: () => projectHarvest(sourceLedgerStoreRef.current),
      // `harvestAttemptStarted` / `harvestSatisfied` / `harvestParkedRecord` each
      // build the whole record, so one write carries all four fields.
      onWrite: (id, record) => dispatchLifecycle(id, { kind: 'harvestRecord', record }),
      onDelete: (id) => dispatchLifecycle(id, { kind: 'harvestCleared' }),
      // The legacy initial value: an absent record reads as "nothing attempted yet".
      initial: () => ({ attempts: 0, mountedAt: 0, retryAt: 0, satisfied: false }),
    }),
  }), [dispatchLifecycle])
  const harvestIntentRef = useRef<Set<string>>(new Set())
  // 仍需收割的来源（prewarmEligible 的渲染期镜像）：提交推送时据此决定"保留
  // 最后收割的壳当温壳"还是"回收让位给下一个候选"。
  const harvestCandidatesRef = useRef<Set<string>>(new Set())
  // reclaimView 的 ref 镜像：定义在下方（依赖 mountedViews），而
  // handleShellState / onInstanceSnapshot 是 [] 依赖的回调——它们只能经此
  // 拿到最新闭包（同 reclaimHiddenViewsRef 纪律）。
  const reclaimViewRef = useRef<(id: string, reason?: 'retention' | 'harvest') => void>(() => undefined)
  // 保留策略计时：每视图"连续隐藏"起点（ms epoch；**屏上视图无键**）。settle
  // 完成或离开屏时置 now，重新画上屏删除，随 mountedViews 收敛清理（回收 effect
  // 内统一处理）。previousActiveViewRef 供 paintedView 落地 effect 对比
  // （W3：起表/清表都按 painted——活跃判定 activeView 会让持有窗内的屏上壳被计时）。
  //  the hidden-window ledger now lives in ONE per-source state object. The ref
  // below stays, but it is no longer a store - it is a LIVE VIEW: reads project the
  // container, and the scheduler's direct writes (delete/timestamp) are translated
  // into reducer events. That keeps the existing call sites unchanged while leaving
  // exactly one owner, which is what the migration is for; the writes become explicit
  // dispatches as each remaining ledger moves over.
  const sourceLedgerStoreRef = useRef<SourceRegistry>({})
  // The incarnation fence uses the ownership registry's REAL fingerprint (the
  // registry above already tracks it per view), so a re-registered source gets a
  // fresh record and a reclaim/re-mount cycle keeps its history - the distinction
  // this container exists to express. `undefined` (registry has not captured the
  // view yet) falls back to the id, matching "one record per view" until the
  // registry catches up.
  // A LIVE VIEW, not a store: reads project the container on every access (so the
  // scheduler's momentary reads can never observe a stale render), and the
  // scheduler's direct writes are translated back into reducer events. The call
  // sites stay unchanged while there is exactly one owner.
  const hiddenSinceRef = useMemo(() => ({
    get current(): Record<string, number> {
      return projectHiddenSince(sourceLedgerStoreRef.current)
    },
    set current(next: Record<string, number>) {
      const previous = projectHiddenSince(sourceLedgerStoreRef.current)
      for (const [id, at] of Object.entries(next)) {
        if (previous[id] !== at) dispatchLifecycle(id, { kind: 'hidden', at })
      }
      for (const id of Object.keys(previous)) {
        if (next[id] === undefined) dispatchLifecycle(id, { kind: 'windowReset' })
      }
    },
  }), [dispatchLifecycle])
  const previousActiveViewRef = useRef<string | null>(paintedView)
  // chamber ()：每视图 shell 终态（InstanceView
  // 经 onStateChange 上报）——活动视图 boot 失败时由 App 渲染统一失败覆盖层
  // （失败报告 + 重试 + 服务器切换）。retryTokens 驱动 InstanceView 的重试
  // 重 boot（令牌递增 → 视图复位 → 重新启动 shell）。
  const [shellStates, setShellStates] = useState<Record<string, ShellState>>({})
  /**
   * 来源就绪门 + 降级自愈（）：
   * ① 实例仍启动时让取图等它就绪（冷启动 / 重启跨越窗口不再丢掉整套 profile
   *    客户端插件；`ui-chat` 依赖的 `sidebarRight` 只由其中的 ui-sidebar-right
   *    行提供）；
   * ② boot 以降级收尾（无图 / 必需 extra-row 服务缺席）而来源随后 ready 时，
   *    自动重挂一次——此前只有整页 reload 能恢复。每个 ready 世代一次。
   * 相位从 servers 的渲染期镜像读取，门自身带绝对上限，来源被移除即放弃。
   */
  const serversPhaseRef = useRef<Record<string, string | undefined>>({})
  const waitForServing = useCallback(async (instanceId: string): Promise<boolean> => {
    // 终态宽限（W2）：用户点来源时 App 会先触发一次即时重连，相位需要一两个
    // tick 才翻到 connecting——终态必须**持续**一段时间才判"不可服务"，
    // 否则会把正在恢复的来源误报成未连接。
    let terminalSince: number | null = null
    //  (W6): the wait is the shared primitive now. The bound is passed as a
    // WALL-CLOCK budget (`now`), which is what this site always meant: the retired
    // loop compared `Date.now() >= deadline`. Without P1's clock the primitive would
    // count TICKS, and a delayed event loop would overrun the 60s boot budget.
    // Order is preserved: the gate is judged first, the bound second.
    let verdict: boolean | null = null
    const outcome = await waitForCondition({
      pollMs: SERVING_POLL_MS,
      boundMs: SERVING_WAIT_MS,
      scheduler: WAIT_SCHEDULER,
      now: () => Date.now(),
      isDone: () => {
        const phase = serversPhaseRef.current[instanceId]
        // undefined（投影未到）交给纯判定：事实未到不是"未连接"，预算内继续等
        // （）。
        if (phase === 'ready') { verdict = true; return true }
        // 相位感知（W2，）：`error`（快速重试耗尽）与
        // idle（手动断开）不再烧满整个 boot 预算；`connecting`/`degraded`
        // （恢复中）继续在预算内等。判定是纯逻辑（source-readiness），本处只接线。
        const decision = decideServingGate({ phase, nowMs: Date.now(), terminalSinceMs: terminalSince })
        if (decision.action === 'serve') { verdict = true; return true }
        if (decision.action === 'unavailable') { verdict = false; return true }
        terminalSince = decision.terminalSinceMs
        return false
      },
    })
    // Expiry keeps the old meaning: the budget ran out and the source never served.
    return outcome === 'expired' ? false : verdict === true
  }, [])
  //  the once-per-ready-epoch self-heal mark, projected from the SAME container.
  // The scheduler's clear (`[id] = false`) translates to the container's
  // `retryForgotten` at the view's write point, so the mark's lifecycle has one owner
  // while every reader keeps its old call site.
  const degradedRetriedRef = useMemo(() => ({
    get current(): Record<string, boolean> {
      return projectDegradedRetried(sourceLedgerStoreRef.current)
    },
    set current(next: Record<string, boolean>) {
      const previous = projectDegradedRetried(sourceLedgerStoreRef.current)
      for (const id of Object.keys(previous)) {
        if (next[id] !== true) dispatchLifecycle(id, { kind: 'retryForgotten' })
      }
    },
  }), [dispatchLifecycle])
  const [retryTokens, setRetryTokens] = useState<Record<string, number>>({})
  // 每实例 workspace/session 聚合（已挂载 ctx 推送 + 未挂载 unary 兜底；控制面不持有会话事实）
  const [aggregates, setAggregates] = useState<Record<string, InstanceAggregate>>({})
  // Complete snapshots reported by mounted ctx stores. A source appears here
  // only while both reconnect baselines are idle + ready; loading/error
  // withdraws ownership so an identical recovered baseline is re-published.
  // Complete sources require no periodic unary aggregation; unmounted/
  // incomplete sources retain the bounded fallback below.
  const [snapshotSources, setSnapshotSources] = useState<Record<string, true>>({})
  // Event callbacks and fallback polls may interleave before React commits the
  // state update above. Keep a synchronous ownership mirror so a producer's
  // first snapshot immediately suppresses any later unary pull in that window.
  const snapshotSourcesRef = useRef<Record<string, true>>({})
  // Last PUSHED-snapshot timestamp per source (ms epoch; absent = never). The
  // staleness watchdog uses recency as its only liveness signal — the unary
  // client exposes no per-source connection state, and a silently dead push
  // channel never fires the producer withdrawal (aggregate-store clear()).
  const snapshotAtRef = useRef<Record<string, number>>({})
  /** 最近一次**成功验证事实**（push 或 unary 提交）的时刻（）：
   *  保留视图据此有界化 —— 超过界限仍无法验证时，不再保留无法验证的 running 断言
   *  （aggregate-refresh.ts 的 shouldDropUnverifiedRunningFacts，design 05 ）。 */
  const factsAtRef = useRef<Record<string, number>>({})
  // Last connection-reconnect timestamp per source (S2, ms epoch; absent =
  // never reconnected). The staleness watchdog records it so
  // shouldReconnectStaleMounted can bound repeat reconnects of one stale
  // mounted source (AGGREGATE_RECONNECT_BACKOFF_MS). Reaped with the source
  // like snapshotAtRef (a same-id re-add must start a fresh backoff window).
  const lastReconnectAtRef = useRef<Record<string, number>>({})
  // Last session-list refresh request timestamp per source (design 24 ,
  // ms epoch; absent = never requested). Floors the re-request cadence of the
  // ghost-row convergence machine below (SESSION_LIST_REFRESH_COALESCE_MS): a
  // refresh re-runs the OFFICIAL session.list of the mounted ctx, and a
  // failing refresh on a busy source must not stack RPCs per push. Reaped with
  // the source like lastReconnectAtRef (same-id re-add starts a fresh window).
  const sessionListRefreshAtRef = useRef<Record<string, number>>({})
  // Un-converged ghost-row ids per source (design 24 ): archived ids removed
  // by a purge whose rows are STILL listed in the latest mounted push of this
  // source (rows linger in the official client summaries until a session-list
  // refresh drops them). Maintained by planSessionListRefresh on every push;
  // empty/absent = converged (rows gone or never listed). Reaped with the
  // source like the stamp map above (same-id re-add starts clean).
  const sessionListRefreshPendingRef = useRef<Record<string, string[]>>({})
  // Last AUTHORITATIVE archive set per source (design 24  F3):
  // the ids published by a mounted push with `archiveSetKnown: true`. It
  // survives the aggregate being replaced by the degraded unary view (which
  // carries no archive wire), so (a) a purge whose shrink lands while the
  // producer's first projection is still pending is still detectable as a
  // shrink, and (b) a degraded commit can keep filtering archived rows
  // instead of un-hiding every archived session. Never authoritative on its
  // own: `archiveSetKnown` stays false wherever this memory is used as a
  // substitute. Reaped with the source like the refs above.
  const authoritativeArchiveSetRef = useRef<Record<string, readonly string[]>>({})
  // Synchronous connection-generation edge memory. A mounted producer may
  // suppress an identical post-reconnect snapshot, while the App has already
  // replaced its aggregate with not-connected; one authoritative pull on each
  // not-ready -> ready edge closes that gap without restoring periodic RPCs.
  const readyAggregateSourcesRef = useRef<Set<string>>(new Set())
  // Unary aggregate pulls and bounded retries use latest-owner object tokens.
  // The table is active-only: retirement/disconnect deletes ownership, while
  // a later same-id pull receives a never-reused object.
  const aggregateRequestOwnersRef = useRef<SourceOwnershipRegistry | null>(null)
  aggregateRequestOwnersRef.current ??= new SourceOwnershipRegistry()
  const aggregatePollSeqRef = useRef<Record<string, number>>({})
  const mutationRefreshSeqRef = useRef<Record<string, number>>({})
  const aggregateFailuresRef = useRef<Record<string, number>>({})
  const aggregateRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const aggregateRefreshQueueRef = useRef(new AggregateRefreshQueue())
  const clearAggregateRetry = useCallback((sourceId: string): void => {
    const timer = aggregateRetryTimersRef.current.get(sourceId)
    if (timer === undefined) return
    clearTimeout(timer)
    aggregateRetryTimersRef.current.delete(sourceId)
  }, [])
  const [pluginDiagnostics, setPluginDiagnostics] = useState<Record<string, PluginGraphDiagnostic | undefined>>({})
  // 工作区创建回声（）：侧栏在某来源上用 unary
  // `workspace.create` 建好工作区后，把宿主 workspaceId 上报到这里；App 在
  // **投影那一个**汇合点（deriveServers）把该行并入，直到权威 `workspace/follow`
  // push 覆盖它。为什么需要：未挂载来源只有 unary 兜底（工作区靠会话 cwd 反推，
  // 新空工作区没有会话 ⇒ 结构上不可见），已推送来源的工作区集又被冻结
  // （commitAggregatePull 的 mounted merge），所以 requestRefresh 无论哪条分支
  // 都刷不出这一行——真机表现为"必须手动点一下那个服务器"。
  // state 供渲染触发，ref 供事件侧同步读（与 snapshotSources/snapshotSourcesRef 同纪律）。
  const [workspaceEcho, setWorkspaceEcho] = useState<WorkspaceEchoLedger>({})
  const workspaceEchoRef = useRef<WorkspaceEchoLedger>({})
  const updateWorkspaceEcho = useCallback((next: WorkspaceEchoLedger): void => {
    workspaceEchoRef.current = next
    setWorkspaceEcho(next)
  }, [])
  // 会话创建回声（）：侧栏的 "+" 与
  // 行菜单 fork 都经**该来源自己的 unary client** 建会话。挂载壳的官方 summaries
  // 只有一条异步外源（宿主的 api-session/added 广播）：竞态窗内随后那次挂载推送
  // 会拿还不含它的 store 替换整份聚合，行随即消失；而未挂载来源（收割后的稳态，
  // 工作区行仍是真实推送行）根本收不到广播，30s unary 兜底的 mounted merge 又冻结
  // 工作区成员位——新会话只能以未归属散落行出现，且仍是暂存 blank 行时不进导航。
  // 真机表现：新建的会话要切到那个服务器（挂载 → follow 基线）才出现。账本记录
  // 宿主 id 并立刻并入投影，权威视图（App 在事实到达时请求的官方 session-list
  // 刷新——只有挂载壳有这条 seam，它强制 summaries 重读语料——或该来源下次挂载）
  // 到达即退场（reconcilePendingSessions）。与会话打开意图同纪律：state 供渲染，
  // ref 供事件侧同步读。
  const [sessionEcho, setSessionEcho] = useState<SessionEchoLedger>({})
  const sessionEchoRef = useRef<SessionEchoLedger>({})
  const updateSessionEcho = useCallback((next: SessionEchoLedger): void => {
    sessionEchoRef.current = next
    setSessionEcho(next)
  }, [])
  // 会话归档墓碑（）：侧栏的归档动词同样走 unary，未挂载来源
  // （收割后的稳态）没有任何活通道——mounted merge 冻结上次推送的 archivedSessionIds、
  // unary 兜底根本没有归档 wire，于是刚归档的行照样留在列表里且可点（点开即空视图：
  // 官方运行时会把 archived current 清掉）。本账本把**本页自己归档**的 id 过滤掉，直到
  // 权威归档集覆盖它；别处（另一个客户端）归档的仍需挂载（已登记残余）。租约由
  // 兜底拉取续期（只要那份错视图还在列它，就继续藏）；权威集覆盖 / 来源退役 / 租约到期
  // 收敛。与会话回声同纪律：state 供渲染，ref 供事件侧同步读。
  const [sessionArchive, setSessionArchive] = useState<SessionArchiveLedger>({})
  const sessionArchiveRef = useRef<SessionArchiveLedger>({})
  const updateSessionArchive = useCallback((next: SessionArchiveLedger): void => {
    sessionArchiveRef.current = next
    setSessionArchive(next)
  }, [])
  /**
   * Expire echoes past their TTL. Called from every tick that can change what a
   * source's workspace list SHOULD contain — a new creation, an authoritative
   * mount push, and each fallback pull — because an echo whose convergence never
   * arrives (a source that is never mounted again, a workspace deleted on the
   * host by another client) has no other clock: sweeping only inside the create
   * handler would let such an entry live for the rest of the session. Identity
   * preserving, so a sweep that expires nothing costs no re-render.
   */
  const sweepWorkspaceEcho = useCallback((): void => {
    const next = sweepPendingWorkspaces(workspaceEchoRef.current, Date.now())
    if (next !== workspaceEchoRef.current) updateWorkspaceEcho(next)
  }, [updateWorkspaceEcho])
  /**
   * Session-echo TTL tick (same three clocks as the workspace echo: a new
   * creation — where the recording handler sweeps before it records — an
   * authoritative mount push, and each fallback pull). The TTL is a leak guard,
   * not a convergence budget: a create whose convergence never arrives (a
   * source that is never mounted again, a session deleted on the host by
   * another client) must still expire. Identity preserving.
   */
  const sweepSessionEcho = useCallback((): void => {
    const next = sweepPendingSessions(sessionEchoRef.current, Date.now())
    if (next !== sessionEchoRef.current) updateSessionEcho(next)
  }, [updateSessionEcho])
  /** Lease-expiry tick for the local archive tombstones (the fallback pull clock, plus
   *  the archive fact tick which sweeps before recording). */
  const sweepSessionArchive = useCallback((): void => {
    const next = sweepPendingArchives(sessionArchiveRef.current, Date.now())
    if (next !== sessionArchiveRef.current) updateSessionArchive(next)
  }, [updateSessionArchive])
  // 会话打开意图（）：App 是唯一写者
  // （openSession 的 arm/release），槽位本身在 sidebar 包的 shared/open-intent.ts
  // ——它是跨 ctx 单例，因为 boot 期早开臂要在**目标实例自己的 ctx 内**读它。
  // 这里经 useSyncExternalStore 绑定：快照在无变化时保持同一引用，一次 arm /
  // 一次 release 各触发一次重渲染，投影门与揭示门同时生效。
  const openIntents = useSyncExternalStore(subscribeOpenIntent, getOpenIntentsSnapshot)
  // 每实例运行时事实（06 ）：来自各来源 ctx 的 chamberBridge 上报，仅附加
  const [runtimeFacts, setRuntimeFacts] = useState<Record<string, InstanceRuntimeReport | undefined>>({})
  const [hostFacts, setHostFacts] = useState<Record<string, HostFacts | undefined>>({})
  // 问题 B（）：gateway 来源的托管 dsh connectionState（探针见下方
  // managed-runtime.ts）。null = 探不到（fail open），键随来源生命周期收敛。
  const [managedRuntime, setManagedRuntime] = useState<Record<string, string | null>>({})
  // chamber (06 , )：App 自持的「完成未读」蓝点（completedBySource）
  // 与边沿记忆（prevRunningRef）。蓝点不依赖各来源 shell 的 selected——后台
  // 来源的陈旧 selected 会让 vendor 提醒错误压制「完成但未读」——而是由 App
  // 从上报里的实时 running 位自行推导 running→idle 边沿，以 App 已知的
  // 「谁在阅读」（**屏上来源** paintedView + 各来源 current + 焦点）判定武装/解除。
  // 插件侧保持无状态（纯投影），避免在每 ctx 复制一套状态机。
  // 2026-12 facts wiring（主计划 §3.3-2 / R2）：completedBySource 不再是唯一
  // 来源，而是 deriveSourceUnread 的**派生投影**；durable 回退账本
  // （edgeLedgerRef）与读水位（readMarksRef）在首帧从 v2 落盘载入（此前仓内
  // 未读零持久化），撤回/同代重挂/重启后由事实重算。v1 导入是防御性代码
  // （HEAD 无写入者，见 unread-store.ts 头注）。
  const [unreadBoot] = useState(() => {
    const storage = browserUnreadStorage()
    const payload = loadUnread(storage)
    return { storage, payload }
  })
  const unreadStorageRef = useRef<UnreadStorageLike | undefined>(unreadBoot.storage)
  const readMarksRef = useRef<Record<string, Record<string, number>>>(unreadBoot.payload.read)
  const edgeLedgerRef = useRef<Record<string, Record<string, boolean>>>(unreadBoot.payload.edge)
  // complete 通知账本（设计 19 ；）：水位轨（facts 入口，
  // 单调只升）与武装轨（壳边沿入口，直到重新 running）共用一个容器与键空间，规则
  // 本体仍在 watermark.ts / notification-edges.ts；初始表来自 v2 落盘。
  const completeLedgerRef = useRef(createCompleteLedger(unreadBoot.payload.notified))
  const clientInstallIdRef = useRef('')
  if (clientInstallIdRef.current === '') clientInstallIdRef.current = loadClientInstallId(unreadBoot.storage)
  const [completedBySource, setCompletedBySource] = useState<Record<string, Record<string, boolean>>>(
    () => ({ ...unreadBoot.payload.edge }),
  )
  const prevRunningRef = useRef<Record<string, Record<string, boolean>>>({})
  // 通知边沿记忆（设计 19 ）：每来源每会话的上一份事实快照，供
  // detectNotificationEdges 判定 running→idle / pending 武装边沿。与
  // prevRunningRef（蓝点机）并存互不耦合：蓝点带「正在阅读」解除，通知边沿
  // 不受解除影响——窗口隐藏到托盘时活动来源的当前会话完成也必须通知
  // （requireHidden 豁免在主进程裁决）。随来源生命周期收敛（onRuntimeReport
  // 的 clear 分支 delete，与 prevRunningRef 同纪律）。
  const prevRuntimeFactsRef = useRef<Record<string, Record<string, SessionFacts>>>({})
  // ──
  /** 每来源 facts 快照（判定输入：completedAt/updatedAt/lastTurnEnd/pendingKind）。 */
  const [sessionFacts, setSessionFacts] = useState<Record<string, SessionFactsSnapshot | undefined>>({})
  /** 渲染期同步镜像（事件回调与派生读最新值，不因 state 提交时序漂移）。 */
  const sessionFactsRef = useRef(sessionFacts)
  sessionFactsRef.current = sessionFacts
  const runtimeFactsRef = useRef(runtimeFacts)
  runtimeFactsRef.current = runtimeFacts
  /** 活跃事实源实例（gateway 来源；指纹变化 = 新化身重探）。 */
  const sessionFactsSourcesRef = useRef<Map<string, SessionFactsSource>>(new Map())
  /** 每个实例的退订 + stop 合成器（来源退役/降级时调用一次）。 */
  const sessionFactsTeardownRef = useRef<Map<string, () => void>>(new Map())
  // W6：非 gateway 来源的无壳观察者（SSH/dsh 远端没有只读镜像可依赖）。
  const sourceMuxTeardownRef = useRef<Map<string, () => void>>(new Map())
  // 审计 APP-9：观察者必须按**身份**（sourceId + sourceFingerprint）收敛——只按 id 去重会让
  // 「同 id 新指纹」（身份编辑/重连后的新化身）复用旧观察者，rows/runningBefore 跨化身串味。
  const sourceMuxIdentityRef = useRef<Map<string, string>>(new Map())
  /** 通知第二入口的基线播种集：首份 facts 快照只播种水位，不补发通知（-5）。 */
  const factsSeededRef = useRef<Set<string>>(new Set())
  /** 行刷新提示的 floor 记账（每来源）。 */
  const refreshHintAtRef = useRef<Record<string, number>>({})
  /** 每来源在途 unary 拉取计数（提示的 inFlight 拒绝输入）。 */
  const factsPullInFlightRef = useRef<Record<string, number>>({})
  /** 读标记落盘节流（≤1 次/秒；pagehide/hidden 立即 flush）。 */
  const unreadSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushUnreadRef = useRef<() => void>(() => undefined)

  // chamberBridge 投影（05 ）：health/remoteStatus/aggregates 任一变化后
  // 派生并发布；首帧（health 未就绪）即发布 connected=false 的分组。
  const servers = useMemo(
    // W3：current 投影（侧栏高亮）跟随 **paintedView**（屏上是谁），不是选择——
    // 持有窗内用户点向 B 时屏上仍是 A，A 的当前会话高亮摘掉再装回是纯闪烁；
    // 揭示完成那一拍 painted 变化（本 memo 依赖）自然把高亮交棒给 B。
    () => deriveServers(health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, completedBySource, paintedView, pluginDiagnostics, shellStates, managedRuntime, workspaceEcho, sessionEcho, sessionArchive, openIntents, locale, sessionFacts),
    [health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, completedBySource, paintedView, pluginDiagnostics, shellStates, managedRuntime, workspaceEcho, sessionEcho, sessionArchive, openIntents, locale, sessionFacts],
  )
  // chamberBridge publish 签名闸（）：servers 在每次依赖变化
  // 时都会重建（含聚合快照上报/兜底、30s 注册表轮询、状态推送的恒新对象），但
  // 只有**渲染相关内容**变化才值得通知订阅方——否则每个 shell 的侧边栏都会
  // 周期性兜底触发全量重渲染。签名排除无人消费的 server.updatedAt 时间戳。设置桥的
  // subscribeServers 早已做了同类去重（本闸是对 publish 源头的收口）。
  const lastServersSignatureRef = useRef('')
  useEffect(() => {
    const signature = serversProjectionSignature(servers)
    if (signature === lastServersSignatureRef.current) return
    lastServersSignatureRef.current = signature
    chamberBridge.publish(servers)
  }, [servers])

  // 相位镜像（waitForServing 读它；effect 里写，避免渲染期改 ref）。远端来源取
  // **原始 transport 投影**的相位（与 deferredBootIds 同源）：deriveServers 把
  // "投影未到达"折叠成 'idle'，那是缺失事实的合成值——折叠值当输入会让一次投影
  // 延迟被就绪门快判成"未连接"（）。本地来源没有 transport 投影，
  // 用派生相位；undefined = 事实未到，门在预算内继续等。
  useEffect(() => {
    const phases: Record<string, string | undefined> = {}
    for (const server of servers) {
      if (server.id === LOCAL_INSTANCE_ID) { phases[server.id] = server.phase; continue }
      const rawId = rawInstanceIdFromSourceId(server.id)
      // 纯函数决定语义（可单测）：原始投影缺席 → undefined（等）；在场 → 派生相位
      // （含托管折叠的终态词表）。
      phases[server.id] = rawId === null
        ? server.phase
        : servingGatePhase(server.phase, remoteStatus[rawId] !== undefined)
    }
    serversPhaseRef.current = phases
  }, [servers, remoteStatus])

  /**
   * boot 推迟集合（W2，）：**手动断开**（idle）的来源不
   * 启动 shell——一次注定吃满 503 预算的 boot 只会白烧，还会把用户丢进加载态。
   * 遮罩此时呈现「未连接」+「连接」，点连接后相位离开 idle，正常 boot 开始。
   * 未知相位（投影未到）不推迟；本判定是渲染期事实（`servers`），不用 ref 镜像。
   */
  const deferredBootIds = useMemo(() => {
    const ids = new Set<string>()
    for (const server of servers) {
      if (server.id === LOCAL_INSTANCE_ID) continue
      // 事实源必须是**原始 transport 投影**（remoteStatus 以 raw id 为键）：
      // deriveServers 把"投影未到达"折叠成 `'idle'`（`remoteStatus[...]?.phase ?? 'idle'`），
      // 那不是手动断开事实——拿折叠值当输入会把一次投影延迟/状态拉取失败变成
      // "该来源未连接、拒绝 boot"，而纯契约明确要求 undefined 绝不推迟。
      const rawId = rawInstanceIdFromSourceId(server.id)
      if (rawId === null) continue
      if (shouldDeferBootForSource(remoteStatus[rawId]?.phase)) ids.add(server.id)
    }
    return ids
  }, [servers, remoteStatus])
  /** 推迟集合的稳定签名：让"起表/豁免"的 effect 只在成员变化时重跑。 */
  const deferredBootSignature = useMemo(
    () => [...deferredBootIds].sort().join('\u0000'),
    [deferredBootIds],
  )
  /** 渲染期镜像（effect 与清理臂读它，避免把它们挂到 servers 的依赖上）。 */
  const deferredBootRef = useRef<ReadonlySet<string>>(new Set<string>())
  deferredBootRef.current = deferredBootIds

  useEffect(() => {
    //  feed the facts into the container BEFORE planning, so the self-heal mark
    // has one owner. The dispatch is idempotent in exactly the way the planner's
    // carry-forward is: `bootSettled` spreads the previous state (the mark survives a
    // repeat), and `phaseChanged` away from ready drops the mark (a fresh ready
    // transition earns the next attempt). `isRetryableBootGap` is the table the
    // reducer receives, so retryability still has a single source.
    for (const server of servers) dispatchLifecycle(server.id, { kind: 'phaseChanged', phase: server.phase })
    for (const [instanceId, state] of Object.entries(shellStates)) {
      if (state.degraded === null) continue
      dispatchLifecycle(instanceId, {
        kind: 'bootSettled',
        outcome: 'degraded',
        gapKind: state.degraded.kind,
      })
    }
    //  the re-boot list now comes from the container's typed effect instead of a
    // parallel planner. The mark is written by the same reduction that decides, so
    // "who decided" and "who remembers" are one place; the planner's carry-forward is
    // reproduced by dispatching the same facts every pass (see the note above).
    const retry: string[] = []
    for (const [instanceId, state] of Object.entries(shellStates)) {
      if (state.degraded === null) continue
      const effect = dispatchLifecycle(instanceId, {
        kind: 'bootSettled',
        outcome: 'degraded',
        gapKind: state.degraded.kind,
      })
      if (effect?.e === 'degradedSelfHeal') retry.push(instanceId)
    }
    if (retry.length === 0) return
    console.warn(`[app] degraded shell(s) re-booting after the source became ready: ${retry.join(', ')}`)
    setRetryTokens(prev => {
      const next = { ...prev }
      for (const instanceId of retry) next[instanceId] = (next[instanceId] ?? 0) + 1
      return next
    })
  }, [servers, shellStates])

  // 问题 B（）：gateway 来源的托管 dsh 状态探针。desktop 的 ready 只
  // 证明 gateway 进程活着，托管 dsh 是独立进程——不消费 connectionState 时，
  // 停机窗口里的来源"可点但背后不可用"（`+` 建会话必失败、状态显示缺失）。
  // 探针只跑 gateway 来源、仅前台、15s 一轮；探不到（非 200/代理失败/未挂载
  // 隧道）一律 null = fail open（见 managed-runtime.ts 头注）。
  // 探针函数另存 ref：前台恢复补偿要在 drain 之前先刷新一轮，否则窗口隐藏
  // 期间（探针被跳过）首次 drain 可能把一个托管 dsh 已停机的源拿去收割/预热
  // （）。
  const probeManagedRuntimeRef = useRef<() => Promise<void>>(async () => undefined)
  useEffect(() => {
    const gatewayIds = remoteInstances
      .filter(instance => instance.kind === 'gateway')
      .map(sourceIdForInstance)
    const live = new Set(gatewayIds)
    setManagedRuntime(prev => {
      const next: Record<string, string | null> = {}
      let changed = false
      for (const [id, state] of Object.entries(prev)) {
        if (!live.has(id)) {
          changed = true
          continue
        }
        next[id] = state
      }
      return changed ? next : prev
    })
    if (gatewayIds.length === 0) return
    let cancelled = false
    let inFlight: Promise<void> | null = null
    const controller = new AbortController()
    // 单飞 + 单次探针超时（问题 B 复查 MINOR-3）：代理悬挂时既不堆叠请求，
    // 也不会永久堵死轮询（15s 周期 × 10s 上限 ⇒ 每轮至多一个在途请求）。
    const probeSignal = (): AbortSignal => {
      const timeout = typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(MANAGED_RUNTIME_PROBE_TIMEOUT_MS)
        : undefined
      if (timeout === undefined || typeof AbortSignal.any !== 'function') return controller.signal
      return AbortSignal.any([controller.signal, timeout])
    }
    const probe = (): Promise<void> => {
      // 单飞返回**同一个在途 promise**（不是 no-op）：可见性恢复补偿要先等
      // 探针落地再 drain，否则 drain 会读到 15s tick 留下的旧投影，把一个已
      // 停机的 gateway 源拿去收割（白烧一次尝试；）。
      if (inFlight !== null) return inFlight
      if (!shouldRunBackgroundPhase(document.visibilityState)) return Promise.resolve()
      const run = (async (): Promise<void> => {
      try {
        const signal = probeSignal()
        const entries = await Promise.all(gatewayIds.map(async id =>
          [id, await fetchManagedRuntimeState(id, { signal })] as const))
        if (cancelled) return
        setManagedRuntime(prev => {
          let changed = false
          const next = { ...prev }
          for (const [id, state] of entries) {
            if (next[id] !== state) {
              next[id] = state
              changed = true
            }
          }
          return changed ? next : prev
        })
      } finally {
        inFlight = null
      }
      })()
      inFlight = run
      return run
    }
    void probe()
    probeManagedRuntimeRef.current = probe
    const timer = setInterval(() => { void probe() }, MANAGED_RUNTIME_POLL_MS)
    return () => {
      cancelled = true
      controller.abort()
      probeManagedRuntimeRef.current = async () => undefined
      clearInterval(timer)
    }
  }, [remoteInstances])

  // 注册表 id 的命令式权威集合：selectView 与 openSession 在 apply 时用它拒绝
  // 已回收来源（视图生命周期 = 注册表条目生命周期，05 ）。This is not a render
  // mirror. Event-side invalidate/success edges must not be overwritten by a
  // concurrent or stale render. refreshRemotes replaces it synchronously when
  // the matching registry generation succeeds; local is always authoritative.
  const liveServerIdsRef = useRef<Set<string>>(new Set([LOCAL_INSTANCE_ID]))
  const liveServerIds = useMemo(() => new Set(servers.map(server => server.id)), [servers])

  // 隧道相位镜像（按原始注册表 id 键控，onStatusChanged 推送的 payload.id）：
  // ensureRemoteConnected 经它读最新相位而不进依赖——selectView/openSession 的
  // 身份保持稳定（本文件既有 ref 镜像纪律），相位变化不重建这些回调。
  const remoteStatusRef = useRef(remoteStatus)
  remoteStatusRef.current = remoteStatus
  const remoteInstancesRef = useRef(remoteInstances)
  remoteInstancesRef.current = remoteInstances

  // 切换意图镜像：activeViewRef = 已落地的当前视图（渲染期镜像），
  // pendingViewRef = 在途/顺延中的最新切换意图（过渡链 apply 前有效）。
  // selectView 的早期返回必须查镜像而非闭包：过渡在途时 UI 仍显示旧视图，
  // 用闭包里的 activeView 会把「切回旧视图」的撤销意图误判为无操作丢弃——
  // 违反 view-transition.ts 的「最后一次意图胜出」性质。
  const activeViewRef = useRef(activeView)
  activeViewRef.current = activeView
  // 屏上视图的渲染期镜像（同 activeViewRef 纪律）：保留回收、退役回落与揭示回调的
  // 守卫都要在事件/微任务里读它，而这些位置拿不到渲染作用域的 paintedView。
  const paintedViewRef = useRef(paintedView)
  paintedViewRef.current = paintedView
  /**
   * 揭示门的持有窗起点（单调钟 ms；null = 当前稳态）。`revealHoldStartedAt` 推进它：
   * 一次在途揭示从分叉那一拍起算，回到稳态即清空（见 reveal-gate.ts 头注）。
   */
  const revealHoldStartedAtRef = useRef<number | null>(null)
  /** 持有窗到期的一次性重算触发器（照 InstanceView 的 surfaceFallbackTick 形态）。 */
  const [revealTick, setRevealTick] = useState(0)
  const pendingViewRef = useRef<string | null>(null)
  /**
   * 用户在遮罩上显式放弃的视图（W1/W4）：只由遮罩的「切换来源」写入，由
   * `selectView`（用户又点回它 = 撤回意图）或落地回收删除。声明位置必须在
   * `selectView` 之前——撤回就发生在那里。
   */
  // 放弃标记：被放弃的视图 → 当时要切去的目标。记目标是为了能在"切换没落地"
  // （目标退役/被删）时撤回标记（）。
  //  Map LEDGER view - reads project the container, set/delete become events.
  // The sweeps iterate a snapshot, so deleting inside the loop stays safe.
  const abandonedViewsRef = useMemo(() => ({
    current: createMapLedgerView({
      read: () => projectAbandonedTargets(sourceLedgerStoreRef.current),
      onSet: (id, target) => dispatchLifecycle(id, { kind: 'abandoned', target }),
      onDelete: (id) => dispatchLifecycle(id, { kind: 'abandonmentCleared' }),
    }),
  }), [dispatchLifecycle])

  /**
   * N-ctx 视图回收（设计 05 ）：视图生命周期 = 注册表条目生命周期。
   * 只有来源从注册表删除时才卸载其视图并 dispose shell——连接失败/手动
   * 断开是瞬时事实（投影为图标/徽标），不回收视图：设置页卡片与侧边栏
   * 分组都锚定注册表，视图若随瞬时状态消失会造成三面不匹配（如侧边栏
   * 分组头仍可激活一个立即被回收的视图），且与「会话保活」的 N-ctx
   * 设计意图相悖。local 常驻。被回收的视图若是当前视图则回落到 local。
   * identity-preserving：无变化时两个 setter 都返回原值（servers 每轮
   * 轮询/推送都重建，不能借此触发无谓重渲染）。
   */
  useEffect(() => {
    const live = new Set(servers.map(server => server.id))
    // dispose 是副作用，不能放进 setState updater（React 19 渲染期可能急切
    // 求值 updater，StrictMode 还会双调用）——先从当前 mountedViews 算出
    // 被回收的 id 再统一处置；setMountedViews 保持 identity-preserving。
    const removed = mountedViews.filter(id => !live.has(id))
    if (removed.length > 0) {
      for (const id of removed) {
        autoPrewarmedRef.current.delete(id)
        // 保留策略：注册表删除 = 生命周期终结，抑制键随视图一起收敛。
        prewarmSuppressedRef.current.delete(id)
        // 收割账本同源收敛：同 id 重新注册 = 新来源代，账本从零开始。
        delete harvestStateRef.current[id]
        harvestIntentRef.current.delete(id)
        disposeInstanceShell(id)
        chamberBridge.clearPluginDiagnostic(id)
      }
      setMountedViews(prev => {
        const next = prev.filter(id => live.has(id))
        return next.length === prev.length ? prev : next
      })
      // 视图已回收：失败覆盖层状态与重试令牌随视图收敛（重加同名 id 由新
      // boot 重建）。
      setShellStates(prev => {
        const next = { ...prev }
        for (const id of removed) delete next[id]
        return next
      })
      setRetryTokens(prev => {
        const next = { ...prev }
        for (const id of removed) delete next[id]
        return next
      })
    }
    setActiveView(prev => {
      if (prev === LOCAL_INSTANCE_ID) return prev
      const server = servers.find(candidate => candidate.id === prev)
      if (server !== undefined) return prev
      return LOCAL_INSTANCE_ID
    })
    // 注册表删除的实例同时清掉其数据面残留（聚合/运行时事实/状态投影）——
    // 视图已回收，键空间应随注册表收敛（重加同名 id 由刷新重建）。
    // 全部走 source-registry.ts 内核（live 外删除 + identity-preserving）。
    setAggregates(prev => pruneSourceRecord(prev, live) ?? prev)
    setRuntimeFacts(prev => pruneSourceRecord(prev, live) ?? prev)
    setSnapshotSources(prev => pruneSourceRecord(prev, live) ?? prev)
    const snapshotSourcesNext = pruneSourceRecord(snapshotSourcesRef.current, live)
    if (snapshotSourcesNext !== null) {
      // Keep recency in lockstep: a same-id re-add must start as never-pushed
      // (first-boot window falls back) rather than inheriting the removed
      // source's last-push timestamp — only the ids snapshotSources itself dropped.
      const removedSnapshotSources = new Set(Object.keys(snapshotSourcesRef.current).filter(id => !live.has(id)))
      snapshotSourcesRef.current = snapshotSourcesNext
      for (const id of removedSnapshotSources) delete snapshotAtRef.current[id]
    }
    // 事实水位/无法验证标记随来源退役（same-id re-add 必须是全新的可验证窗口）。
    const factsAtNext = pruneSourceRecord(factsAtRef.current, live)
    if (factsAtNext !== null) factsAtRef.current = factsAtNext
    setUnverified(prev => pruneSourceList(prev, live) ?? prev)
    // 用户忽略（dismiss）也随来源退役：否则 same-id 再挂载的**新**代际会在下一个
    // liveness tick 之前被旧忽略静默压住（）。
    setDismissedStalls(prev => pruneSourceList(prev, live) ?? prev)
    // S2: last-reconnect recency is source-scoped too — a same-id re-add must
    // start a fresh reconnect-backoff window (mirrors the snapshotAtRef
    // lockstep above; the reconnect only ever ran for mounted sources).
    const lastReconnectNext = pruneSourceRecord(lastReconnectAtRef.current, live)
    if (lastReconnectNext !== null) lastReconnectAtRef.current = lastReconnectNext
    // Same lockstep for the session-list-refresh coalescing stamps and the
    // ghost-row convergence state (design 24 ): a same-id re-add must start
    // a fresh request window and a fresh pending set.
    const refreshAtNext = pruneSourceRecord(sessionListRefreshAtRef.current, live)
    if (refreshAtNext !== null) sessionListRefreshAtRef.current = refreshAtNext
    const refreshPendingNext = pruneSourceRecord(sessionListRefreshPendingRef.current, live)
    if (refreshPendingNext !== null) sessionListRefreshPendingRef.current = refreshPendingNext
    const archiveSetNext = pruneSourceRecord(authoritativeArchiveSetRef.current, live)
    if (archiveSetNext !== null) authoritativeArchiveSetRef.current = archiveSetNext
    setPluginDiagnostics(prev => pruneSourceRecord(prev, live) ?? prev)
    setCompletedBySource(prev => pruneSourceRecord(prev, live) ?? prev)
    // prevRunning 是 ref：同步裁剪，随注册表收敛（重加同名 id 由刷新重建）。
    const prevRunningNext = pruneSourceRecord(prevRunningRef.current, live)
    if (prevRunningNext !== null) prevRunningRef.current = prevRunningNext
    // 通知边沿记忆同款收敛（设计 19 ）：与 prevRunningRef 对称，
    // 随注册表收敛，重加同名 id 由刷新重建。
    const prevRuntimeFactsNext = pruneSourceRecord(prevRuntimeFactsRef.current, live)
    if (prevRuntimeFactsNext !== null) prevRuntimeFactsRef.current = prevRuntimeFactsNext
    // complete 通知两轨（水位 + 武装）与注册表同拍收敛（一次调用覆盖两张表）。
    completeLedgerRef.current.prune(live)
    // facts wiring 数据面（）：退役来源的读水位 / 回退账本 / 通知水位 /
    // 播种集 / 提示记账 / 在途计数与 facts state 一并清（same-id 重加 = 新来源代，
    // 不得继承上一代的已读/已通知判定）。
    const readMarksNext = pruneSourceRecord(readMarksRef.current, live)
    if (readMarksNext !== null) readMarksRef.current = readMarksNext
    const edgeLedgerNext = pruneSourceRecord(edgeLedgerRef.current, live)
    if (edgeLedgerNext !== null) edgeLedgerRef.current = edgeLedgerNext
    const seededNext = pruneSourceSet(factsSeededRef.current, live)
    if (seededNext !== null) factsSeededRef.current = seededNext
    const refreshHintNext = pruneSourceRecord(refreshHintAtRef.current, live)
    if (refreshHintNext !== null) refreshHintAtRef.current = refreshHintNext
    const pullInFlightNext = pruneSourceRecord(factsPullInFlightRef.current, live)
    if (pullInFlightNext !== null) factsPullInFlightRef.current = pullInFlightNext
    if (pruneSourceRecord(sessionFactsRef.current, live) !== null) {
      setSessionFacts(prev => pruneSourceRecord(prev, live) ?? prev)
    }
    setRemoteStatus(prev => {
      // remoteStatus 按原始注册表 id 键控（deriveServers 的 statusKey），
      // 与 servers 的 <kind>-<id> 不同——按 kind 前缀还原再比较。
      const liveRaw = new Set<string>()
      for (const server of servers) {
        const rawId = server.kind === 'local' ? 'local' : rawInstanceIdFromSourceId(server.id)
        if (rawId !== null) liveRaw.add(rawId)
      }
      return pruneSourceRecord(prev, liveRaw) ?? prev
    })
  }, [servers, mountedViews])

  const refreshConnections = useCallback(async () => {
    try {
      setConnections(await api.connections.list())
    } catch {
      // 控制面不可达由 /health 轮询的 healthError 呈现；连接行保持现状
    }
  }, [])

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.host.health())
      setHealthError(null)
      setHealthErrorAt(null)
    } catch (err) {
      setHealthError(errorMessage(err))
      setHealthErrorAt(prev => prev ?? Date.now())
    }
  }, [])

  const refreshRemoteStatus = useCallback(async (id: string, expectedSourceId?: string) => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const sourceId = expectedSourceId ?? sourceIdForRawInstance(id, remoteInstancesRef.current)
    if (sourceId === null) return
    const sourceOwner = sourceLifecyclesRef.current!.capture(sourceId)
    if (sourceOwner === null) return
    try {
      const projection = await ssh.status(id)
      if (
        projection !== null
        && sourceIdForTransport(projection.kind, id) === sourceId
        && liveServerIdsRef.current.has(sourceId)
        && sourceLifecyclesRef.current!.owns(sourceOwner)
      ) {
        remoteStatusRef.current = { ...remoteStatusRef.current, [id]: projection }
        setRemoteStatus(prev => ({ ...prev, [id]: projection }))
      }
    } catch {
      // 状态读取失败时保持已有投影（权威状态来自 onStatusChanged 推送）
    }
  }, [])

  /** Invalidate the roster synchronously before an instances-changed refresh.
   * The ref closes the event→React-commit gap in which a deep-link push can
   * otherwise observe the previous generation as settled. */
  const invalidateRemoteRoster = useCallback(() => {
    remoteRosterRefreshSeqRef.current += 1
    remoteRosterSettledRef.current = false
    setRemoteRosterSettled(false)
  }, [])

  /** Synchronously retire every renderer owner of an authoritative lifecycle
   * edge (deletion or transport-identity edit). This is event-side on purpose:
   * passive effects can be skipped when React batches a same-id replacement. */
  const retireSources = useCallback((sourceIds: ReadonlySet<string>): void => {
    const retired = new Set([...sourceIds].filter(sourceId => sourceId !== LOCAL_INSTANCE_ID))
    if (retired.size === 0) return
    sourceLifecyclesRef.current!.retire(retired)
    // P4: a retired source's generation leaves the registry with it, so a same-id
    // re-add starts from a clean epoch instead of inheriting the retired life.
    const liveSourceIds = new Set(
      Object.keys(sourceLedgerStoreRef.current).filter((sourceId) => !retired.has(sourceId)),
    )
    sourceLedgerStoreRef.current = retainSourceIds(sourceLedgerStoreRef.current, liveSourceIds)
    aggregateRequestOwnersRef.current!.retire(retired)
    for (const sourceId of retired) {
      delete aggregatePollSeqRef.current[sourceId]
      delete mutationRefreshSeqRef.current[sourceId]
      // S2: last-reconnect recency retires with the source (same-id re-add
      // starts a fresh backoff window; the state-backed aggregate maps are
      // covered by the pure invalidation below, this keyed ref retires here).
      delete lastReconnectAtRef.current[sourceId]
    }

    // Force the supplied authoritative delta through the aggregate generation
    // transition even when a newer roster snapshot already contains the same
    // id. That is the exact two-pull remove/re-add race the delta closes.
    const previousLive = new Set(liveServerIdsRef.current)
    const nextLive = new Set(liveServerIdsRef.current)
    for (const sourceId of retired) {
      previousLive.add(sourceId)
      nextLive.delete(sourceId)
    }
    const aggregateInvalidation = invalidateRemovedAggregateSources(
      previousLive,
      nextLive,
      {
        failuresBySource: aggregateFailuresRef.current,
        snapshotAtBySource: snapshotAtRef.current,
        snapshotSources: snapshotSourcesRef.current,
        readySources: readyAggregateSourcesRef.current,
      },
    )
    aggregateFailuresRef.current = aggregateInvalidation.failuresBySource
    snapshotAtRef.current = aggregateInvalidation.snapshotAtBySource
    snapshotSourcesRef.current = aggregateInvalidation.snapshotSources
    readyAggregateSourcesRef.current = aggregateInvalidation.readySources
    // Event authority is immediate: delayed view/deep-link callbacks must see
    // the source absent before the replacement instances_get resolves.
    liveServerIdsRef.current = nextLive

    // Record shell.ts's async teardown barrier before any replacement mount.
    // Identity edits deliberately reach this path even though the registry id
    // remains present; label/service/home-only edits do not retire the shell.
    for (const sourceId of retired) {
      clearAggregateRetry(sourceId)
      aggregateRefreshQueueRef.current.delete([sourceId])
      autoPrewarmedRef.current.delete(sourceId)
      // 保留策略：注册表删除的源不再占用"回收后不自动预热"键（与其它
      // ref 键空间同纪律随生命周期收敛）。
      prewarmSuppressedRef.current.delete(sourceId)
      // 收割账本/意图随来源生命周期收敛（同 id 重新注册 = 新来源代）。
      delete harvestStateRef.current[sourceId]
      harvestIntentRef.current.delete(sourceId)
      chamberBridge.retireInstanceProducers(sourceId)
      disposeInstanceShell(sourceId)
      releaseInstanceClient(sourceId)
      chamberBridge.clearPluginDiagnostic(sourceId)
      delete prevRunningRef.current[sourceId]
      delete prevRuntimeFactsRef.current[sourceId]
      completeLedgerRef.current.forget(sourceId)
      // facts wiring：事实源实例与全部未读数据面键随退役同拍收敛（reclaimView
      // 刻意不碰这些——拆壳不等于来源消失，R2/L3）。
      sessionFactsTeardownRef.current.get(sourceId)?.()
      sessionFactsTeardownRef.current.delete(sourceId)
      sessionFactsSourcesRef.current.delete(sourceId)
      // 审计 APP-9：无壳观察者与身份记录同样随退役收敛（只拆 gateway 事实源会留下孤观察者）。
      sourceMuxTeardownRef.current.get(sourceId)?.()
      sourceMuxTeardownRef.current.delete(sourceId)
      sourceMuxIdentityRef.current.delete(sourceId)
      delete readMarksRef.current[sourceId]
      delete edgeLedgerRef.current[sourceId]
      delete refreshHintAtRef.current[sourceId]
      delete factsPullInFlightRef.current[sourceId]
      factsSeededRef.current.delete(sourceId)
    }
    // 工作区创建回声账本随来源生命周期收敛（同纪律：同 id 重新注册 = 新来源代，
    // 上一代的回声不得在新代里残留成幽灵工作区行）。
    updateWorkspaceEcho(forgetPendingWorkspaces(workspaceEchoRef.current, retired))
    // 会话创建回声同纪律：上一代记账的会话不得在新来源代的列表里幽灵复现。
    updateSessionEcho(forgetPendingSessions(sessionEchoRef.current, retired))
    // 归档墓碑同纪律：新一代来源必须是干净的（旧代的本地归档不得藏住新代的会话）。
    updateSessionArchive(forgetPendingArchives(sessionArchiveRef.current, retired))
    // 打开意图同纪律：被删除来源的在途意图必须撤掉，否则新一代会在投影门/揭示门
    // 上被上一代的 open 永久压住（那是两个"永远不释放"的闸门）。
    clearOpenIntents(retired)
    const pendingDeepLink = pendingDeepLinkDeliveryRef.current
    if (
      pendingDeepLink !== null
      && pendingDeepLink.sourceId !== null
      && retired.has(pendingDeepLink.sourceId)
    ) {
      pendingDeepLinkDeliveryRef.current = null
      void acknowledgeDeepLink(pendingDeepLink).catch(error => {
        reportDeepLinkAckFailure(pendingDeepLink, error)
      })
    }
    const retainedNotificationOpens: NotificationOpenDelivery[] = []
    for (const open of pendingRosterNotificationOpensRef.current) {
      if (!retired.has(open.sourceId)) {
        retainedNotificationOpens.push(open)
        continue
      }
      void acknowledgeNotificationOpen(open).catch(error => {
        reportNotificationAckFailure(open, error)
      })
    }
    pendingRosterNotificationOpensRef.current = retainedNotificationOpens
    pendingViewRef.current = retireSelectedSource(pendingViewRef.current, retired, null)
    if (retired.has(activeViewRef.current)) activeViewRef.current = LOCAL_INSTANCE_ID
    // W3：屏上视图随注册表退役**同帧**回落 local（第一道；揭示门的 unmountable
    // 分支是第二道保险）。回落 local 而不是 selected：选择可能是同一来源、也可能
    // 尚未 settle——直接画上去会露出 pending（不可见）壳，即一帧无可见视图。
    if (retired.has(paintedViewRef.current)) paintedViewRef.current = LOCAL_INSTANCE_ID
    prewarmQueueRef.current = withoutRemovedSourceIds(prewarmQueueRef.current, retired)
    prewarmEligibleRef.current = new Set(
      [...prewarmEligibleRef.current].filter(sourceId => !retired.has(sourceId)),
    )
    if (prewarmInflightRef.current !== null && retired.has(prewarmInflightRef.current)) {
      // I8：在途预热随来源退役作废（还没被任何人用上）。
      recordPrewarm('cancelled', prewarmInflightRef.current)
      prewarmInflightRef.current = null
      prewarmInflightAtRef.current = 0
    }

    // Queue every React owner deletion before any roster render. A replacement
    // id only returns through a fresh view mount/producer generation.
    setMountedViews(prev => withoutRemovedSourceIds(prev, retired))
    setActiveView(prev => retireSelectedSource(prev, retired, LOCAL_INSTANCE_ID))
    setPaintedView(prev => retireSelectedSource(prev, retired, LOCAL_INSTANCE_ID))
    setShellStates(prev => withoutRemovedSourceKeys(prev, retired))
    setRetryTokens(prev => withoutRemovedSourceKeys(prev, retired))
    setAggregates(prev => withoutRemovedSourceKeys(prev, retired))
    setSnapshotSources(prev => withoutRemovedSourceKeys(prev, retired))
    setRuntimeFacts(prev => withoutRemovedSourceKeys(prev, retired))
    setPluginDiagnostics(prev => withoutRemovedSourceKeys(prev, retired))
    // 托管 dsh 状态同源收敛（问题 B 复查 MINOR-4）：轮询 effect 的 roster 差分
    // 是异步的，同 id 重新注册在那一拍之前会读到上一代的 stopped/error。
    setManagedRuntime(prev => withoutRemovedSourceKeys(prev, retired))
    setCompletedBySource(prev => withoutRemovedSourceKeys(prev, retired))
    const removedRawIds = new Set([...retired]
      .map(rawInstanceIdFromSourceId)
      .filter((rawId): rawId is string => rawId !== null))
    remoteStatusRef.current = withoutRemovedSourceKeys(remoteStatusRef.current, removedRawIds)
    for (const rawId of removedRawIds) knownRemoteIdsRef.current.delete(rawId)
    setRemoteStatus(prev => withoutRemovedSourceKeys(prev, removedRawIds))
  }, [
    acknowledgeDeepLink,
    acknowledgeNotificationOpen,
    clearAggregateRetry,
    reportDeepLinkAckFailure,
    reportNotificationAckFailure,
  ])

  const refreshRemotes = useCallback(async (): Promise<boolean> => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return false
    const seq = remoteRosterRefreshSeqRef.current + 1
    remoteRosterRefreshSeqRef.current = seq
    try {
      const instances = await ssh.instances_get()
      if (remoteRosterRefreshSeqRef.current !== seq) return false
      const acceptedInstances = instances.flatMap((instance) => {
        const sourceId = sourceIdForInstance(instance)
        const fingerprint = parseAuthoritativeSourceFingerprint(sourceId, instance.sourceFingerprint)
        if (fingerprint === null) {
          console.error(`[renderer] remote source ${sourceId} omitted: invalid authoritative lifecycle proof`)
          return []
        }
        return [{ instance, sourceId, fingerprint }]
      })
      const nextSources = [
        { sourceId: LOCAL_INSTANCE_ID, fingerprint: 'local' },
        ...acceptedInstances.map(({ sourceId, fingerprint }) => ({ sourceId, fingerprint })),
      ]
      const nextLiveServerIds = new Set(nextSources.map(source => source.sourceId))
      const retired = authoritativeSourceRetirements(
        liveServerIdsRef.current,
        sourceLifecyclesRef.current!,
        nextSources,
      )
      retireSources(retired)
      sourceLifecyclesRef.current!.activate(LOCAL_INSTANCE_ID, 'local')
      // P4: the authoritative roster is the one place a fingerprint change is
      // observed; registering it here is what turns a re-registration into an epoch
      // bump. Events never recompute the fingerprint.
      sourceLedgerStoreRef.current = reincarnate(
        sourceLedgerStoreRef.current,
        { sourceId: LOCAL_INSTANCE_ID, fingerprint: 'local' },
      )
      for (const { sourceId, fingerprint } of acceptedInstances) {
        sourceLifecyclesRef.current!.activate(sourceId, fingerprint)
        sourceLedgerStoreRef.current = reincarnate(sourceLedgerStoreRef.current, { sourceId, fingerprint })
      }
      liveServerIdsRef.current = nextLiveServerIds
      remoteRosterSettledRef.current = true
      const acceptedSpecs = acceptedInstances.map(({ instance }) => instance)
      remoteInstancesRef.current = acceptedSpecs
      setRemoteInstances(acceptedSpecs)
      setRemoteRosterSettled(true)
      for (const { instance, sourceId } of acceptedInstances) {
        void refreshRemoteStatus(instance.id, sourceId)
      }
      return true
    } catch {
      // 桌面 SSH 面不可达时保持现状；首次权威结果前 settled 仍为 false，
      // deep-link intent 继续 held，并由快速重试/30s 稳态轮询再次拉取。
      return false
    }
  }, [refreshRemoteStatus, retireSources])

  /**
   * 拉取一个实例的 workspace/session 快照（失败落 error 态，由轮询重试）。
   * 每次调用按实例取序并递增；resolve/reject 时仅当捕获的序号仍是最新才
   * 落 state——避免慢轮询在拖拽提交后的即时刷新之后落地、用旧序覆盖新序
   * （拖拽 commit 前的兜底快照可能晚于 refresh 拉取到达，造成陈旧排序）。
   */
  const aggregatePollRunningRef = useRef(false)
  const refreshAggregate = useCallback(async (instanceId: string, mutationTag?: number) => {
    const sourceOwner = sourceLifecyclesRef.current!.capture(instanceId)
    if (sourceOwner === null) return
    // 行刷新提示的 inFlight 拒绝输入（）：计数而不是布尔，
    // 并发波/提示/看门狗重叠时最后一个结束才归零。
    factsPullInFlightRef.current[instanceId] = (factsPullInFlightRef.current[instanceId] ?? 0) + 1
    try {
    const startedPollSeq = (aggregatePollSeqRef.current[instanceId] ?? 0) + 1
    aggregatePollSeqRef.current[instanceId] = startedPollSeq
    if (mutationTag !== undefined) aggregateRequestOwnersRef.current!.retire([instanceId])
    const requestOwner = mutationTag === undefined
      ? aggregateRequestOwnersRef.current!.renew(instanceId)
      : null
    const stillOwnsSource = (): boolean => sourceLifecyclesRef.current!.owns(sourceOwner)
    const stillCurrent = (): boolean => stillOwnsSource()
      && refreshPullStillCurrent({
        mutationTag,
        mutationSeq: mutationRefreshSeqRef.current[instanceId],
        pollSeq: aggregatePollSeqRef.current[instanceId] ?? 0,
        startedPollSeq,
      })
      && (requestOwner === null || aggregateRequestOwnersRef.current!.owns(requestOwner))
    const scheduleRetry = (): void => {
      const mutationStillCurrent = mutationTag === undefined
        ? stillCurrent()
        : stillOwnsSource() && mutationRefreshSeqRef.current[instanceId] === mutationTag
      if (!mutationStillCurrent) return
      const failures = aggregateFailuresRef.current[instanceId] ?? 0
      if (failures >= AGGREGATE_RETRY_LIMIT) {
        delete aggregateFailuresRef.current[instanceId]
        return
      }
      aggregateFailuresRef.current[instanceId] = failures + 1
      clearAggregateRetry(instanceId)
      const retryTimer = setTimeout(() => {
        if (aggregateRetryTimersRef.current.get(instanceId) === retryTimer) {
          aggregateRetryTimersRef.current.delete(instanceId)
        }
        // 2026 性能整改：窗口隐藏期不维持 3s 失败重试链——恢复可见由
        // visibilitychange 的 watchdog 补偿拉取覆盖（stale 源会被重拉，
        // 失败计数随成功路径清除）。
        if (!shouldRunBackgroundPhase(document.visibilityState)) return
        const mayRetry = mutationTag === undefined
          ? stillCurrent()
          : stillOwnsSource() && mutationRefreshSeqRef.current[instanceId] === mutationTag
        if (mayRetry) void refreshAggregate(instanceId, mutationTag)
      }, AGGREGATE_RETRY_MS)
      aggregateRetryTimersRef.current.set(instanceId, retryTimer)
    }
    try {
      const snapshot = await fetchInstanceSnapshot(getInstanceClient(instanceId))
      if (!stillCurrent()) return
      delete aggregateFailuresRef.current[instanceId]
      clearAggregateRetry(instanceId)
      // 工作区回声的 TTL 也挂在这条 unary 兜底链上（）：未挂载来源没有
      // 挂载 push 可依，30s 兜底拉取是它唯一的周期时钟——否则一条永远不会被
      // 权威列表覆盖的回声（例如工作区已在别处被删除）会一直留在投影里。
      sweepWorkspaceEcho()
      // 会话回声同理（）：TTL 挂同一条时钟，并且**未推送**来源（兜底提交
      // 的合成 cwd 分组就是它的投影工作区）在列表归属到该会话时立即收敛。
      // 已推送来源刻意不做这一步：commitAggregatePull 的 mounted merge 保留的是
      // 权威工作区行，用兜底的合成行收敛会把行抛进未分组桶（位置跳动）。
      sweepSessionEcho()
      if (snapshotSourcesRef.current[instanceId] !== true) {
        const reconciled = reconcilePendingSessions(sessionEchoRef.current, instanceId, snapshot.workspaces)
        if (reconciled !== sessionEchoRef.current) updateSessionEcho(reconciled)
      }
      // 归档墓碑（）：租约挂在同一条兜底时钟上——只要这份（冻结/降级）视图
      // 还在列该会话，就继续藏着它；权威归档集只可能来自挂载 push，所以这里**绝不**
      // 用兜底的空归档集收敛。
      // 顺序是契约：**先续租、再回收**。回收是全账本的（任何来源的一次拉取都会清所有
      // 过期租约），若先回收，一个离线超过租约窗的来源重连后首个列表还没续上租，墓碑
      // 就被别的来源那次拉取清掉了，归档行随即回浮。反过来，只要列表仍列着该 id 就先
      // 续租：TTL 只回收"列表里已经没有"的墓碑（没什么可藏了）。
      {
        const listed = new Set(snapshot.sessions.map(session => session.sessionId))
        const leased = refreshPendingArchives(sessionArchiveRef.current, instanceId, listed, Date.now())
        if (leased !== sessionArchiveRef.current) updateSessionArchive(leased)
      }
      sweepSessionArchive()
      // identity-preserving：快照内容未变（兜底/手动刷新常态）则复用旧 state 对象
      // ——避免恒新对象驱动 servers 重新派生并触发 publish 签名闸后面的全量
      // 侧边栏重渲染（）。错误分支保持无条件覆盖（error 文本
      // 是权威失败事实，不能因"看起来没变"而吞掉）。
      // 其工作区分组/归档集/state，兜底只贡献 sessions——否则 watchdog 的 30s
      // 空闲重拉会用空归档集替换聚合，全部已归档会话重新出现（archived-
      // resurfacing）。签名比较针对合并结果：合并后内容与当前一致时依旧不换对象。
      setAggregates(prev => {
        const current = prev[instanceId]
        const next = commitAggregatePull(
          current,
          snapshot,
          snapshotSourcesRef.current[instanceId] === true,
          authoritativeArchiveSetRef.current[instanceId],
        )
        if (current !== undefined && current.state === 'ok'
          && instanceSnapshotSignature(current) === instanceSnapshotSignature(next)) {
          return prev
        }
        return { ...prev, [instanceId]: next }
      })
      // 事实重新可验证（）：记水位并撤下「无法确认」呈现。
      factsAtRef.current[instanceId] = Date.now()
      setUnverified(prev => (prev.includes(instanceId) ? prev.filter(id => id !== instanceId) : prev))
    } catch (err) {
      if (!stillOwnsSource()) return
      // A push/newer pull supersedes an error fact. Mutation success may cross
      // an interim push, but a stale failure must never replace that healthy push.
      if ((aggregatePollSeqRef.current[instanceId] ?? 0) !== startedPollSeq) {
        scheduleRetry()
        return
      }
      if (!stillCurrent()) return
      // 失败说明不了推送通道，置空/置 error 只会隐藏权威推送状态（与 withdrawal
      // 窗口保留最后视图同规）。未推送源维持原 error 态与快速重试。
      // 已知取舍：若推送通道与 unary 探针同时死亡，视图静默冻结在最后推送状态
      // （watchdog 每 30s 重探一次，503 仍触发 refreshHealth 翻转连接判定）——
      // 无错误行可看，但比展示劣化/空态诚实；与官方前端同依赖的恢复路径
      // （liveness 触发/整页刷新）一致。
      const failureAggregate = commitAggregateFailure(
        snapshotSourcesRef.current[instanceId] === true,
        errorMessage(err),
      )
      if (failureAggregate === null) {
        // 503 仍是权威"未就绪"信号：立即刷新使连接判定尽快翻转。
        if (isInstanceUnavailable(err)) void refreshHealth()
        clearAggregateRetry(instanceId)
        // 卫生：mounted 失败不再走 scheduleRetry，未推送期残留的失败计数
        // 一并清掉（成功路径与 roster 移除也会清，这里提前清无副作用）。
        delete aggregateFailuresRef.current[instanceId]
        // 保留视图有界化（）：事实读持续失败到界限后，
        // 不再保留一个**无法验证**的「运行中」断言 —— 只清 running 位（行/分组照旧保留，
        // 不触发归档回流），并把该来源交给既有的会话停滞横幅（文案 = 「无法确认会话状态」）。
        // 下一次成功读取（push 或 unary）立即恢复事实并撤下呈现。
        const retained = watchdogAggregatesRef.current[instanceId]
        if (retained !== undefined && retained.state === 'ok'
          && retained.sessions.some(session => session.running === true)
          && shouldDropUnverifiedRunningFacts({
            factsAt: factsAtRef.current[instanceId],
            now: Date.now(),
          })) {
          setAggregates(prev => {
            const current = prev[instanceId]
            if (current === undefined || current.state !== 'ok') return prev
            if (!current.sessions.some(session => session.running === true)) return prev
            return {
              ...prev,
              [instanceId]: {
                ...current,
                sessions: current.sessions.map(session => (
                  session.running === true ? { ...session, running: false } : session)),
              },
            }
          })
          setUnverified(prev => (prev.includes(instanceId) ? prev : [...prev, instanceId]))
        }
        return
      }
      setAggregates(prev => ({ ...prev, [instanceId]: failureAggregate }))
      // 反代 503 = 权威"未就绪"信号（03 ）：本地 /health 可能还停留在
      // 旧 ready（最多一个健康轮询周期的陈旧窗口），立即刷新使连接判定
      // 尽快翻转（否则错误行要挂到下一个健康轮询才被 not-connected 替换）。
      if (isInstanceUnavailable(err)) void refreshHealth()
      // 首屏加速：一次瞬时失败不等到 30s 兜底轮询——限次快速重试（工作区
      // 单元冷启动期间快照获取可能短暂 503/超时；git 快照先到会让未注册块
      // 抢在工作区列表前渲染，
      // session/list cwd 事实，workspace.list 已删）。
      scheduleRetry()
    }
    } finally {
      const remaining = (factsPullInFlightRef.current[instanceId] ?? 1) - 1
      if (remaining <= 0) delete factsPullInFlightRef.current[instanceId]
      else factsPullInFlightRef.current[instanceId] = remaining
    }
  }, [clearAggregateRetry, refreshHealth, sweepSessionArchive, sweepSessionEcho, sweepWorkspaceEcho, updateSessionArchive, updateSessionEcho])
  /** facts 提示的稳定入口（lifecycle effect 的闭包只创建一次，取最新 refreshAggregate）。 */
  const refreshAggregateRef = useRef(refreshAggregate)
  refreshAggregateRef.current = refreshAggregate

  /**
   * Run a bounded refresh wave: at most AGGREGATE_POLL_CONCURRENCY concurrent
   * pulls, one wave at a time. Shared by the edge-triggered poll and the
   * staleness watchdog so neither can burst N pulls or overlap each other.
   */
  const runBoundedAggregateWave = useCallback((sourceIds: string[]) => {
    aggregateRefreshQueueRef.current.enqueue(sourceIds)
    if (aggregateRefreshQueueRef.current.size === 0 || aggregatePollRunningRef.current) return
    aggregatePollRunningRef.current = true
    void (async () => {
      try {
        while (aggregateRefreshQueueRef.current.size > 0) {
          const queuedSourceIds = aggregateRefreshQueueRef.current.take()
          let cursor = 0
          const worker = async () => {
            while (cursor < queuedSourceIds.length) {
              const sourceId = queuedSourceIds[cursor]
              cursor += 1
              await refreshAggregate(sourceId)
            }
          }
          await Promise.all(Array.from(
            { length: Math.min(AGGREGATE_POLL_CONCURRENCY, queuedSourceIds.length) },
            () => worker(),
          ))
        }
      } finally {
        aggregatePollRunningRef.current = false
      }
    })()
  }, [refreshAggregate])

  /** 刷新需要兜底/刚重连的就绪实例；未就绪实例落 not-connected——已推送过的
   *  挂载来源除外（保留其最后推送视图，）。 */
  const pollAggregates = useCallback(() => {
    const { ready, notReady } = collectReadySourceIds(health, remoteStatus, remoteInstances)
    const refreshPlan = planAggregateRefreshes(
      ready,
      readyAggregateSourcesRef.current,
      snapshotSourcesRef.current,
    )
    // Commit the observed generation synchronously before starting pulls: an
    // overlapping health/status callback must not mint duplicate reconnect pulls.
    readyAggregateSourcesRef.current = refreshPlan.nextReady
    runBoundedAggregateWave(refreshPlan.refreshSourceIds)
    if (notReady.length > 0) {
      aggregateRefreshQueueRef.current.delete(notReady)
      // A pull started in the dying generation must never restore an `ok`
      // aggregate after the authoritative transport state became not-ready.
      aggregateRequestOwnersRef.current!.retire(notReady)
      for (const sourceId of notReady) {
        aggregatePollSeqRef.current[sourceId] = (aggregatePollSeqRef.current[sourceId] ?? 0) + 1
        mutationRefreshSeqRef.current[sourceId] = (mutationRefreshSeqRef.current[sourceId] ?? 0) + 1
      }
      setAggregates(prev => {
        let changed = false
        const next = { ...prev }
        for (const id of notReady) {
          const current = next[id]
          if (current === undefined) {
            next[id] = emptyAggregate('not-connected')
            changed = true
          } else if (current.state !== 'not-connected'
            // 本就以 connected 为门（断连不显示任何行），保留它让重连后的
            // ready-edge 拉取走 sessions-only merge（工作区/归档集不丢失）。
            // 未推送/未挂载来源照旧落 not-connected（unary 兜底 = 其文档化
            // 范围）。shouldRetainPushedAggregate 单测覆盖（aggregate-refresh.test.ts）。
            && !shouldRetainPushedAggregate(snapshotSourcesRef.current[id] === true, current)) {
            next[id] = emptyAggregate('not-connected')
            changed = true
          }
        }
        return changed ? next : prev
      })
      // 断连即清该来源的运行时事实（06 ：generation 级事实随断连失效）
      setRuntimeFacts(prev => {
        let changed = false
        const next = { ...prev }
        for (const id of notReady) {
          if (next[id] !== undefined) {
            delete next[id]
            changed = true
          }
        }
        return changed ? next : prev
      })
      // Host facts are generation-scoped too: a disconnected source must
      // not retain a version from the previous connection generation
      // (0.1.2: the local instance's version comes from the desktop bridge).
      setHostFacts(prev => {
        let changed = false
        const next = { ...prev }
        for (const id of notReady) {
          if (next[id] !== undefined) {
            delete next[id]
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
  }, [health, remoteStatus, remoteInstances, refreshAggregate, runBoundedAggregateWave])

  const pollAggregatesRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    pollAggregatesRef.current = pollAggregates
  })

  // 连接事实（health / 隧道相位 / 注册表）或快照生产者变化即重估聚合，
  // tick：ready↔degraded 转换瞬间的错误行在下一次状态推送后立即被
  // not-connected/正常数据替换，不残留到轮询周期。
  useEffect(() => {
    pollAggregatesRef.current()
  }, [health, remoteStatus, remoteInstances, snapshotSources])

  // Staleness watchdog: the edge logic above only pulls newly-ready or
  // never-pushed sources, so a mounted producer whose push channel silently
  // dies (no withdrawal — aggregate-store clear() never fires) would leave
  // its aggregate stale forever. Every tick, pull any ready source whose
  // last PUSHED snapshot is older than the threshold. Actively pushing
  // sources are never pulled; the bounded wave keeps quiet-fleet cost at a
  // handful of loopback requests per minute and the signature dedup keeps
  // unchanged state churn-free.
  // Render-phase mirror of the aggregates state for this interval (the timer
  // must stay stable across aggregate commits — re-creating it on every push
  // would stretch the cadence under activity; same ref-mirror discipline as
  // remoteStatusRef above).
  const watchdogAggregatesRef = useRef(aggregates)
  watchdogAggregatesRef.current = aggregates
  // 运行位活性守卫（）：运行时事实的
  // render-phase 镜像（与上面的 aggregates 镜像同纪律：timer 稳定，不因每次
  // 上报重建）+ 守卫状态 ref + 需要用户可见提示的来源。
  const watchdogRuntimeFactsRef = useRef(runtimeFacts)
  watchdogRuntimeFactsRef.current = runtimeFacts
  const sessionLivenessRef = useRef(createSessionLivenessState())
  const [stalledSources, setStalledSources] = useState<readonly string[]>([])
  // 用户已经「忽略」过的停滞来源：同一停滞时段不再重复提示（与 mobile
  // session-stall.ts 的 dismiss 语义一致——误报不得反复打扰），来源恢复
  // （离开 stalled）时自动解除忽略。
  const [dismissedStalls, setDismissedStalls] = useState<readonly string[]>([])
  /** 事实已越界无法验证的来源（）：与 stalledSources 共用同一条
   *  停滞横幅（文案本身即「无法确认会话状态」），下一次成功读取（push/unary）即移除。 */
  const [unverifiedSources, setUnverifiedSources] = useState<readonly string[]>([])
  // 渲染期镜像（与 watchdogAggregatesRef 同纪律）：watchdog 回调不因它重建定时器。
  const unverifiedSourcesRef = useRef(unverifiedSources)
  unverifiedSourcesRef.current = unverifiedSources
  /**
   * 唯一的标记写入口（）：除 setState 外**同步**更新 ref ——
   * 同一 tick 的 dismiss 剪枝与失败分支都读 ref，若只等下一次渲染，刚被判「无法确认」
   * 的来源会被旧快照误判成已恢复（忽略被提前剪掉、横幅反复重现）。
   */
  const setUnverified = (updater: (prev: readonly string[]) => readonly string[]): void => {
    setUnverifiedSources(prev => {
      const next = updater(prev)
      unverifiedSourcesRef.current = next
      return next
    })
  }
  // S2 (对齐 ssh 断链自动恢复): a stale MOUNTED direct-http source (registry
  // spec transport === 'http', whatever the target kind) additionally gets a
  // lightweight connection reconnect (bounded by lastReconnectAtRef) so the
  // ctx's own reconnect chain re-establishes the frozen workspace follow —
  // the unary pull only refreshes session rows, it cannot heal the push
  // channel. The reconnect is an ADDITION, never a replacement of the pull.
  // Cadence (two distinct regimes, review M2/Low-2): a HEALTHY-but-quiet
  // source rebaselines after each reconnect, whose baseline push refreshes
  // snapshotAt — the next reconnect fires one transport threshold later
  // (this depends on the producer's withdraw→re-publish chain resurfacing the
  // baseline; if that chain stays silent the regime degrades to the backoff
  // gate below). A TRULY dead channel gets no push after a reconnect, so once
  // stale it retries every AGGREGATE_RECONNECT_BACKOFF_MS — bounded churn
  // that keeps probing until the channel heals or the source leaves ready.
  // 2026 性能整改：tick 主体抽成可即时调用的回调——周期 interval 与
  // visibilitychange 恢复补偿（hidden→visible）共用，隐藏期跳过的 stale 拉取
  // 在恢复后立即收敛（见下方 visibility effect）。
  const runStalenessWatchdogNow = useCallback(() => {
    const now = Date.now()
    const ready = collectReadySourceIds(health, remoteStatus, remoteInstances).ready
    const staleIds = ready
      .filter(id => isSnapshotStale(snapshotAtRef.current[id], now, AGGREGATE_FALLBACK_POLL_MS))
    if (staleIds.length > 0) runBoundedAggregateWave(staleIds)
    // The reconnect arm is scoped to DIRECT-HTTP sources (registry spec
    // transport === 'http' — gateway-kind AND dsh-kind alike); ssh-transport
    // targets (any kind) are excluded: the tunnel's ssh keepalive and
    // loopback stability already protect them, so churning their ctxs would
    // be pure cost (M1 review fix: the axis is the transport, not the target
    // kind). No host-loopback exclusion here — unlike S2-a (whose transport
    // keepalive is pointless on a loopback leg that cannot half-open), this
    // arm also heals ctx-level push-channel freezes that are NOT
    // transport-caused (e.g. a dsh-restart rebaseline gap), so a
    // loopback-host direct-http target (local gateway dev) stays covered; a
    // healthy idle one there merely bounces every ~2min (bounded, dev form).
    // Per-source transport decides the threshold (): http
    // keeps the 120s tight-heal cadence (no upstream heartbeat), ssh gets the
    // 5min last-resort cadence (three independent tunnel detectors already
    // cover transport-level death; this arm only heals an app-level freeze),
    // and local/unknown sources are skipped entirely.
    const transportBySourceId = new Map(
      remoteInstances.map(instance => [sourceIdForInstance(instance), instance.transport]),
    )
    // 本 tick 内**真正执行过** reconnect 的来源（**三条臂**共享：S2 陈旧臂、
    // fallback-view 重建臂、运行位守卫的 L2）：用局部集合而不是墙钟窗口判断，
    // 避免「先规划改状态、后因窗口命中而跳过」把已到期的 L2 推迟一个退避周期，
    // 也避免时钟抖动带来的误判（）。**每条执行了 reconnect 的臂
    // 都必须登记**——漏登记就会让后面的臂对同一来源再重连一次（每次都要重放
    // 全部 baseline；三轮复核抓出 fallback 臂漏登记）。
    const reconnectedThisTick = new Set<string>()
    for (const id of ready) {
      if (id === LOCAL_INSTANCE_ID) continue
      const stalenessMs = reconnectStalenessMsForTransport(transportBySourceId.get(id))
      if (stalenessMs === null) continue
      // mounted here means "the ctx producer pushed at least one snapshot
      // this generation" (snapshotSources) — the S2 target class is a
      // channel that worked and then went silent; a channel dead from its
      // first boot never pushes and stays on the unary fallback, which
      // already covers it (KNOWN DEGRADATION scope, M3 review note).
      if (!shouldReconnectStaleMounted({
        mounted: snapshotSourcesRef.current[id] === true,
        lastSnapshotAt: snapshotAtRef.current[id],
        lastReconnectAt: lastReconnectAtRef.current[id],
        now,
        stalenessMs,
        reconnectBackoffMs: AGGREGATE_RECONNECT_BACKOFF_MS,
      })) continue
      // Record the attempt synchronously with firing so overlapping
      // ticks/effect re-arms cannot double-fire while a reconnect is in
      // flight — but only when reconnect() was actually invoked: a no-op
      // (shell not booted / ctx missing, e.g. a boot-failure retry window)
      // must not consume the backoff window and delay the first effective
      // reconnect (M4 review fix).
      // NOTE (review P2-3): each reconnect resets the ctx connection's
      // official exponential backoff to an immediate retry (MANUAL_RECONNECT
      // semantics) — while a target stays ready-but-dead this yields a
      // fixed ~60s probe cadence instead of the official backoff ceiling.
      // Bounded and intended (it is the healing probe); a long-dead target
      // eventually flips to not-connected via the main-process reverify
      // path, which removes it from this arm.
      if (reconnectInstanceConnection(id)) {
        lastReconnectAtRef.current[id] = now
        reconnectedThisTick.add(id)
      }
    }
    for (const id of ready) {
      if (id === LOCAL_INSTANCE_ID) continue
      if (!shouldRebaselineFallbackView({
        mounted: snapshotSourcesRef.current[id] === true,
        fallbackView: isFallbackDerivedView(watchdogAggregatesRef.current[id]),
        lastReconnectAt: lastReconnectAtRef.current[id],
        now,
        reconnectBackoffMs: AGGREGATE_RECONNECT_BACKOFF_MS,
      })) continue
      if (reconnectInstanceConnection(id)) {
        lastReconnectAtRef.current[id] = now
        reconnectedThisTick.add(id)
      }
    }
    // 运行位活性守卫（）：ui-chat 的
    // 「深度求索中」由官方 session 的 running 位驱动，而该位只由 mux 上一条
    // emit 型事件 api-session/status 递送（无重传），官方唯一的收敛路径
    // handleConnected() → refreshList() 又只挂在连接代际重置上 ⇒ 丢一帧或
    // carrier 静默半死时 running 永久为 true。本臂：L1 对账（官方 session.list →
    // 本地判定 → 独立权威探针；权威正面证伪而契约内纠正不了时**回写官方 store**，
    // 只写 false、写后自校验 —— design 14 §D4 ①b）→ 仅当回执证明对账通道坏掉才
    // L2 reconnect → L3 可见提示。local 刻意不排除：本次缺陷的现场就是本地实例，
    // 且升级依据是「拿不到权威结论」而非「沉默很久」（长工具/长推理的合法
    // 静默与真卡死在本层不可区分，误升级会引入 reconnect 风暴）。
    const generationBySourceId = new Map(
      servers.map(server => [server.id, server.sourceFingerprint]),
    )
    const livenessSources: Record<string, SessionLivenessSourceInput | undefined> = {}
    for (const id of ready) {
      const report = watchdogRuntimeFactsRef.current[id]
      livenessSources[id] = {
        sessions: report?.sessions,
        // 共享重连账本（同一 tick 的 S2/fallback 臂已经写过，见上方循环）：挡住时
        // 守卫不派遣 L2，只继续 L1——被 App 丢弃的派遣会静默整个退避窗且停摆 L1
        // （）。
        reconnectBlocked: reconnectedThisTick.has(id)
          || (lastReconnectAtRef.current[id] !== undefined
            && now - lastReconnectAtRef.current[id] < AGGREGATE_RECONNECT_BACKOFF_MS),
        // 代际指纹（registry 投影同源）：不变量是「A 结束、B 开始」若发生在两次
        // tick 之间（隐藏期跳过），新会话绝不能继承旧时段的配额/提示。
        ...(generationBySourceId.get(id) === undefined
          ? {}
          : { generation: generationBySourceId.get(id) }),
        ...(report?.sessionFactReconcile === undefined
          ? {}
          : { reconcile: report.sessionFactReconcile }),
      }
    }
    const livenessPlan = planSessionLiveness(sessionLivenessRef.current, { now, sources: livenessSources })
    sessionLivenessRef.current = livenessPlan.state
    for (const action of livenessPlan.actions) {
      // watchdog 绝不向 App 抛错（与上面的 reconnect 臂同纪律）；动作次数由
      // 守卫自身的预算封顶（L1 滚动窗口 10 分钟 ≤3 次、L2 每时段 ≤1 次），日志因此有界。
      try {
        if (action.kind === 'refresh') {
          console.warn(`[renderer] session-liveness: reconciling session facts for ${action.sourceId}`)
          chamberBridge.requestSessionListRefresh(action.sourceId)
        } else if (action.kind === 'reconnect') {
          // 与既有臂共用同一份 per-source 账本：同一 tick 内已经重连过的来源不得
          // 被多条臂各重连一次；跨 tick 也要看账本——S2/fallback 臂可能刚在几十秒前
          // 重连过（它们各自会重放全部 baseline），此时 L2 应当让位而不是紧跟一次
          // （）。
          // 守卫已用同一账本事实（reconnectBlocked）提前排除被挡住的派遣，这两道
          // 检查是防御性兜底（账本在同一 tick 的更早阶段被 S2/fallback 臂写入）。
          if (reconnectedThisTick.has(action.sourceId)) continue
          const lastReconnectAt = lastReconnectAtRef.current[action.sourceId]
          if (lastReconnectAt !== undefined && now - lastReconnectAt < AGGREGATE_RECONNECT_BACKOFF_MS) {
            console.warn(`[renderer] session-liveness: ${action.sourceId} was reconnected ${String(Math.round((now - lastReconnectAt) / 1000))}s ago; deferring L2`)
            continue
          }
          console.warn(`[renderer] session-liveness: reconciler unresponsive for ${action.sourceId}; reconnecting`)
          // 只有真正执行了才消耗 L2 预算：shell 未 boot / ctx 缺失时该杠杆是
          // no-op 并返回 false，此时升级会给出「一次都没试过」的假提示；no-op 另计
          // 一条账（连续多次 ⇒ 允许 L3，否则用户永远看不到提示）。
          if (reconnectInstanceConnection(action.sourceId)) {
            sessionLivenessRef.current = markSessionLivenessReconnect(
              sessionLivenessRef.current, action.sourceId, now)
            lastReconnectAtRef.current = { ...lastReconnectAtRef.current, [action.sourceId]: now }
          } else {
            sessionLivenessRef.current = markSessionLivenessReconnectNoop(
              sessionLivenessRef.current, action.sourceId)
          }
        } else {
          console.warn(`[renderer] session-liveness: ${action.sourceId} still stalled after a reconnect`)
        }
      } catch (error) {
        console.error('[renderer] session-liveness action failed:', error)
      }
    }
    setStalledSources(prev => (prev.length === livenessPlan.stalled.length
      && prev.every((id, index) => id === livenessPlan.stalled[index])
      ? prev
      : [...livenessPlan.stalled]))
    setDismissedStalls(prev => {
      // 只在「既未停滞、也未被判无法验证」时解除忽略（）：只看
      // livenessPlan.stalled 会把「无法确认」来源的忽略立刻剪掉 ⇒ 横幅反复重现。
      const next = prev.filter(id => livenessPlan.stalled.includes(id)
        || unverifiedSourcesRef.current.includes(id))
      return next.length === prev.length ? prev : next
    })
  }, [health, remoteStatus, remoteInstances, runBoundedAggregateWave])
  const runStalenessWatchdogRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    runStalenessWatchdogRef.current = runStalenessWatchdogNow
  })

  // Staleness watchdog cadence + 文档可见性门控（2026 性能整改）：窗口隐藏
  // （Electron 最小化/隐藏到托盘）期跳过周期 unary 拉取与 S2 reconnect 臂——
  // 用户不可见期不维持 30s 轮询/重连链（含"已回收但仍 ready 的源"的兜底拉
  // 取：隐藏期暂停、恢复可见立即补偿一轮，见 visibility effect；窗口可见时
  // 该兜底照常维持 30s 周期——回收源的任务完成检测依赖它，05  语义不
  // 变）。恢复补偿由下方 visibility effect 调 runStalenessWatchdogRef。
  useEffect(() => {
    const timer = setInterval(() => {
      if (!shouldRunBackgroundPhase(document.visibilityState)) return
      runStalenessWatchdogRef.current()
    }, AGGREGATE_FALLBACK_POLL_MS)
    return () => { clearInterval(timer) }
  }, [])

  // 前台恢复补偿（2026 性能整改）：hidden → visible 立即推进一轮聚合
  // watchdog（隐藏期暂停的 30s 兜底/stale 拉取在此收敛，含已回收源）、
  // 空闲预热队列与保留回收检查，以及两条 30s 兜底轮询（连接行/注册表，
  // ）。五个目标都是 ref 镜像的最新闭包。
  const refreshConnectionsRef = useRef(refreshConnections)
  const refreshRemotesRef = useRef(refreshRemotes)
  useEffect(() => {
    refreshConnectionsRef.current = refreshConnections
    refreshRemotesRef.current = refreshRemotes
  })
  useEffect(() => {
    let compensationTimer: number | undefined
    let disposed = false
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      runStalenessWatchdogRef.current()
      void refreshConnectionsRef.current()
      void refreshRemotesRef.current()
      // 托管 dsh 状态**先刷新完再** drain：隐藏期探针被跳过，若并行 drain 会
      // 读到期前的 managedRuntime 投影，把一个已停机的 gateway 源拿去收割/预热
      // （白烧一次尝试；复查 MINOR-2）。
      // 探针 promise 在微任务里 resolve，而 React 要到下一个宏任务才提交
      // setManagedRuntime——直接 drain 会读到探针前的投影（
      // MINOR）。延后一个宏任务，让补偿真正看到新事实；定时器随卸载清理，
      // 探针 reject 也不能让补偿整条腿消失（复查 NIT）。
      probeManagedRuntimeRef.current().then(() => {
        if (disposed) return
        compensationTimer = window.setTimeout(() => {
          compensationTimer = undefined
          if (document.visibilityState !== 'visible') return
          drainPrewarmRef.current()
          reclaimHiddenViewsRef.current()
        }, 0)
      }).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      if (compensationTimer !== undefined) window.clearTimeout(compensationTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => () => {
    for (const timer of aggregateRetryTimersRef.current.values()) clearTimeout(timer)
    aggregateRetryTimersRef.current.clear()
  }, [])

  // C2 perf 埋点（User Timing；标记注册表见 perf-marks.ts）：页面壳挂载与
  // 本地实例 ready 首达。settle/boot-failed 由 shell.ts 在 settle 返回点
  // 统一打点，本组件不再重复。
  const appMountMarkedRef = useRef(false)
  useEffect(() => {
    if (appMountMarkedRef.current) return
    appMountMarkedRef.current = true
    perfMark(PERF_MARKS.appMount)
  }, [])
  const firstLocalReadyMarkedRef = useRef(false)
  useEffect(() => {
    if (health?.dsh?.status !== 'ready' || firstLocalReadyMarkedRef.current) return
    firstLocalReadyMarkedRef.current = true
    perfMark(PERF_MARKS.appLocalReady)
  }, [health])

  useEffect(() => {
    let cancelled = false

    void refreshHealth()
    void refreshConnections()
    pollAggregatesRef.current()

    // Local status push channel (设计 05 ): the control plane streams every
    // machine transition — starting → ready 即时翻转，没有周期性健康轮询。
    // EventSource 自带重连，重连后先收到当前快照；流建立失败时做一次性
    // /health 兜底（承载 controlUnreachable 判定与首帧收敛）。
    const healthEvents = api.host.healthEvents()
    healthEvents.onmessage = (event) => {
      if (cancelled) return
      try {
        const payload = JSON.parse(event.data) as HealthResponse
        if (payload?.ok === true && payload?.dsh !== undefined) {
          setHealth(payload)
          setHealthError(null)
          setHealthErrorAt(null)
        }
      } catch {
        // 畸形帧忽略——流的下一帧快照会覆盖
      }
    }
    healthEvents.onerror = () => {
      if (cancelled) return
      void refreshHealth()
    }

    // 连接行低频刷新（label/dshPort 极少变化；行状态在启动判定后不再敏感）。
    // 隐藏期跳过（
    // 生效）：恢复可见时由上方 visibility effect 立即补偿一轮。
    const connectionsTimer = setInterval(() => {
      if (cancelled) return
      if (!shouldRunBackgroundPhase(document.visibilityState)) return
      void refreshConnections()
    }, CONNECTIONS_POLL_MS)

    // 注册表低频轮询（与连接行同节奏）：兜底桌面侧任何来源的注册表变化
    // （主进程 save/delete 的 instances_changed 推送之外；隧道状态本身走 onStatusChanged
    // 推送，不依赖此轮询）。隐藏期跳过与恢复补偿同连接行轮询。
    const remotesTimer = setInterval(() => {
      if (cancelled) return
      if (!rosterListenerReadyRef.current) return
      if (!shouldRunBackgroundPhase(document.visibilityState)) return
      void refreshRemotes()
    }, CONNECTIONS_POLL_MS)

    window.addEventListener('beforeunload', disposeAllShells)

    return () => {
      cancelled = true
      clearInterval(connectionsTimer)
      clearInterval(remotesTimer)
      healthEvents.close()
      window.removeEventListener('beforeunload', disposeAllShells)
    }
  }, [refreshHealth, refreshConnections, refreshRemotes])

  /**
   * 桌面桥订阅（05 ）：preload 经异步 dsh-chamber:info 往返后才暴露
   * window.dshChamber——桥可能在挂载 effect 之后才出现，一次性订阅会静默
   * 丢失状态/注册表推送（退化为 30s 轮询自愈）。机制：500ms 探测直到桥出现，
   * 出现即装载 roster 并订阅 onStatusChanged / onInstancesChanged（设置页
   * 同款 bridgeUp 守卫）。卸载时退订。
   */
  const [sshBridgeReady, setSshBridgeReady] = useState(false)
  const [rosterListenerReady, setRosterListenerReady] = useState(false)
  const rosterListenerReadyRef = useRef(false)
  useEffect(() => {
    if (sshBridgeReady) return
    const timer = setInterval(() => {
      if (window.dshChamber?.desktopSsh !== undefined) {
        clearInterval(timer)
        setSshBridgeReady(true)
      }
    }, 500)
    return () => { clearInterval(timer) }
  }, [sshBridgeReady])

  /** First authoritative roster acquisition: retry transient IPC failures on
   * a short bounded cadence. Exhaustion keeps the one pending activation held;
   * the existing 30s registry poll remains the long-tail recovery path. */
  useEffect(() => {
    if (
      !sshBridgeReady
      || !rosterListenerReady
      || !rosterListenerReadyRef.current
      || remoteRosterSettled
    ) return
    let cancelled = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const attempt = (): void => {
      attempts += 1
      void refreshRemotes().then((settled) => {
        if (cancelled || settled) return
        if (attempts >= REMOTE_ROSTER_RETRY_LIMIT) {
          console.error('[renderer] remote instances roster unavailable; pending deep-link activation remains held')
          return
        }
        retryTimer = setTimeout(attempt, REMOTE_ROSTER_RETRY_MS)
      })
    }
    attempt()
    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [sshBridgeReady, rosterListenerReady, remoteRosterSettled, refreshRemotes])

  useEffect(() => {
    if (!sshBridgeReady) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const unsubscribe = ssh.onStatusChanged((payload) => {
      // A removed transport may emit one final phase while main tears it down.
      // The delta already retired this incarnation; refreshRemoteStatus after
      // a real re-add supplies the replacement's first accepted projection.
      const sourceId = sourceIdForRawInstance(payload.id, remoteInstancesRef.current)
      if (sourceId === null
        || sourceIdForTransport(payload.status.kind, payload.id) !== sourceId
        || !liveServerIdsRef.current.has(sourceId)) return
      remoteStatusRef.current = { ...remoteStatusRef.current, [payload.id]: payload.status }
      setRemoteStatus(prev => ({ ...prev, [payload.id]: payload.status }))
    })
    // 注册表变更推送：设置页增/删/改实例即时重拉 roster（自动连接新 id、
    // 回收已删视图），不等 30s 轮询周期。
    const refreshAuthoritativeRoster = (): void => {
      invalidateRemoteRoster()
      void refreshRemotes()
    }
    // Listener-before-snapshot closes the bridge-hydration lost-update window:
    // a registry mutation can no longer land between a successful initial
    // instances_get and onInstancesChanged subscription while the old roster
    // remains marked authoritative.
    const unsubscribeInstances = subscribeRosterBeforeRefresh(
      listener => ssh.onInstancesChanged(({ retiredIds }) => {
        // The trusted desktop delta is the only observation that survives two
        // overlapping pulls both seeing the final same-id re-add. Retirement
        // must happen before invalidating/refreshing the roster generation.
        retireSources(remoteRetiredSourceIds(retiredIds))
        listener()
      }),
      refreshAuthoritativeRoster,
    )
    rosterListenerReadyRef.current = true
    setRosterListenerReady(true)
    // OS 唤醒分发（design 14 D4）：主进程 push system-resume → 本页面所有
    // dsh 前端连接（N-ctx 单页共享 window）立即重连——dsh-client-connection
    // 的 chamber 补丁监听该 window 事件。事件名以该包的共享常量
    // `SYSTEM_RESUME_EVENT`（client/index.ts，值为 'dsh-chamber:system-resume'）
    // 为唯一权威，本处字面量必须与之保持一致（renderer tsconfig 无法解析该
    // 包的深路径导出，故用字面量 + 此注释锁定同步）。桥与 desktopSsh 同一批
    // expose，desktopSsh 存在则 systemResume 必存在。
    const unsubscribeResume = window.dshChamber?.systemResume?.onResume(() => {
      window.dispatchEvent(new Event('dsh-chamber:system-resume'))
    })
    // 通知点击打开（design 19 ）：主进程推送 notification-open →
    // openSession（既有路径：切 shell → ensureRemoteConnected →
    // openInstanceSession）。桥与 desktopSsh 同一批 expose，desktopSsh 存在
    // 则 notifications 必存在（与上方 SYSTEM_RESUME_EVENT 同款锁定纪律）。
    // 监听注册后立即发就绪信号：主进程只在就绪后放行推送（did-finish-load
    // 早于本监听注册，窗口重建路径的事件不能丢）。
    const notifications = window.dshChamber?.notifications
    const unsubscribeNotifications = notifications?.onOpen((open) => {
      const { sourceId } = open
      const classification = classifyRosterGatedSource(
        sourceId,
        remoteRosterSettledRef.current,
        liveServerIdsRef.current,
      )
      // A successful roster pull updates the imperative authority ref before
      // React commits the replay effect. Keep a later remote click behind any
      // already-held payloads during that small window; local remains immediate
      // per the roster-gate contract.
      if (
        classification === 'hold'
        || (sourceId !== LOCAL_INSTANCE_ID && pendingRosterNotificationOpensRef.current.length > 0)
      ) {
        const queued = enqueueBoundedRosterIntent(
          pendingRosterNotificationOpensRef.current,
          open,
          MAX_PENDING_ROSTER_NOTIFICATION_OPENS,
        )
        pendingRosterNotificationOpensRef.current = queued.pending
        if (queued.dropped !== null) {
          console.warn(`[notifications] roster pending queue full; dropped oldest open (${queued.dropped.sourceId}/${queued.dropped.sessionId})`)
          void acknowledgeNotificationOpen(queued.dropped).catch(error => {
            reportNotificationAckFailure(queued.dropped!, error)
          })
        }
        return
      }
      if (classification === 'missing') {
        console.warn(`[notifications] ignored source absent from the authoritative roster: ${sourceId}`)
        void acknowledgeNotificationOpen(open).catch(error => {
          reportNotificationAckFailure(open, error)
        })
        return
      }
      void enqueueNotificationOpen(open, 'live')
    })
    // Listener-before-ready mirrors the deep-link contract. A transient
    // sender-fence/navigation race must not leave main's click queue held for
    // the lifetime of the renderer, so retry on a small bounded budget and
    // make final exhaustion loud.
    let notificationReadyCancelled = false
    let notificationReadyAttempts = 0
    let notificationReadyRetryTimer: ReturnType<typeof setTimeout> | null = null
    const signalNotificationReady = (): void => {
      if (notifications?.ready === undefined) return
      notificationReadyAttempts += 1
      void Promise.resolve()
        .then(() => notifications.ready())
        .then((ready) => {
          if (ready !== true) throw new Error('notifications ready returned false')
        })
        .catch((error: unknown) => {
          if (notificationReadyCancelled) return
          if (notificationReadyAttempts >= LISTENER_READY_RETRY_LIMIT) {
            console.error('[notifications] readiness handshake exhausted its retry budget:', error)
            return
          }
          notificationReadyRetryTimer = setTimeout(signalNotificationReady, LISTENER_READY_RETRY_MS)
        })
    }
    if (unsubscribeNotifications !== undefined) {
      signalNotificationReady()
    }
    return () => {
      rosterListenerReadyRef.current = false
      notificationReadyCancelled = true
      if (notificationReadyRetryTimer !== null) clearTimeout(notificationReadyRetryTimer)
      unsubscribe()
      unsubscribeInstances()
      unsubscribeResume?.()
      unsubscribeNotifications?.()
    }
    // openSession 依赖链稳定到 []（selectView/ensureRemoteConnected 均
    // useCallback([])），enqueueNotificationOpen 仅包装该稳定引用与页面级
    // serial tail；effect 单次订阅捕获的闭包永不过期。两者都声明在其后，
    // 不能列入此处立即求值的 deps（会触发 TDZ）。
  }, [
    sshBridgeReady,
    acknowledgeNotificationOpen,
    invalidateRemoteRoster,
    refreshRemotes,
    reportNotificationAckFailure,
  ])

  /**
   * 本地实例幂等启动（05 ）：首轮连接行装载后（null = 尚未拉到）行缺失/
   * stopped/error 均触发一次 POST /api/connections（幂等，重复 200 返回既有
   * 状态）。一旦 ready 即不再 POST（后续状态由 /health 呈现）。POST 失败
   * **不置位**——下一个连接行轮询周期（30s）重试，直到成功或出现 ready 行
   * （控制面不可达时应用本就显示致命屏，恢复后本地实例不再被静默放弃）。
   * 远程实例的自动连接独立于本地启动（见下个 effect），互不阻塞。
   */
  const localBootedRef = useRef(false)
  useEffect(() => {
    if (connections === null) return
    if (localBootedRef.current) return
    const local = connections.find(c => c.connectionId === LOCAL_INSTANCE_ID && c.kind === 'local')
    if (local !== undefined && local.status === 'ready') {
      localBootedRef.current = true
      return
    }
    void api.connections.createLocal().then(() => {
      localBootedRef.current = true
    }).catch(err => {
      console.error('[renderer] auto-start local failed (will retry on the next connections poll):', err)
    })
  }, [connections])

  /**
   * 注册表远程实例自动连接（05 ）：只对**本渲染会话首次见到的**实例 id
   * connect——应用启动装载 / 设置页新增都在下一个注册表轮询周期内生效，
   * 不依赖本地实例。绝不重复 connect 已见过的 id：否则该轮询会把用户手动
   * 断开的实例重新拉起（30s 后）——「仅新 id」守住手动断开语义。error/
   * degraded 的**自动恢复**不在这里（那是 transport-manager 的慢速重探 +
   * 下方 ensureRemoteConnected 的用户点击即时重连——两者都尊重手动断开：
   * 慢速重探被 disconnect 取消，点击重连只对 error/degraded 生效、不触碰
   * idle）。id 随注册表删除移出，重新添加即再次自动连接。
   */
  const knownRemoteIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const known = knownRemoteIdsRef.current
    for (const instance of remoteInstances) {
      if (known.has(instance.id)) continue
      known.add(instance.id)
      // connect 对未知 id 会经 IPC 拒绝（注册表在 get 与 connect 之间被删）：
      // 显式吞掉并记录，绝不产生未处理的 rejection。
      void ssh.connect(instance.id).catch(err => {
        console.error(`[renderer] auto-connect ${instance.id} failed:`, err)
      })
    }
    for (const id of [...known]) {
      if (!remoteInstances.some(instance => instance.id === id)) known.delete(id)
    }
  }, [remoteInstances])

  /**
   * 用户意图即时重连（）：点击/打开一个远程来源 = 「现在就想要这个
   * server」。侧边栏点击来源头只做视图切换（requestActivateSource →
   * selectView），从不触发隧道 connect——error（快速重试耗尽，transport-
   * manager 已进入慢速周期重探）与 degraded（重试在途）的来源需要点击即
   * 立刻再试一次，不等慢速重探周期（该周期是自动兜底，这里是即时加速 +
   * 用户能动性）。idle（手动断开）绝不触碰——保持手动断开语义，设置页
   * Connect 是显式恢复路径；requiresUserAction 终态同样放行（用户显式意图
   * 与设置页 Connect 同语义，connect() 会重置该标志）。connect 对
   * connecting/ready 幂等，故重复点击无副作用。
   */
  const ensureRemoteConnected = useCallback((viewId: string) => {
    if (viewId === LOCAL_INSTANCE_ID) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const rawId = rawInstanceIdFromSourceId(viewId)
    if (rawId === null) return
    const phase = remoteStatusRef.current[rawId]?.phase
    if (phase !== 'error' && phase !== 'degraded') return
    void ssh.connect(rawId).catch(err => {
      console.error(`[renderer] click-to-reconnect ${rawId} failed:`, err)
    })
  }, [])

  /**
   * 用户意图即时再验证（ready-state heartbeat 的即时加速）：点击/打开一个
   * 远程来源 = 「现在就想要这个 server」。与 ensureRemoteConnected 互补——
   * 非 ready 的 error/degraded 来源走隧道重连（connecting 已在途、idle 手动
   * 断开不触碰）；**ready 但会话/远端已死**（远端改密吊销 gateway 会话、远端
   * 进程掉线等，transport 相位不变、心跳要等最多一个周期）由主进程 reverify
   * 立即探测一次：终端失败（401 重登被拒等）相位翻 error（红点 + 连接页错误
   * 指引），瞬态失败走有界重连。fire-and-forget：权威状态以相位推送为准；
   * reverify 对非 ready/静默窗内的调用是主进程侧 no-op，故重复点击无副作用。
   */
  const probeRemoteReady = useCallback((viewId: string) => {
    if (viewId === LOCAL_INSTANCE_ID) return
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined || ssh.reverify === undefined) return
    const rawId = rawInstanceIdFromSourceId(viewId)
    if (rawId === null) return
    void ssh.reverify(rawId).catch(() => {
      // 探测失败保持现状：权威状态仍由 onStatusChanged 推送/轮询兜底；
      // 但失败本身值得留痕（IPC/主进程侧异常，非实例状态）。
      console.warn(`[renderer] ready-state reverify ${rawId} failed`)
    })
  }, [])

  /**
   * 重试一个视图（05 ）：升格为唯一入口，失败覆盖层与降级提示共用同一套
   * 三段式——重挂该视图 + error/degraded 隧道立即再试 + ready 但会话/远端已死
   * 的来源立即探测一次。自己写一套会漏掉最后那条探测臂（重试会因隧道故障或
   * 死会话原地失败）。令牌递增驱动 InstanceView 复位重 boot；来源非 ready 时
   * 前两段是 no-op，语义仍正确。
   */
  const retryView = useCallback((viewId: string) => {
    probeRemoteReady(viewId)
    ensureRemoteConnected(viewId)
    setRetryTokens(prev => ({ ...prev, [viewId]: (prev[viewId] ?? 0) + 1 }))
  }, [ensureRemoteConnected, probeRemoteReady])

  /** 视图切换（设计 05 ；W3 延迟揭示 ）：**只改选择，不改可见性**。
   * 本函数提交 activeView + mountedViews；屏上仍是 paintedView 那个视图，直到
   * 揭示 effect 判定"目标首帧可用"才经既有 'view' 过渡键收敛（view-transition.ts
   * 不改）。为什么不在这里包 VT：VT 的语义是"新状态渲染就绪后动画才开始"
   * （view-transition.ts:6-11），冷 boot 的"新状态首帧"就是遮罩本身——VT 单独
   * 做不到"boot 期保持旧视图"。因此这里连过渡节都不需要：点击后屏上没有任何变化，
   * 也就不存在"旧视图输入栏 × 新遮罩"的混色窗口（P2 的 cut 判据随之只在揭示节上）。
   * prefers-reduced-motion 仍由 view-transition.ts 的直通模式接管（揭示即时落地，
   * 持有窗不变——持有是内容决策，不是动效）。
   * 注册表守卫（05 ：视图生命周期 = 注册表条目生命周期）：来源已被删除
   * 时不挂载/不切换（点击时与提交时各查一次）。绝不把已回收的视图重新挂成僵尸：
   * 一次完整 boot 很贵，且回收 effect 的回滚会造成一闪而过的幽灵骨架屏。local 常驻。
   */
  const selectView = useCallback((viewId: string, onApply?: (applied: boolean) => void): boolean => {
    // 用户又选中这个视图 = 撤回"放弃"意图（否则它下一次离开会跳过保留宽限被
    // 立即回收）。切换来源的动作把标记写在**另一个** id 上，不会被这里误删。
    abandonedViewsRef.current.delete(viewId)
    // 用户点击 = 意图使用该来源：ready 但会话/远端已死的来源立即探测一次
    //（heartbeat 的即时加速；fire-and-forget，见 probeRemoteReady）。
    probeRemoteReady(viewId)
    // 用户点击 = 意图使用该来源：error/degraded 隧道立即再试（慢速重探的
    // 即时加速；idle 手动断开不触碰——见 ensureRemoteConnected）。
    ensureRemoteConnected(viewId)
    if (viewId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(viewId)) return false
    // I8：此刻它仍在自动预热集合里 ⇒ 这次用户选中就是一次**命中**（删除之前判定）。
    if (autoPrewarmedRef.current.has(viewId)) recordPrewarm('hit', viewId)
    autoPrewarmedRef.current.delete(viewId)
    // 用户主动点开 = 意图使用：解除"回收后不自动预热"抑制（此后闲置仍会被
    // 再次回收并再次抑制）。
    prewarmSuppressedRef.current.delete(viewId)
    // 收割中被点开 = 采用为用户视图：撤销收割意图（绝不回收用户正在看的壳），
    if (harvestIntentRef.current.delete(viewId)) {
      harvestStateRef.current[viewId] = harvestSatisfied(harvestStateRef.current[viewId])
    }
    // 查重（非闭包镜像）：同一次提交内重复登记直接跳过；已选中视图只在**没有
    // 在途揭示**时跳过。W3 起"在途"由 painted != selected 表达（揭示门持有旧视图
    // 的这 1s 内点击屏上那个视图 = 撤销：activeView 改回它，揭示门随即稳态），
    // pendingViewRef 只是这段同步提交里的意图槽（不再跨越异步边界）。
    if (viewId === pendingViewRef.current) return true
    if (pendingViewRef.current === null && viewId === activeViewRef.current) return true
    // chamber (): anchor the outgoing shell's sidebar
    // scroll BEFORE the switch; the incoming shell's stale scrollTop would
    // otherwise make the whole sidebar jump (each N-ctx shell owns its own
    // .chamberList scrollTop). restoreSidebarScroll runs inside the apply —
    // its PARK phase synchronously copies the raw scroll onto the incoming
    // container before the transition's new-state snapshot, so the incoming
    // sidebar never reveals at its own stale/zero position; the row-anchored
    // REFINE then corrects sub-row content deltas once the shell is visible
    // (booting / collapsed-to-rail shells are covered by the retry chain,
    // sidebar-scroll-sync.ts).
    const scrollAnchor = captureSidebarScrollAnchor(activeViewRef.current)
    pendingViewRef.current = viewId
    // perf 仪器（W3 I7）：switchFrameMs = view-request → view-reveal 两条 mark 之差
    // （scripts/perf/switch-frame-probe.mjs 消费；纯观测，无业务语义）。
    perfMark(PERF_MARKS.appViewRequest, viewId)
    // 同步提交（不包 VT——头注）。原来的过渡回调体整段前移到这里：
    // A roster-removal retirement or a newer click clears/replaces this
    // intent. Membership alone is insufficient: a rapid same-id re-add is live
    // again but belongs to a new source generation, so a stale intent must not
    // activate it. 提交现在与登记同拍（无异步间隙），守卫仍保留——selectView 也被
    // 深链/遮罩等异步路径调用，且"最后一次意图胜出"由 pendingViewRef 镜像兜底。
    if (pendingViewRef.current !== viewId) return true
    if (viewId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(viewId)) {
      // 提交时来源已被删除：放弃本次切换并清掉意图（绝不把已回收的视图重新挂成
      // 僵尸：一次完整 boot 很贵，且回收 effect 的回滚会造成一闪而过的幽灵骨架屏。
      // local 常驻）。
      if (pendingViewRef.current === viewId) pendingViewRef.current = null
      // 目标在提交期被删除 = 这次切换没有落地：通知调用方撤回放弃标记
      // （）。
      onApply?.(false)
      return true
    }
    if (pendingViewRef.current === viewId) pendingViewRef.current = null
    setActiveView(viewId)
    // 保留策略：被回收（不在 mountedViews）的 live 来源在此重新挂载——
    // 冷 boot + entry 重放（shell.ts 同 id 串行 barrier 保证与回收的异步
    // teardown 不交错）；本视图的 hiddenSince 由 painted 落地 effect 清除。
    setMountedViews(prev => (prev.includes(viewId) ? prev : [...prev, viewId]))
    if (scrollAnchor !== null) restoreSidebarScroll(viewId, scrollAnchor)
    onApply?.(true)
    return true
  }, [ensureRemoteConnected, probeRemoteReady])

  /**
   * 遮罩「切换来源」的放弃意图（W1/W4，）：记下意图后
   * 切换到目标来源，**等切换落地**再由下方 effect 回收被放弃的视图。
   * 为什么不就地回收：reclaimView 拒绝活动/待开视图（既有守卫），而 selectView
   * 的 apply 经 View Transition 单槽队列可能延迟——反过来"先拆再切"会在切换
   * 失败时留下没有内容的窗口。标记只由这个显式用户动作写入；目标不合法或
   * selectView 同步抛出时立即撤回，绝不让一个"没落地的放弃"污染后续回收
   * （否则该视图下一次离开会跳过保留宽限被立刻拆掉）。
   */
  const switchSourceFromVeil = useCallback((fromViewId: string, targetId: string) => {
    if (fromViewId === targetId) return
    if (targetId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(targetId)) return
    if (fromViewId !== LOCAL_INSTANCE_ID) abandonedViewsRef.current.set(fromViewId, targetId)
    // selectView 的"没落地"**不抛异常**（注册表竞态早退、apply 期目标被删除都只是
    // return），所以同步 try/catch 撤不掉标记：用一个"落地即回调"的返回值收口——
    // 只有切换真的被接受/落地，放弃标记才保留，否则撤回（
    // 否则一次没落地的切换会让该视图下一次离开跳过 60s 保留宽限被立刻拆掉）。
    const revoke = (): void => { abandonedViewsRef.current.delete(fromViewId) }
    try {
      const accepted = selectView(targetId, applied => { if (!applied) revoke() })
      if (!accepted) revoke()
    } catch (error) {
      revoke()
      console.error(`[renderer] veil switch ${fromViewId} -> ${targetId} failed:`, error)
    }
  }, [selectView])

  /**
   * 遮罩「连接」（W2）：显式用户意图，与设置页 Connect 同语义。idle 的
   * 「手动断开不被自动触碰」纪律正是靠"只有显式动作才连接"守恒，因此这里不像
   * ensureRemoteConnected 那样按相位过滤。
   */
  const connectSourceFromVeil = useCallback((viewId: string) => {
    const ssh = window.dshChamber?.desktopSsh
    const rawId = rawInstanceIdFromSourceId(viewId)
    if (ssh === undefined || rawId === null) return
    void ssh.connect(rawId).catch(err => {
      console.error(`[renderer] veil connect ${rawId} failed:`, err)
    })
  }, [])

  /** Replay the one cold-start remote activation only after the first
   * authoritative instances_get result committed the same roster generation.
   * A missing target is an authoritative removal/nonexistence decision, so it
   * is dropped instead of bypassing selectView's zombie-view guard. */
  useEffect(() => {
    // The state schedules this passive effect; the imperative ref is the final
    // authority check. An instances-changed event can invalidate the roster
    // after commit but before this effect flushes, in which case the intent
    // must remain held for the replacement generation.
    if (!canReplayRosterIntents(remoteRosterSettled, remoteRosterSettledRef.current)) return
    const pending = pendingDeepLinkDeliveryRef.current
    if (pending === null) return
    const sourceId = pending.sourceId
      ?? sourceIdForRawInstance(pending.rawInstanceId, remoteInstancesRef.current)
    if (sourceId === null) {
      pendingDeepLinkDeliveryRef.current = null
      console.warn(`[renderer] deep-link raw source is absent from the authoritative roster: ${pending.rawInstanceId}`)
      void acknowledgeDeepLink(pending).catch(error => {
        reportDeepLinkAckFailure(pending, error)
      })
      return
    }
    const decision = settlePendingDeepLinkActivation(
      sourceId,
      liveServerIdsRef.current,
    )
    pendingDeepLinkDeliveryRef.current = null
    if (decision.discarded?.reason === 'missing') {
      console.warn(`[renderer] deep-link source is no longer in the authoritative roster: ${decision.discarded.sourceId}`)
    }
    if (decision.activateSourceId !== null) {
      if (deliveryMatchesCurrentSource(
        sourceLifecyclesRef.current!,
        sourceId,
        pending.sourceFingerprint,
      )) {
        selectView(decision.activateSourceId)
      } else {
        console.warn(`[renderer] ignored stale deep-link source proof: ${sourceId}`)
      }
    }
    void acknowledgeDeepLink(pending).catch(error => {
      reportDeepLinkAckFailure(pending, error)
    })
  }, [
    remoteRosterSettled,
    liveServerIds,
    acknowledgeDeepLink,
    reportDeepLinkAckFailure,
  ])

  /** 服务器显示名（骨架屏文案；缺失回落 instanceId）。 */
  const serverLabels = useMemo(() => {
    const map: Record<string, string> = {}
    if (connections !== null) {
      for (const conn of connections) {
        if (conn.kind === 'local' && conn.label !== undefined && conn.label !== '') {
          map[LOCAL_INSTANCE_ID] = conn.label
        }
      }
    }
    // 空 label 不入表（与本地行同规）：InstanceView 的 `?? viewId` 回落
    // 只认 undefined——空串会渲染出无名的骨架标题。
    for (const instance of remoteInstances) {
      if (instance.label !== '') map[sourceIdForInstance(instance)] = instance.label
    }
    return map
  }, [connections, remoteInstances])

  // 通知事件组装镜像（设计 19 ）：onRuntimeReport effect（依赖 []）经
  // ref 读取最新 aggregates/serverLabels——effect 闭包拿不到 state/useMemo，
  // 渲染期镜像纪律同 remoteStatusRef（与 commit 同步，微任务/事件回调安全）。
  const aggregatesRef = useRef(aggregates)
  aggregatesRef.current = aggregates
  const serverLabelsRef = useRef(serverLabels)
  serverLabelsRef.current = serverLabels

  // ── ）：事实源生命周期 / 派生账本 / 通知第二入口 ──

  /**
   * 读标记 / 退避账本写盘（≤1 次/秒节流；pagehide/hidden 立即 flush）。内存是
   * 权威，v2 只是缓存，服务端是跨端权威（蓝图 ）。never-throw。
   */
  const flushUnread = useCallback((): void => {
    if (unreadSaveTimerRef.current !== null) {
      clearTimeout(unreadSaveTimerRef.current)
      unreadSaveTimerRef.current = null
    }
    saveUnread(unreadStorageRef.current, {
      v: 2,
      read: readMarksRef.current,
      edge: edgeLedgerRef.current,
      notified: completeLedgerRef.current.notifiedTable(),
    })
  }, [])
  flushUnreadRef.current = flushUnread
  const schedulePersistUnread = useCallback((): void => {
    if (unreadSaveTimerRef.current !== null) return
    unreadSaveTimerRef.current = setTimeout(() => {
      unreadSaveTimerRef.current = null
      flushUnreadRef.current()
    }, 1_000)
  }, [])

  /**
   * 一个来源的未读派生（唯一入口）。判定规则与输入全部来自纯模块
   * unread-derivation.ts（其 deriveUnread 就是 sidebar shared 的 4 参导出，
   * ABSENT/degraded turn-end 的武装分支不在此重实现）。本函数只负责：
   * 读 refs → 读动作推进 → 派生 → 写回 refs/state → 落盘/ack。
   */
  const recomputeSourceUnread = useCallback((sourceId: string): void => {
    if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
    const factsSnapshot = sessionFactsRef.current[sourceId]
    const usableFacts = factsSnapshot !== undefined && factsSnapshot.verdict === 'ok' ? factsSnapshot : undefined
    const factsRows = usableFacts?.rows
    const report = runtimeFactsRef.current[sourceId]
    // 唯一「正在阅读」谓词（主计划 -15）：paintedView（屏上是谁，不是选择）
    // ∩ 该来源 current ∩ document.hasFocus()。失焦即视为未读（行为变更已登记）。
    const readingCurrent = paintedViewRef.current === sourceId && document.hasFocus()
      ? report?.current
      : undefined
    if (readingCurrent !== undefined && factsRows !== undefined) {
      const watermark = viewingReadWatermark(factsRows[readingCurrent])
      if (watermark !== undefined) {
        const table = readMarksRef.current[sourceId] ?? {}
        const advanced = advanceReadMark(table[readingCurrent], watermark)
        if (advanced !== undefined && advanced !== table[readingCurrent]) {
          readMarksRef.current = { ...readMarksRef.current, [sourceId]: { ...table, [readingCurrent]: advanced } }
          schedulePersistUnread()
          sessionFactsSourcesRef.current.get(sourceId)?.ackRead(clientInstallIdRef.current, readingCurrent, advanced)
        }
      }
    }
    const result = deriveSourceUnread({
      facts: factsRows,
      channel: report?.sessions,
      // R13：只有权威完整列表（listComplete === true）才允许剪枝；缺省/未证明
      // = 不剪（默认不剪——列表短暂收缩不得假清）。
      listComplete: report?.listComplete === true,
      prevRunning: prevRunningRef.current[sourceId] ?? {},
      prevLedger: edgeLedgerRef.current[sourceId] ?? {},
      readMarks: readMarksRef.current[sourceId] ?? {},
      readingSessionId: readingCurrent,
      // 无 facts = channel-only 照常派生；有 facts 但 serviceable=false（host
      // 停机）⇒ 原样保留（不 clobber、不假清，R20）。注意 stale 不在此闸内：
      // R14 要求断连未读照常呈现。
      factsVerified: usableFacts !== undefined ? usableFacts.serviceable !== false : true,
    }, { deriveUnread, reconcileCompletedFacts })
    prevRunningRef.current[sourceId] = result.nextRunning
    edgeLedgerRef.current[sourceId] = result.unread
    if (!result.changed) return
    schedulePersistUnread()
    setCompletedBySource(prev => {
      const existing = prev[sourceId] ?? {}
      if (sameBooleanLedger(existing, result.unread)) return prev
      return { ...prev, [sourceId]: result.unread }
    })
  }, [schedulePersistUnread])

  /**
   * 通知组装的**唯一**入口（主计划 -3 / -16）：壳通道边沿与 watcher
   * 完成边沿两个入口都走这里；bridge.notify( 全文件只允许出现一次（接线锁）。
   */
  const emitSessionNotification = useCallback((request: SessionNotificationRequest): void => {
    const bridge = window.dshChamber?.notifications
    if (bridge === undefined) {
      // I4：没有通知桥本身就是一次决定（什么都没投递）——负断言必须看得见它，
      // 否则「通知路径整体坏掉」与「正确地没有通知」在账本上无法区分。
      notificationLedger.record({
        at: Date.now(),
        sourceId: request.sourceId,
        sessionId: request.sessionId,
        kind: request.kind,
        ...(request.watermark === undefined ? {} : { watermark: request.watermark }),
        requireHidden: false,
        decision: 'skipped',
        error: 'no-notification-bridge',
      })
      publishNotificationInstrument()
      return
    }
    try {
      const copyLocale = readDocumentLocale()
      const label = serverLabelsRef.current[request.sourceId] ?? request.sourceId
      const aggregate = aggregatesRef.current[request.sourceId]
      const sessionTitle = (sessionId: string): string => {
        const row = aggregate?.sessions.find(session => session.sessionId === sessionId)
        const display = row?.displayTitle
        if (display !== undefined && display !== '') return display
        if (row?.title !== undefined && row.title !== '') return row.title
        return frameText(copyLocale, 'session.untitled')
      }
      const title =
        request.kind === 'complete' ? frameText(copyLocale, 'notification.sessionComplete')
        : request.kind === 'ask' ? frameText(copyLocale, 'notification.awaitingAnswer')
        : frameText(copyLocale, 'notification.awaitingApproval')
      const body = label + ' · ' + sessionTitle(request.sessionId)
      // 正在屏幕上查看的会话豁免（主计划 -15）：**屏上**来源（paintedView，
      // 不是选择——持有窗内 active 已是目标而屏上仍是旧视图）∩ 该来源 current
      // ∩ 焦点；主进程再查一次窗口焦点作权威豁免。
      const requireHidden = paintedViewRef.current === request.sourceId
        && runtimeFactsRef.current[request.sourceId]?.current === request.sessionId
        && document.hasFocus()
      // I4：账本记的是**主进程回执**（shown / suppressed + error 原文），不是「我们调用了
      // 通知」——这正是 R6/R3 的正对照能成立的前提。
      const ledgerBase = {
        at: Date.now(),
        sourceId: request.sourceId,
        sessionId: request.sessionId,
        kind: request.kind,
        ...(request.watermark === undefined ? {} : { watermark: request.watermark }),
        requireHidden,
      } as const
      void bridge.notify({
        sourceId: request.sourceId,
        sourceFingerprint: request.sourceFingerprint,
        sessionId: request.sessionId,
        kind: request.kind,
        title,
        body,
        requireHidden,
        ...(request.watermark !== undefined ? { watermark: request.watermark } : {}),
      }).then(result => {
        notificationLedger.record({
          ...ledgerBase,
          decision: result.shown ? 'sent' : 'suppressed',
          ...(result.error === undefined ? {} : { error: result.error }),
        })
      }).catch(err => {
        notificationLedger.record({ ...ledgerBase, decision: 'skipped', error: String(err) })
        console.warn('[notifications] 发送失败:', err)
      })
      publishNotificationInstrument()
    } catch (error) {
      console.warn('[notifications] 事件组装失败:', error)
    }
  }, [])

  /**
   * facts 快照到达（probe / SSE delta / resync 共用）：先合服务端读水位
   * （R10 跨端收敛），再喂通知第二入口（只 observed，首帧只播种），最后重算。
   */
  const applySessionFacts = useCallback((sourceId: string, snapshot: SessionFactsSnapshot | undefined): void => {
    if (snapshot === undefined) {
      setSessionFacts(prev => {
        if (prev[sourceId] === undefined) return prev
        const next = { ...prev }
        delete next[sourceId]
        return next
      })
      delete sessionFactsRef.current[sourceId]
      recomputeSourceUnread(sourceId)
      return
    }
    const usable = snapshot.verdict === 'ok'
    if (usable && snapshot.read !== null) {
      const local = readMarksRef.current[sourceId] ?? {}
      const merged = mergeReadMarks(local, snapshot.read.marks)
      if (merged !== local) {
        readMarksRef.current = { ...readMarksRef.current, [sourceId]: merged }
        schedulePersistUnread()
      }
    }
    setSessionFacts(prev => (prev[sourceId] === snapshot ? prev : { ...prev, [sourceId]: snapshot }))
    sessionFactsRef.current = { ...sessionFactsRef.current, [sourceId]: snapshot }
    if (usable) {
      // 第二入口：watcher 观察到的完成（completedAtSource === 'observed'）。
      // reconstructed（缺口重建）只出未读、不通知（主计划 -5）；首份快照
      // 只播种水位（桌面关闭期间的完成不得补发通知）。
      const seeded = factsSeededRef.current.has(sourceId)
      const lifecycle = sourceLifecyclesRef.current!.capture(sourceId)
      for (const row of Object.values(snapshot.rows)) {
        // 子代理压制（与壳通道同一谓词）：不记账，待子代理全部结束后补发。
        if (row.subagentCount > 0) continue
        if (row.completedAtSource !== 'observed' || row.completedAt === null) continue
        const watermark = completionWatermark(row)
        if (watermark === undefined) continue
        const previous = completeLedgerRef.current.notifiedWatermark(sourceId, row.sessionId, 'complete')
        const nextWatermark = nextNotifiedWatermark(previous, watermark)
        if (nextWatermark !== undefined && nextWatermark !== previous) {
          completeLedgerRef.current.setNotifiedWatermark(sourceId, row.sessionId, 'complete', nextWatermark)
        }
        if (seeded && lifecycle !== null && shouldNotifyWatermark(previous, watermark)) {
          emitSessionNotification({
            sourceId,
            sourceFingerprint: lifecycle.fingerprint,
            sessionId: row.sessionId,
            kind: 'complete',
            watermark,
          })
        }
      }
      factsSeededRef.current.add(sourceId)
    }
    recomputeSourceUnread(sourceId)
  }, [emitSessionNotification, recomputeSourceUnread, schedulePersistUnread])

  /** servers 的渲染期镜像（facts effect 闭包不随每次 servers 重建）。 */
  const serversRef = useRef(servers)
  serversRef.current = servers

  /**
   * 行刷新提示（主计划 -4 / R9）：facts 的 session-added/removed/changed
   * ⇒ 该来源一次 unary 聚合拉取（行权威仍在聚合，不做第二行源）。四拒：
   * 未连接 / unverified / 在途 / 1s floor（source-refresh-hint.ts 纯判定）。
   */
  const requestFactsRefresh = useCallback((sourceId: string): void => {
    const server = serversRef.current.find(candidate => candidate.id === sourceId)
    const now = Date.now()
    if (!shouldDispatchRefreshHint({
      connected: server?.connected === true,
      unverified: unverifiedSourcesRef.current.includes(sourceId),
      inFlight: (factsPullInFlightRef.current[sourceId] ?? 0) > 0,
      lastHintAt: refreshHintAtRef.current[sourceId],
      now,
    })) return
    refreshHintAtRef.current[sourceId] = now
    void refreshAggregateRef.current(sourceId)
  }, [])

  /**
   * facts 生命周期的稳定签名：来源 id + 化身指纹 + connected。指纹变化 =
   * 新化身（重探、旧判定作废）；connected 边沿 = 重探 / 停流。
   */
  const gatewayFactsSpec = useMemo(
    () => servers
      .filter(server => server.kind === 'gateway')
      .map(server => server.id + ':' + server.sourceFingerprint + ':' + (server.connected ? '1' : '0'))
      .join('|'),
    [servers],
  )
  useEffect(() => {
    const wanted = new Map<string, { fingerprint: string; connected: boolean }>()
    for (const server of serversRef.current) {
      if (server.kind !== 'gateway') continue
      wanted.set(server.id, { fingerprint: server.sourceFingerprint, connected: server.connected })
    }
    for (const [sourceId, teardown] of [...sessionFactsTeardownRef.current]) {
      if (wanted.has(sourceId)) continue
      teardown()
      sessionFactsTeardownRef.current.delete(sourceId)
      sessionFactsSourcesRef.current.delete(sourceId)
      setSessionFacts(prev => {
        if (prev[sourceId] === undefined) return prev
        const next = { ...prev }
        delete next[sourceId]
        return next
      })
      delete sessionFactsRef.current[sourceId]
    }
    for (const [sourceId, input] of wanted) {
      let source = sessionFactsSourcesRef.current.get(sourceId)
      if (source === undefined) {
        const created = createSessionFactsSource({
          sourceId,
          onDiagnostic: (message, error) => console.warn(message, error ?? ''),
        })
        source = created
        const unsubscribeFacts = created.subscribe(snapshot => applySessionFacts(sourceId, snapshot))
        const unsubscribeHint = created.onRowHint(() => requestFactsRefresh(sourceId))
        sessionFactsSourcesRef.current.set(sourceId, created)
        sessionFactsTeardownRef.current.set(sourceId, () => {
          unsubscribeFacts()
          unsubscribeHint()
          created.stop()
        })
      }
      source.update(input)
    }
  }, [gatewayFactsSpec, applySessionFacts, requestFactsRefresh])

  /**
   * W6：SSH / 其它 dsh 远端来源的**无壳观察者**。网关来源有只读镜像，这些来源没有——
   * 关壳期间没有任何事实通道，完成会丢。观察者讲实例自己的远程协议（经控制面既有无鉴权
   * 实例代理），产出的快照与 gateway 事实源**同形**，因此直接喂同一条 applySessionFacts
   * 管线（同一份事实、同一套未读判定），不需要第二条判定路径。只观察：永不结算瀑布。
   */
  const sourceMuxSpec = useMemo(
    () => servers
      .filter(server => server.kind === 'dsh')
      .map(server => server.id + ':' + server.sourceFingerprint + ':' + (server.connected ? '1' : '0'))
      .join('|'),
    [servers],
  )
  useEffect(() => {
    const wanted = new Map<string, string>()
    for (const server of serversRef.current) {
      if (server.kind !== 'dsh' || server.connected !== true) continue
      wanted.set(server.id, server.sourceFingerprint)
    }
    for (const [sourceId, teardown] of [...sourceMuxTeardownRef.current]) {
      // 身份变了（同 id 新指纹）也必须拆：旧观察者的 rows/runningBefore 属于旧化身。
      if (wanted.get(sourceId) === sourceMuxIdentityRef.current.get(sourceId)) continue
      teardown()
      sourceMuxTeardownRef.current.delete(sourceId)
      sourceMuxIdentityRef.current.delete(sourceId)
    }
    for (const [sourceId, fingerprint] of wanted) {
      if (sourceMuxTeardownRef.current.has(sourceId)) continue
      const observer = createSourceMuxFacts({
        sourceId,
        origin: window.location.origin,
        onSnapshot: snapshot => applySessionFacts(sourceId, snapshot),
      })
      observer.start()
      sourceMuxTeardownRef.current.set(sourceId, () => observer.stop())
      sourceMuxIdentityRef.current.set(sourceId, fingerprint)
    }
  }, [sourceMuxSpec, applySessionFacts])

  // 焦点参与「正在阅读」谓词（主计划 -15）：focus/blur 只重算来源账本，
  // 不回退读标记（「已读」是单向的）。
  useEffect(() => {
    const onFocusChange = (): void => {
      const ids = new Set<string>([...sessionFactsSourcesRef.current.keys(), ...Object.keys(runtimeFactsRef.current)])
      for (const sourceId of ids) recomputeSourceUnread(sourceId)
    }
    window.addEventListener('focus', onFocusChange)
    window.addEventListener('blur', onFocusChange)
    return () => {
      window.removeEventListener('focus', onFocusChange)
      window.removeEventListener('blur', onFocusChange)
    }
  }, [recomputeSourceUnread])

  useEffect(() => {
    const flush = (): void => flushUnreadRef.current()
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      flushUnreadRef.current()
    }
  }, [])


  /**
   * 空闲预热（设计 05 ）：ready 的注册表远程实例按序、一次一个地在后台
   * boot（settle 后推进下一个），使多数首次切换在点击时已就绪——骨架屏只
   * 在预热未覆盖时出现。boot 本身经 shell.ts 的全局串行队列，与用户触发的
   * boot 共享一条链（用户请求经同一链排队，最坏等一个在途 boot）；每个 entry
   * 的实例事实独立注入，不随队列超时后的重叠而串线。预热视图为 instance-pending 态（仅 visibility 隐藏、
   * 保留 layout——vendor 测量/IntersectionObserver 在 boot 期间正常）。
   */
  const localSettledRef = useRef(false)
  const prewarmQueueRef = useRef<string[]>([])
  const prewarmInflightRef = useRef<string | null>(null)
  // 在途挂载的挂载时刻（绝对放弃上限用；0 = 无在途）。与 prewarmInflightRef
  // 同生命周期：drainPrewarm 置位，settle / 退役 / 回收清除。
  const prewarmInflightAtRef = useRef(0)
  // 每个挂载视图的挂载时刻：绝对放弃上限按**视图**判定，不能只看预热在途
  // （用户点开/深链挂载的壳同样可能挂死；）。
  const viewBootStartedAtRef = useRef<Record<string, number>>({})

  /**
   * R8 意图预热（blueprint ）的 App 侧账本。hover 意图的**唯一**作用是"该
   * 来源优先"：把 id 提前到既有队列头，让既有 pickPrewarmTarget 先看到它。它
   * 不新增槽位、不提高 MAX_PREWARMED_REMOTE_VIEWS、不放宽
   * prewarmEligible/prewarmSuppressed/收割预留中的任何一道门。
   * - intentPriorityRef：已被意图提前、尚未被 drainPrewarm 真正选中的来源。
   * - intentBudgetRef：只记"真的因意图起了一次 boot"（队列重排不计费）——
   *   每次 boot 可能新建一个远端 blank 会话，故每会话有上限与 60s 冷却
   *   （shared/prewarm-intent.ts 的纯策略）。
   */
  const intentPriorityRef = useRef<Set<string>>(new Set())
  const intentBudgetRef = useRef<IntentPrewarmBudget>(emptyIntentPrewarmBudget())

  /**
   * 渲染期镜像（与 commit 同步，微任务安全）：settle 微任务可能先于 effect
   * flush 到达（如注册表删除后的回收 effect 尚未运行），drain 时必须用它
   * 过滤已失效的队列项——绝不把已删除/已挂载的实例重新挂成僵尸视图。
   * 排除 mounted：用户已点开（或已被别处挂载）的视图不再占用预热槽位。
   */
  const prewarmEligibleRef = useRef<Set<string>>(new Set())
  // 视图调度簇（预热资格 / 收割保温 / 保留回收 / 后台相位）已抽为命名 hook
  // （阶段 3）；依赖面类型化，App 取回 8 个既有调用面继续接线。
  const {
    prewarmEligible, drainPrewarm, reclaimView, reclaimHiddenViews,
    handleInstanceSettled, handleShellState, reclaimHiddenViewsRef, drainPrewarmRef,
  } = useViewScheduler({
    activeView, health, liveServerIds, managedRuntime,
    mountedViews, remoteInstances, remoteStatus, shellStates,
    setMountedViews, setRetryTokens, setShellStates, abandonedViewsRef,
    activeViewRef, autoPrewarmedRef, deferredBootRef, degradedRetriedRef,
    harvestCandidatesRef, harvestIntentRef, harvestStateRef, hiddenSinceRef,
    intentBudgetRef, intentPriorityRef, localSettledRef, paintedViewRef,
    pendingViewRef, prewarmEligibleRef, prewarmInflightAtRef, prewarmInflightRef,
    prewarmQueueRef, prewarmSuppressedRef, reclaimViewRef, settingsTargetRef,
    viewBootStartedAtRef, MAX_PREWARMED_REMOTE_VIEWS,
  })

  // 共享文档的主题投影归属（N-ctx 硬化，design 06）：文档级 color-scheme /
  // body 调色板属性是 DOCUMENT-global 的，而本形态把 N 个实例壳挂在同一份
  // 文档里——每个挂载中的视图都跑自己的 ui-layout theme presenter。App 是
  // 「谁在屏上」的唯一权威，把它发布到 page-wide chamberBridge；ui-layout
  // fork 的 document-theme 投影器据此只让活动视图写文档（详见
  // packages/dsh-chamber-client-ui-layout/src/client/document-theme.ts）。
  // useLayoutEffect：必须在切换视图的那一帧**绘制前**发布，否则主题不同的两个
  // 视图互切会先画一帧旧调色板（2026-12 复查 MINOR-2）。
  // 同一份「谁在屏上」的权威也是文档级 `<html lang>` 的归属来源（design 06
  // 「页面语言归属」）：每个实例壳的官方 locale 服务都无条件写这个属性且无 teardown，
  // page-language 归属器只让**屏上来源、且其宿主设置已回答**的语言落地——默认
  // 进入只有本地实例的设置能决定页面语言，后台/预热的壳一律被就地回写；尚未
  // 加载的来源在它报出自己的语言之前保持当前页面语言。
  useLayoutEffect(() => {
    chamberBridge.setActiveSource(activeView)
    setPageActiveSource(activeView)
  }, [activeView])

  /**
   * 揭示门（W3 延迟揭示，）：painted 收敛到 selected 的**唯一入口**。
   * 判定全在纯叶子 reveal-gate.ts（node 直测）；这里只提供事实并走既有 'view'
   * 过渡键：
   *  - shellStates：目标 settle（成功或失败）就是"首帧可用"的信号；
   *  - revealTick：持有窗到期的一次性重算（单调钟；照 InstanceView 的
   *    surfaceFallbackTick 形态）；
   *  - 回调内必须重验 `activeViewRef.current === target`：揭示意图可能已过期
   *    （用户点了 B 又点回 A；或来源被退役）——过期揭示绝不能把已撤销的目标画回
   *    屏上（蓝图  点名"最容易写错的一点"；selectView 的 pendingViewRef 守卫
   *    是同一族纪律）。
   * flushSync 出场方式：runViewTransition 在直通模式（reduced-motion / 无
   * startViewTransition）会**同步** flushSync，而 React 不允许在 commit 相位内
   * flushSync（它自己给的处置就是"挪到 microtask"）；microtask 仍在下一帧绘制前
   * 执行，揭示时机与 layout effect 直调等价，且非直通模式下浏览器本来就在下一帧
   * 才回调 update。
   */
  useLayoutEffect(() => {
    const selected = activeView
    const nowMs = monotonicNow()
    revealHoldStartedAtRef.current = revealHoldStartedAt(revealHoldStartedAtRef.current, {
      inFlight: selected !== paintedView,
      nowMs,
    })
    const targetState = shellStates[selected]
    const verdict = shouldReveal({
      selectedViewId: selected,
      paintedViewId: paintedView,
      targetMountable: selected === LOCAL_INSTANCE_ID
        || (mountedViews.includes(selected) && liveServerIdsRef.current.has(selected)),
      targetSettled: isSettledShellState(targetState),
      targetFailed: (targetState?.error ?? null) !== null,
      holdStartedAtMs: revealHoldStartedAtRef.current,
      nowMs,
    })
    if (!verdict.reveal) {
      if (verdict.reason !== 'painted') return
      const handle = setTimeout(
        () => setRevealTick(tick => tick + 1),
        revealHoldRemainingMs(revealHoldStartedAtRef.current, nowMs),
      )
      return () => { clearTimeout(handle) }
    }
    queueMicrotask(() => {
      // 排队期间屏上目标可能已被改写/该壳已画上：揭示前重验（与回调内重验同纪律）。
      if (activeViewRef.current !== selected) return
      const mountable = selected === LOCAL_INSTANCE_ID
        || (mountedViews.includes(selected) && liveServerIdsRef.current.has(selected))
      // 目标不可挂载（退役/被删的竞态）：绝不把死视图留在屏上——回落 local
      // （唯一恒挂载视图），与 activeView 的退役回落同一条语义。
      const target = mountable ? selected : LOCAL_INSTANCE_ID
      if (paintedViewRef.current === target) return
      // 目标落地后是否显示遮罩的 DOM 事实（P2 判据不变）：在场 ⇒ 'cut'（旧视图
      // 快照不与新遮罩交叉混色），否则 'crossfade'。判不出来（无 CSS.escape /
      // 选择器抛错）就地保守取 'cut'。
      const paint = (): PaintIntent => {
        try {
          const el = document.querySelector(`.instance-view[data-instance="${CSS.escape(target)}"]`)
          return el !== null && el.querySelector('.instance-loading') === null ? 'crossfade' : 'cut'
        } catch {
          return 'cut'
        }
      }
      runViewTransition(() => {
        if (activeViewRef.current !== selected) return
        if (selected !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(selected)) return
        setPaintedView(target)
        perfMark(PERF_MARKS.appViewReveal, target)
      }, 'view', paint)
    })
  }, [activeView, paintedView, shellStates, mountedViews, revealTick])

  // **屏上视图**落地即重计隐藏窗（W3：判据是 paintedView，不是 activeView）：
  // 离开屏的旧视图开始计时，新屏上视图清计时。覆盖揭示落地、注册表删除回落
  // （fallback 到 local）等一切路径；持有窗内旧视图仍在屏上，不会因本 effect 被计时
  // ——否则 1s 持有期给屏上壳起表，保留策略会把"用户正在看的温壳"当隐藏壳回收。
  useEffect(() => {
    if (previousActiveViewRef.current === paintedView) return
    const previous = previousActiveViewRef.current
    previousActiveViewRef.current = paintedView
    delete hiddenSinceRef.current[paintedView]
    if (previous !== null) hiddenSinceRef.current[previous] = Date.now()
  }, [paintedView])

  // hiddenSince 键随挂载收敛（覆盖注册表删除分支与回收两条移除路径）+
  // 挂载/回收/激活变化后尽快补查一轮回收（60s 安全窗外的兜底由周期 tick 承担）。
  useEffect(() => {
    const live = new Set(mountedViews)
    for (const id of Object.keys(hiddenSinceRef.current)) {
      if (!live.has(id)) delete hiddenSinceRef.current[id]
    }
    // 挂载时刻（绝对放弃上限的基准；settle 时清除）。**被推迟的 boot 不起表**
    // （W2）：还没有在途 boot，绝不能被放弃臂判成"永不 settle"；相位离开 idle
    // 后本 effect 因签名变化重跑，那一刻才起表（新尝试有自己的预算）。
    // 刻意**只跳过起表、绝不删除已有表**：boot 已经开始、来源随后被手动断开时，
    // 在途的那次 boot 仍需放弃臂看管（删表会让它失去唯一的兜底）。
    const now = Date.now()
    for (const id of mountedViews) {
      if (deferredBootRef.current.has(id)) {
        // W2 生命周期：被推迟的视图**永不 settle**，所以它拿不到 handleInstanceSettled
        // 的 hiddenSince——后台挂载（设置面板选来源）又不会经过 activeView 变化臂。
        // 没有计时键，下面的推迟回收臂与 retention 都看不见它（F1：视图泄漏 +
        // 误占预热槽/隐藏壳数）。这里按挂载时刻起表，与"隐藏即计时"同一条语义。
        if (id !== activeViewRef.current && id !== pendingViewRef.current
          && hiddenSinceRef.current[id] === undefined) {
          hiddenSinceRef.current[id] = now
        }
        continue
      }
      if (viewBootStartedAtRef.current[id] === undefined) viewBootStartedAtRef.current[id] = now
    }
    for (const id of Object.keys(viewBootStartedAtRef.current)) {
      if (!live.has(id)) delete viewBootStartedAtRef.current[id]
    }
    reclaimHiddenViews()
  }, [mountedViews, deferredBootSignature, reclaimHiddenViews])

  // 周期回收检查（settle/切换以外的主要驱动）；visibilitychange 恢复补偿的
  // 回收臂在下方 aggregate 段 visibility effect 中统一处理（与预热/聚合补偿
  // 同源，避免重复监听）。
  useEffect(() => {
    const timer = setInterval(() => {
      reclaimHiddenViewsRef.current()
      // 退避期满的重试不能只靠 30s roster 轮询带来的重渲染驱动（轮询失败时
      // 后台槽会无限空转）：同一 tick 补一次 drain（复查 MINOR-4）。
      drainPrewarmRef.current()
    }, VIEW_RECLAIM_TICK_MS)
    return () => { clearInterval(timer) }
  }, [])

  // 温壳为收割让位（）：把最后收割的壳留在温壳位省了一次 boot，
  // 但该壳（autoPrewarmed + 隐藏）会占住唯一后台槽且不被 retention 回收——一旦
  // 出现新的收割候选，它必须让位，否则后变 ready 的来源永远拿不到基线（与
  // "一个失败实体不得阻塞其它"同源）。已有权威聚合，回收只是拆壳。
  useEffect(() => {
    if (!shouldRunBackgroundPhase(document.visibilityState)) return
    if (harvestCandidatesRef.current.size === 0) return
    const warm = mountedViews.find(id =>
      id !== LOCAL_INSTANCE_ID
      && id !== activeView
      && autoPrewarmedRef.current.has(id)
      && harvestStateRef.current[id]?.satisfied === true)
    if (warm !== undefined) reclaimView(warm, 'harvest')
  }, [mountedViews, activeView, prewarmEligible, reclaimView])

  useEffect(() => {
    const eligible = prewarmEligibleRef.current
    prewarmQueueRef.current = prewarmQueueRef.current.filter(id => eligible.has(id))
    // R8：已不再 eligible 的意图优先级键（被点开而挂载、被回收抑制、退役、
    // harvest 停车）就地作废——悬停不得让一道已经落下的 App 纪律复活。
    for (const id of [...intentPriorityRef.current]) {
      if (!eligible.has(id)) intentPriorityRef.current.delete(id)
    }
    for (const instance of remoteInstances) {
      const id = sourceIdForInstance(instance)
      if (!eligible.has(id)) continue
      const queue = prewarmQueueRef.current
      if (!queue.includes(id)) queue.push(id)
    }
    drainPrewarm()
    // activeView 依赖（2026 评审 Minor 修复）：保留槽可经「纯激活」释放——
    // 用户点开一个已挂载的隐藏温壳（mountedViews 不变、无 settle/roster/
    // 可见性事件）——eligible 随 activeView 变化增长，但队列补种与 drain 都
    // 在此 effect；缺该依赖会静默饿死下一次投机预热直到无关事件到来。
  }, [remoteInstances, remoteStatus, mountedViews, activeView, drainPrewarm])

  /** 打开某来源的会话：切到该来源 shell（未挂载先挂载）并分发到运行时。
   *  chamber ()：进入时 arm 一条打开意图、settle 时
   *  按 sessionId 守卫地释放——它是"这次打开还没落地"的唯一事实源，同时驱动
   *  ①投影门（该来源在此窗口内不投影 current，blank"新会话"行不可能进列表）
   *  ②揭示门（目标壳干净 settle 后遮罩继续留到本次 open 落定）
   *  ③boot 期早开（目标 ctx 内的侧栏插件读活槽位，抢在运行时初始导航之前）。
   *  守卫式释放保证"点 X 后马上点 Y"时，X 的迟到 finally 不会撤掉 Y 的闸门。 */
  const openSession = useCallback(async (instanceId: string, sessionId: string) => {
    // 用户要在这个来源上工作：error/degraded 隧道立即再试（同上）。
    ensureRemoteConnected(instanceId)
    // 与 selectView 同款注册表守卫：来源已删除时拒绝入队——否则 open 会
    // 挂进 pendingOpens 永不分发（视图不再挂载，dispose 已执行），留死键。
    if (instanceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(instanceId)) {
      // ): the open-failure texts are thrown
      // across the frame→plugin boundary (the sidebar renders whatever text the
      // rejected promise carries), so the FRAME-OWNED part is dictionary copy in
      // the document locale; read at throw time, since no render scope owns it
      // (locales.ts readDocumentLocale — the module's out-of-render reader).
      throw new Error(frameText(readDocumentLocale(), 'open.failed.sourceGone', { source: instanceId }))
    }
    try {
      armOpenIntent(instanceId, sessionId)
      selectView(instanceId)
      await openInstanceSession(instanceId, sessionId)
    } catch (err) {
      // ): dictionary copy around a raw cause —
      // `{detail}` is the underlying error text, which stays whatever the
      // crossing boundary produced. BOUNDARY (deliberate, open work for the docs
      // lane): that text is assembled BELOW the frame — shell.ts's open-failure
      // diagnostics (`实例 … 无法打开会话：…`, the list/open deadlines) and the
      // dsh runtime's own errors — and none of those sites owns a locale seat, so
      // an English document still sees a Chinese detail clause here. The frame's
      // half is dictionary copy; translating another module's error text would be
      // a second, drifting copy of it.
      throw new Error(frameText(readDocumentLocale(), 'open.failed.detail', { detail: errorMessage(err) }))
    } finally {
      releaseOpenIntent(instanceId, sessionId)
    }
  }, [selectView, ensureRemoteConnected])

  type NotificationOpen = NotificationOpenDelivery & {
    phase: 'live' | 'held'
    sourceOwner: SourceOwnershipToken | null
  }
  const notificationOpenRunnerRef = useRef<SerialIntentRunner<NotificationOpen> | null>(null)
  notificationOpenRunnerRef.current ??= new SerialIntentRunner<NotificationOpen>()
  const enqueueNotificationOpen = useCallback((delivery: NotificationOpenDelivery, phase: NotificationOpen['phase']) => {
    const sourceOwner = sourceLifecyclesRef.current!.capture(delivery.sourceId)
    if (!deliveryMatchesCurrentSource(
      sourceLifecyclesRef.current!,
      delivery.sourceId,
      delivery.sourceFingerprint,
    )) {
      console.warn(`[notifications] ignored stale source proof (${delivery.sourceId}/${delivery.sessionId})`)
      return acknowledgeNotificationOpen(delivery).catch(error => {
        reportNotificationAckFailure(delivery, error)
      })
    }
    const settled = notificationOpenRunnerRef.current!.enqueue(
      {
        ...delivery,
        phase,
        sourceOwner,
      },
      open => {
        if (!sourceLifecyclesRef.current!.owns(open.sourceOwner)) {
          // ): same dictionary rule as the two
          // open-failure texts above — the notification runner's rejection text
          // is surfaced by the sidebar, so the frame's half is dictionary copy.
          throw new Error(frameText(readDocumentLocale(), 'open.failed.sourceRebuilt', { source: open.sourceId }))
        }
        return openSession(open.sourceId, open.sessionId)
      },
      (error, open) => {
        console.error(`[notifications] 打开 ${open.phase} 会话失败 (${open.sourceId}/${open.sessionId}):`, error)
      },
    )
    return settled.then(async () => {
      try {
        await acknowledgeNotificationOpen(delivery)
      } catch (error) {
        reportNotificationAckFailure(delivery, error)
      }
    })
  }, [acknowledgeNotificationOpen, openSession, reportNotificationAckFailure])

  /** Notification clicks can be released by main before the initial remote
   * roster arrives, just like deep-link activation. Replay their full payloads
   * after authority settles; a removed source is loud-dropped and never enters
   * shell.ts's pending-open queue. */
  useEffect(() => {
    if (
      !canReplayRosterIntents(remoteRosterSettled, remoteRosterSettledRef.current)
      || pendingRosterNotificationOpensRef.current.length === 0
    ) return
    const pending = pendingRosterNotificationOpensRef.current
    pendingRosterNotificationOpensRef.current = []
    for (const open of pending) {
      const classification = classifyRosterGatedSource(open.sourceId, true, liveServerIdsRef.current)
      if (classification === 'missing') {
        console.warn(`[notifications] pending source is no longer in the authoritative roster: ${open.sourceId}`)
        void acknowledgeNotificationOpen(open).catch(error => {
          reportNotificationAckFailure(open, error)
        })
        continue
      }
      void enqueueNotificationOpen(open, 'held')
    }
  }, [
    remoteRosterSettled,
    liveServerIds,
    acknowledgeNotificationOpen,
    enqueueNotificationOpen,
    reportNotificationAckFailure,
  ])

  /**
   * W4「全部已读」：读水位与落盘都在 App 手里（WS-C 的读数纪律），所以侧栏只发意图、
   * 动作在此执行——一次性把该来源的读标记抬到**源级上界**（maxWatermark：
   * max(updatedAt, completedAt) 的全表最大值），落盘并通知镜像（ackAllRead 的
   * read-all 地板），然后重算派生（蓝点/todo 立即清空，单调提升绝不回退）。
   */
  const markSourceAllRead = useCallback((sourceId: string): void => {
    if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
    const snapshot = sessionFactsRef.current[sourceId]
    const rows = snapshot !== undefined && snapshot.verdict === 'ok' ? snapshot.rows : undefined
    if (rows === undefined) return
    const through = maxWatermark(rows)
    // 没有可用水位（全是 0）时什么都不做：绝不写一个凭空的"已读"读数。
    if (through <= 0) return
    const table = readMarksRef.current[sourceId] ?? {}
    const next: Record<string, number> = { ...table }
    for (const sessionId of Object.keys(rows)) {
      next[sessionId] = advanceReadMark(next[sessionId], through) ?? through
    }
    readMarksRef.current = { ...readMarksRef.current, [sourceId]: next }
    schedulePersistUnread()
    sessionFactsSourcesRef.current.get(sourceId)?.ackAllRead(clientInstallIdRef.current, through)
    recomputeSourceUnread(sourceId)
  }, [recomputeSourceUnread, schedulePersistUnread])

  // 桥订阅簇（全部已读 / 深链 / 回声 / 挂载快照 / 运行时上报…）已抽为命名
  // hook（阶段 3）；依赖面类型化，App 只负责传入当前 ref/state/回调与预算常量。
  useBridgeSubscriptions({
    acknowledgeDeepLink, emitSessionNotification, markSourceAllRead, openSession,
    recomputeSourceUnread, refreshAggregate, reportDeepLinkAckFailure, selectView,
    updateSessionArchive, updateSessionEcho, updateWorkspaceEcho, aggregatePollSeqRef,
    aggregateRequestOwnersRef, authoritativeArchiveSetRef, autoPrewarmedRef, completeLedgerRef,
    drainPrewarmRef, factsAtRef, harvestCandidatesRef, harvestIntentRef,
    harvestStateRef, intentBudgetRef, intentPriorityRef, liveServerIdsRef,
    mutationRefreshSeqRef, pendingDeepLinkDeliveryRef, prevRunningRef, prevRuntimeFactsRef,
    prewarmEligibleRef, prewarmQueueRef, prewarmSuppressedRef, readyAggregateSourcesRef,
    reclaimViewRef, remoteInstancesRef, remoteRosterSettledRef, sessionArchiveRef,
    sessionEchoRef, sessionFactsRef, sessionListRefreshAtRef, sessionListRefreshPendingRef,
    settingsTargetRef, snapshotAtRef, snapshotSourcesRef, sourceLifecyclesRef,
    watchdogAggregatesRef, workspaceEchoRef, setAggregates, setHostFacts,
    setMountedViews, setPluginDiagnostics, setRuntimeFacts, setSnapshotSources,
    setUnverified, sshBridgeReady, LISTENER_READY_RETRY_MS, LISTENER_READY_RETRY_LIMIT,
  })

  /** chamber (06 ，)：**屏上**来源（paintedView，
   *  非选择——持有窗内 active 已是目标而屏上仍是旧视图）的 current 会话立即视为
   *  已读：清除后台期间武装的蓝点；读水位推进 + 派生重算在同一拍
   *  （recomputeSourceUnread 内完成，覆盖「激活但无新上报」的路径，如点击来源头
   *  不打开会话）。谓词与通知 requireHidden / readingCurrent 完全同一份
   *  （-15：paintedView ∩ current ∩ hasFocus）。 */
  const prevPaintedViewRef = useRef(paintedView)
  useEffect(() => {
    const previous = prevPaintedViewRef.current
    prevPaintedViewRef.current = paintedView
    if (previous === paintedView) return
    recomputeSourceUnread(paintedView)
    recomputeSourceUnread(previous)
  }, [paintedView, recomputeSourceUnread])

  // 未读徽标 effect 簇（推送 / 桥迟到兜底 / reject 重推与卸载清理）已抽为
  // 命名 hook（阶段 3）；事实源与预算显式传入，桥面由 hook 内读 window 单例。
  useBadgeCount({
    completedBySource,
    runtimeFacts,
    retryMs: LISTENER_READY_RETRY_MS,
    retryLimit: LISTENER_READY_RETRY_LIMIT,
  })


  // 控制面失联 = 覆盖式致命屏（视图保持挂载、恢复即续会话，05 ）。判定：
  // 健康错误**持续**存在超过宽容窗才呈现——首帧（health 从未拉到）立即呈现；
  // 会话中途则要求错误持续 HEALTH_ERROR_GRACE_MS（容忍 SSE 重连/瞬时抖动的
  // 一次失败，避免闪烁），否则陈旧 health 会永远掩盖中途失联。ticker 只在该
  // 条件下运行，正常态零开销。
  /**
 * How long a boot's host-graph fetch may wait for its source to start serving
 * (). SINGLE-SOURCED from the boot budget on purpose: the same 60s
 * sizes the shell's page-level slot (`boot-budget.ts`), the prewarm harvest
 * deadline (`HARVEST_DEADLINE_MS = budget + 15s`) and the mount abandonment
 * threshold (`HARVEST_ABANDON_MS = deadline + budget`). A hand-written number
 * here would silently drift out of that ladder (the "same fact twice" failure
 * this repo already paid for elsewhere) — worst case the gate would outlive the
 * abandonment sweep and the failure overlay would race a still-waiting boot.
 */
/** The real clock, injected: the package imports nothing. W6's bound is the serving
 *  gate's own budget; the poll cadence is unchanged. */
const WAIT_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

const SERVING_WAIT_MS = BOOT_TIMEOUT_MS

/** Poll interval of the serving gate (cheap; ends the moment the phase flips). */
const SERVING_POLL_MS = 250

const HEALTH_ERROR_GRACE_MS = 10_000
  const [, setHealthErrorTick] = useState(0)
  useEffect(() => {
    if (healthError === null || healthErrorAt === null) return
    const timer = setInterval(() => setHealthErrorTick(tick => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [healthError, healthErrorAt])
  const controlUnreachable =
    healthError !== null &&
    (health === null || (healthErrorAt !== null && Date.now() - healthErrorAt >= HEALTH_ERROR_GRACE_MS))

  // 活动视图的 shell 失败报告（05  失败呈现修订）：boot 失败 settle 后由
  // InstanceView 上报终态；只有失败态（error 非空）触发覆盖层——booting/
  // 成功态由骨架屏/真实 UI 呈现。
  const activeShellState = shellStates[activeView]
  const activeShellError = activeShellState?.error ?? null
  // W3 失败/控制面不可达的**强制揭示**（蓝图 -7）：这两条路径继续用 selected
  // （用户选的那个失败必须立刻可见），并且不等待揭示门——覆盖层是模态且不透明的，
  // 没有白帧风险；但屏上不能停在旧视图上等一个永远不会到来的"目标首帧"。直接
  // setPaintedView（不走过渡节）：它在同一提交里把 painted 收敛到 selected，覆盖层
  // 随之独占屏幕。揭示门的 failed/settled 分支是常规路径，这里是兜底（含控制面
  // 不可达这种与壳状态无关的全局条件）。
  useEffect(() => {
    if (activeShellError === null && !controlUnreachable) return
    if (paintedViewRef.current === activeView) return
    revealHoldStartedAtRef.current = null
    setPaintedView(activeView)
  }, [activeShellError, controlUnreachable, activeView])
  // T15 (): the failed boot's plugin ids, as the
  // official report lists them (shell.ts collectFailedEntries reads the failed
  // boot's own loader sweep). Empty for failures that produced no loader entry
  // (module-system/manifest), which keeps today's report-only overlay.
  const activeShellFailedEntries = activeShellState?.failedEntries ?? NO_FAILED_ENTRIES
  // 降级呈现（）：活动视图 boot 成功但已知缺口时，给出现场说明。
  // 只有 error 为空的降级态才渲染——boot 失败覆盖层已独占失败态（结构互斥，
  // 见 shell.ts：settled 的 degraded 蕴含 booted && error === null）。**但控制面
  // 不可达覆盖层与壳状态无关**，上面的条件管不住它，故渲染处再加一道
  // `!controlUnreachable`：否则横幅会被那张不透明覆盖层盖住却仍可聚焦/播报
  // （）。
  // 「会自动重挂吗」由 boot-gap.ts 的纯判定给出：来源 ready 且本 ready 世代
  // 还没重挂过，才允许承诺自动重挂（self-heal 从不触碰非 ready 来源）。
  const activeShellGap = activeShellState !== undefined && activeShellState.error === null
    ? activeShellState.degraded
    : null
  const activeBootGap = activeShellGap === null
    ? null
    : bootGapNotice(activeShellGap, {
        phase: servers.find(server => server.id === activeView)?.phase,
        retried: degradedRetriedRef.current[activeView] === true,
        // fact (local runtime management is read-only on Windows), never on the
        // producer's diagnostic sentence.
        instanceId: activeView,
      })

  // 停滞提示的可见集合（用户已忽略的来源不再提示；来源恢复即自动解除忽略）。
  // 停滞来源与「事实无法验证」来源共用同一横幅（文案 = 「无法确认会话状态」）。
  const visibleStalls = [...new Set([...stalledSources, ...unverifiedSources])]
    .filter(id => !dismissedStalls.includes(id))
  return (
    <ErrorBoundary>
      <div className="app">
        {/* 运行位活性守卫的 L3（2026-12）：L1 对账（含权威写回）与 L2 有界
            reconnect 都没能收敛时，只给用户两个选择——轻恢复（重新连接，不丢页面状态）与
            重恢复（重新加载应用页面）。绝不自动重载：与 mobile 的
            session-stall.ts 同纪律（观测者只呈现，动作由用户决定）。 */}
        {visibleStalls.length > 0 && !controlUnreachable && activeShellError === null && (
          <div className="session-stall-layer">
            <div className="session-stall">
              {/* role=status 只包**文本**：交互后代放进 live region 会在整区
                  变化时被读屏整体重播（与 boot-gap 横幅同规）。 */}
              <div className="session-stall-text" role="status">
                {t('sessionStall.text', {
                  sources: visibleStalls
                    .map(id => servers.find(server => server.id === id)?.label ?? id)
                    // 分隔符按语言（en 用 ', '，zh 用 '、'）：此前硬写 '、' 会让英文
                    // 文案里出现中文顿号（）。
                    .join(t('sessionStall.separator')),
                })}
              </div>
              <div className="session-stall-actions">
                <Button
                  variant="outline"
                  onClick={() => {
                    // 与自动臂用同一记账（返回值 + 共享账本）：否则用户点一次之后
                    // S2 臂看不到、守卫预算也没消耗，会在同一窗口再自动重连一次
                    // （每次重连都要重放全部 baseline）。
                    // 手动动作也要**有界**（2026-12 三轮复核）：连点/多按钮会各自
                    // 重放一份完整 baseline，所以沿用自动臂的 60s per-source 退避——
                    // 窗口内只记账不重连（但记账仍需发生，否则自动臂会马上补一次）。
                    const at = Date.now()
                    for (const id of visibleStalls) {
                      const lastReconnectAt = lastReconnectAtRef.current[id]
                      if (lastReconnectAt !== undefined && at - lastReconnectAt < AGGREGATE_RECONNECT_BACKOFF_MS) continue
                      if (!reconnectInstanceConnection(id)) continue
                      sessionLivenessRef.current = markSessionLivenessReconnect(
                        sessionLivenessRef.current, id, at)
                      lastReconnectAtRef.current = { ...lastReconnectAtRef.current, [id]: at }
                    }
                  }}
                >
                  {t('sessionStall.reconnect')}
                </Button>
                <Button variant="outline" onClick={() => { window.location.reload() }}>
                  {t('sessionStall.reload')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setDismissedStalls(prev => [...prev, ...visibleStalls]) }}
                >
                  {t('sessionStall.dismiss')}
                </Button>
              </div>
            </div>
          </div>
        )}
        {/* 视图始终挂载：致命屏改为覆盖层——卸载视图而不 dispose shell 会
            遗留僵尸 ctx（entries 被新 boot 覆盖、旧 ctx 永不清除，违反
            05 §4 无僵尸不变量），且恢复后要重 boot 丢会话连续性。 */}
        {mountedViews.map((viewId) => {
          const sourceFingerprint = sourceLifecyclesRef.current!.capture(viewId)?.fingerprint
          const transport = servers.find(server => server.id === viewId)?.transport
          if (sourceFingerprint === undefined || transport === undefined) return null
          /**
           * reveal gate. Read from data this view ALREADY has — the RAW runtime
           * current (never the gated projection, which the veil itself hides) and
           * the source's own aggregate, whose session rows carry the runtime's
           * `blank` flag (`InstanceAggregate.sessions`, projected by
           * projectInstanceSnapshot). No extra fetch: the mounted ctx pushes that
           * snapshot, and the unary fallback fills it for unmounted sources.
           * UNKNOWN ⇒ true on purpose: a session the aggregate does not list yet
           * (cold boot, the push has not landed) must keep the veil, which is the
           * pre-fix cold-boot behaviour. Only a KNOWN non-blank current session
           * makes this false — the warm-shell case the veil used to cover for up
           * to the whole 8s open budget.
           */
          const currentSessionId = runtimeFacts[viewId]?.current
          const blankCurrent = currentSessionId === undefined
            || (aggregates[viewId]?.sessions.find(session => session.sessionId === currentSessionId)?.blank ?? true)
          return (
            <InstanceView
              key={viewId}
              instanceId={viewId}
              basePath={instanceBasePath(viewId)}
              sourceFingerprint={sourceFingerprint}
              transport={transport}
              // W3：可见性由 **paintedView**（屏上是谁）驱动，不是选择——点击后旧视图
              // 保持可见到揭示门放行，目标壳（未 settle 时仍是 instance-pending）绝不
              // 在持有窗内提前露出。选择语义仍走 activeView（失败面/横幅/侧栏导航）。
              active={paintedView === viewId}
              label={serverLabels[viewId] ?? (viewId === LOCAL_INSTANCE_ID ? t('source.local') : viewId)}
              locale={locale}
              onSettled={handleInstanceSettled}
              onStateChange={handleShellState}
              retryToken={retryTokens[viewId]}
              waitForServing={waitForServing}
              // W1/W2/W4：遮罩的事实输入与动作（导航/回收顺序仍由 App 拥有）。
              sourcePhase={servers.find(server => server.id === viewId)?.phase}
              bootDeferred={deferredBootIds.has(viewId)}
              // App 的全局失败覆盖层是模态的：覆盖层在场时遮罩退出 DOM（否则
              // 其按钮仍可聚焦/被读屏播报，）。
              // 两种模态覆盖层都要算：boot 失败（activeShellError）与控制面不可达
              // （controlUnreachable 的 .fatal-overlay，同样不透明，）。
              failureOverlayVisible={activeShellError !== null || controlUnreachable}
              switchTargets={servers
                .filter(server => server.id !== viewId)
                .map(server => ({ id: server.id, label: server.label }))}
              onSwitchSource={targetId => switchSourceFromVeil(viewId, targetId)}
              onConnectSource={() => connectSourceFromVeil(viewId)}
              onRequestRetry={() => retryView(viewId)}
              // chamber (): the reveal gate. The
              // boot window is covered by the view's own `!settled` veil; this
              // boolean extends the hold past a clean settle for exactly as long
              // as the shell would NOT show the requested session. Every input
              // lives in the App: the shell's settled/failed mirror, the RAW
              // runtime current (never the gated projection value — the gate
              // exists to hide that very value) and that view's own blank flag
              // (blankCurrent, below).
              // Deliberately NOT "any pending open": a view that already shows
              // the requested session (idempotent re-open, or the boot-ctx
              // early-open arm having preempted the runtime's initial selection)
              // must not veil at all, and a warm visible shell that is switching
              // between two REAL sessions resolves synchronously — holding a veil
              // there would hide a working UI for no reason.
              // 2026-09-11 review S1: "shows nothing legitimate" is a REQUIRED
              // input of the shared rule (blankCurrent) — the hold is
              // `pendingIntent && !failed && !showsRequestedSession &&
              // blankCurrent`, i.e. the veil covers only a blank (cold "新会话")
              // or unknown current session, never a warm shell showing a real one.
              holdVeil={shouldHoldViewVeil({
                failed: (shellStates[viewId]?.error ?? null) !== null,
                pendingIntent: openIntents[viewId] !== undefined,
                blankCurrent,
                // `openIntents[viewId] !== undefined` is spelled out here on
                // purpose: without it, "no current AND no intent" would read as
                // "already showing the requested session" (undefined ===
                // undefined). The rule short-circuits on pendingIntent today, but
                // the comparison must not depend on that for its meaning.
                showsRequestedSession: openIntents[viewId] !== undefined
                  && shellStates[viewId]?.booted === true
                  && runtimeFacts[viewId]?.current === openIntents[viewId],
              })}
              // P3 持有窗的请求身份（二轮 review MINOR-4）：同视图 A→B 换代时窗口必须
              // 重新起算，否则新请求会继承 A 的起点（极端时窗口立即过期）。
              openIntentId={openIntents[viewId]}
            />
          )
        })}
        {/* chamber (2026-08 失败呈现修订, 05 §4)：活动视图 boot 失败 = 该视图
            的 dsh shell 从未挂载——导航（侧边栏在 shell 内）随之不可用，若不
            提供逃生通道，用户会被失败报告困在当前视图（只能整页刷新）。
            覆盖层 = 失败报告 + 重试 + 服务器切换：失败以 chamber 层呈现，
            绝不阻断切换/重试（正确性不变量：一个实体的失败不得抹除/阻断
            无关的健康实体）。仅活动视图渲染；非活动视图失败在激活时呈现。
            控制面不可达（controlUnreachable）是更高层的全局条件，渲染在其
            之上（下方 JSX 顺序在后）。 */}
        {activeBootGap !== null && !controlUnreachable && (
          <div className="boot-gap-layer">
            {/* 降级呈现（2026-12, 05 §4）：boot 成功但整个面缺席时的现场说明。
                非模态、不阻断——侧栏/会话头/composer/切换来源全部照常，命中测试
                只落在卡片本身（层 pointer-events:none）。role="status" 而非
                "alert"：本通知不夺焦点也不打断读屏，且 kind 并不能判定"暂时"
                还是"结构性"（图通道竞态与结构性缺行同 kind），用 alert 会把
                几秒的竞态当成事故播报。文案全部来自框架字典；产出方的原文只作
                诊断行（跨边界诊断文案规则，STATUS）。 */}
            <div className="boot-gap" role="status">
              <div className="boot-gap-title">{t('bootGap.title')}</div>
              <div className="boot-gap-body">{t(activeBootGap.bodyKey)}</div>
              {activeBootGap.services.length > 0 && (
                <div className="boot-gap-facts">
                  {t('bootGap.services')}: {activeBootGap.services.join(', ')}
                  {activeBootGap.injectedBy.length > 0
                    ? ` · ${t('bootGap.injectedBy')}: ${activeBootGap.injectedBy.join(', ')}`
                    : ''}
                </div>
              )}
              {activeBootGap.failedIds.length > 0 && (
                <div className="boot-gap-facts">
                  {t('bootGap.failedPlugins')}: {activeBootGap.failedIds.join(', ')}
                </div>
              )}
              <div className="boot-gap-action">
                {/* The manual half is decided by boot-gap.ts (kind + source id);
                    autoRetryArmed keeps its own honest promise. Local and remote
                    sources get DIFFERENT manual copy (FIX 6c): the local runtime
                    is a read-only projection on Windows. */}
                {t(activeBootGap.autoRetryArmed ? 'bootGap.action.autoRetry' : activeBootGap.manualKey)}
              </div>
              {activeBootGap.detail !== '' && (
                <div className="boot-gap-detail">{t('bootGap.detail')}: {activeBootGap.detail}</div>
              )}
              {activeBootGap.retryable && (
                <Button variant="outline" onClick={() => retryView(activeView)}>
                  {t('action.retry')}
                </Button>
              )}
            </div>
          </div>
        )}
        {activeShellError !== null && (
          <div className="fatal fatal-overlay">
            {/* T15 (2026-09-11 upstream-alignment): the failure report carries
                the SAME content the official report does — a title, the boot
                failure text, and the plugin ids that did not activate (the
                shell reads them off the failed boot's own loader sweep and the
                ids ride ShellState, never a new channel). The chamber cover
                itself stays (design 05 §2.2.1 gate 2 + §4: navigation lives
                inside the shell, so a failed boot needs this escape hatch). */}
            <div role="alert">
              <div className="fatal-title">{t('fatal.boot.title')}</div>
              <div className="fatal-message">{activeShellError}</div>
              {activeShellFailedEntries.length > 0 && (
                <div className="fatal-entries">
                  <div className="fatal-entries-title">{t('fatal.entries.title')}</div>
                  {activeShellFailedEntries.map(entryId => (
                    <div key={entryId} className="fatal-entry">{entryId}</div>
                  ))}
                </div>
              )}
            </div>
            <Button
              variant="primary"
              onClick={() => {
                // 重试 = 重新 boot 该视图；error/degraded 隧道同时立即再试，
                // ready 但会话/远端已死的来源立即探测一次（与 selectView
                // 同语义——boot 失败若由隧道故障或死会话引起，不重连/不探测
                // 则重试只会再次失败）。与降级提示共用唯一入口 retryView。
                retryView(activeView)
              }}
            >
              {t('action.retry')}
            </Button>
            {servers.length > 1 && (
              <div className="fatal-servers">
                <span className="muted small">{t('action.switchServer')}</span>
                {servers.map(server => (
                  server.id === activeView ? null : (
                    <Button
                      key={server.id}
                      variant="outline"
                      onClick={() => selectView(server.id)}
                    >
                      {/* 空 label 回退 id，避免出现无标签的切换按钮 */}
                      {server.label !== '' ? server.label : server.id}
                    </Button>
                  )
                ))}
              </div>
            )}
          </div>
        )}
        {controlUnreachable && (
          <div className="fatal fatal-overlay">
            {/* a11y nit of the same audit (2026-09-11 upstream-alignment): the
                fatal overlay is an alert like its boot-failure sibling — a
                screen reader must announce the control-plane loss without a
                focus move. */}
            <div role="alert">
              <div className="fatal-title">{t('fatal.controlPlane.title')}</div>
              <div className="fatal-message">{healthError}</div>
            </div>
            <Button
              variant="primary"
              onClick={() => {
                void refreshHealth()
                void refreshConnections()
              }}
            >
              {t('action.retry')}
            </Button>
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}
