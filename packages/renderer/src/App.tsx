/**
 * dsh-chamber bridge host（design 05 §1/§3）：页面唯一入口宿主。
 *
 * 首屏 = 本地实例的完整 dsh shell（纯 dsh UI，无 chamber 外壳）；多来源
 * session/workspace 导航在 dsh 原生侧边栏内由 chamber 自研插件承担
 * （05 §2）。本组件只负责数据层与 N-ctx 编排：
 * - 控制面 /health 与 /api/connections 轮询；
 * - 桌面 ssh 实例装载与状态投影订阅（隧道 URL 永不进 renderer）；
 * - 每实例 workspace/session 聚合（instance-api unary，05 §2.3）；
 * - 本地实例自动启动、注册表远程实例自动连接；
 * - N-ctx shell 挂载（local 常驻，其他来源按需挂载/空闲预热；hide/show
 *   切换经 View Transition 包装（view-transition.ts）：旧视图 visibility+
 *   `content-visibility:hidden` 即时隐去（跳过 style/layout/paint 并缓存
 *   渲染状态），切换与骨架→内容过渡由 `startViewTransition` 的静态旧视图
 *   快照遮盖 reveal 重排——无黑帧、无闪烁；见 styles.css `.instance-hidden`）。
 *   **保留策略（2026 性能整改，05 §1/§4 偏差）**：隐藏壳不再无限常驻——
 *   除 local 恒留外至多保留 RETAINED_HIDDEN_VIEWS 个，超限回收已 settle 且
 *   连续隐藏 ≥60s 的最久者（retention.ts）；回收仅拆 UI 壳（dispose shell），
 *   实例进程/连接/后台任务不受影响，重开走冷 boot；
 * - chamberBridge 投影发布（05 §3）：轮询状态合并为 ChamberServerAggregate[]
 *   供侧边栏插件消费；onOpenSession 通道驱动会话打开。
 *
 * 会话打开请求来自侧边栏插件（经 chamberBridge，05 §3）：onOpenSession
 * 通道驱动 openSession 切 shell 并分发；打开终态（成功或预算耗尽失败）经
 * reportOpenSessionOutcome 回报每个侧边栏 shell——失败落在被点击的会话
 * 行内呈现，不再是单向通道的 console-only 盲区（2026-09 修订）。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import api, { type ConnectionSummary, type HealthResponse } from './api.ts'
import {
  armOpenIntent,
  chamberBridge,
  clearOpenIntents,
  deriveArchivedSessions,
  deriveServerWorkspaces,
  emptyAggregate,
  fetchInstanceSnapshot,
  fetchManagedRuntimeState,
  forgetPendingWorkspaces,
  getInstanceClient,
  getOpenIntentsSnapshot,
  instanceSnapshotSignature,
  isInstanceUnavailable,
  managedRuntimeDown,
  managedRuntimeUnusable,
  mergeRuntimeFacts,
  projectableCurrent,
  reconcilePendingWorkspaces,
  recordPendingWorkspace,
  releaseInstanceClient,
  releaseOpenIntent,
  // 2026-09-11 review S3: the withdraw/rewrite half of the workspace echo.
  removePendingWorkspace,
  renamePendingWorkspace,
  reconcileCompletedFacts,
  runtimeReportSignature,
  serversProjectionSignature,
  shouldHoldViewVeil,
  subscribeOpenIntent,
  sweepPendingWorkspaces,
  withWorkspaceEcho,
  type ChamberServerAggregate,
  type InstanceAggregate,
  type InstanceRuntimeReport,
  type InstanceSnapshot,
  type PluginGraphDiagnostic,
  type WorkspaceEchoLedger,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import { detectNotificationEdges, dedupeCompleteEdges, type SessionFacts } from './notification-edges.ts'
import { projectBadgeCount } from './badge-count.ts'
import {
  acknowledgeRendererDelivery,
  authoritativeSourceRetirements,
  canReplayRosterIntents,
  classifyRosterGatedSource,
  deliveryMatchesCurrentSource,
  enqueueBoundedRosterIntent,
  parseAuthoritativeSourceFingerprint,
  routeDeepLinkActivation,
  SerialIntentRunner,
  SourceOwnershipRegistry,
  settlePendingDeepLinkActivation,
  subscribeRosterBeforeRefresh,
  type RendererDeliveryCoordinates,
  type SourceOwnershipToken,
} from './deep-link-activation.ts'
import { openInstanceSession, reconnectInstanceConnection, disposeAllShells, disposeInstanceShell, type ShellState } from './shell.ts'
// T15 (2026-09-11 upstream-alignment): the official Button atom (U
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
// 2026-09-11 review-fix (finding 4d): the round's notes quoted the T15-round
// figures as if they were current. Re-measured with `pnpm run build:renderer` on
// the final review-fix tree (all round fixes applied): main graph raw 1,228,157
// · chamber entry raw 1,989,208. The entry therefore sits
// 0.5% under its 2 MB warn gate, and the main graph ~9% under its 1.35 MB one
// (check-chunk-budgets.mjs) — the deep path matters at least as much as it did
// when T15 chose it. The ~87 KB barrel delta is a property of the barrel, not of
// this round's edits.
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
// T16 (2026-09-11 upstream-alignment): frame copy lives in ONE typed locale
// dictionary (locales.ts); the frame reads the document language the official
// locale service keeps in sync (see that module's header).
import {
  frameText, readDocumentLocale, subscribeDocumentLocale,
  type FrameKey, type FrameLocale,
} from './locales.ts'
import { BOOT_TIMEOUT_MS } from './boot-budget.ts'
import { planDegradedRetries } from './degraded-retry.ts'
// Settled-boot gap → render decision (design 05 §4 「降级呈现」). The pure module
// owns the copy key, the retry verdict and the "will the self-heal re-mount
// this?" rule; the frame only maps its keys through `t`.
import { bootGapNotice, toServerBootGap } from './boot-gap.ts'
import { runViewTransition } from './view-transition.ts'
import { captureSidebarScrollAnchor, restoreSidebarScroll } from './sidebar-scroll-sync.ts'
import {
  AggregateRefreshQueue,
  commitAggregateFailure,
  commitAggregatePull,
  invalidateRemovedAggregateSources,
  isFallbackDerivedView,
  isSnapshotStale,
  planAggregateRefreshes,
  planSessionListRefresh,
  refreshPullStillCurrent,
  remoteRetiredSourceIds,
  retireSelectedSource,
  shouldRebaselineFallbackView,
  shouldReconnectStaleMounted,
  shouldRequestSessionListRefresh,
  shouldRetainPushedAggregate,
  withoutRemovedSourceIds,
  withoutRemovedSourceKeys,
  reconnectStalenessMsForTransport,
  AGGREGATE_RECONNECT_HTTP_STALE_MS,
  AGGREGATE_RECONNECT_SSH_STALE_MS,
} from './aggregate-refresh.ts'
import { errorMessage } from './status.ts'
import type { SshInstanceSpec, SshStatusProjection, TransportKind } from './global.d.ts'
import {
  instanceBasePath,
  rawInstanceIdFromSourceId,
  sourceIdForInstance,
  sourceIdForRawInstance,
  sourceIdForTransport,
} from './transport-source.ts'
import {
  decideReclaimCandidates,
  shouldRunBackgroundPhase,
  VIEW_RECLAIM_TICK_MS,
} from './retention.ts'
import {
  HARVEST_ABANDON_MS,
  harvestAbandoned,
  harvestAttemptStarted,
  harvestDeadlinePassed,
  harvestParked,
  harvestParkedRecord,
  harvestPending,
  harvestRetryDue,
  harvestSatisfied,
  pickPrewarmTarget,
  prewarmCandidates,
  shouldReclaimHarvestedShell,
  type HarvestRecord,
} from './baseline-harvest.ts'
import InstanceView from './components/InstanceView.tsx'
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
/** Re-request floor for session-list refresh dispatch (design 24 §12): a
 *  refresh re-runs the OFFICIAL session.list of the mounted ctx; while ghost
 *  rows of purged sessions stay pending, requests are floored to one per
 *  coalescing window per source (the official refreshList single-flight bounds
 *  concurrency; this bounds sequential churn when the refresh keeps failing on
 *  a busy source). Suppressed dispatches never lose the ids — they stay in the
 *  per-source pending set and re-evaluate on the next push. The archive-manager
 *  dialog additionally requests one on every purge settle (immediate path,
 *  not stamped here — deliberate cross-package decoupling, §12 notes the
 *  overlap). */
const SESSION_LIST_REFRESH_COALESCE_MS = 5_000
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

const LOCAL_INSTANCE_ID = 'local'

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
 * 实例可被聚合轮询：对齐反代契约（03 §3.3）——只有 `ready` 才放行，否则
 * 显式 503。starting/degraded/connecting 期间轮询只会收获 503，故一律按
 * 未连接呈现（分组头 + 相位文本，不轮询、无错误刷屏）。
 */
