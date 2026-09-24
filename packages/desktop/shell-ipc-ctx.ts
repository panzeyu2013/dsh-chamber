/**
 * ShellIpcCtx — the context handed to the domain IPC registrars (shell-ipc-*.ts).
 *
 * Extracted from shell-core.ts (R4 P7 type-cycle break): shell-core.ts imports
 * the registrars, and the registrars import this context type, so it cannot
 * live in shell-core.ts without recreating the type cycle. Leaf module: it must
 * never import './shell-core.ts' or a shell-ipc-* registrar.
 *
 * The fields are structural on purpose: the registrar only needs these shapes,
 * so shell-core's single construction point (with its getter object) stays the
 * one wiring site.
 */
import type { ChamberSettings, ChamberSettingsStatus } from './chamber-settings.ts';
import type { BoundedAckDeliveryQueue, VscodeLaunchRequest } from './deep-link.ts';
import type { DshRuntimeController } from './dsh-runtime-controller.ts';
import type { HostEdges } from './host-edges.ts';
import type { NotificationOpenIntent, NotificationSourceIncarnations, BoundedRateLimiter } from './notifications.ts';
import type { NotificationSourceToken } from './notifications.ts';
import type { OpenInLaunchContext } from './open-in.ts';
import type { ChamberHostPackageSeed, PluginProtectionFacts } from './plugin-sync.ts';
import type { ProjectedRegistryInstance } from './registry-projection.ts';
import type { IpcRegistrar, ShellAssemblyCtx } from './shell-assembly-ctx.ts';
import type { TransportInstanceSpec } from './transport-provider.ts';

/** 渲染器投递状态机的可变三态（shell-ipc-settings.ts 经 ctx.state 读写；
 *  单一权威，destructure 拷贝会使深链/徽标就绪位失联）。 */
export interface ShellMutableState {
  notificationOpenDrainReady: boolean
  deepLinkRendererReady: boolean
  pendingBadgeCount: number | null
}

/** 渲染器深链 intent 的队列载荷（成功启动 VS Code 后的来源代际快照）。 */
export type RendererVscodeIntent = VscodeLaunchRequest & {
  sourceId: string
  sourceFingerprint: string
  sourceGeneration: number
}

/** installIpcHandlers 的注入参数（ipc 注册面 + 收窄的 edges 子集 + 装配 ctx）。 */
export interface ShellIpcDeps {
  ipc: IpcRegistrar
  edges: Pick<
    HostEdges,
    | 'rendererPush'
    | 'showNativeNotification'
    | 'notificationSupported'
    | 'setBadge'
    | 'badgeCountApiAvailable'
    | 'isFocused'
    | 'onSystemResume'
    | 'onMainWindowShown'
    | 'mainWindowAlive'
    | 'webViewLoading'
    | 'webViewContentAlive'
    | 'showMessage'
    | 'pickPluginSource'
    | 'openExternal'
    | 'openPath'
    | 'showItemInFolder'
    | 'showError'
  >
  ctx: ShellAssemblyCtx
}

/** Context for the domain registrars: the ShellAssemblyCtx deps plus the
 *  shared local helpers/module state they close over. */
export interface ShellIpcCtx {
  deps: ShellIpcDeps
  MACOS_NOTIFICATION_SETTINGS_URL: string
  NPM_SEARCH_MAX_BODY_BYTES: number
  applyBadgePresentation: (count: number) => boolean
  applySettingsPatch: (patch: Partial<ChamberSettings>) => Promise<{ ok: true } | { ok: false; error: string }>
  captureVscodeSource: (instanceId: string) => NotificationSourceToken | null
  chamberSettingsStatus: () => ChamberSettingsStatus
  confirmPluginAction: (copy: { message: string; detail: string }) => Promise<{ ok: true } | { ok: false; error: string } | { cancelled: true }>
  confirmRuntimeMutation: (message: string, detail: string, confirmLabel: string) => Promise<boolean>
  deepLinkRendererReady: boolean
  drainPendingNotificationOpens: () => boolean
  drainPendingRendererDeepLinkIntents: () => boolean
  enqueueNotificationOpen: (sourceToken: NotificationSourceToken, sessionId: string) => void
  enqueueRendererDeepLinkIntent: (intent: VscodeLaunchRequest, sourceToken: NotificationSourceToken) => void
  localProtectionFacts: () => PluginProtectionFacts
  matchesNotificationSource: (sourceId: string, fingerprint: string) => boolean
  nativeNotificationRateLimiter: BoundedRateLimiter
  notificationOpenDrainReady: boolean
  notificationSourceIncarnations: NotificationSourceIncarnations
  openInCtx: OpenInLaunchContext
  ownsNotificationSource: (token: NotificationSourceToken) => boolean
  pendingBadgeCount: number | null
  pendingNotificationOpens: BoundedAckDeliveryQueue<NotificationOpenIntent>
  pendingRendererIntents: BoundedAckDeliveryQueue<RendererVscodeIntent>
  projectInstances: (instances: readonly TransportInstanceSpec[]) => ProjectedRegistryInstance[]
  pushSettingsChanged: () => void
  quittingLeaf: () => boolean
  reconcileBadgeCount: () => void
  runRuntimeCheck: () => Promise<ReturnType<DshRuntimeController['getState']>>
  verifyLocalProfileFamily: (facts: PluginProtectionFacts) => { ok: true } | { ok: false; error: string }
  portableHostSeeds: () => readonly ChamberHostPackageSeed[]
  version: string
  state: ShellMutableState
}
