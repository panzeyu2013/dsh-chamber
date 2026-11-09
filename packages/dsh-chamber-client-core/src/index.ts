/** chamber client-core shared faces: the instance unary client, the chamberBridge singleton, the
 * control-plane REST client, and the gateway dsh-runtime core.
 * The `.` face is the production-consumed surface list, not a barrel: a runtime value
 * only a test needs is not a public face (judged by `verify-no-dead-exports`), and a new production
 * consumer adds its face here in the same change. `archive-purge.ts` belongs to the sidebar. */

export type * from './instance-api.ts'
export type * from './instance-rpc-error.ts'
export { InstanceRpcError } from './instance-rpc-error.ts'
export { InstanceDomainMissingError, MutationOutcomeUnknownError, ResponseLostError, archiveSession, createHostDirectory, createSession, createWorkspace, deleteWorkspace, emptyAggregate, fetchInstanceSnapshot, forkSession, getInstanceClient, insertSessionBefore, insertWorkspaceBefore, isInstanceUnavailable, listHostDirectory, purgeArchivedSessions, releaseInstanceClient, renameSession, renameWorkspace, searchSessions, stopSessionsForPurge } from './instance-api.ts'
export type * from './workspace-mutations.ts'
export { createWorkspaceForSource, deleteWorkspaceForSource, renameWorkspaceForSource } from './workspace-mutations.ts'
export type * from './wire-common.ts'
export { classifyGraphChannelFailure, isRecord, mintRpcId, postUnary } from './wire-common.ts'
export type * from './wire-error.ts'
export { throwIfInstanceUnavailable, wrapWireError } from './wire-error.ts'
export type * from './control-plane-client.ts'
export { controlPlaneUrl, post, request, subscribeHostHealth, toConnectionSummary, toLocalWriterDiagnosis } from './control-plane-client.ts'
export type * from './aggregate-store.ts'
export { SOURCE_PHASE_UNKNOWN, chamberBridge, isValidProducerSourceFingerprint } from './aggregate-store.ts'
export type * from './client-plugin-loader.ts'
export { BundleLoadTimeoutError, clientPluginRowOwner, dedupeCoveredRows, loadClientPluginRows } from './client-plugin-loader.ts'
export type * from './plugin-graph-recheck.ts'
export { isChannelClassDiagnostic, recheckPluginGraphDiagnostic } from './plugin-graph-recheck.ts'
export type * from './settings-shell.ts'
export { SETTINGS_SHELL_ENTRY_ID, SETTINGS_SHELL_SHADOW_PRIORITY, classifySettingsSeatOccupant, settingsSeatTakeoverMessage } from './settings-shell.ts'
export type * from './derive.ts'
export { BLANK_GHOST_GRACE_MS, SEARCH_QUERY_MAX_CODE_UNITS, armBlankGhost, basenameOf, canonicalPathKey, deriveArchivedSessions, deriveLocalSearchMatches, deriveServerWorkspaces, gapSignature, groupArchivedRows, increasedForkTitle, instanceSnapshotSignature, mergeRuntimeFacts, mergeSearchResults, nextServerOrder, nextUpdatedOrder, orderServersForDisplay, orderUngroupedSessions, projectInstanceSnapshot, projectRuntimeFacts, reconciledSessionOrder, relativeTimeBucket, runningRingVisible, runtimeReportSignature, sanitizeSearchQuery, serversProjectionSignature, sessionDisplayTitle, sourceAccentColor, workspaceAccentStyle } from './derive.ts'
// Checkout-row placement leaf (design 08 PR2): derive owns visibility, this leaf
// owns identity/placement. `orderCheckoutRows`/`checkoutRowId` stay on the
// ./checkout-placement subpath (the sidebar drag consumes them there).
export type * from './checkout-placement.ts'
export { checkoutOrderKey, checkoutPathKey, checkoutWorkspaceOf, parseCheckoutOrderKey, pathIsWithin, planCheckoutPlacements } from './checkout-placement.ts'
export { cachedServersProjectionSignature, createChamberProjectionSignatureCache, rememberServersProjectionSignature, type ChamberProjectionSignatureCache } from './projection-signature-cache.ts'
export type * from './projection-signature-cache.ts'
// 仅开发档（devtools 页面全局）的页面渲染计数器（design 05 §3）：发布栅与投影派生各记
// 一处；读面是 `globalThis.__dshChamberRenderCounters`，不是用户可见 UI、不持久化。
export type * from './render-counters.ts'
export { countChangedProjectionSources, recordProjectionPublish, recordSidebarRowDerivations } from './render-counters.ts'
export type * from './completion-arm.ts'
export { stepCompletionArm, sameTrueTable } from './completion-arm.ts'
export type * from './workspace-echo.ts'
export type * from './workspace-tree.ts'
export { FLAT_ACCOUNT_KEY } from './flat-account.ts'
export type * from './pin-partition.ts'
export { partitionPinnedSessions } from './pin-partition.ts'
export { workspaceTreeDepths, workspaceTreeParents } from './workspace-tree.ts'
export { forgetPendingWorkspaces, reconcilePendingWorkspaces, recordPendingWorkspace, removePendingWorkspace, renamePendingWorkspace, sweepPendingWorkspaces, withWorkspaceEcho } from './workspace-echo.ts'
// 位置意图（pre-create 半边）：宿主 create 的 PREPEND 短暂态在回声能存在之前就已渲染。
export type * from './workspace-placement.ts'
export { forgetPendingPlacements, reconcilePendingPlacements, recordWorkspacePlacement, removePendingPlacement, removeUnclaimedPlacements, sweepPendingPlacements, withWorkspacePlacements } from './workspace-placement.ts'
// 删除意图（pre-delete 半边）：宿主删除的 order 帧把被删行沉到列表尾部（pinned client store 的
// unranked-sink），本账本在**观察到下沉**的那一帧把它摘掉，权威 remove 帧再带走行。
export type * from './workspace-removal.ts'
export { forgetPendingRemovals, reconcilePendingRemovals, recordPendingWorkspaceRemoval, removePendingWorkspaceRemoval, sweepPendingRemovals, withoutPendingWorkspaceRemovals } from './workspace-removal.ts'
export type * from './session-echo.ts'
export { forgetPendingArchives, forgetPendingSessions, reconcilePendingArchives, reconcilePendingSessions, recordPendingArchive, recordPendingSession, refreshPendingArchives, removePendingArchive, removePendingSession, sweepPendingArchives, sweepPendingSessions, voidPendingSessionPlacement, withPendingArchives, withSessionEcho } from './session-echo.ts'
export type * from './session-restore.ts'
export { onSessionRestored } from './session-restore.ts'
export type * from './session-row-state.ts'
export { sessionRowState, subagentActivityOf } from './session-row-state.ts'
export { sessionOpenPromiseInFlight } from './session-open.ts'
export type * from './session-create-ledger.ts'
export { publishSessionCreationInstrument, sessionCreationLedger } from './session-create-ledger.ts'
export type * from './session-mutations.ts'
export { archiveSessionForSource, createSessionForSource, forkSessionForSource, pinSessionForSource, unarchiveSessionForSource, unpinSessionForSource } from './session-mutations.ts'
export type * from './open-intent.ts'
export { EARLY_OPEN_BUDGET_MS, EARLY_OPEN_RETRY_MS, armOpenIntent, clearOpenIntents, getOpenIntent, getOpenIntentsSnapshot, projectableCurrent, releaseOpenIntent, shouldEarlyOpenSession, shouldHoldViewVeil, subscribeOpenIntent } from './open-intent.ts'
export type * from './gateway-runtime.ts'
export { REMOTE_PHASES, REMOTE_RESTART, REMOTE_RUNTIME_CONTROL_TIMEOUT_MS, REMOTE_SOURCES, REMOTE_STATUS_POLL_TIMEOUT_MS, fetchRemoteRuntimeStatus, fetchRemoteRuntimeVersions, pollRemoteRuntimeUntilSettled, remoteRuntimeAction, remoteRuntimeActionGates, remoteRuntimeControl, remoteRuntimeSetRegistry, resetRemoteRuntimeActivityOwners } from './gateway-runtime.ts'
export type * from './gateway-runtime-poll.ts'
export { pollGatewayReady } from './gateway-runtime-poll.ts'
export type * from './managed-runtime.ts'
export { MANAGED_RUNTIME_TRANSIENT_STATES, fetchManagedRuntimeState, managedRuntimeDown, managedRuntimeUnusable } from './managed-runtime.ts'
export type * from './runtime-refusal.ts'
export { classifyRuntimeRefusal, serverRefusalText } from './runtime-refusal.ts'
export type * from './error-text.ts'
export { describeThrown, errorMessage } from './error-text.ts'
export type * from './listener-set.ts'
export { createListenerSet } from './listener-set.ts'
export type * from './boot-gap-shape.ts'
export { bootGapShape } from './boot-gap-shape.ts'
export type * from './view-prefs.ts'
export { clearSourceBookkeeping, flushScheduledActivityWrites, getViewPrefs, scheduleUpdatedOrderWrite, subscribeViewPrefs, updateViewPrefs } from './view-prefs.ts'
export type * from './search-state.ts'
export { clearSearch, collapseSearch, expandSearch, getSearchStates, setSearchFetcher, setSearchQuery, subscribeSearch } from './search-state.ts'
export type * from './pending-click.ts'
export { clearPendingClick, isClickInsidePendingRow, noteSessionRowClick } from './pending-click.ts'
export type * from './hover-intent.ts'
export { HOVER_OPEN_DELAY_MS, createHoverIntent, dismissVisibleRowCard } from './hover-intent.ts'
export type * from './prewarm-intent.ts'
export { createPrewarmIntent, emptyIntentPrewarmBudget, intentPrewarmAllowed, intentPrewarmSpent, prioritizePrewarmSource } from './prewarm-intent.ts'
export type * from './workspace-git-flags.ts'
export { clearWorkspaceGitFlags, getSourceRepoLayouts, getWorkspaceGitFlag, getWorkspaceGitFlagsVersion, hiddenByMainWorkspaceFold, isSourceGitFlagsLoaded, markSourceGitFlagsLoaded, retainSourceWorkspaceFlags, setSourceRepoLayouts, setWorkspaceGitFlag, subscribeWorkspaceGitFlags } from './workspace-git-flags.ts'
export type * from './workspace-drag-order.ts'
export { resolveWorkspaceDrop } from './workspace-drag-order.ts'
export type * from './todo-attention.ts'
export { deriveTodoAttention } from './todo-attention.ts'
export type * from './todo-prefs.ts'
export { getTodoPrefs, subscribeTodoPrefs } from './todo-prefs.ts'
// 证据有效性层（design 14 §D4）：只有**生产消费**面经桶导出——`hadSchedulingGap` 与
// `startPageScheduleProbe` 被 renderer/侧栏/reconcile 消费，`recordEvidence` 被四处截止判定
// 消费；其余（探针注入点、快照/复位、账本读回与键名）是本模块与其测试的内部面，测试直接
// import 子路径（与 forensics 的内部面同规，见 verify:no-dead-exports 的判定口径）。
export type * from './page-schedule.ts'
export { hadSchedulingGap, startPageScheduleProbe } from './page-schedule.ts'
export type * from './evidence-log.ts'
export { recordEvidence } from './evidence-log.ts'
// 页面级多路复用通道（design 26）：页面**唯一**的长连接。只有生产消费面经桶导出——
// 两个符号分别被 renderer/main.tsx 与 api.ts、settings-connections 消费；常数、socket
// 注入面与测试复位面留在模块与其子路径（测试直接 import './page-channel.ts'，与
// page-schedule / evidence-log 同规，见 verify:no-dead-exports 的判定口径）。
export type * from './page-channel.ts'
export { subscribePageChannel, installPageChannelEventSourceAudit, configurePageChannelLink } from './page-channel.ts'
export { linkEpochOf, linkReady } from './link-projection.ts'
// 页面级插件刷新请求（design 09 §3.7 / design 15 §6）：设置面按来源请求一次
// 客户端插件图重同步。请求面只经桶导出，两个符号分别被 renderer 的桥订阅与
// settings-bridge 的重试动作消费（fan-out 复用 aggregate-store 的 createChannel）。
export type * from './plugin-refresh-requests.ts'
export { onClientGraphResyncRequest, requestClientGraphResync } from './plugin-refresh-requests.ts'
// 常驻壳页面级单例（N-ctx 壳常驻 v1.1）：常驻阀发布快照，设置面的性能与内存面板订阅并发出
// 释放命令。只有一个运行时符号经桶导出；快照/事实/释放类型走同批的 `export type *` 面。
export type * from './resident-store.ts'
export { residentBridge } from './resident-store.ts'
// 页面级面板轴（N-ctx 多实例）：每个挂载壳的侧栏发布本 ctx 的 sidebar.panellist 条目快照，
// 任意壳的侧栏读取它（非活动来源的 server 头也显示该来源自己的面板入口）；选中是「切到目标
// 来源后由目标壳自己执行 selectPanel」的一次性意图通道（目标壳未挂载时 pending + TTL）。
// 唯一生产消费者是 sidebar 包（发布/订阅/选中意图）；测试直接 import './panel-axis.ts'
// （本模块的内部复位面不经桶导出）。
export type * from './panel-axis.ts'
export { PANEL_SELECT_INTENT_TTL_MS, consumePanelSelect, getPanelAxesSnapshot, onPanelSelectRequest, publishPanelAxis, requestPanelSelect, retirePanelAxis, subscribePanelAxes } from './panel-axis.ts'