function instanceConnected(
  kind: 'local' | TransportKind,
  health: HealthResponse | null,
  remoteStatus: Record<string, SshStatusProjection>,
  instanceId: string,
): boolean {
  if (kind === 'local') {
    const status = health?.dsh?.status
    return status === 'ready'
  }
  const status = remoteStatus[instanceId]
  // A registry kind switch and its IPC pushes are separate messages. Never
  // treat a briefly-stale READY projection from the old provider as proof
  // that the replacement provider is ready.
  return status?.kind === kind && status.phase === 'ready'
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
 * 轮询状态 → chamberBridge 投影（05 §3）：local + 每个注册表远程实例一条。
 * connected 只看权威状态（本地 /health dsh；远程隧道 phase）；workspaces
 * 只在对应聚合 state==='ok' 时派生（否则空数组，不显示陈旧数据）；拉取
 * 失败时把错误文本带上 aggregateError（UI 区分「拉取失败」与「无工作区」）。
 */

/** Per-source dsh version fact. D2: the LOCAL instance comes from the desktop
 *  bridge (`window.dshChamber.dshVersion`); remote instances stay absent
 *  until a remote version probe is wired (the old in-ctx host-producer
 *  channel was removed — host.describe was deleted upstream). */
type HostFacts = { dshVersion?: string }

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
  // 2026-12（05 §4「降级呈现」第二批）：降级事实要过投影给侧栏来源行与连接页，
  // 所以 shellStates 与 pluginDiagnostics 一样是 derive 的输入——只读
  // `degraded`，失败态（error）不进这条投影。
  shellStates: Record<string, ShellState | undefined>,
  managedRuntime: Record<string, string | null>,
  workspaceEcho: WorkspaceEchoLedger,
  openIntents: Readonly<Record<string, string>>,
  // T16 (2026-09-11 upstream-alignment): the local source's fallback label is
  // frame copy (the connection row may carry no label), so it comes from the
  // frame's dictionary in the locale the frame renders in.
  locale: FrameLocale,
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
    // 问题 B 修复（2026-12）：gateway 形态的 ready 只证明 gateway 进程活着
    // （desktop 的就绪探针读的就是 `/chamber/runtime/status`），托管 dsh 是
    // 独立进程。把它的 connectionState 投影进该源——phase 走侧栏既有的状态点
    // （status.stopped/error/restartExhausted 文案已存在），终态停机时
    // connected=false 让动作入口按既有语义禁用而不是"可点但背后不可用"。
    // 探针缺失/未知一律 fail open（不拿缺失的探针隐藏健康来源）。
    // **只在该源的传输确实可用时**才认这条事实：`phase` 是"托管态 ∪ 传输态"的
    // 合并值，而两套词表都含 `error`——若让消费者重新分类合并后的 phase，
    // SSH/隧道失败会被误诊为"托管 dsh 停机"（2026-12 复查 BLOCKER）。
    const runtimeState = kind === 'gateway' ? managedRuntime[id] : null
    const transportUsable = kind === 'local'
      ? transportPhase === 'ready'
      : transportPhase === 'ready' || transportPhase === 'degraded'
    const managedDown = kind === 'gateway' && transportUsable && managedRuntimeDown(runtimeState)
    // 托管态的**瞬态**（starting/restarting）同样投影进 phase：此时隧道是好的、
    // 但 dsh 还没起来，绿点会撒谎（2026-12 复查 MINOR）。degraded 保持传输态
    // （设计 17 既有语义：degraded 仍可交互）。
    const managedTransient = kind === 'gateway' && transportUsable
      && (runtimeState === 'starting' || runtimeState === 'restarting')
    const phase = managedDown || managedTransient ? runtimeState! : transportPhase
    let workspaces: ChamberServerAggregate['workspaces'] = []
    const aggregate = aggregates[id]
    // 托管态瞬态（starting/restarting）同样不可用：dsh 还没服务，动作入口只会
    // 503（与终态停机同一理由，2026-12 复查 MINOR）。phase 已携带忙碌点。
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
      // 来源投影（06 §4.3 全局单选纪律）——否则每个已挂载来源都会冒出它的
      // 空"新建会话"行。其他来源 blank 行照旧不进入导航列表。
      //
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
      //
      // chamber (2026-12, design 05 §2.2 revision): the workspace-creation echo
      // rides the SAME projection pass — one choke point for every workspace
      // row (derived or echoed), so the echo needs no second copy inside the
      // aggregate. `withWorkspaceEcho` is identity-preserving for an absent or
      // empty ledger, leaving this derive byte-identical to before.
      workspaces = deriveServerWorkspaces(
        withWorkspaceEcho(aggregate, workspaceEcho[id]),
        id,
        '',
        current,
      )
      // Archive-manager metadata (design 24 revision 2026-09): archived rows
      // of this source's snapshot ride the same aggregate; the manager UI
      // never issues its own session read. archiveSetKnown is the provenance
      // tri-state: the mounted baseline reports an authoritative set (even
      // when empty); the unary-fallback view reports NOT known — consumers
      // must never read its set as "no archived sessions" (it may be empty OR
      // the remembered authoritative set, §12 F3(b)).
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
    // 运行时事实只在 connected 时附加（断连态不应携带事实，避免死状态翻转）。
    // App 自持的完成未读点（completedBySource）与通道上报并集：蓝点以 App
    // 派生的 running→idle 边沿为准（它无视后台来源 shell 的陈旧 selected），
    // vendor 的 completed 作兜底保留。合并为纯函数 mergeRuntimeFacts（shared/
    // derive.ts，单测覆盖）。
    if (connected) {
      const dshVersion = hostFacts[id]?.dshVersion
      if (dshVersion !== undefined) entry.dshVersion = dshVersion
      const merged = mergeRuntimeFacts(runtimeFacts[id], completedBySource[id])
      if (merged !== undefined) entry.runtime = merged
    }
    if (aggregate !== undefined && aggregate.state === 'error') {
      // 2026-09-11 review-fix (finding 4b): this fallback is frame-owned copy —
      // it is rendered verbatim by the sidebar's source alert and the archive
      // dialog (ServerSection.tsx role="alert", ArchiveManagerDialog.tsx), i.e.
      // it crosses the frame→plugin boundary as a finished string, so it must
      // come from the frame dictionary in the frame's locale like every other
      // audited string (the previous round's audit missed it).
      entry.aggregateError = aggregate.error ?? frameText(locale, 'error.unknown')
    }
    if (pluginDiagnostics[id] !== undefined) entry.pluginDiagnostic = pluginDiagnostics[id]
    // Settled-boot gap（2026-12）：结构化事实过桥，渲染方（侧栏来源行 / 连接页）
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
    // 用新 entry 覆盖未销毁的旧 ctx（僵尸 ctx，05 §4 无僵尸不变量）。
    disposeAllShells()
  }

  render(): React.ReactNode {
    if (this.state.error) {
      // T16 (2026-09-11 upstream-alignment): frame copy rides the typed locale
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

export default function App() {
  // T16 (2026-09-11 upstream-alignment): the frame owns no `t` seat, so it
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
  // 视图：'local' | '<kind>-<id>'。N-ctx 常驻语义（05 §1/§4）自 2026 性能
  // 整改起收窄为保留策略（retention.ts）：local 恒留；隐藏非 local 壳最多
  // 保留 RETAINED_HIDDEN_VIEWS 个，超限回收"已 settle + 连续隐藏 ≥60s"的
  // 最久者（回收 = dispose shell + 卸载壳；实例进程/连接/后台任务不受影响，
  // 重开走冷 boot + entry 重放——见 reclaimView）。会话保活由实例侧承担，
  // UI 壳不再无限常驻。
  const [activeView, setActiveView] = useState<string>(LOCAL_INSTANCE_ID)
  const [mountedViews, setMountedViews] = useState<string[]>([LOCAL_INSTANCE_ID])
  // Views mounted only by background prewarm. User selection removes the id
  // from this set, freeing one of the idle-prewarm slots while keeping
  // the user-opened N-ctx shell resident.
  const autoPrewarmedRef = useRef<Set<string>>(new Set())
  // 保留策略：被回收（闲置隐藏壳超限回收）的源禁止自动预热，直到用户主动
  // 点开（selectView 清除）或来源从注册表删除（retireSources 清除）——否则
  // prewarmEligible 会立刻把刚回收的源重新 boot，回收空转（见 reclaimView）。
  const prewarmSuppressedRef = useRef<Set<string>>(new Set())
  // 设置面板目标来源（design 05 §5，2026-12 完整桥接修订）：面板渲染的是**选中
  // 来源自己的 boot ctx 台账**，所以该来源的壳必须挂载着。面板打开期间由 App
  // 保证两件事——未挂载则后台挂载（不切 active view），已挂载则排除出保留策略
  // 回收候选（否则隐藏 60s 后壳被拆，面板正在编辑的设置面随之消失）。面板关闭
  // (`undefined`) 即撤除这两条保证。
  const settingsTargetRef = useRef<string | undefined>(undefined)
  // 首屏基线收割（design 05 §2.3 / baseline-harvest.ts）：ready 但从未挂载过的
  // 来源在后台预热槽里挂一次，拿到首个权威推送即回收——否则它稳态停留在
  // unary 兜底视图（合成分组 + 空归档集）直到用户点击。harvestStateRef 是
  // 每源账本（尝试次数/退避/是否已满足），harvestIntentRef 记录"当前这次挂载
  // 是收割挂载"（提交推送、boot 失败、用户点开三条路径据此分流）。
  const harvestStateRef = useRef<Record<string, HarvestRecord>>({})
  const harvestIntentRef = useRef<Set<string>>(new Set())
  // 仍需收割的来源（prewarmEligible 的渲染期镜像）：提交推送时据此决定"保留
  // 最后收割的壳当温壳"还是"回收让位给下一个候选"。
  const harvestCandidatesRef = useRef<Set<string>>(new Set())
  // reclaimView 的 ref 镜像：定义在下方（依赖 mountedViews），而
  // handleShellState / onInstanceSnapshot 是 [] 依赖的回调——它们只能经此
  // 拿到最新闭包（同 reclaimHiddenViewsRef 纪律）。
  const reclaimViewRef = useRef<(id: string, reason?: 'retention' | 'harvest') => void>(() => undefined)
  // 保留策略计时：每视图"连续隐藏"起点（ms epoch；活动视图无键）。settle
  // 完成或切走时置 now，重新选中删除，随 mountedViews 收敛清理（回收 effect
  // 内统一处理）。previousActiveViewRef 供 activeView 落地 effect 对比。
  const hiddenSinceRef = useRef<Record<string, number>>({})
  const previousActiveViewRef = useRef<string | null>(activeView)
  // chamber (2026-08 失败呈现修订, 05 §4)：每视图 shell 终态（InstanceView
  // 经 onStateChange 上报）——活动视图 boot 失败时由 App 渲染统一失败覆盖层
  // （失败报告 + 重试 + 服务器切换）。retryTokens 驱动 InstanceView 的重试
  // 重 boot（令牌递增 → 视图复位 → 重新启动 shell）。
  const [shellStates, setShellStates] = useState<Record<string, ShellState>>({})
  /**
   * 来源就绪门 + 降级自愈（2026-09-10，sidebarRight 彻底修复）：
   * ① 实例仍启动时让取图等它就绪（冷启动 / 重启跨越窗口不再丢掉整套 profile
   *    客户端插件；`ui-chat` 依赖的 `sidebarRight` 只由其中的 ui-sidebar-right
   *    行提供）；
   * ② boot 以降级收尾（无图 / 必需 extra-row 服务缺席）而来源随后 ready 时，
   *    自动重挂一次——此前只有整页 reload 能恢复。每个 ready 世代一次。
   * 相位从 servers 的渲染期镜像读取，门自身带绝对上限，来源被移除即放弃。
   */
  const serversPhaseRef = useRef<Record<string, string>>({})
  const waitForServing = useCallback((instanceId: string): Promise<boolean> => {
    const deadline = Date.now() + SERVING_WAIT_MS
    return new Promise<boolean>((resolve) => {
      const check = (): void => {
        const phase = serversPhaseRef.current[instanceId]
        if (phase === undefined) { resolve(false); return }
        if (phase === 'ready') { resolve(true); return }
        if (Date.now() >= deadline) { resolve(false); return }
        setTimeout(check, SERVING_POLL_MS)
      }
      check()
    })
  }, [])
  const degradedRetriedRef = useRef<Record<string, boolean>>({})
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
  // Last connection-reconnect timestamp per source (S2, ms epoch; absent =
  // never reconnected). The staleness watchdog records it so
  // shouldReconnectStaleMounted can bound repeat reconnects of one stale
  // mounted source (AGGREGATE_RECONNECT_BACKOFF_MS). Reaped with the source
  // like snapshotAtRef (a same-id re-add must start a fresh backoff window).
  const lastReconnectAtRef = useRef<Record<string, number>>({})
  // Last session-list refresh request timestamp per source (design 24 §12,
  // ms epoch; absent = never requested). Floors the re-request cadence of the
  // ghost-row convergence machine below (SESSION_LIST_REFRESH_COALESCE_MS): a
  // refresh re-runs the OFFICIAL session.list of the mounted ctx, and a
  // failing refresh on a busy source must not stack RPCs per push. Reaped with
  // the source like lastReconnectAtRef (same-id re-add starts a fresh window).
  const sessionListRefreshAtRef = useRef<Record<string, number>>({})
  // Un-converged ghost-row ids per source (design 24 §12): archived ids removed
  // by a purge whose rows are STILL listed in the latest mounted push of this
  // source (rows linger in the official client summaries until a session-list
  // refresh drops them). Maintained by planSessionListRefresh on every push;
  // empty/absent = converged (rows gone or never listed). Reaped with the
  // source like the stamp map above (same-id re-add starts clean).
  const sessionListRefreshPendingRef = useRef<Record<string, string[]>>({})
  // Last AUTHORITATIVE archive set per source (design 24 §12 F3):
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
  // 工作区创建回声（2026-12，design 05 §2.2 修订）：侧栏在某来源上用 unary
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
  // 会话打开意图（2026-12，design 05 §2.2 修订；真机问题 1）：App 是唯一写者
  // （openSession 的 arm/release），槽位本身在 sidebar 包的 shared/open-intent.ts
  // ——它是跨 ctx 单例，因为 boot 期早开臂要在**目标实例自己的 ctx 内**读它。
  // 这里经 useSyncExternalStore 绑定：快照在无变化时保持同一引用，一次 arm /
  // 一次 release 各触发一次重渲染，投影门与揭示门同时生效。
  const openIntents = useSyncExternalStore(subscribeOpenIntent, getOpenIntentsSnapshot)
  // 每实例运行时事实（06 §4）：来自各来源 ctx 的 chamberBridge 上报，仅附加
  const [runtimeFacts, setRuntimeFacts] = useState<Record<string, InstanceRuntimeReport | undefined>>({})
  const [hostFacts, setHostFacts] = useState<Record<string, HostFacts | undefined>>({})
  // 问题 B（2026-12）：gateway 来源的托管 dsh connectionState（探针见下方
  // managed-runtime.ts）。null = 探不到（fail open），键随来源生命周期收敛。
  const [managedRuntime, setManagedRuntime] = useState<Record<string, string | null>>({})
  // chamber (06 §4.1, 2026-08)：App 自持的「完成未读」蓝点（completedBySource）
  // 与边沿记忆（prevRunningRef）。蓝点不依赖各来源 shell 的 selected——后台
  // 来源的陈旧 selected 会让 vendor 提醒错误压制「完成但未读」——而是由 App
  // 从上报里的实时 running 位自行推导 running→idle 边沿，以 App 已知的
  // 「谁在阅读」（activeView + 各来源 current）判定武装/解除。插件侧保持
  // 无状态（纯投影），避免在每 ctx 复制一套状态机。
  const [completedBySource, setCompletedBySource] = useState<Record<string, Record<string, boolean>>>({})
  const prevRunningRef = useRef<Record<string, Record<string, boolean>>>({})
  // 通知边沿记忆（设计 19 §3.2）：每来源每会话的上一份事实快照，供
  // detectNotificationEdges 判定 running→idle / pending 武装边沿。与
  // prevRunningRef（蓝点机）并存互不耦合：蓝点带「正在阅读」解除，通知边沿
  // 不受解除影响——窗口隐藏到托盘时活动来源的当前会话完成也必须通知
  // （requireHidden 豁免在主进程裁决）。随来源生命周期收敛（onRuntimeReport
  // 的 clear 分支 delete，与 prevRunningRef 同纪律）。
  const prevRuntimeFactsRef = useRef<Record<string, Record<string, SessionFacts>>>({})
  // 通知 complete 去重记忆（设计 19 §3.2，dedupeCompleteEdges）：每来源已发
  // complete 的会话集合——正被查看的会话完成先走 running 边沿，切走后 vendor
  // 延迟武装 completed 的重复边沿在此丢弃；会话重新 running 时清除。
  const notifiedCompleteRef = useRef<Record<string, Set<string>>>({})

  // chamberBridge 投影（05 §3）：health/remoteStatus/aggregates 任一变化后
  // 派生并发布；首帧（health 未就绪）即发布 connected=false 的分组。
  const servers = useMemo(
    () => deriveServers(health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, completedBySource, activeView, pluginDiagnostics, shellStates, managedRuntime, workspaceEcho, openIntents, locale),
    [health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, completedBySource, activeView, pluginDiagnostics, shellStates, managedRuntime, workspaceEcho, openIntents, locale],
  )
  // chamberBridge publish 签名闸（2026-08 perf pass）：servers 在每次依赖变化
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

  // 相位镜像（waitForServing 读它；effect 里写，避免渲染期改 ref）。
  useEffect(() => {
    serversPhaseRef.current = Object.fromEntries(servers.map(server => [server.id, server.phase]))
  }, [servers])

  // 降级自愈：boot 以降级收尾（无客户端插件图 / 必需 extra-row 服务缺席）而来源
  // 随后 ready 时，自动重挂一次——此前只有整页 reload 能恢复（2026-09-10，
  // sidebarRight 彻底修复）。每个 ready 世代一次。
  useEffect(() => {
    const phases = Object.fromEntries(servers.map(server => [server.id, server.phase]))
    const plan = planDegradedRetries({
      // 只把「settled 且带缺口」的挂载送进计划，并**带上 kind**：可重试性由
      // 事实自己的裁决表决定（boot-gap.ts），而不是由这里的调用方猜。
      degraded: Object.entries(shellStates).flatMap(([instanceId, state]) =>
        state.degraded === null ? [] : [{ instanceId, kind: state.degraded.kind }]),
      phaseOf: (instanceId) => phases[instanceId],
      retried: degradedRetriedRef.current,
    })
    degradedRetriedRef.current = plan.retried
    if (plan.retry.length === 0) return
    console.warn(`[app] degraded shell(s) re-booting after the source became ready: ${plan.retry.join(', ')}`)
    setRetryTokens(prev => {
      const next = { ...prev }
      for (const instanceId of plan.retry) next[instanceId] = (next[instanceId] ?? 0) + 1
      return next
    })
  }, [servers, shellStates])

  // 问题 B（2026-12）：gateway 来源的托管 dsh 状态探针。desktop 的 ready 只
  // 证明 gateway 进程活着，托管 dsh 是独立进程——不消费 connectionState 时，
  // 停机窗口里的来源"可点但背后不可用"（`+` 建会话必失败、状态显示缺失）。
  // 探针只跑 gateway 来源、仅前台、15s 一轮；探不到（非 200/代理失败/未挂载
  // 隧道）一律 null = fail open（见 managed-runtime.ts 头注）。
  // 探针函数另存 ref：前台恢复补偿要在 drain 之前先刷新一轮，否则窗口隐藏
  // 期间（探针被跳过）首次 drain 可能把一个托管 dsh 已停机的源拿去收割/预热
  // （2026-12 复查 MINOR-1）。
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
      // 停机的 gateway 源拿去收割（白烧一次尝试；2026-12 复查 NIT）。
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
  // 已回收来源（视图生命周期 = 注册表条目生命周期，05 §4）。This is not a render
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
  const pendingViewRef = useRef<string | null>(null)

  /**
   * N-ctx 视图回收（设计 05 §4）：视图生命周期 = 注册表条目生命周期。
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
    setAggregates(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    setRuntimeFacts(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    setSnapshotSources(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    for (const id of Object.keys(snapshotSourcesRef.current)) {
      if (!servers.some(server => server.id === id)) {
        delete snapshotSourcesRef.current[id]
        // Keep recency in lockstep: a same-id re-add must start as
        // never-pushed (first-boot window falls back) rather than inheriting
        // the removed source's last-push timestamp.
        delete snapshotAtRef.current[id]
      }
    }
    // S2: last-reconnect recency is source-scoped too — a same-id re-add must
    // start a fresh reconnect-backoff window (mirrors the snapshotAtRef
    // lockstep above; the reconnect only ever ran for mounted sources).
    for (const id of Object.keys(lastReconnectAtRef.current)) {
      if (!servers.some(server => server.id === id)) {
        delete lastReconnectAtRef.current[id]
      }
    }
    // Same lockstep for the session-list-refresh coalescing stamps and the
    // ghost-row convergence state (design 24 §12): a same-id re-add must start
    // a fresh request window and a fresh pending set.
    for (const id of Object.keys(sessionListRefreshAtRef.current)) {
      if (!servers.some(server => server.id === id)) {
        delete sessionListRefreshAtRef.current[id]
      }
    }
    for (const id of Object.keys(sessionListRefreshPendingRef.current)) {
      if (!servers.some(server => server.id === id)) {
        delete sessionListRefreshPendingRef.current[id]
      }
    }
    for (const id of Object.keys(authoritativeArchiveSetRef.current)) {
      if (!servers.some(server => server.id === id)) {
        delete authoritativeArchiveSetRef.current[id]
      }
    }
    setPluginDiagnostics(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    setCompletedBySource(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!servers.some(server => server.id === id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    // prevRunning 是 ref：同步裁剪，随注册表收敛（重加同名 id 由刷新重建）。
    for (const id of Object.keys(prevRunningRef.current)) {
      if (!servers.some(server => server.id === id)) delete prevRunningRef.current[id]
    }
    // 通知边沿记忆同款收敛（设计 19 §3.2）：与 prevRunningRef 对称，
    // 随注册表收敛，重加同名 id 由刷新重建。
    for (const id of Object.keys(prevRuntimeFactsRef.current)) {
      if (!servers.some(server => server.id === id)) delete prevRuntimeFactsRef.current[id]
    }
    for (const id of Object.keys(notifiedCompleteRef.current)) {
      if (!servers.some(server => server.id === id)) delete notifiedCompleteRef.current[id]
    }
    setRemoteStatus(prev => {
      // remoteStatus 按原始注册表 id 键控（deriveServers 的 statusKey），
      // 与 servers 的 <kind>-<id> 不同——按 kind 前缀还原再比较。
      const liveRaw = new Set<string>()
      for (const server of servers) {
        const rawId = server.kind === 'local' ? 'local' : rawInstanceIdFromSourceId(server.id)
        if (rawId !== null) liveRaw.add(rawId)
      }
      const next = { ...prev }
      let changed = false
      for (const id of Object.keys(next)) {
        if (!liveRaw.has(id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
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
      delete notifiedCompleteRef.current[sourceId]
    }
    // 工作区创建回声账本随来源生命周期收敛（同纪律：同 id 重新注册 = 新来源代，
    // 上一代的回声不得在新代里残留成幽灵工作区行）。
    updateWorkspaceEcho(forgetPendingWorkspaces(workspaceEchoRef.current, retired))
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
    prewarmQueueRef.current = withoutRemovedSourceIds(prewarmQueueRef.current, retired)
    prewarmEligibleRef.current = new Set(
      [...prewarmEligibleRef.current].filter(sourceId => !retired.has(sourceId)),
    )
    if (prewarmInflightRef.current !== null && retired.has(prewarmInflightRef.current)) {
      prewarmInflightRef.current = null
      prewarmInflightAtRef.current = 0
    }

    // Queue every React owner deletion before any roster render. A replacement
    // id only returns through a fresh view mount/producer generation.
    setMountedViews(prev => withoutRemovedSourceIds(prev, retired))
    setActiveView(prev => retireSelectedSource(prev, retired, LOCAL_INSTANCE_ID))
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
      for (const { sourceId, fingerprint } of acceptedInstances) {
        sourceLifecyclesRef.current!.activate(sourceId, fingerprint)
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
      // 工作区回声的 TTL 也挂在这条 unary 兜底链上（2026-12）：未挂载来源没有
      // 挂载 push 可依，30s 兜底拉取是它唯一的周期时钟——否则一条永远不会被
      // 权威列表覆盖的回声（例如工作区已在别处被删除）会一直留在投影里。
      sweepWorkspaceEcho()
      // identity-preserving：快照内容未变（兜底/手动刷新常态）则复用旧 state 对象
      // ——避免恒新对象驱动 servers 重新派生并触发 publish 签名闸后面的全量
      // 侧边栏重渲染（2026-08 perf pass）。错误分支保持无条件覆盖（error 文本
      // 是权威失败事实，不能因"看起来没变"而吞掉）。
      // 2026-09 beta 回归修复：已推送过的 mounted 源由 commitAggregatePull 保留
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
    } catch (err) {
      if (!stillOwnsSource()) return
      // A push/newer pull supersedes an error fact. Mutation success may cross
      // an interim push, but a stale failure must never replace that healthy push.
      if ((aggregatePollSeqRef.current[instanceId] ?? 0) !== startedPollSeq) {
        scheduleRetry()
        return
      }
      if (!stillCurrent()) return
      // 2026-09 beta 回归修复：已推送过的 mounted 源保留其最后聚合——unary 探针
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
        return
      }
      setAggregates(prev => ({ ...prev, [instanceId]: failureAggregate }))
      // 反代 503 = 权威"未就绪"信号（03 §3.3）：本地 /health 可能还停留在
      // 旧 ready（最多一个健康轮询周期的陈旧窗口），立即刷新使连接判定
      // 尽快翻转（否则错误行要挂到下一个健康轮询才被 not-connected 替换）。
      if (isInstanceUnavailable(err)) void refreshHealth()
      // 首屏加速：一次瞬时失败不等到 30s 兜底轮询——限次快速重试（工作区
      // 单元冷启动期间快照获取可能短暂 503/超时；git 快照先到会让未注册块
      // 抢在工作区列表前渲染，2026-08 用户反馈；0.1.2 起快照派生自
      // session/list cwd 事实，workspace.list 已删）。
      scheduleRetry()
    }
  }, [clearAggregateRetry, refreshHealth, sweepWorkspaceEcho])

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
   *  挂载来源除外（保留其最后推送视图，2026-09 归档回流修复，见下方注释）。 */
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
            // 2026-09 归档回流修复：断连不清除「已推送过」的来源聚合——行渲染
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
      // 断连即清该来源的运行时事实（06 §4.2：generation 级事实随断连失效）
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
    // Per-source transport decides the threshold (2026-09 extension): http
    // keeps the 120s tight-heal cadence (no upstream heartbeat), ssh gets the
    // 5min last-resort cadence (three independent tunnel detectors already
    // cover transport-level death; this arm only heals an app-level freeze),
    // and local/unknown sources are skipped entirely.
    const transportBySourceId = new Map(
      remoteInstances.map(instance => [sourceIdForInstance(instance), instance.transport]),
    )
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
      }
    }
    // Fallback-view heal (sidebar-hidden merge, 2026-09 archived-resurfacing
    // fix — see shouldRebaselineFallbackView): a MOUNTED source whose
    // aggregate is stuck on the unary-fallback view (synthetic cwd groups +
    // no archive set — archived sessions resurface as openable rows and
    // clicks on them dead-end into the official no-session view) gets a
    // bounded ctx reconnect so the workspace follow replays and the producer
    // re-publishes its real baseline WITH the archive set (store withdrawal
    // clears the producer's signature dedupe). Transport-agnostic: the stuck
    // view most commonly follows a ready-edge full commit whose ctx stores
    // stayed silent (retention — shouldRetainPushedAggregate — prevents NEW
    // stuck views; this arm heals residual/pre-existing ones, e.g. aggregates
    // degraded before that fix). The S2 direct-http arm above targets stale
    // PUSH CHANNELS; this arm targets the degraded VIEW itself. Same backoff
    // + record-on-invocation discipline as the S2 arm. Runs inside the same
    // watchdog callback, so the 2026 性能整改 visibility gating applies:
    // hidden windows skip it, the hidden→visible compensation tick converges
    // it once on restore.
    // LOCAL 刻意排除（与 S2 臂同纪律）：本地聚合由权威数据直供、不经推送
    // 通道，不存在「卡在降级合成视图」的推送类成因——重连本地 ctx 无此
    // 自愈目标。
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
      }
    }
  }, [health, remoteStatus, remoteInstances, runBoundedAggregateWave])
  const runStalenessWatchdogRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    runStalenessWatchdogRef.current = runStalenessWatchdogNow
  })

  // Staleness watchdog cadence + 文档可见性门控（2026 性能整改）：窗口隐藏
  // （Electron 最小化/隐藏到托盘）期跳过周期 unary 拉取与 S2 reconnect 臂——
  // 用户不可见期不维持 30s 轮询/重连链（含"已回收但仍 ready 的源"的兜底拉
  // 取：隐藏期暂停、恢复可见立即补偿一轮，见 visibility effect；窗口可见时
  // 该兜底照常维持 30s 周期——回收源的任务完成检测依赖它，05 §2.3 语义不
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
  // 空闲预热队列与保留回收检查。三个目标都是 ref 镜像的最新闭包。
  useEffect(() => {
    let compensationTimer: number | undefined
    let disposed = false
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      runStalenessWatchdogRef.current()
      // 托管 dsh 状态**先刷新完再** drain：隐藏期探针被跳过，若并行 drain 会
      // 读到期前的 managedRuntime 投影，把一个已停机的 gateway 源拿去收割/预热
      // （白烧一次尝试；复查 MINOR-2）。
      // 探针 promise 在微任务里 resolve，而 React 要到下一个宏任务才提交
      // setManagedRuntime——直接 drain 会读到探针前的投影（2026-12 复查
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

    // Local status push channel (设计 05 §3): the control plane streams every
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
    const connectionsTimer = setInterval(() => {
      if (cancelled) return
      void refreshConnections()
    }, CONNECTIONS_POLL_MS)

    // 注册表低频轮询（与连接行同节奏）：兜底桌面侧任何来源的注册表变化
    // （主进程 save/delete 的 instances_changed 推送之外；隧道状态本身走 onStatusChanged
    // 推送，不依赖此轮询）。
    const remotesTimer = setInterval(() => {
      if (cancelled) return
      if (!rosterListenerReadyRef.current) return
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
   * 桌面桥订阅（05 §7.4）：preload 经异步 dsh-chamber:info 往返后才暴露
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
    // 通知点击打开（design 19 §3.3）：主进程推送 notification-open →
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
    retireSources,
  ])

  /**
   * 本地实例幂等启动（05 §3）：首轮连接行装载后（null = 尚未拉到）行缺失/
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
   * 注册表远程实例自动连接（05 §3）：只对**本渲染会话首次见到的**实例 id
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
   * 用户意图即时重连（2026-08）：点击/打开一个远程来源 = 「现在就想要这个
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
   * 重试一个视图（05 §4）：升格为唯一入口，失败覆盖层与降级提示共用同一套
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

  /** 视图切换（设计 05 §4）：经 View Transition 包装（view-transition.ts）——
   * 旧视图静态快照保持到新视图渲染就绪，随后短 crossfade；reveal 重排期间
   * 无黑帧；prefers-reduced-motion/不支持时降级即时切换。未就绪目标视图
   * 由 InstanceView 的骨架屏呈现加载中间态。
   *
   * 注册表守卫（05 §4：视图生命周期 = 注册表条目生命周期）：来源已被删除
   * 时不挂载/不切换（点击时与过渡 apply 时各查一次——apply 时可能已迟到，
   * 如过渡在途期间注册表删除）。绝不把已回收的视图重新挂成僵尸：一次完整
   * boot 很贵，且回收 effect 的回滚会造成一闪而过的幽灵骨架屏。local 常驻。
   */
  const selectView = useCallback((viewId: string) => {
    // 用户点击 = 意图使用该来源：ready 但会话/远端已死的来源立即探测一次
    //（heartbeat 的即时加速；fire-and-forget，见 probeRemoteReady）。
    probeRemoteReady(viewId)
    // 用户点击 = 意图使用该来源：error/degraded 隧道立即再试（慢速重探的
    // 即时加速；idle 手动断开不触碰——见 ensureRemoteConnected）。
    ensureRemoteConnected(viewId)
    if (viewId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(viewId)) return
    autoPrewarmedRef.current.delete(viewId)
    // 用户主动点开 = 意图使用：解除"回收后不自动预热"抑制（此后闲置仍会被
    // 再次回收并再次抑制）。
    prewarmSuppressedRef.current.delete(viewId)
    // 收割中被点开 = 采用为用户视图：撤销收割意图（绝不回收用户正在看的壳），
    // 账本记为已满足——这次挂载的首个推送（或用户自己的 boot）即权威基线。
    if (harvestIntentRef.current.delete(viewId)) {
      harvestStateRef.current[viewId] = harvestSatisfied(harvestStateRef.current[viewId])
    }
    // 镜像查重（非闭包）：在途/顺延中的同一意图直接跳过；已落地视图只有在
    // 无在途意图时才跳过——过渡在途时 UI 仍显示旧视图，点击旧视图 = 撤销
    // 意图（最后一次意图胜出，view-transition.ts），不能按当前态误丢。
    // 被回收来源在 apply 时被守卫否决后 pendingViewRef 已清空，重加后的点击
    // 不被残留意图误吞。
    if (viewId === pendingViewRef.current) return
    if (pendingViewRef.current === null && viewId === activeViewRef.current) return
    // chamber (2026-08 scroll sync): anchor the outgoing shell's sidebar
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
    // 键 'view'：与 settle 流隔离；同键突发意图在 view-transition 层单槽合并
    // （perf T2）——被取代意图不进快照/动画，末意图胜出语义不变。
    runViewTransition(() => {
      // A roster-removal retirement or a newer click clears/replaces this
      // intent while a View Transition callback is deferred. Membership alone
      // is insufficient: a rapid same-id re-add is live again but belongs to a
      // new source generation, so the old callback must not activate it.
      if (pendingViewRef.current !== viewId) return
      if (viewId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(viewId)) {
        // 过渡在途期间来源被删除：放弃本次切换并清掉意图（绝不把已回收的
        // 视图重新挂成僵尸：一次完整 boot 很贵，且回收 effect 的回滚会造成
        // 一闪而过的幽灵骨架屏。local 常驻）。
        if (pendingViewRef.current === viewId) pendingViewRef.current = null
        return
      }
      // 仅当本次意图仍是最新时清掉 pending——更晚的意图（已入过渡链）继续
      // 占用槽位，其 apply 时再清。
      if (pendingViewRef.current === viewId) pendingViewRef.current = null
      setActiveView(viewId)
      // 保留策略：被回收（不在 mountedViews）的 live 来源在此重新挂载——
      // 冷 boot + entry 重放（shell.ts 同 id 串行 barrier 保证与回收的异步
      // teardown 不交错）；本视图的 hiddenSince 由 activeView 落地 effect 清除。
      setMountedViews(prev => (prev.includes(viewId) ? prev : [...prev, viewId]))
      if (scrollAnchor !== null) restoreSidebarScroll(viewId, scrollAnchor)
    }, 'view')
  }, [ensureRemoteConnected, probeRemoteReady])

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
    selectView,
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

  // 通知事件组装镜像（设计 19 §3.3）：onRuntimeReport effect（依赖 []）经
  // ref 读取最新 aggregates/serverLabels——effect 闭包拿不到 state/useMemo，
  // 渲染期镜像纪律同 remoteStatusRef（与 commit 同步，微任务/事件回调安全）。
  const aggregatesRef = useRef(aggregates)
  aggregatesRef.current = aggregates
  const serverLabelsRef = useRef(serverLabels)
  serverLabelsRef.current = serverLabels

  /**
   * 空闲预热（设计 05 §4）：ready 的注册表远程实例按序、一次一个地在后台
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
  // （用户点开/深链挂载的壳同样可能挂死；2026-12 复查 MAJOR）。
  const viewBootStartedAtRef = useRef<Record<string, number>>({})

  /**
   * 渲染期镜像（与 commit 同步，微任务安全）：settle 微任务可能先于 effect
   * flush 到达（如注册表删除后的回收 effect 尚未运行），drain 时必须用它
   * 过滤已失效的队列项——绝不把已删除/已挂载的实例重新挂成僵尸视图。
   * 排除 mounted：用户已点开（或已被别处挂载）的视图不再占用预热槽位。
   */
  const prewarmEligibleRef = useRef<Set<string>>(new Set())
  const prewarmEligible = useMemo(() => {
    const liveRemoteIds = new Set(remoteInstances.map(sourceIdForInstance))
    for (const id of autoPrewarmedRef.current) {
      if (!liveRemoteIds.has(id)) autoPrewarmedRef.current.delete(id)
    }
    // 保留槽位占用门（2026 评审 Major-1 修复）：保留槽（RETAINED_HIDDEN_VIEWS
    // = 1）被「非自动预热」的隐藏非 local 壳占用（用户切走的温壳；含正在
    // 打开、尚未 settle 的用户壳——保守视为占用）时，不再启动投机预热。
    // 否则预热壳 settle 的 hiddenSince 恒晚于用户壳的切走时间，超限回收按
    // hiddenSince 排序会把用户的温壳先回收、从未请求的预热壳占据槽位，且
    // 被回收源进入预热抑制（reclaimView）——双倍保冷，违背 retention.ts
    // 头注「最近访问的 1 个」契约（触发形态：睡眠唤醒/实例增删等 idle 边
    // 缘 + 3+ 源；登记见 design 05 §1 注记与 STATUS 性能第二阶段条）。
    // 用户主动点开时 selectView 同步摘除 autoPrewarmed 标记，此门随之为
    // 该壳让位；同窗候选内的回收偏好（预热壳先走）见 decideReclaimCandidates
    // 的 prewarmOriginIds 排序。
    const retentionSlotOccupied = mountedViews.some(id =>
      id !== LOCAL_INSTANCE_ID
      && id !== activeView
      && !autoPrewarmedRef.current.has(id)
      // 已失败的用户壳（error !== null）不算占用：它既不会被回收（隐藏 1 壳
      // 时 excess=0）也不是预热壳，若算占用则 remaining 恒 0、收割链整场停摆
      // （2026-12 复查 MINOR-2：用户点开一个停机 gateway → boot 失败 → 切回）。
      && shellStates[id]?.error == null)
    // 只统计"仍挂载且未失败"的预热壳：一个 boot 失败的预热壳会一直挂在
    // autoPrewarmedRef 里且不会被回收（无收割意图、excess=0），若计进占用则
    // warmRemaining 恒 0（2026-12 复查 MINOR-3）。
    const liveAutoPrewarmed = mountedViews.filter(id =>
      autoPrewarmedRef.current.has(id) && shellStates[id]?.error == null).length
    const warmRemaining = retentionSlotOccupied
      ? 0
      : Math.max(0, MAX_PREWARMED_REMOTE_VIEWS - liveAutoPrewarmed)
    const readyUnmountedIds = remoteInstances
      // `phase === 'ready'` 之外再过一道 instanceConnected：remoteStatus 以 raw id
      // 为键，kind 切换（ssh↔http）后可能残留旧 READY 投影，status.kind 不匹配时
      // instanceConnected 会拒绝——否则会给其实未就绪的源白烧一次尝试
      // （2026-12 复查 NIT）。
      .filter(instance => remoteStatus[instance.id]?.phase === 'ready'
        && instanceConnected(instance.kind, health, remoteStatus, instance.id))
      // 托管 dsh 终态停机的 gateway 源不预热/不收割：壳 boot 必然失败（网关
      // 侧 503），只会白烧尝试次数并占用唯一后台槽（问题 B 的投影事实在此
      // 直接作为门控输入；用户启动托管 dsh 后本门随 15s 探针自动放开）。
      .filter(instance => !(instance.kind === 'gateway'
        && managedRuntimeUnusable(managedRuntime[sourceIdForInstance(instance)])))
      .map(sourceIdForInstance)
      .filter(id => !mountedViews.includes(id))
    // 收割优先（design 05 §2.3 / baseline-harvest.ts）：还没拿到权威基线的源
    // 排在最前，且**不受**"回收后禁预热"抑制——收割正是这类源（从未推送、
    // 或曾降级后被回收）的治本臂；抑制只为防止 drainPrewarm 立刻重 boot 已
    // 回收的温壳，不能反过来把降级源永久钉在兜底视图里。
    const harvestIds = readyUnmountedIds
      .filter(id => harvestPending(harvestStateRef.current[id]))
    harvestCandidatesRef.current = new Set(harvestIds)
    // 保留策略：被回收过的源不再自动预热——否则回收(拆壳)会立即被
    // drainPrewarm 重新 boot(白回收循环)。抑制持续到用户主动点开
    // （selectView 清除）或来源从注册表删除（retireSources 清除）。
    // 另外排除"尝试耗尽且从未拿到基线"的源（harvestParked）：它若退回普通
    // 预热会白拿第三次 boot，并以 autoPrewarmed 身份长期占用唯一后台槽
    // （隐藏 1 壳时 retention 不会回收它）——此后本会话再没有任何源能预热
    // 或收割（2026-12 复查 MAJOR-2）。
    const warmIds = readyUnmountedIds
      .filter(id => !prewarmSuppressedRef.current.has(id))
      .filter(id => !harvestParked(harvestStateRef.current[id]))
      .filter(id => !harvestIds.includes(id))
    // 收割候选在场时**独占**后台槽（prewarmCandidates）：若让温壳顶上来，它会
    // 变成 autoPrewarmed，而隐藏 1 壳时 retention 不会回收它 ⇒ remaining 恒 0、
    // 本会话剩余来源永远拿不到基线（一个失败源阻塞全部——违反正确性不变量；
    // 2026-12 复查 MAJOR-1）。退避期空转槽位是有界代价，收割全部结束/停用后
    // 温壳预热照常恢复。
    // **收割有自己的预算线**：用户保留的隐藏温壳会让 warmRemaining 恒 0
    // （retention 只保 1 个隐藏壳），但收割壳是瞬时的（推送即回收 / 仅最后
    // 一个保留 / 有截止与放弃上限），不能被用户温壳永久挡死——否则用户点开过
    // 任何来源之后，后变 ready 的来源永远停在兜底视图（2026-12 复查 MAJOR-1
    // 的第二形态）。
    const slotBudget = harvestIds.length > 0 ? MAX_PREWARMED_REMOTE_VIEWS : warmRemaining
    return new Set(prewarmCandidates(harvestIds, warmIds, slotBudget))
  }, [remoteInstances, remoteStatus, mountedViews, activeView, managedRuntime, shellStates])
  prewarmEligibleRef.current = prewarmEligible

  const drainPrewarm = useCallback(() => {
    if (prewarmInflightRef.current !== null) return
    if (!localSettledRef.current) return
    // 2026 性能整改：仅前台推进预热——窗口隐藏期不为"用户没看"的源继续
    // boot 全量 UI（恢复可见由 visibilitychange 补偿一轮 drain）。
    if (!shouldRunBackgroundPhase(document.visibilityState)) return
    const now = Date.now()
    const pendingOf = (id: string): boolean => harvestPending(harvestStateRef.current[id])
    const dueOf = (id: string): boolean => harvestRetryDue(harvestStateRef.current[id], now)
    // 选取顺序（baseline-harvest.pickPrewarmTarget）：退避已满的收割候选优先，
    // 其次温壳；退避中的收割候选被跳过而不是挡住它后面的温壳。
    const next = pickPrewarmTarget(prewarmQueueRef.current, prewarmEligibleRef.current, pendingOf, dueOf)
    if (next === undefined) return
    prewarmQueueRef.current = prewarmQueueRef.current.filter(id => id !== next)
    // 这次挂载是否为收割挂载：未满足基线的源都是（提交推送/ boot 失败 /
    // 用户点开三条路径据此分流，见 onInstanceSnapshot / handleShellState /
    // selectView）。
    if (pendingOf(next)) {
      harvestIntentRef.current.add(next)
      harvestStateRef.current[next] = harvestAttemptStarted(harvestStateRef.current[next], now)
    }
    prewarmInflightRef.current = next
    prewarmInflightAtRef.current = now
    autoPrewarmedRef.current.add(next)
    setMountedViews(prev => (prev.includes(next) ? prev : [...prev, next]))
  }, [])

  const handleInstanceSettled = useCallback((instanceId: string) => {
    delete viewBootStartedAtRef.current[instanceId]
    if (instanceId === LOCAL_INSTANCE_ID) localSettledRef.current = true
    if (prewarmInflightRef.current === instanceId) {
      prewarmInflightRef.current = null
      prewarmInflightAtRef.current = 0
    }
    // 保留策略：settle 完成才起 60s 回收窗——隐藏视图（预热完成/切走后
    // settle）从此刻计"可回收时长"，boot 耗时不被白付；活动视图保持无键。
    if (instanceId === activeViewRef.current) delete hiddenSinceRef.current[instanceId]
    else hiddenSinceRef.current[instanceId] = Date.now()
    // 无条件 drain：任何 settle 都可能是"在途预热完成"或"本地首次 settle"
    // 的触发器（后者在状态先于本地就绪时不会因依赖变化而触发队列推进）。
    drainPrewarm()
  }, [drainPrewarm])

  /** Shell 终态上报（InstanceView onStateChange）：失败覆盖层读取活动视图的 error。 */
  const handleShellState = useCallback((instanceId: string, state: ShellState) => {
    // 注：settle/boot-failed 的 perf 标记由 shell.ts 在 settle 返回点统一打点
    // （本回调只消费状态，避免同名双标记污染 trace）。
    // 重新进入 booting/idle（「重试」复位）即重新计时：否则在放弃后很久才重试的
    // 视图会立刻被同一轮清扫再判超时（2026-12 复查 MINOR）。
    if (!state.booted && state.error === null) viewBootStartedAtRef.current[instanceId] = Date.now()
    setShellStates(prev => (prev[instanceId] === state ? prev : { ...prev, [instanceId]: state }))
    // 收割挂载 boot 失败：本次尝试失败（尝试计数与退避已随 attempt 武装），
    // 立即释放该壳——失败壳占着后台槽，也让来源停在兜底视图；重试由退避
    // 期满后的 drain 承担（attempts 上限见 baseline-harvest.ts）。
    if (state.error !== null && harvestIntentRef.current.has(instanceId)) {
      harvestIntentRef.current.delete(instanceId)
      reclaimViewRef.current(instanceId, 'harvest')
    }
  }, [])

  // ---- N-ctx 保留策略（2026 性能整改，纯函数与语义见 src/retention.ts）----
  // 已 settle（booted 或 error）视图集合：booting/未上报 = 未 settle，不回收
  // （避免取消在途 boot 白付成本）。
  const settledViewIds = useMemo(() => {
    const settled = new Set<string>()
    for (const [id, state] of Object.entries(shellStates)) {
      if (state.booted || state.error !== null) settled.add(id)
    }
    return settled
  }, [shellStates])

  /** 把"永不 settle 的挂载"标记为失败：让既有失败覆盖层与重试出现（该壳若是
   * 活动/待开视图则不可回收，见 reclaimHiddenViews 的绝对放弃臂）。 */
  const markAbandonedShellFailed = useCallback((id: string) => {
    // 重新计时（2026-12 复查 MAJOR）：否则用户点「重试」后，挂载时刻仍是原值，
    // 同一轮清扫会立刻再次判超时——覆盖层原地复活、新 boot 永远看不到，切走还会
    // 把在途重试的壳按保留策略回收掉。
    viewBootStartedAtRef.current[id] = Date.now()
    setShellStates(prev => ({
      ...prev,
      [id]: {
        instanceId: id,
        basePath: instanceBasePath(id),
        booted: false,
        booting: false,
        error: frameText(readDocumentLocale(), 'fatal.harvestTimeout', {
          seconds: String(Math.round(HARVEST_ABANDON_MS / 1000)),
        }),
        // 超时是失败态，不是降级态：自愈重挂由失败覆盖层的「重试」负责。
        degraded: null,
      },
    }))
  }, [])

  /**
   * 回收一个超限隐藏壳（幂等）。与注册表删除分支（retireSources）的区别：
   * 来源仍在注册表与 liveServerIdsRef 中，因此这里不碰数据面键空间
   * （aggregates/runtimeFacts/通知记忆随 producer 通道撤回自行收敛）、不回退
   * active/pending 意图、不清 deep-link/通知在途交付。dispose 先于 React 卸载
   * （同一提交内），实例进程/隧道/后台任务不受影响；重开 = selectView 重新
   * 挂载 → 冷 boot + entry 重放（shell.ts 同 id 串行 barrier 既有）。
   * 数据面降级按既有语义自然发生：ctx 卸载触发快照 producer clear，App 的
   * onInstanceSnapshot withdrawal 分支对已推送源保留 mounted marker（最后权威
   * 分组/归档集留在侧栏），30s unary watchdog 以 mounted 合并持续刷新其会话行
   * 与 running 位（05 §2.3）。已知取舍：壳内运行中任务的完成蓝点/通知边沿随
   * runtime-facts 通道撤回而暂停，直至该源重开（冷 boot 首报重新播种）——
   * 60s 安全窗 + RETAINED_HIDDEN_VIEWS=1 限制损失面，登记于 STATUS.md。
   */
  const reclaimView = useCallback((id: string, reason: 'retention' | 'harvest' = 'retention') => {
    if (id === LOCAL_INSTANCE_ID || !mountedViews.includes(id)) return
    if (id === activeViewRef.current || id === pendingViewRef.current) return
    // 收割回收时后台槽就是它自己：boot 已产出首个推送（或已失败），先释放槽位
    // 再回收，否则 prewarmInflight 守卫会把自己挡回去（保留回收语义不变）。
    if (reason === 'harvest' && prewarmInflightRef.current === id) {
      prewarmInflightRef.current = null
      prewarmInflightAtRef.current = 0
    }
    if (id === prewarmInflightRef.current) return
    harvestIntentRef.current.delete(id)
    autoPrewarmedRef.current.delete(id)
    // 保留策略：回收后禁止自动预热（否则 drainPrewarm 立刻重新 boot 它，
    // 回收空转）；用户主动点开（selectView）或注册表删除（retireSources）时清除。
    // 收割回收不写抑制键：它回收的是"已经拿到基线（或按上限放弃）"的源，
    // 抑制键会把从未推送的降级源永久钉在兜底视图里，与收割目的相反。
    if (reason === 'retention') prewarmSuppressedRef.current.add(id)
    prewarmQueueRef.current = withoutRemovedSourceIds(prewarmQueueRef.current, new Set([id]))
    if (prewarmEligibleRef.current.has(id)) {
      const next = new Set(prewarmEligibleRef.current)
      next.delete(id)
      prewarmEligibleRef.current = next
    }
    disposeInstanceShell(id)
    // 诊断收敛（2026 评审 Minor-2 修复）：boot-graph 诊断通道没有 ctx 卸载
    // 撤回——注册表删除路径之外的唯一清除点是显式 undefined 上报与退役。
    // 回收是新的生命周期类别（ctx 拆除而来源仍注册），不清除会让被拆 ctx
    // 的旧非 ok 诊断（bundle-load-failed / restart-required）挂在源上直到
    // 注册表删除，健康重开反而无上报（shell.ts 只在 graph 失败时上报）。
    // 与注册表删除镜像：clearPluginDiagnostic 改变签名 → 重发布，settings
    // 的 connections 插件面随之更新。聚合/runtimeFacts/通知记忆仍按
    // reclaimView 头注随 producer 通道撤回自行收敛。
    chamberBridge.clearPluginDiagnostic(id)
    delete hiddenSinceRef.current[id]
    setMountedViews(prev => withoutRemovedSourceIds(prev, new Set([id])))
    setShellStates(prev => withoutRemovedSourceKeys(prev, new Set([id])))
    setRetryTokens(prev => withoutRemovedSourceKeys(prev, new Set([id])))
  }, [mountedViews])

  /** 保留策略检查：仅前台执行（窗口隐藏期不拆壳；恢复可见由
   * visibilitychange 补偿一轮）。守卫与上限见 decideReclaimCandidates。
   * 同轮承担收割超时清扫：挂载后 HARVEST_DEADLINE_MS 内没有权威推送 = 本次
   * 尝试失败，释放后台槽（尝试上限与退避已随 attempt 武装）。 */
  const reclaimHiddenViews = useCallback(() => {
    if (!shouldRunBackgroundPhase(document.visibilityState)) return
    const now = Date.now()
    for (const id of [...harvestIntentRef.current]) {
      const record = harvestStateRef.current[id]
      if (record === undefined) continue
      if (harvestDeadlinePassed(record, now) && settledViewIds.has(id)) {
        // 只在壳已 settle 后按截止值判超时：boot 预算 60s（shell.ts
        // BOOT_TIMEOUT_MS），截止值高于它——settle 前只可能是排队/在途 boot。
        harvestIntentRef.current.delete(id)
        reclaimView(id, 'harvest')
        continue
      }
      if (harvestAbandoned(record, now)) {
        // 绝对上限：壳**始终**不 settle（挂死的 loader/fetch）时截止臂永远
        // 不可达，而后台槽被 prewarmInflight 永久占住。此时回收并**停用**
        // 该源（attempts 打满 → harvestParked），否则重试会撞进同一个挂死。
        harvestIntentRef.current.delete(id)
        harvestStateRef.current[id] = harvestParkedRecord()
        reclaimView(id, 'harvest')
      }
    }
    // 绝对放弃臂（2026-12 复查 MAJOR）：上面的截止臂只扫 harvestIntentRef，而
    // "用户点开正在收割的壳"会撤销意图、普通温壳预热从不写意图、selectView/深链
    // 挂载的壳更与预热无关——boot 挂死时后台槽/该视图就永久卡住。这里按**每个挂载
    // 视图的挂载时刻**独立兜底：只判仍未 settle 的挂载（已 settle 的走上方的截止
    // 臂），超上限后按身份分流。
    for (const id of mountedViews) {
      if (settledViewIds.has(id)) continue
      const startedAt = viewBootStartedAtRef.current[id]
      if (startedAt === undefined || now - startedAt < HARVEST_ABANDON_MS) continue
      const wasHarvest = harvestIntentRef.current.has(id)
      if (wasHarvest) {
        harvestIntentRef.current.delete(id)
        harvestStateRef.current[id] = harvestParkedRecord()
      }
      if (prewarmInflightRef.current === id) {
        prewarmInflightRef.current = null
        prewarmInflightAtRef.current = 0
      }
      if (id === activeViewRef.current || id === pendingViewRef.current) {
        // 活动/待开视图不可回收（reclaimView 会拒绝）。若不标记，用户会永久停在
        // boot 蒙层上（无错误、无重试）——标记为失败让既有失败覆盖层 + 重试出现。
        markAbandonedShellFailed(id)
      } else {
        // 隐藏视图：收割壳不写抑制键（它可能仍需重试），用户/温壳按保留策略回收。
        reclaimView(id, wasHarvest ? 'harvest' : 'retention')
      }
    }
    const candidates = decideReclaimCandidates({
      mountedViews,
      activeViewId: activeViewRef.current,
      hiddenSince: hiddenSinceRef.current,
      settled: settledViewIds,
      pendingViewId: pendingViewRef.current,
      prewarmInflightId: prewarmInflightRef.current,
      localId: LOCAL_INSTANCE_ID,
      // 快照（decide 即读）：自动预热来源在候选排序中先于用户来源被回收
      // （retention.ts 规则 3——预热壳从未被用户请求，straddle 形态下不
      // 允许它挤掉用户温壳）。
      prewarmOriginIds: new Set(autoPrewarmedRef.current),
      now: Date.now(),
    })
    // 设置面板正在编辑的来源不可回收（design 05 §5，2026-12 完整桥接修订）：
    // 面板渲染的是该来源自己 boot ctx 的台账，拆掉壳 = 正在编辑的设置面消失。
    // 过滤而非改判定：面板关闭后该源重新成为普通保留候选。
    for (const id of candidates) {
      if (id === settingsTargetRef.current) continue
      reclaimView(id)
    }
  }, [mountedViews, reclaimView, settledViewIds])

  // 定时器/事件驱动的检查需要最新闭包：ref 镜像（同 pollAggregatesRef 纪律）。
  const reclaimHiddenViewsRef = useRef<() => void>(() => undefined)
  const drainPrewarmRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    reclaimHiddenViewsRef.current = reclaimHiddenViews
    drainPrewarmRef.current = drainPrewarm
    reclaimViewRef.current = reclaimView
  })

  // 共享文档的主题投影归属（N-ctx 硬化，design 06）：文档级 color-scheme /
  // body 调色板属性是 DOCUMENT-global 的，而本形态把 N 个实例壳挂在同一份
  // 文档里——每个挂载中的视图都跑自己的 ui-layout theme presenter。App 是
  // 「谁在屏上」的唯一权威，把它发布到 page-wide chamberBridge；ui-layout
  // fork 的 document-theme 投影器据此只让活动视图写文档（详见
  // packages/dsh-chamber-client-ui-layout/src/client/document-theme.ts）。
  // useLayoutEffect：必须在切换视图的那一帧**绘制前**发布，否则主题不同的两个
  // 视图互切会先画一帧旧调色板（2026-12 复查 MINOR-2）。
  useLayoutEffect(() => {
    chamberBridge.setActiveSource(activeView)
  }, [activeView])

  // 活动视图落地即重计隐藏窗：离开活动的旧视图开始计时，新活动视图清计时。
  // 覆盖 selectView 过渡 apply、注册表删除回落（fallback 到 local）等一切路径；
  // 过渡在途时 activeViewRef 仍是旧视图，展示中的壳不会因本 effect 被计时。
  useEffect(() => {
    if (previousActiveViewRef.current === activeView) return
    const previous = previousActiveViewRef.current
    previousActiveViewRef.current = activeView
    delete hiddenSinceRef.current[activeView]
    if (previous !== null) hiddenSinceRef.current[previous] = Date.now()
  }, [activeView])

  // hiddenSince 键随挂载收敛（覆盖注册表删除分支与回收两条移除路径）+
  // 挂载/回收/激活变化后尽快补查一轮回收（60s 安全窗外的兜底由周期 tick 承担）。
  useEffect(() => {
    const live = new Set(mountedViews)
    for (const id of Object.keys(hiddenSinceRef.current)) {
      if (!live.has(id)) delete hiddenSinceRef.current[id]
    }
    // 挂载时刻（绝对放弃上限的基准；settle 时清除）。
    const now = Date.now()
    for (const id of mountedViews) {
      if (viewBootStartedAtRef.current[id] === undefined) viewBootStartedAtRef.current[id] = now
    }
    for (const id of Object.keys(viewBootStartedAtRef.current)) {
      if (!live.has(id)) delete viewBootStartedAtRef.current[id]
    }
    reclaimHiddenViews()
  }, [mountedViews, reclaimHiddenViews])

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

  // 温壳为收割让位（2026-12 复查 M3）：把最后收割的壳留在温壳位省了一次 boot，
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
   *  chamber (2026-12，design 05 §2.2 修订)：进入时 arm 一条打开意图、settle 时
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
      // 2026-09-11 review-fix (finding 4b): the open-failure texts are thrown
      // across the frame→plugin boundary (the sidebar renders whatever text the
      // rejected promise carries), so the FRAME-OWNED part is dictionary copy in
      // the document locale; read at throw time, since no render scope owns it
      // (locales.ts readDocumentLocale — the module's out-of-render reader).
      throw new Error(frameText(readDocumentLocale(), 'open.failed.sourceGone', { source: instanceId }))
    }
    // INVARIANT (2026-09-11 review F1): arm and release are ONE pair owned by
    // this try/finally, and the arm is the FIRST statement inside the `try` —
    // nothing may ever be inserted between them. `selectView` can throw
    // synchronously (view-transition plumbing), so an arm placed before the
    // `try` latches the intent for the whole generation: the source's projected
    // `current` stays suppressed and, once the shell settles elsewhere, the
    // loading veil is pinned forever (the finally that would release is the one
    // statement the throw skips).
    // Arming stays BEFORE selectView (the gates must be active the moment the
    // view switches, or the target shell's self-selected blank session is
    // projected for a frame). A synchronous throw from the switch now also
    // reports through the wrapped open-failure text below — accurate, the user's
    // session open is what failed.
    try {
      armOpenIntent(instanceId, sessionId)
      selectView(instanceId)
      await openInstanceSession(instanceId, sessionId)
    } catch (err) {
      // 2026-09-11 review-fix (finding 4b): dictionary copy around a raw cause —
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
          // 2026-09-11 review-fix (finding 4b): same dictionary rule as the two
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

  /** 侧边栏插件打开请求（05 §3）：mount 订阅、卸载取消。请求通道单向
   *  （插件→App）；打开终态经 outcome 回报（App→每个 sidebar shell，
   *   行内错误呈现），失败同时 console.error。 */
  useEffect(() => {
    const unsubscribe = chamberBridge.onOpenSession(({ sourceId, sessionId }) => {
      void openSession(sourceId, sessionId).then(
        () => { chamberBridge.reportOpenSessionOutcome({ sourceId, sessionId }) },
        (err) => {
          const message = errorMessage(err)
          console.error(`[renderer] openSession failed (${sourceId}/${sessionId}):`, err)
          chamberBridge.reportOpenSessionOutcome({ sourceId, sessionId, message })
        },
      )
    })
    return unsubscribe
  }, [openSession])

  /** 侧边栏插件点击来源头部的激活请求：切换到该来源 shell（未挂载先挂载，N-ctx）。 */
  useEffect(() => {
    return chamberBridge.onActivateSource((sourceId) => {
      selectView(sourceId)
    })
  }, [selectView])

  /**
   * 设置面板目标来源（design 05 §5，2026-12 完整桥接修订）：面板渲染选中来源
   * 自己的 boot ctx 台账，因此该来源的壳必须挂载。这里只做"挂载 + 保留"，绝不
   * 切换 active view——下拉选服务器不等于把用户正在看的视图换掉（与
   * `requestActivateSource` 的分工：后者是用户点了侧栏来源头部）。
   * 未在权威 roster 里的 id 不挂载（已退役来源不得被重新 boot）；面板对离线
   * 来源本就不设目标（它显示不可达占位）。
   */
  useEffect(() => {
    return chamberBridge.onSettingsTarget((sourceId) => {
      settingsTargetRef.current = sourceId
      if (sourceId === undefined) return
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      // 曾经因闲置被回收而被抑制预热的来源，被面板显式选中 = 再次有使用意图。
      prewarmSuppressedRef.current.delete(sourceId)
      autoPrewarmedRef.current.delete(sourceId)
      setMountedViews(prev => (prev.includes(sourceId) ? prev : [...prev, sourceId]))
    })
  }, [])

  /** VS Code OS 深链（design 16 §2，hold/replay）：先注册监听，再以 ready()
   *  通知主进程放行归一化 intent；冷启动/重载期间的成功启动不会丢失来源激活。
   *  raw id → 视图 id 通过当前权威 kind roster 解析为 dsh-/gateway-；
   *  legacy ssh- 只作为输入兼容，绝不由 v2 roster 新产生。
   *  远程来源在首次 authoritative instances_get settle 前进入单槽 pending，
   *  roster 成功后再由上方 effect replay；local 不依赖 roster，立即激活。
   *  VS Code 启动由主进程独立完成，渲染层激活从不阻塞它。桥与 desktopSsh
   *  同一批 expose，sshBridgeReady 即 deepLink 可用。 */
  useEffect(() => {
    if (!sshBridgeReady) return
    const deepLink = window.dshChamber?.deepLink
    if (deepLink === undefined) return
    const unsubscribe = deepLink.onIntent((intent) => {
      if (typeof intent.instanceId !== 'string'
        || typeof intent.sourceFingerprint !== 'string'
        || !Number.isSafeInteger(intent.deliveryId) || intent.deliveryId < 1
        || !Number.isSafeInteger(intent.attempt) || intent.attempt < 1) {
        console.error('[renderer] ignored malformed deep-link activation intent')
        return
      }
      const sourceId = intent.instanceId === 'local'
        ? LOCAL_INSTANCE_ID
        : remoteRosterSettledRef.current
          ? sourceIdForRawInstance(intent.instanceId, remoteInstancesRef.current)
          : null
      if (intent.instanceId !== 'local' && remoteRosterSettledRef.current && sourceId === null) {
        console.warn(`[renderer] ignored deep-link raw source absent from the authoritative roster: ${intent.instanceId}`)
        void acknowledgeDeepLink(intent).catch(error => {
          reportDeepLinkAckFailure(intent, error)
        })
        return
      }
      // If authority for this source is already installed, reject a stale IPC
      // pipe delivery before it can supersede a legitimate held intent. When
      // no owner exists yet, preserve the delivery until the roster settles
      // and perform the same exact-proof check in the replay effect.
      if (
        sourceId !== null
        && sourceLifecyclesRef.current!.capture(sourceId) !== null
        && !deliveryMatchesCurrentSource(
          sourceLifecyclesRef.current!,
          sourceId,
          intent.sourceFingerprint,
        )
      ) {
        console.warn(`[renderer] ignored stale deep-link source proof before routing: ${sourceId}`)
        void acknowledgeDeepLink(intent).catch(error => {
          reportDeepLinkAckFailure(intent, error)
        })
        return
      }
      const previous = pendingDeepLinkDeliveryRef.current
      const current: DeepLinkDelivery = {
        rawInstanceId: intent.instanceId,
        sourceId,
        sourceFingerprint: intent.sourceFingerprint,
        deliveryId: intent.deliveryId,
        attempt: intent.attempt,
      }
      if (sourceId === null) {
        pendingDeepLinkDeliveryRef.current = current
        if (previous !== null && previous.deliveryId !== current.deliveryId) {
          void acknowledgeDeepLink(previous).catch(error => {
            reportDeepLinkAckFailure(previous, error)
          })
        }
        return
      }
      const decision = routeDeepLinkActivation(
        sourceId,
        remoteRosterSettledRef.current,
        liveServerIdsRef.current,
        previous?.sourceId ?? null,
      )
      pendingDeepLinkDeliveryRef.current = decision.pendingSourceId === null ? null : current
      if (previous !== null && previous.deliveryId !== current.deliveryId) {
        // View activation is explicitly last-intent-wins. A newer delivery
        // deliberately supersedes the older held item, so commit the old id
        // instead of leaving main's single-flight key retained forever.
        void acknowledgeDeepLink(previous).catch(error => {
          reportDeepLinkAckFailure(previous, error)
        })
      }
      if (decision.discarded?.reason === 'missing') {
        console.warn(`[renderer] ignored deep-link source absent from the authoritative roster: ${decision.discarded.sourceId}`)
      }
      if (decision.activateSourceId !== null) {
        if (deliveryMatchesCurrentSource(
          sourceLifecyclesRef.current!,
          sourceId,
          current.sourceFingerprint,
        )) {
          selectView(decision.activateSourceId)
        } else {
          console.warn(`[renderer] ignored stale deep-link source proof: ${sourceId}`)
        }
      }
      if (decision.pendingSourceId === null) {
        void acknowledgeDeepLink(current).catch(error => {
          reportDeepLinkAckFailure(current, error)
        })
      }
    })
    // Listener-before-ready is the ordering contract: ready synchronously
    // unlocks the main-process drain, whose first send may happen immediately.
    // Retry a transient IPC failure on a bounded budget; main keeps its intent
    // held until one invocation succeeds.
    let cancelled = false
    let readyAttempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const signalReady = (): void => {
      readyAttempts += 1
      void Promise.resolve()
        .then(() => deepLink.ready())
        .then((ready) => {
          if (ready !== true) throw new Error('deep-link ready returned false')
        })
        .catch((error: unknown) => {
          if (cancelled) return
          if (readyAttempts >= LISTENER_READY_RETRY_LIMIT) {
            console.error('[renderer] deep-link readiness handshake exhausted its retry budget:', error)
            return
          }
          retryTimer = setTimeout(signalReady, LISTENER_READY_RETRY_MS)
        })
    }
    signalReady()
    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      unsubscribe()
    }
  }, [sshBridgeReady, acknowledgeDeepLink, reportDeepLinkAckFailure, selectView])

  /** 侧边栏动作成功后请求的即时刷新（chamberBridge.requestRefresh）；失败落 error 态由 UI 呈现。
   *  Always pull on a mutation: the mounted producer's push can lag the host's
   *  registry reorder (create → prepend → insertBefore), so relying on the
   *  freshness check here left new worktrees/sessions stranded at the prepended
   *  head until the next 30s poll (2026-08 user report). */
  useEffect(() => {
    return chamberBridge.onRefresh((sourceId) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const tag = (mutationRefreshSeqRef.current[sourceId] ?? 0) + 1
      mutationRefreshSeqRef.current[sourceId] = tag
      void refreshAggregate(sourceId, tag)
    })
  }, [refreshAggregate])

  /**
   * 工作区创建回声（2026-12，design 05 §2.2 修订；真机问题 2）：
   * 侧栏在建好工作区后上报宿主 workspaceId，App 记入渲染端账本并把该行并入
   * 投影（deriveServers 的单一汇合点）。权威收敛点只有两个：
   * - 该来源挂载壳的 push 列出同一 workspaceId / 同一路径的真实 id ⇒ 账本条目
   *   立即清除（reconcilePendingWorkspaces，见 onInstanceSnapshot）；
   * - 来源离开注册表 / TTL 到期 ⇒ 随生命周期收敛。
   * 这里只记录、不拉取：侧栏在自己的 create 成功后照旧 `requestRefresh`，两条
   * 通道职责不重叠（本通道是"我刚刚造了它"的事实，刷新是"其它行要更新"）。
   */
  useEffect(() => {
    return chamberBridge.onWorkspaceCreated((fact) => {
      const { sourceId } = fact
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const owner = sourceLifecyclesRef.current!.capture(sourceId)
      if (owner === null) return
      const now = Date.now()
      let ledger = sweepPendingWorkspaces(workspaceEchoRef.current, now)
      ledger = recordPendingWorkspace(ledger, sourceId, { workspaceId: fact.workspaceId, path: fact.path }, now)
      if (ledger !== workspaceEchoRef.current) updateWorkspaceEcho(ledger)
    })
  }, [updateWorkspaceEcho])
  /**
   * 回声的**撤下 / 改写**通道（2026-12，design 05 §2.2 修订；2026-09-11 review S3）：
   * 只有 create 事实的回声没有退场机制——创建后又在侧栏删掉会留一行幽灵，且
   * **权威挂载 push 也退不掉它**（push 只调和"它列出了什么"，列不出的行无事发生，
   * 幽灵要挂到 10 分钟 TTL；而那一行带真实 host id，工作区级动作在宿主上
   * fail-closed `workspace/not-found`），
   * 重命名则因为账本只按路径生成 title 而看起来像没生效。两条通道都是单向事实，
   * 与 onWorkspaceCreated 同栅栏（活跃来源 + 生命周期捕获），并且经**同一个**
   * updateWorkspaceEcho 写入：App 仍是投影的唯一写者，账本之外没有第二份状态。
   * 纯账本改写（removePendingWorkspace / renamePendingWorkspace）保持同一性——
   * 无匹配条目时返回同一引用，不触发重渲染。
   */
  useEffect(() => {
    return chamberBridge.onWorkspaceRemoved((fact) => {
      const { sourceId } = fact
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const owner = sourceLifecyclesRef.current!.capture(sourceId)
      if (owner === null) return
      // The removal is another tick that can change what that source's list
      // SHOULD contain, so it carries the same TTL sweep as the create fact
      // (whose doc enumerates these ticks): the retired entry itself is dropped
      // eagerly by removePendingWorkspace, the sweep covers the entries whose
      // convergence never came. Identity-preserving, so a no-op costs no render.
      let ledger = sweepPendingWorkspaces(workspaceEchoRef.current, Date.now())
      ledger = removePendingWorkspace(ledger, sourceId, { workspaceId: fact.workspaceId, path: fact.path })
      if (ledger !== workspaceEchoRef.current) updateWorkspaceEcho(ledger)
    })
  }, [updateWorkspaceEcho])
  useEffect(() => {
    return chamberBridge.onWorkspaceRenamed((fact) => {
      const { sourceId } = fact
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const owner = sourceLifecyclesRef.current!.capture(sourceId)
      if (owner === null) return
      const next = renamePendingWorkspace(
        workspaceEchoRef.current,
        sourceId,
        fact.workspaceId,
        fact.title,
      )
      if (next !== workspaceEchoRef.current) updateWorkspaceEcho(next)
    })
  }, [updateWorkspaceEcho])
  /**
   * Mounted source ctxs publish the same complete snapshot shape as the unary
   * fallback. A push invalidates any older in-flight pull before committing.
   * A withdrawal (`undefined`) means the source's arrival baselines have not
   * landed (first boot window); a source that ALREADY pushed once keeps its
   * mounted marker and last aggregate — dropping them would hand the source
   * to the sessions-only unary fallback (no workspace groups, no archive
   * filter — the archive set exists only on the workspace baseline — and 30s
   * polled state), the all-ungrouped + archived-resurfacing + stale-state
   * regression (2026-09 fix). The staleness watchdog still bounds a
   * silently-dead producer channel via the retained snapshotAt recency.
   */
  useEffect(() => {
    return chamberBridge.onInstanceSnapshot((
      sourceId,
      snapshot: InstanceSnapshot | undefined,
      sourceFingerprint,
    ) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const currentSource = sourceLifecyclesRef.current!.capture(sourceId)
      if (currentSource === null || currentSource.fingerprint !== sourceFingerprint) return
      aggregatePollSeqRef.current[sourceId] = (aggregatePollSeqRef.current[sourceId] ?? 0) + 1
      aggregateRequestOwnersRef.current!.retire([sourceId])
      if (snapshot === undefined) {
        // Withdraw ONLY a source that never pushed (nothing to keep); a
        // source with a last push keeps its mounted marker and recency so
        // planAggregateRefreshes never re-enables the unary fallback for it.
        if (snapshotAtRef.current[sourceId] === undefined) {
          delete snapshotSourcesRef.current[sourceId]
          delete snapshotAtRef.current[sourceId]
        }
      } else {
        snapshotSourcesRef.current[sourceId] = true
        snapshotAtRef.current[sourceId] = Date.now()
      }
      setSnapshotSources(prev => {
        if (snapshot === undefined) {
          if (snapshotAtRef.current[sourceId] !== undefined) return prev
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        }
        if (prev[sourceId] === true) return prev
        return { ...prev, [sourceId]: true }
      })
      if (snapshot === undefined) return
      // 工作区创建回声的权威收敛点（2026-12，design 05 §2.2 修订）：挂载壳自己的
      // follow baseline / upsert 列出了这个工作区（同 workspaceId，或同路径的真实
      // id）⇒ 账本条目立刻退休，投影随之只剩权威行。刻意放在下面的 ready 门之前：
      // push 里的工作区身份来自该来源自己的 follow 基线，与聚合是否已提交无关。
      {
        // TTL first, then retire whatever the authoritative list now covers: the
        // mounted push is the echo's convergence signal, so an entry it lists has
        // no job left and must not survive as a duplicate.
        const swept = sweepPendingWorkspaces(workspaceEchoRef.current, Date.now())
        const reconciled = reconcilePendingWorkspaces(swept, sourceId, snapshot.workspaces)
        if (reconciled !== workspaceEchoRef.current) updateWorkspaceEcho(reconciled)
      }
      // A mounted ctx can deliver a late store notification after its
      // transport generation died. Keep producer ownership, but never let
      // that notification overwrite the authoritative not-connected row;
      // the next ready edge performs one unary refresh.
      if (!readyAggregateSourcesRef.current.has(sourceId)) return
      // design 24 §12 (archive-cleanup convergence): an archived-set SHRINK
      // in a mounted push is the client-observable "a purge completed" signal
      // (no unarchive wire — only the cleanup purge removes set members). The
      // purged sessions' rows may still linger in the official client session
      // summaries of this mounted ctx (refreshed only on connection
      // generations; host purge events are documented no-ops), so once the set
      // stops covering them they would render as ordinary rows and open with
      // session/not-found. Convergence state machine (planSessionListRefresh),
      // evaluated on EVERY ready push: removed ids still listed as rows become
      // pending ghosts; the source's ctx is asked to re-run its OFFICIAL
      // session-list refresh (sidebar-plugin subscriber — reconciles the
      // summaries against the server corpus and drops the deleted rows); the
      // resulting producer push then clears the pending set. A refresh that
      // fails transiently is re-requested on a later push (cadence floored by
      // SESSION_LIST_REFRESH_COALESCE_MS so a failing refresh on a busy source
      // cannot stack RPCs); a suppressed dispatch never loses the ids — they
      // stay pending and re-evaluate on the next push. Quiet sources with no
      // further push self-hide within one watchdog cycle (the 30s merge pull
      // replaces the aggregate's session rows with the clean unary list).
      // Remember the last AUTHORITATIVE archive set (see the ref's doc): used
      // as the shrink baseline when the committed aggregate lost provenance,
      // and as the archived-row filter for a degraded commit. ORDER IS
      // LOAD-BEARING (2026-09 scan MAJOR): the PRE-update value is the
      // baseline — updating the memory first would make the remembered set
      // equal to the incoming snapshot's own set, so archiveSetShrink could
      // never observe a shrink (the fallback branch would be dead code).
      const rememberedArchiveSet = authoritativeArchiveSetRef.current[sourceId]
      if (snapshot.archiveSetKnown === true) {
        authoritativeArchiveSetRef.current[sourceId] = snapshot.archivedSessionIds
      }
      const decision = planSessionListRefresh(
        watchdogAggregatesRef.current[sourceId],
        snapshot,
        sessionListRefreshPendingRef.current[sourceId],
        rememberedArchiveSet,
      )
      if (decision.pending.length > 0) sessionListRefreshPendingRef.current[sourceId] = decision.pending
      else delete sessionListRefreshPendingRef.current[sourceId]
      if (decision.request) {
        const now = Date.now()
        if (shouldRequestSessionListRefresh(
          sessionListRefreshAtRef.current[sourceId],
          now,
          SESSION_LIST_REFRESH_COALESCE_MS,
        )) {
          sessionListRefreshAtRef.current[sourceId] = now
          chamberBridge.requestSessionListRefresh(sourceId)
        }
      }
      setAggregates(prev => {
        const current = prev[sourceId]
        if (current !== undefined && current.state === 'ok'
          && instanceSnapshotSignature(current) === instanceSnapshotSignature(snapshot)) return prev
        return { ...prev, [sourceId]: { state: 'ok', ...snapshot, error: null } }
      })
      // 收割完成（design 05 §2.3）：该源的首个挂载推送就是权威基线（真实
      // 工作区分组 + 归档集，`archiveSetKnown:true`）——标记已满足并立即回收
      // 后台壳，来源转入已上线的"已回收来源"态（30s unary merge 刷新会话行）。
      // 非收割挂载的推送同样满足基线需求（用户点开、retention 温壳、退避后
      // 被用户抢先点开）：不标记会让已推送过的源在回收后又被收割白 boot 一次。
      if (harvestIntentRef.current.has(sourceId)) {
        harvestIntentRef.current.delete(sourceId)
        harvestStateRef.current[sourceId] = harvestSatisfied(harvestStateRef.current[sourceId])
        // 保留**最后收割的壳当温壳**（2026-12 复查 M3/N2）：省掉一次完整后台
        // boot，并让该源的运行时状态事实（pending/完成点）保持在线；仅当还有
        // 别的收割候选时才回收，把唯一后台槽让给基线恢复。
        if (shouldReclaimHarvestedShell(
          harvestCandidatesRef.current,
          sourceId,
          id => harvestPending(harvestStateRef.current[id]),
        )) reclaimViewRef.current(sourceId, 'harvest')
      } else {
        harvestStateRef.current[sourceId] = harvestSatisfied(harvestStateRef.current[sourceId])
      }
    })
  }, [])

  useEffect(() => {
    return chamberBridge.onPluginDiagnostic((sourceId, diagnostic) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      setPluginDiagnostics(prev => {
        if (diagnostic === undefined) {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        }
        return { ...prev, [sourceId]: diagnostic }
      })
    })
  }, [])

  /**
   * D2 (review-round3d P1-1): the local instance's dsh version is the desktop's
   * active runtime version (IPC INFO bridge — the control-plane fact
   * projection). Remote (ssh/http) instances stay hidden until a remote
   * version probe is wired (D2 fallback; STATUS.md records the pending item).
   * The old in-ctx host-producer channel (registerInstanceHostProducer /
   * onInstanceHost) was removed entirely — host.describe was deleted upstream
   * and no producer ever registered again (2026-09 cleanup).
   */
  useEffect(() => {
    const version = window.dshChamber?.dshVersion ?? undefined
    if (version === undefined) return
    setHostFacts(prev => {
      const existing = prev[LOCAL_INSTANCE_ID]
      if (existing?.dshVersion === version) return prev
      return { ...prev, [LOCAL_INSTANCE_ID]: { ...(existing ?? {}), dshVersion: version } }
    })
  }, [])

  /** 每来源 ctx 的运行时事实上报（06 §4）：report 覆盖、clear 删除；同时
   *  对账该来源的「完成未读」蓝点（completedBySource）。无需额外依赖。 */
  useEffect(() => {
    return chamberBridge.onRuntimeReport((sourceId, report, sourceFingerprint) => {
      if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
      const currentSource = sourceLifecyclesRef.current!.capture(sourceId)
      if (currentSource === null || currentSource.fingerprint !== sourceFingerprint) return
      setRuntimeFacts(prev => {
        if (report === undefined) {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        }
        // identity-preserving：同内容上报（store 通知但事实未变的常态）不换
        // state 对象——否则每次上报都触发 servers 重新派生与 publish（2026-08
        // perf pass）。
        const current = prev[sourceId]
        if (current !== undefined && runtimeReportSignature(current) === runtimeReportSignature(report)) {
          return prev
        }
        return { ...prev, [sourceId]: report }
      })
      if (report === undefined) {
        // 通道撤回（shell 重连/重 boot 窗口，来源移除的 clear 已被上方的
        // liveServerIds/指纹检查挡掉，不会到达这里）：清掉 UI 蓝点边沿与
        // 通知边沿的 prev 记忆——恢复后的首份上报是纯播种（prev undefined
        // 只记不发），与蓝点机的撤回语义一致（2026-09 清理：此前保留 prev
        // 记忆以补发撤回窗口内完成的会话，但 wire 只有 running 位、无法区分
        // 手动停止与完成，窗口内被手动停止的会话会在恢复首报上误报
        // 「完成」；删除记忆后窗口内的完成通知不再补发——窗口仅持续到重连
        // 完成，且会话完成状态在 UI 中可见）。
        delete prevRunningRef.current[sourceId]
        delete prevRuntimeFactsRef.current[sourceId]
        delete notifiedCompleteRef.current[sourceId]
        setCompletedBySource(prev => {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        })
        return
      }
      // 通知边沿（设计 19 §3.2/§3.3）：独立纯函数 detectNotificationEdges +
      // dedupeCompleteEdges，与蓝点机互不耦合——蓝点带「正在阅读」解除，
      // 通知边沿不受解除影响（窗口隐藏时活动来源的当前会话完成也必须通知，
      // requireHidden 豁免在主进程裁决）。首份上报（prev === undefined）只
      // 播种记忆不发事件；边沿为空也更新记忆（记忆是后续上报的 prev，report
      // 为不可变新对象，直接存引用即可）。
      const prevFacts = prevRuntimeFactsRef.current[sourceId]
      const edges = detectNotificationEdges(prevFacts, report.sessions)
      prevRuntimeFactsRef.current[sourceId] = report.sessions
      // 父会话回合结束但后台子代理仍在运行时（runningSubagents > 0）不视为
      // 完成（06 §4.5 与官方 Rows 呈现优先级 pending > runningSubagents >
      // completed 一致）：通知面不得成为唯一「大声」的错位表面——用户点开
      // 发现子代理还在干活。抑制发生在去重之前（不记账），若 vendor 在子
      // 代理全部结束后才武装 completed，届时 completed 边沿正常补发。
      const edgesWithoutRunningSubagents = edges.filter(edge =>
        !(edge.kind === 'complete'
          && (report.sessions[edge.sessionId]?.runningSubagents ?? 0) > 0)
      )
      // complete 去重（跨上报记忆）：正被查看的会话完成先走 running 边沿，
      // 切走后 vendor 延迟武装 completed 的重复边沿在此丢弃；running=true
      // 的会话清除记忆（下次完成重新可发）。
      const runningIds = Object.entries(report.sessions)
        .filter(([, facts]) => facts?.running === true)
        .map(([sessionId]) => sessionId)
      const notifiedBefore = notifiedCompleteRef.current[sourceId] ?? new Set<string>()
      const deduped = dedupeCompleteEdges(edgesWithoutRunningSubagents, notifiedBefore, runningIds)
      // 已离开列表的会话清除已发记忆（与蓝点机 leave-the-list 清扫同纪律，
      // 防长活来源上的记忆缓慢增长）。
      for (const sessionId of [...deduped.notified]) {
        if (report.sessions[sessionId] === undefined) deduped.notified.delete(sessionId)
      }
      notifiedCompleteRef.current[sourceId] = deduped.notified
      if (deduped.edges.length > 0) {
        // 事件组装（设计 19 §3.3）：文案来自 App 框架的 typed 字典
        // （locales.ts，T16 2026-09-11 upstream-alignment）；本 effect 依赖
        // []，拿不到 render 作用域的 `t`，因此在事件组装时读取当前文档语言
        // （与 render 侧同一个读法：readDocumentLocale）。label/title 取渲染期
        // 镜像（同上）。桥未就绪（window.dshChamber 异步出现）静默
        // 跳过——边沿是低频事件，错过早期事件可接受，不报错刷屏。组装块
        // 与蓝点对账隔离：任何异常不得吞掉该份上报的蓝点推进（try/finally
        // 保底，主链路 notify 本身有 catch）。
        try {
          const bridge = window.dshChamber?.notifications
          if (bridge !== undefined) {
            const copyLocale = readDocumentLocale()
            const label = serverLabelsRef.current[sourceId] ?? sourceId
            const aggregate = aggregatesRef.current[sourceId]
            const sessionTitle = (sessionId: string) =>
              aggregate?.sessions.find(session => session.sessionId === sessionId)?.title
              ?? frameText(copyLocale, 'session.untitled')
            for (const edge of deduped.edges) {
              const title =
                edge.kind === 'complete' ? frameText(copyLocale, 'notification.sessionComplete')
                : edge.kind === 'ask' ? frameText(copyLocale, 'notification.awaitingAnswer')
                : frameText(copyLocale, 'notification.awaitingApproval')
              const body = `${label} · ${sessionTitle(edge.sessionId)}`
              // 正在屏幕上查看的会话豁免（与 OpenChamber requireHidden 同语义；
              // 单窗口下 renderer 的 document.hasFocus() 与主进程
              // isAnyWindowFocused() 等价，主进程再查一次作权威）。
              const requireHidden =
                sourceId === activeViewRef.current &&
                edge.sessionId === report.current &&
                document.hasFocus()
              void bridge.notify({
                sourceId,
                sourceFingerprint,
                sessionId: edge.sessionId,
                kind: edge.kind,
                title,
                body,
                requireHidden,
              }).catch(err => console.warn('[notifications] 发送失败:', err))
            }
          }
        } catch (error) {
          console.warn('[notifications] 事件组装失败:', error)
        }
      }
      // 蓝点对账（规则与 vendor 提醒同构，但「正在阅读」取 App 侧事实——
      // 活动视图的 current 会话，而非各来源自己可能陈旧的 selected；纯函数
      // 见 shared/derive.ts reconcileCompletedFacts）。边沿记忆 ref 在本
      // handler 同步推进（幂等），蓝点 state 在函数式 updater 里按序组合
      // ——同来源两次上报落在同一渲染周期也不会互相覆盖丢蓝点。每份上报
      // 各自捕获 prevRunning 快照，保证 updater 与自己的上报正确配对。
      const prevRunningSnapshot = prevRunningRef.current[sourceId] ?? {}
      const nextRunning: Record<string, boolean> = {}
      for (const [sessionId, row] of Object.entries(report.sessions)) {
        nextRunning[sessionId] = row?.running === true
      }
      prevRunningRef.current[sourceId] = nextRunning
      // 活动来源的 current 会话 = 正在阅读；后台来源无阅读者（undefined）。
      const readingCurrent = sourceId === activeViewRef.current ? report.current : undefined
      setCompletedBySource(prev => {
        const result = reconcileCompletedFacts({
          sessions: report.sessions,
          nextRunning,
          prevRunning: prevRunningSnapshot,
          prevCompleted: prev[sourceId] ?? {},
          readingCurrent,
        })
        if (!result.changed) return prev
        return { ...prev, [sourceId]: result.completed }
      })
    })
  }, [])

  /** chamber (06 §4.1)：切到某来源时，其 current 会话立即视为已读——清除
   *  后台期间武装的蓝点（阅读解除在 reconcile 里按上报做，这里兜底「激活但
   *  无新上报」的路径，如点击来源头不打开会话）。 */
  const prevActiveViewRef = useRef(activeView)
  useEffect(() => {
    const previous = prevActiveViewRef.current
    prevActiveViewRef.current = activeView
    if (previous === activeView) return
    const current = runtimeFacts[activeView]?.current
    if (current === undefined) return
    setCompletedBySource(prev => {
      const sourceCompleted = prev[activeView]
      if (sourceCompleted === undefined || sourceCompleted[current] !== true) return prev
      const nextCompleted = { ...sourceCompleted }
      delete nextCompleted[current]
      return { ...prev, [activeView]: nextCompleted }
    })
  }, [activeView])

  // 未读徽标（design 19 §3.7）：completedBySource（完成未读蓝点集）是徽标计数的
  // 唯一事实源——跨来源求未读会话数（projectBadgeCount，纯函数），推给主进程
  // 呈现 Dock/任务栏红气泡。计数与蓝点同源同规则（武装/解除同一状态机），两面
  // 永不分叉；0 = 清除。子代理压制（06 §4.5 同规）：父回合结束
  // 但后台子代理仍存活（runningSubagents > 0）的会话虽然已武装蓝点，窗口内点
  // 被运行环压制、complete 通知被过滤，徽标同样不计——投影须读最新运行时事实
  // （runtimeFacts 行），否则 Dock 会在「主分支闲置等子代理」期间误亮红气泡。
  // 子代理全部结束后 armed 蓝点正常浮现计入（与侧边栏同语义）。runtimeFacts
  // 在依赖里：子代理计数归零（事实行变化）时无需蓝点变化也要重推当前计数。
  // 通道-only 变化可能重推相同计数值——主进程 setBadgeCount 幂等，无副作用。
  // 桥未就绪（window.dshChamber 异步 expose）时静默跳过
  // ——计数变化发生在运行时上报之后（远晚于桥暴露），首个真实计数不会丢；
  // 重载后复位为 0 的兜底推送由下方挂载 effect 负责。reject 兜底（review B1）：
  // 同进程 IPC 偶发拒绝不得让徽标停滞到下一次计数变化——按 LISTENER_READY 预算
  // 有界重推当前计数（badgeCountRef 始终最新），预算耗尽 loud 一次。
  const badgeCountRef = useRef(0)
  const badgeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushBadgeWithRetry = useCallback((attemptsLeft: number): void => {
    const badge = window.dshChamber?.badge
    // typeof 守卫（review C1）：与设置页 testNotifySurface 同款版本偏斜防护——
    // 旧主进程 + 新渲染端的窗口重建窗口内 badge 面可能缺失 set 方法。
    if (badge === undefined || typeof badge.set !== 'function') return
    void badge.set(badgeCountRef.current).catch(error => {
      if (attemptsLeft <= 0) {
        console.warn('[badge] 徽标计数推送失败：', error)
        return
      }
      badgeRetryTimerRef.current = setTimeout(
        () => pushBadgeWithRetry(attemptsLeft - 1),
        LISTENER_READY_RETRY_MS,
      )
    })
  }, [])
  useEffect(() => {
    const count = projectBadgeCount(completedBySource, runtimeFacts)
    badgeCountRef.current = count
    pushBadgeWithRetry(LISTENER_READY_RETRY_LIMIT)
  }, [completedBySource, runtimeFacts, pushBadgeWithRetry])

  // 桥迟到的兜底（同 LISTENER_READY 重试纪律，见通知就绪手shake）：窗口重载/
  // 重建后 completedBySource 复位为 {}，必须向主进程推 0 清除遗留徽标——桥经
  // requestAppInfo 异步暴露，可能晚于首个 [completedBySource, runtimeFacts]
  // effect 的提交时机（该 effect 在挂载帧即推 0，此时桥大概率未就绪）。有界重试
  // 直至桥出现，推一次当前计数（0）后停止；预算耗尽静默放弃（dev 无桥场景的
  // 正常路径）。
  useEffect(() => {
    if (window.dshChamber?.badge !== undefined) return
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      const badge = window.dshChamber?.badge
      if (badge !== undefined && typeof badge.set === 'function') {
        clearInterval(timer)
        pushBadgeWithRetry(LISTENER_READY_RETRY_LIMIT)
        return
      }
      if (attempts >= LISTENER_READY_RETRY_LIMIT) clearInterval(timer)
    }, LISTENER_READY_RETRY_MS)
    return () => clearInterval(timer)
  }, [pushBadgeWithRetry])

  // reject 重推计时器的卸载清理（挂载期内可能由 pushBadgeWithRetry 排入）。
  useEffect(() => () => {
    if (badgeRetryTimerRef.current !== null) clearTimeout(badgeRetryTimerRef.current)
  }, [])

  // 控制面失联 = 覆盖式致命屏（视图保持挂载、恢复即续会话，05 §4）。判定：
  // 健康错误**持续**存在超过宽容窗才呈现——首帧（health 从未拉到）立即呈现；
  // 会话中途则要求错误持续 HEALTH_ERROR_GRACE_MS（容忍 SSE 重连/瞬时抖动的
  // 一次失败，避免闪烁），否则陈旧 health 会永远掩盖中途失联。ticker 只在该
  // 条件下运行，正常态零开销。
  /**
 * How long a boot's host-graph fetch may wait for its source to start serving
 * (2026-09-10). SINGLE-SOURCED from the boot budget on purpose: the same 60s
 * sizes the shell's page-level slot (`boot-budget.ts`), the prewarm harvest
 * deadline (`HARVEST_DEADLINE_MS = budget + 15s`) and the mount abandonment
 * threshold (`HARVEST_ABANDON_MS = deadline + budget`). A hand-written number
 * here would silently drift out of that ladder (the "same fact twice" failure
 * this repo already paid for elsewhere) — worst case the gate would outlive the
 * abandonment sweep and the failure overlay would race a still-waiting boot.
 */
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

  // 活动视图的 shell 失败报告（05 §4 失败呈现修订）：boot 失败 settle 后由
  // InstanceView 上报终态；只有失败态（error 非空）触发覆盖层——booting/
  // 成功态由骨架屏/真实 UI 呈现。
  const activeShellState = shellStates[activeView]
  const activeShellError = activeShellState?.error ?? null
  // T15 (2026-09-11 upstream-alignment): the failed boot's plugin ids, as the
  // official report lists them (shell.ts collectFailedEntries reads the failed
  // boot's own loader sweep). Empty for failures that produced no loader entry
  // (module-system/manifest), which keeps today's report-only overlay.
  const activeShellFailedEntries = activeShellState?.failedEntries ?? NO_FAILED_ENTRIES
  // 降级呈现（2026-12, 05 §4）：活动视图 boot 成功但已知缺口时，给出现场说明。
  // 只有 error 为空的降级态才渲染——boot 失败覆盖层已独占失败态（结构互斥，
  // 见 shell.ts：settled 的 degraded 蕴含 booted && error === null）。**但控制面
  // 不可达覆盖层与壳状态无关**，上面的条件管不住它，故渲染处再加一道
  // `!controlUnreachable`：否则横幅会被那张不透明覆盖层盖住却仍可聚焦/播报
  // （2026-12 review MINOR）。
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
      })

  return (
    <ErrorBoundary>
      <div className="app">
        {/* 视图始终挂载：致命屏改为覆盖层——卸载视图而不 dispose shell 会
            遗留僵尸 ctx（entries 被新 boot 覆盖、旧 ctx 永不清除，违反
            05 §4 无僵尸不变量），且恢复后要重 boot 丢会话连续性。 */}
        {mountedViews.map((viewId) => {
          const sourceFingerprint = sourceLifecyclesRef.current!.capture(viewId)?.fingerprint
          const transport = servers.find(server => server.id === viewId)?.transport
          if (sourceFingerprint === undefined || transport === undefined) return null
          /**
           * 2026-09-11 review S1: the "nothing legitimate on screen" input of the
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
              active={activeView === viewId}
              label={serverLabels[viewId] ?? (viewId === LOCAL_INSTANCE_ID ? t('source.local') : viewId)}
              locale={locale}
              onSettled={handleInstanceSettled}
              onStateChange={handleShellState}
              retryToken={retryTokens[viewId]}
              waitForServing={waitForServing}
              // chamber (2026-12, design 05 §2.2 revision): the reveal gate. The
              // boot window is covered by the view's own `!settled` veil; this
              // boolean extends the hold past a clean settle for exactly as long
              // as the shell would NOT show the requested session. Every input
              // lives in the App: the shell's settled/failed mirror, the RAW
              // runtime current (never the gated projection value — the gate
              // exists to hide that very value) and that view's own blank flag
              // (blankCurrent, below).
              //
              // Deliberately NOT "any pending open": a view that already shows
              // the requested session (idempotent re-open, or the boot-ctx
              // early-open arm having preempted the runtime's initial selection)
              // must not veil at all, and a warm visible shell that is switching
              // between two REAL sessions resolves synchronously — holding a veil
              // there would hide a working UI for no reason.
              //
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
                {t(activeBootGap.autoRetryArmed ? 'bootGap.action.autoRetry' : 'bootGap.action.manual')}
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
