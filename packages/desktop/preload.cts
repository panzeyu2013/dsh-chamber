import type { IpcRendererEvent } from 'electron';
import type {
  TransportInstanceInput as SshInstanceInput,
  TransportInstanceSpec as RegistrySshInstanceSpec,
  TransportLogEntry as SshLogEntry,
  TransportStatusProjection as SshStatusProjection,
} from './transport-provider.ts';
import type { SshConfigDiscovery } from './ssh-config.ts';
import type { UpdateState } from './updater.ts';
import type { RuntimeState } from './dsh-runtime-controller.ts'
import type { PluginRow as PluginRowProjection } from '@dsh-chamber/dsh-chamber-client-core/plugin-row';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Desktop-carrier IPC channels (upstream apps/desktop/src/ipc.ts DESKTOP_IPC
 * subset). Duplicated literals are deliberate: the sandboxed preload build is a
 * self-contained CJS file (build-preload.mjs) and cannot import the main-side
 * single source DESKTOP_SHORTCUTS_CHANNELS (shortcuts-bridge.ts). The lockstep
 * test is test/ipc/desktop-carrier-surface.test.ts.
 */
const DESKTOP_SHORTCUTS_CHANNELS = {
  GET: 'dsh-desktop:shortcuts-get',
  EDIT: 'dsh-desktop:shortcuts-edit',
  RECORDING: 'dsh-desktop:shortcuts-recording',
  CLOSE_WINDOW: 'dsh-desktop:shortcuts-close-window',
  INPUT: 'dsh-desktop:shortcuts-input',
  CHANGED: 'dsh-desktop:shortcuts-changed',
} as const;

// Keep preload runtime self-contained: importing a value from a TypeScript ESM
// module crosses the emitted CommonJS preload boundary. This strict mirror is
// intentionally local; main remains authoritative for the delta contents.
const INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/;

/**
 * Windows caption seat (upstream preload-windows.ts + windows-layout.ts): the
 * official Windows branch of the Web UI keys off html[data-windows-titlebar]
 * and this height variable, while the main process hides the system titlebar
 * and draws its own overlay. Mirrored value, not imported: the preload runtime
 * stays self-contained; upstream-seats.test.ts pins both copies equal.
 */
const WINDOWS_TITLEBAR_HEIGHT = 40;
function markWindowsTitlebar(): void {
  if (process.platform !== 'win32') return;
  if (typeof document === 'undefined' || document === null || document.documentElement === undefined) return;
  const mark = (): void => {
    const root = document.documentElement;
    root.dataset.windowsTitlebar = '';
    root.style.setProperty('--dsh-windows-titlebar-height', WINDOWS_TITLEBAR_HEIGHT + 'px');
  };
  const root = document.documentElement as HTMLElement | null;
  if (root === null) window.addEventListener('DOMContentLoaded', mark);
  else mark();
}
const REMOTE_SOURCE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

function validSourceFingerprint(sourceId: string, value: unknown): value is string {
  return sourceId === 'local'
    ? value === 'local'
    : REMOTE_SOURCE_FINGERPRINT_PATTERN.test(typeof value === 'string' ? value : '');
}

function validDeliveryCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** Main-process registry projection. sourceFingerprint is an opaque,
 * non-persisted lifecycle proof and is never accepted as registry data. */
export interface SshInstanceSpec extends RegistrySshInstanceSpec {
  sourceFingerprint: string
  sshPasswordSet?: boolean
  tokenSet?: boolean
  passwordSet?: boolean
  secretStorage?: 'safeStorage' | 'plaintext'
  /** Cross-flavor projection (see renderer global.d.ts). */
  secretStorageUnreadable?: boolean
}

export interface ConnectionCredentialMutations {
  sshPassword?: string
  gatewayToken?: string
  gatewayPassword?: string
}

export type SaveConnectionResult =
  | { ok: true; instances: SshInstanceSpec[] }
  | { ok: false; instances: SshInstanceSpec[]; error: string; metadataCommitted: boolean }

/** SSH instance-registry load health (degraded + roster-incomplete gates):
 *  while degraded, an instances_get empty array is NOT an authoritative
 *  roster and the renderer keeps its durable pruning gate closed; while
 *  rosterIncomplete (V5-A), the load succeeded but dropped invalid/duplicate
 *  persisted rows, so instances_get is a PARTIAL roster — its legal rows are
 *  installed, yet durable pruning stays vetoed. reason is the non-secret
 *  failure text (absent while healthy); droppedCount is the number of dropped
 *  rows and is present only with rosterIncomplete. Both flags are optional so
 *  an older producer's {degraded} answer still type-checks (the renderer
 *  treats an absent flag as false). */
export interface SshInstancesHealth {
  degraded: boolean
  reason?: string
  rosterIncomplete?: boolean
  droppedCount?: number
}

/**
 * The window.dshChamber bridge contract (design 05 §7.4) — the typed
 * surface the renderer consumes. Its returns/events/projections are non-secret:
 * never a transport URL or credential material. The sole credential-bearing
 * direction is save_connection's transient write-only input. onStatusChanged
 * subscribes to the main-process push and returns an unsubscribe. The
 * provider exec channels (ssh: systemd) resolve the fresh status projection
 * (serviceActive included) or {error} — loud failures, never silent empty
 * success.
 */
export interface DesktopSshSurface {
  instances_get(): Promise<SshInstanceSpec[]>
  /** Registry load health (degraded + roster-incomplete gates): a degraded
   *  registry's empty roster must not settle the renderer's authoritative-
   *  roster gate, and an incomplete (row-dropping) load's partial roster must
   *  not retire its durable unread keys. */
  instances_health(): Promise<SshInstancesHealth>
  /** Exact id-addressed main-owned delete; an absent id is an idempotent no-op. */
  delete_connection(id: string): Promise<SshInstanceSpec[]>
  /** Main-owned registry + write-only credential transaction. */
  save_connection(previousId: string | null, input: SshInstanceInput, credentials: ConnectionCredentialMutations): Promise<SaveConnectionResult>
  /**
   * Explicitly clear the SSH password. Non-empty writes are authoritative
   * only through save_connection's main-owned transaction.
   */
  set_password(id: string, password: null): Promise<{ ok: true } | { error: string }>
  /**
   * Explicitly clear the gateway token; non-empty writes use save_connection.
   */
  set_gateway_token(id: string, token: null): Promise<{ ok: true } | { error: string }>
  /**
   * Explicitly clear the gateway login password; non-empty writes use
   * save_connection. Clearing also invalidates cached login sessions.
   */
  set_gateway_password(id: string, password: null): Promise<{ ok: true } | { error: string }>
  /**
   * Re-run the chamber-plugin seed-cache sync on a gateway instance's
   * registered transport (design 21 §6.5) — the same sync the ready
   * registration performs automatically; id-only, never a URL or credential.
   */
  gateway_plugin_sync(id: string): Promise<GatewayPluginSyncIpcResult>
  /** ~/.ssh/config discovery: non-secret host projections or {error}. */
  config_list(): Promise<SshConfigDiscovery>
  connect(id: string): Promise<SshStatusProjection | null>
  disconnect(id: string): Promise<SshStatusProjection | null>
  status(id: string): Promise<SshStatusProjection | null>
  /** On-demand ready-state re-verification (user activation of a source/
   *  session): main runs one identity probe for a READY transport and
   *  returns the fresh status projection. */
  reverify(id: string): Promise<SshStatusProjection | null>
  logs(id: string): Promise<SshLogEntry[]>
  logs_clear(id: string): Promise<boolean>
  start_service(id: string): Promise<SshExecIpcResult>
  stop_service(id: string): Promise<SshExecIpcResult>
  is_active(id: string): Promise<SshExecIpcResult>
  /** Restart the remote systemd service (design 13 M2): fresh projection or {error}. */
  restart_service(id: string): Promise<SshExecIpcResult>
  /** Read the remote instance's plugin manifest (design 13 §4.1). */
  plugin_list(id: string): Promise<SshRemotePluginListResult>
  /** Read the LOCAL instance's plugin manifest (design 13 §4.1). */
  local_plugin_list(): Promise<SshLocalPluginListResult>
  /** Seed module A onto a remote instance (design 13 §3, 09 遗留 1). */
  seed_host_graph(id: string): Promise<SshSeedHostGraphResult>
  onStatusChanged(callback: (payload: SshStatusChangedPayload) => void): () => void
  /** Registry changed via the main-owned save/delete transaction. The
   * synchronous delta retires exact source generations before async re-pull. */
  onInstancesChanged(callback: (payload: InstancesChangedPayload) => void): () => void
}

/** Main-process push payload for status changes ({id, status projection}). */
export interface SshStatusChangedPayload {
  id: string
  status: SshStatusProjection
}

/** Authoritative synchronous registry delta accompanying a roster refresh. */
export interface InstancesChangedPayload {
  removedIds: string[]
  retiredIds: string[]
}

/** Remote systemd exec result over IPC: the fresh projection or {error}. */
export type SshExecIpcResult = SshStatusProjection | { error: string }

/** Chamber-owned host packages installed into and loaded by one dsh profile. */
/** One chamber host package's per-target state — mirror of plugin-sync.ts
 *  (the wire producer) and the renderer's global.d.ts. The expected package
 *  set is the control-plane registry, so a new host package appears in the
 *  plugin-management page without a UI change. */
export interface ChamberHostPackageState {
  insertId: string
  name: string
  probe: string
  installed: boolean
  patched: boolean
  version: string | null
  live: boolean | null
  /** The registry row is meaningful for the LOCAL instance shape only (design
   *  20 §6: the open-in host domain). The ssh PROBE reports it as
   *  `installed:false`/`patched:false` without ever asking the remote ("not
   *  asked", never "the target lacks it"), while the desktop's own projection
   *  carries the real local state; whichever projection delivered the row, the
   *  plugin table OMITS it on every non-local target (it is listed for the
   *  local shape alone). Absent = an ordinary row. */
  localOnly?: boolean
}
/** Chamber-injected component state (design 09): ok:false = unreadable (loud,
 *  never a silent "not injected"). The preload mirror of plugin-sync.ts /
 *  renderer global.d.ts — the L3 lockstep test guards shape drift. */
export type ChamberInjectionState =
  | { ok: true; packages: ChamberHostPackageState[] }
  | { ok: false; error: string }
/**
 * One read-face plugin row (design 21 §6.11.5): one row per profile dependency,
 * carrying the backend-computed role and `protected` flag (the renderer never
 * re-derives protection). The installation baseline (B₀) and the chamber seed
 * registry (S) only classify rows; they are not projected as installed plugins.
 *
 * The field set has ONE definition — the wire `./plugin-row` face — reached
 * through client-core's pass-through face (`@dsh-chamber/dsh-chamber-client-core/
 * plugin-row`). The import is type-only by construction, so `build:preload`
 * erases it and `dist/preload.cjs` carries no specifier; this file must never
 * re-declare the fields (C14 asserts both).
 */
export type { PluginRowProjection }

/** Remote plugin manifest projection (design 13 §4.1). */
export interface SshRemotePluginManifest {
  dependencies: Record<string, string>
  /** Read-face row projection (design 21 §6.11.5). */
  rows: PluginRowProjection[]
  profileExists: boolean
  error?: string
  /** Chamber-injected component state (design 09), probed over the wire —
   *  mirror of plugin-sync.ts (the wire producer); renderer global.d.ts
   *  mirrors the same shape. */
  chamber: ChamberInjectionState
}
export type SshRemotePluginListResult =
  | { ok: true; manifest: SshRemotePluginManifest }
  | { ok: false; error: string }

/** Local plugin manifest projection (design 13 §4.1). */
export interface SshLocalPluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
  rows: PluginRowProjection[]
  clientLines: string[]
  unsyncable: { name: string; reason: string }[]
  chamber: ChamberInjectionState
}
export type SshLocalPluginListResult =
  | { ok: true; manifest: SshLocalPluginManifest }
  | { ok: false; error: string }

/** Host-graph seed outcome (design 13 §3). */
export type SshSeedHostGraphResult =
  | { ok: true; wrote: boolean; patched: boolean }
  | { ok: false; error: string }

/** Manual chamber-plugin sync outcome (design 21 §6.5): the seed-cache sync
 *  the gateway ready registration performs automatically, re-run on demand.
 *  ok:true carries the same {uploaded, skipped} projection as the auto path;
 *  ok:false is loud (no ready registration / instance gone / sync error). */
export type GatewayPluginSyncIpcResult =
  | { ok: true; uploaded: boolean; skipped: boolean }
  | { ok: false; error: string }

/**
 * The dsh-chamber update surface (design 11) — non-secret only: versions,
 * channel, a release-page URL, a short error text. state() resolves the
 * current snapshot; onChanged subscribes to the main-process push and
 * returns an unsubscribe; check() is the user-initiated「检查更新」action
 * (same silent check path as the startup/6h checks — never downloads);
 * download() is the user-confirmed download action (the「更新」button) —
 * checking itself never downloads (autoDownload=false); restartAndInstall()
 * is the user-triggered「重启并安装」action once the download completed —
 * the main process runs electron-updater quitAndInstall (quit + install +
 * relaunch through the normal quit path).
 */
export interface UpdateSurface {
  state(): Promise<UpdateState>
  /** User-initiated check (the「检查更新」button). */
  check(): Promise<{ ok: true } | { ok: false; error: string }>
  download(): Promise<{ ok: true } | { ok: false; error: string }>
  /** Restart into the downloaded update (the「重启并安装」button). */
  restartAndInstall(): Promise<{ ok: true } | { ok: false; error: string }>
  onChanged(callback: (state: UpdateState) => void): () => void
  /** Open a release page in the system browser (main-process allowlisted). */
  openReleasePage(url: string): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * The dsh-chamber settings surface (design 14 D7) — chamber-GLOBAL runtime
 * settings owned by the main process (<userData>/chamber-settings.json),
 * non-secret only. get() resolves the current projection (settings +
 * platform capability gates); set() applies + persists + pushes; onChanged
 * subscribes to the main-process push and returns an unsubscribe.
 */

/** Close-window behavior (design 14 D1): hide to tray (dsh keeps running) or quit. */
export type WindowCloseBehavior = 'hide-to-tray' | 'quit'

/** Chamber-global runtime settings (design 14 v1 scope). */
export interface ChamberSettings {
  windowCloseBehavior: WindowCloseBehavior
  /** Login autostart (design 14 D6): darwin/win32/linux (design 21 M4). */
  launchAtLogin: boolean
  /** prevent-app-suspension (design 14 D5); default off. */
  keepAwake: boolean
  /** Quit confirmation (design 14 D2): confirm only while the local dsh
   *  instance runs; remote tunnels never prompt. Default on. */
  quitConfirmation: boolean
  /** VS Code open-in window policy (design 16 §3.3 / 20 §4.3): true (default)
   *  → session folders open in a NEW VS Code window (vscode:// URL gains
   *  `?windowId=_blank`); false → bare URL, VS Code's own default policy
   *  decides (a running instance may reuse/replace the active window). */
  vscodeOpenInNewWindow: boolean
  /** dsh runtime npm registry origin (design 18 M4): default npmjs; a
   *  user-selected mirror/custom https origin (trust anchor). */
  registryOrigin: string
  /** 桌面通知设置（design 19 §3.4）：嵌套键，与 chamber-settings.ts 权威 store
   *  及 renderer global.d.ts 的结构镜像保持一致（镜像同步纪律）。 */
  notifications: ChamberNotificationSettings
  /** 侧边栏「会话待办区」（sidebar todo area）：嵌套键，镜像同步纪律同
   *  notifications。 */
  sessionTodo: ChamberSessionTodoSettings
}

/** 桌面通知设置子块（design 19 §3.4 + §3.7）——结构与 desktop/chamber-settings.ts 的
 *  ChamberNotificationSettings 保持一致。 */
export interface ChamberNotificationSettings {
  enabled: boolean
  mode: 'hidden-only' | 'always'
  onComplete: boolean
  onAsk: boolean
  onRequest: boolean
  /** 未读计数徽标（默认 true，被动指示，独立于横幅主开关）。 */
  badgeEnabled: boolean
}

/** 侧边栏「会话待办区」设置子块——结构与 desktop/chamber-settings.ts 的
 *  ChamberSessionTodoSettings 保持一致；默认全开（被动呈现，非打扰型）。 */
export interface ChamberSessionTodoSettings {
  enabled: boolean
  onComplete: boolean
  onAsk: boolean
  onRequest: boolean
}

/** Non-secret status projection: current settings + platform capability gates. */
export interface ChamberSettingsStatus {
  settings: ChamberSettings
  supported: {
    /** True on all shipping platforms (design 21 M4). */
    launchAtLogin: boolean
    /** false when no tray recovery surface exists (dev); macOS always safe. */
    closeToTray: boolean
    /** Unread-badge overlay capability (design 19 §3.7 / design 23 M3): false on win32.
     *  Optional so a differently-versioned shell stays compatible (absent = legacy
     *  shape; renderers must default to "supported" when the field is absent). */
    badgeSupported?: boolean
  }
}

export interface SettingsSurface {
  get(): Promise<ChamberSettingsStatus>
  /** Failure carries a stable machine-readable `code` where the renderer must
   *  branch (e.g. 'cancelled', 'invalid-registry-origin'); `error` is a
   *  user-facing fallback text only, never a branching key. */
  set(patch: Partial<ChamberSettings>): Promise<ChamberSettingsStatus | { error: string; code?: string }>
  onChanged(callback: (status: ChamberSettingsStatus) => void): () => void
}

/** OS wake-from-sleep notification (design 14 D4): the renderer reconnects
 *  immediately instead of waiting for the heartbeat watchdog. */
export interface SystemResumeSurface {
  onResume(callback: (payload: { timestamp: number }) => void): () => void
}

/** Renderer-stall evidence push (frame-probe strikes / input-block RTT). */
export interface RendererStallSurface {
  onEvidence(callback: (observation: { scheduleStrikes: number; inputBlockStrikes: number; at: number }) => void): () => void
}

/**
 * The open-in surface (open-in.ts): apps() is the registry capability
 * negotiation — the full app list in fixed order with id / remoteCapable /
 * available (availability re-probed in the main process on every call — no
 * stale cache); open() is the renderer trigger — the same runOpenInLaunch
 * pipeline every entry point shares (appId whitelist + instanceId/path
 * validation + remoteCapable gate), loud {error} on failure, never a silent
 * empty success.
 */
export interface OpenInAppInfo {
  id: string
  displayKind: string
  remoteCapable: boolean
  available: boolean
}
export interface OpenInSurface {
  apps(): Promise<OpenInAppInfo[]>
  open(appId: string, instanceId: string, path: string, sourceFingerprint: string): Promise<{ ok: true } | { ok: false; error: string }>
}

/** Normalized deep-link intent push payload (design 16 §2). */
export interface DeepLinkIntent {
  instanceId: string
  path: string
  /** Exact non-secret lifecycle proof captured before the native launch. */
  sourceFingerprint: string
  /** Stable across replay; attempt changes for each renderer generation. */
  deliveryId: number
  attempt: number
}

/** The deep-link intent push surface (design 16 §2): onIntent subscribes to the
 *  main-process push and returns an unsubscribe. */
export interface DeepLinkSurface {
  onIntent(callback: (intent: DeepLinkIntent) => void): () => void
  /** Signal only after onIntent is installed; the main process holds successful
   * cold-start intents until this handshake, so renderer activation is replayed. */
  ready(): Promise<boolean>
  /** Commit only after App has accepted/routed this exact attempt. */
  ack(deliveryId: number, attempt: number): Promise<boolean>
}

/** 通知事件种类（design 19 §3.2）：complete / ask / request + test（设置页测试按钮）。 */
export type NotificationKind = 'complete' | 'ask' | 'request' | 'test'

/** 通知 payload（design 19 §3.3）——渲染端组装，主进程白名单校验 + 裁决。 */
export interface NotificationRequest {
  /** `local` or canonical `dsh-<id>` / `gateway-<id>`; main also accepts the
   * legacy `ssh-<id>` input alias and normalizes it to `dsh-<id>`. */
  sourceId: string
  sourceFingerprint: string
  sessionId: string
  kind: NotificationKind
  title: string
  body: string
  /** 正在屏幕上查看的会话（渲染端 document.hasFocus 判定，主进程再查一次作为权威）。 */
  requireHidden: boolean
  /** 内容水位（host 域毫秒）：complete =
   *  `completedAt ?? updatedAt`；ask/request = `updatedAt`。两个通知入口对同一次
   *  事件必须传同一个值（主进程 5s 去重键含水位：同水位合并、不同水位是新事件）。
   *  缺省 = 旧调用方，主进程按四元组行为处理。 */
  watermark?: number
  eventKey?: string
}

/** 通知点击打开事件的载荷（design 19 §3.3）：渲染端据此 openSession。 */
export interface NotificationOpenRequest {
  sourceId: string
  /** Exact non-secret lifecycle proof captured by the native banner. */
  sourceFingerprint: string
  sessionId: string
  deliveryId: number
  attempt: number
}

/** The dsh-chamber notification surface (design 19 §3.3): notify() invokes the
 *  main-process decision chain and resolves with the honest outcome
 *  ({shown} + the failure reason when not shown — the settings page renders it);
 *  ready() signals that the renderer registered its onOpen listener (the main
 *  process only drains notification-open pushes after this); onOpen subscribes
 *  to the notification-click push and returns an unsubscribe; openSystemSettings()
 *  opens the macOS notification pane (recovery entry after a denied permission,
 *  the only remedy macOS offers once the status is denied). */
export interface NotificationSurface {
  notify(payload: NotificationRequest): Promise<{ shown: boolean; outcome: 'shown' | 'suppressed' | 'retryable' | 'permanent'; error?: string }>
  ready(): Promise<boolean>
  /** Commit only after App has accepted/queued this exact click. */
  ack(deliveryId: number, attempt: number): Promise<boolean>
  onOpen(callback: (req: NotificationOpenRequest) => void): () => void
  /** Open the macOS「System Settings → Notifications」pane (false off darwin). */
  openSystemSettings(): Promise<boolean>
}

/** 未读徽标计数面（design 19 §3.7）：renderer 推当前「完成未读」会话数
 *  （0 = 清除），主进程按 notifications.badgeEnabled 裁决并经平台门应用
 *  app.setBadgeCount。返回 true 表示已提交给 OS 徽标 API（macOS Dock /
 *  Linux Unity launcher 家族），**不是可见性保证**——无消费方的桌面环境
 *  （如 GNOME/KDE 默认形态）无可见效果（文档化平台限制）。平台不支持时
 *  false + 主进程 loud 记一次日志——渲染端静默容忍 false。 */
export interface BadgeSurface {
  set(count: number): Promise<boolean>
}

/** The full bridge: app info + platform + ssh + update + chamber settings
 *  + system resume + open-in + deep-link + notifications + badge surfaces. */
export interface DshChamberBridge {
  controlPlaneUrl: string | null
  dshVersion: string | null
  version: string | null
  platform: string | null
  desktopSsh: DesktopSshSurface
  update: UpdateSurface
  settings: SettingsSurface
  systemResume: SystemResumeSurface
  rendererStall: RendererStallSurface
  openIn: OpenInSurface
  deepLink: DeepLinkSurface
  runtime: RuntimeSurface
  notifications: NotificationSurface
  badge: BadgeSurface
}

/** dsh runtime version management surface (design 18 M2 IPC). */
export interface RuntimeSurface {
  state(): Promise<RuntimeState>
  check(): Promise<RuntimeState>
  install(version: string): Promise<RuntimeState>
  resetBuiltin(): Promise<RuntimeState>
  /** Apply the pending version in the current session (design 18 addendum). */
  applyNow(): Promise<RuntimeState>
  retryApply(): Promise<RuntimeState>
  retryRestore(): Promise<RuntimeState>
  recoverMetadata(): Promise<RuntimeState>
  cleanupVersion(version: string): Promise<RuntimeState>
  /** Clear the retained failure record for one version (local-only entry):
   *  main re-reads the failure record set and never
   *  trusts a renderer-provided version; version trees stay untouched. */
  clearFailure(version: string): Promise<RuntimeState>
  /** Write-only data-restore action: the main process validates the stash name
   *  against its private pre-rollback listing; no path is ever accepted. */
  restorePreRollback(stashName: string): Promise<RuntimeState>
  /** Transactional managed-dsh restart (design 18 §3.6 项 8). */
  restart(): Promise<RuntimeState>
  onChanged(callback: (state: RuntimeState) => void): () => void
}

/**
 * The desktop_ssh_* IPC surface (design 05 §7.4) — returns/events/projections
 * are non-secret: never a transport URL or credential material. The sole
 * credential-bearing direction is save_connection's transient write-only input. onStatusChanged
 * subscribes to the main-process push and returns an unsubscribe.
 */
function desktopSshApi(): DesktopSshSurface {
  return {
    instances_get: () => ipcRenderer.invoke('desktop_ssh_instances_get'),
    instances_health: () => ipcRenderer.invoke('desktop_ssh_instances_health'),
    delete_connection: id => ipcRenderer.invoke('desktop_ssh_delete_connection', { id }),
    save_connection: (previousId, input, credentials) => ipcRenderer.invoke('desktop_ssh_save_connection', { previousId, input, credentials }),
    set_password: (id, password) => ipcRenderer.invoke('desktop_ssh_set_password', { id, password }),
    set_gateway_token: (id, token) => ipcRenderer.invoke('desktop_gateway_set_token', { id, token }),
    set_gateway_password: (id, password) => ipcRenderer.invoke('desktop_gateway_set_password', { id, password }),
    gateway_plugin_sync: id => ipcRenderer.invoke('desktop_gateway_plugin_sync', { id }),
    config_list: () => ipcRenderer.invoke('desktop_ssh_config_list'),
    connect: id => ipcRenderer.invoke('desktop_ssh_connect', { id }),
    disconnect: id => ipcRenderer.invoke('desktop_ssh_disconnect', { id }),
    status: id => ipcRenderer.invoke('desktop_ssh_status', { id }),
    reverify: id => ipcRenderer.invoke('desktop_ssh_reverify', { id }),
    logs: id => ipcRenderer.invoke('desktop_ssh_logs', { id }),
    logs_clear: id => ipcRenderer.invoke('desktop_ssh_logs_clear', { id }),
    start_service: id => ipcRenderer.invoke('desktop_ssh_start_service', { id }),
    stop_service: id => ipcRenderer.invoke('desktop_ssh_stop_service', { id }),
    is_active: id => ipcRenderer.invoke('desktop_ssh_is_active', { id }),
    restart_service: id => ipcRenderer.invoke('desktop_ssh_restart_service', { id }),
    plugin_list: id => ipcRenderer.invoke('desktop_ssh_plugin_list', { id }),
    local_plugin_list: () => ipcRenderer.invoke('desktop_local_plugin_list'),
    seed_host_graph: id => ipcRenderer.invoke('desktop_ssh_seed_host_graph', { id }),
    onStatusChanged: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, payload: SshStatusChangedPayload) => callback(payload);
      ipcRenderer.on('desktop_ssh_status_changed', listener);
      return () => ipcRenderer.removeListener('desktop_ssh_status_changed', listener);
    },
    onInstancesChanged: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, payload: unknown) => {
        if (payload === null || typeof payload !== 'object') {
          console.error('[dsh-chamber] ignored malformed instances-changed payload');
          callback({ removedIds: [], retiredIds: [] });
          return;
        }
        const { removedIds, retiredIds } = payload as { removedIds?: unknown; retiredIds?: unknown };
        const validIds = (ids: unknown): ids is string[] =>
          Array.isArray(ids) && ids.every(id => typeof id === 'string' && INSTANCE_ID_PATTERN.test(id));
        if (!validIds(removedIds) || !validIds(retiredIds)) {
          console.error('[dsh-chamber] ignored malformed instances-changed lifecycle delta');
          callback({ removedIds: [], retiredIds: [] });
          return;
        }
        callback({
          removedIds: [...new Set(removedIds)],
          retiredIds: [...new Set(retiredIds)],
        });
      };
      ipcRenderer.on('desktop_ssh_instances_changed', listener);
      return () => ipcRenderer.removeListener('desktop_ssh_instances_changed', listener);
    },
  };
}

/**
 * The dsh-chamber:update-* IPC surface (design 11) — non-secret only.
 * onChanged subscribes to the main-process push and returns an
 * unsubscribe; download() is the user-confirmed download action;
 * restartAndInstall() is the「重启并安装」action (quitAndInstall).
 */
function updateApi(): UpdateSurface {
  return {
    state: () => ipcRenderer.invoke('dsh-chamber:update-state'),
    check: () => ipcRenderer.invoke('dsh-chamber:update-check'),
    download: () => ipcRenderer.invoke('dsh-chamber:update-download'),
    restartAndInstall: () => ipcRenderer.invoke('dsh-chamber:update-restart'),
    openReleasePage: url => ipcRenderer.invoke('dsh-chamber:open-release', { url }),
    onChanged: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, state: UpdateState) => callback(state);
      ipcRenderer.on('dsh-chamber:update-state-changed', listener);
      return () => ipcRenderer.removeListener('dsh-chamber:update-state-changed', listener);
    },
  };
}

/**
 * The dsh-chamber:settings-* IPC surface (design 14 D7) — chamber-global,
 * non-secret only. onChanged subscribes to the main-process push and returns
 * an unsubscribe.
 */
function settingsApi(): SettingsSurface {
  return {
    get: () => ipcRenderer.invoke('dsh-chamber:settings-get'),
    set: patch => ipcRenderer.invoke('dsh-chamber:settings-set', { patch }),
    onChanged: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, status: ChamberSettingsStatus) => callback(status);
      ipcRenderer.on('dsh-chamber:settings-changed', listener);
      return () => ipcRenderer.removeListener('dsh-chamber:settings-changed', listener);
    },
  };
}

/** The dsh-chamber:system-resume push surface (design 14 D4). */
function systemResumeApi(): SystemResumeSurface {
  return {
    onResume: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, payload: { timestamp: number }) => callback(payload);
      ipcRenderer.on('dsh-chamber:system-resume', listener);
      return () => ipcRenderer.removeListener('dsh-chamber:system-resume', listener);
    },
  };
}

function rendererStallApi(): RendererStallSurface {
  return {
    onEvidence: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, payload: { scheduleStrikes: number; inputBlockStrikes: number; at: number }) => callback(payload);
      ipcRenderer.on('dsh-chamber:renderer-stall-evidence', listener);
      return () => ipcRenderer.removeListener('dsh-chamber:renderer-stall-evidence', listener);
    },
  };
}

/** The dsh-chamber:runtime-* IPC surface (design 18 M2). Non-secret projection
 *  only (version strings / list / phase / short error); install/check/reset run
 *  in the main process. onChanged subscribes to the main-process push. */
function runtimeApi(): RuntimeSurface {
  return {
    state: () => ipcRenderer.invoke('dsh-chamber:runtime-state'),
    check: () => ipcRenderer.invoke('dsh-chamber:runtime-check'),
    install: version => ipcRenderer.invoke('dsh-chamber:runtime-install', { version }),
    resetBuiltin: () => ipcRenderer.invoke('dsh-chamber:runtime-reset-builtin'),
    applyNow: () => ipcRenderer.invoke('dsh-chamber:runtime-apply-now'),
    retryApply: () => ipcRenderer.invoke('dsh-chamber:runtime-retry-apply'),
    retryRestore: () => ipcRenderer.invoke('dsh-chamber:runtime-retry-restore'),
    recoverMetadata: () => ipcRenderer.invoke('dsh-chamber:runtime-recover-metadata'),
    cleanupVersion: version => ipcRenderer.invoke('dsh-chamber:runtime-cleanup-version', { version }),
    clearFailure: version => ipcRenderer.invoke('dsh-chamber:runtime-clear-failure', { version }),
    restorePreRollback: stashName => ipcRenderer.invoke('dsh-chamber:runtime-restore-pre-rollback', { stashName }),
    restart: () => ipcRenderer.invoke('dsh-chamber:runtime-restart'),
    onChanged: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, state: RuntimeState) => callback(state);
      ipcRenderer.on('dsh-chamber:runtime-state-changed', listener);
      return () => ipcRenderer.removeListener('dsh-chamber:runtime-state-changed', listener);
    },
  };
}

/**
 * The dsh-chamber:open-in-apps / dsh-chamber:open-in IPC surface (open-in.ts):
 * apps() resolves the registry capability negotiation ({apps} payload unwrapped
 * to the list); open() is the renderer trigger — the same runOpenInLaunch
 * pipeline as every other entry point, loud {error} on failure.
 */
function openInApi(): OpenInSurface {
  return {
    apps: async () => {
      const payload = await ipcRenderer.invoke('dsh-chamber:open-in-apps') as { apps: OpenInAppInfo[] };
      return payload.apps;
    },
    open: (appId, instanceId, path, sourceFingerprint) => ipcRenderer.invoke('dsh-chamber:open-in', { appId, instanceId, path, sourceFingerprint }),
  };
}

/** The dsh-chamber:deep-link-intent push surface (design 16 §2). */
function deepLinkApi(): DeepLinkSurface {
  return {
    onIntent: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, payload: unknown) => {
        if (payload === null || typeof payload !== 'object') {
          console.error('[dsh-chamber] ignored malformed deep-link delivery');
          return;
        }
        const intent = payload as Partial<DeepLinkIntent>;
        if (
          typeof intent.instanceId !== 'string'
          || (intent.instanceId !== 'local' && !INSTANCE_ID_PATTERN.test(intent.instanceId))
          || typeof intent.path !== 'string'
          || !validSourceFingerprint(intent.instanceId, intent.sourceFingerprint)
          || !validDeliveryCoordinate(intent.deliveryId)
          || !validDeliveryCoordinate(intent.attempt)
        ) {
          console.error('[dsh-chamber] ignored malformed deep-link delivery');
          return;
        }
        callback(intent as DeepLinkIntent);
      };
      ipcRenderer.on('dsh-chamber:deep-link-intent', listener);
      return () => ipcRenderer.removeListener('dsh-chamber:deep-link-intent', listener);
    },
    ready: () => ipcRenderer.invoke('dsh-chamber:deep-link-ready'),
    ack: (deliveryId, attempt) => ipcRenderer.invoke('dsh-chamber:deep-link-ack', { deliveryId, attempt }),
  };
}

/**
 * The dsh-chamber notification surface (design 19 §3.3): notify() invokes the
 * main-process decision chain (payload whitelist / dedupe claim / settings /
 * native Notification) and resolves whether a notification was actually shown;
 * ready() signals that the renderer has registered its onOpen listener (the
 * main process only drains notification-open pushes after this — did-finish-load
 * fires before the listener exists); onOpen subscribes to the notification-click
 * push ({sourceId, sessionId} → renderer openSession) and returns an unsubscribe.
 */
function notificationsApi(): NotificationSurface {
  return {
    notify: payload => ipcRenderer.invoke('dsh-chamber:notify', { payload }),
    openSystemSettings: () => ipcRenderer.invoke('dsh-chamber:open-notification-settings'),
    ready: () => ipcRenderer.invoke('dsh-chamber:notifications-ready'),
    ack: (deliveryId, attempt) => ipcRenderer.invoke('dsh-chamber:notification-open-ack', { deliveryId, attempt }),
    onOpen: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, payload: unknown) => {
        if (payload === null || typeof payload !== 'object') {
          console.error('[dsh-chamber] ignored malformed notification-open delivery');
          return;
        }
        const req = payload as Partial<NotificationOpenRequest>;
        const sourceId = req.sourceId;
        const validRemoteSourceId = typeof sourceId === 'string'
          && ['dsh-', 'gateway-', 'ssh-'].some((prefix) => {
            if (!sourceId.startsWith(prefix)) return false;
            return INSTANCE_ID_PATTERN.test(sourceId.slice(prefix.length));
          });
        const validSourceId = typeof sourceId === 'string' && (
          sourceId === 'local'
          || validRemoteSourceId
        );
        if (
          !validSourceId
          || !validSourceFingerprint(sourceId as string, req.sourceFingerprint)
          || typeof req.sessionId !== 'string'
          || req.sessionId.length === 0
          || !validDeliveryCoordinate(req.deliveryId)
          || !validDeliveryCoordinate(req.attempt)
        ) {
          console.error('[dsh-chamber] ignored malformed notification-open delivery');
          return;
        }
        callback(req as NotificationOpenRequest);
      };
      ipcRenderer.on('dsh-chamber:notification-open', listener);
      return () => ipcRenderer.removeListener('dsh-chamber:notification-open', listener);
    },
  };
}

/** The badge surface (design 19 §3.7): a single invoke carrying the current
 *  unseen-session count; 0 clears. The main process validates the payload,
 *  adjudicates against notifications.badgeEnabled and applies it through the
 *  platform gate — the boolean result reports whether it was applied. */
function badgeApi(): BadgeSurface {
  return {
    set: count => ipcRenderer.invoke('dsh-chamber:badge-count', { count }),
  };
}

/** Normalized native input the official shortcuts service accepts (upstream
 *  DesktopShortcutInput). revision must equal the renderer's accepted
 *  preference revision or installNativeKeyboard drops the input. */
export type DesktopShortcutInput = { readonly revision: string } & (
  | { readonly kind: 'menu'; readonly commandId: string }
  | {
    readonly kind: 'keyboard' | 'iframe' | 'webview'
    readonly frameName: string
    readonly code: string
    readonly secondCode?: string
    readonly control: boolean
    readonly alt: boolean
    readonly shift: boolean
    readonly meta: boolean
    readonly repeat: boolean
  }
)

/** Physical-key capability of the desktop carrier (upstream DesktopKeyboardApi). */
export interface DesktopKeyboardApi {
  /** Subscribe to verified native input. @param listener - current document consumer. @returns listener disposer. */
  subscribe(listener: (input: DesktopShortcutInput) => void): () => void
  /** Close the owning window if its configuration is still current. @param revision - accepted configuration identity. */
  closeWindow(revision: string): Promise<void>
}

/** Revisioned preference snapshot (upstream ShortcutConfigSnapshot). */
export interface DesktopShortcutsSnapshot {
  readonly revision: string
  readonly sequence: number
  readonly document: unknown
  readonly status: 'loading' | 'ready' | 'unreadable'
  readonly error: 'read' | 'invalid' | 'future' | null
  readonly usingDefaults: boolean
}

/** Classified save outcome (upstream ShortcutSaveResult). */
export interface DesktopShortcutsSaveResult {
  readonly status: 'saved' | 'stale' | 'unreadable' | 'write-failed' | 'not-ready' | 'conflict'
  readonly snapshot: DesktopShortcutsSnapshot
  readonly issue?: string
  readonly conflicts?: readonly string[]
}

/** Preference transaction capability of the desktop carrier (upstream DesktopShortcutsApi). */
export interface DesktopShortcutsApi {
  /** Install the trusted catalog and read the current preferences. */
  get(definitions: readonly unknown[]): Promise<DesktopShortcutsSnapshot>
  /** Persist one revision-checked edit. */
  edit(edit: unknown, revision: string): Promise<DesktopShortcutsSaveResult>
  /** Subscribe to committed snapshots; returns the disposer. */
  subscribe(listener: (snapshot: DesktopShortcutsSnapshot) => void): () => void
  /** Toggle native recording capture. */
  recording(active: boolean): Promise<void>
}

/** Upstream update presentation consumed by the official settings shell
 *  (dshDesktop.updates), mapped from the chamber UpdateState. */
export interface DesktopUpdatePresentation {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly percent?: number
  readonly failure?: 'check' | 'download' | 'install'
}

/** The operation in flight, so an error receiver can name what failed (upstream
 *  gets this from its coordinator's failedOperation). */
let upstreamActiveOperation: 'check' | 'download' | 'install' = 'check'

/** Map the chamber update projection onto the upstream presentation phases.
 *  up-to-date has no upstream counterpart (the badge renders nothing when idle);
 *  downloaded maps to ready (download finished, install armed). */
function toUpstreamUpdatePresentation(state: UpdateState | null | undefined): DesktopUpdatePresentation {
  const version = state?.latestVersion ?? undefined
  const withVersion = (phase: DesktopUpdatePresentation['phase']): DesktopUpdatePresentation =>
    version === undefined ? { phase } : { phase, version }
  if (state?.phase === 'downloading') upstreamActiveOperation = 'download'
  else if (state?.phase === 'installing') upstreamActiveOperation = 'install'
  else if (state?.phase === 'checking') upstreamActiveOperation = 'check'
  switch (state?.phase) {
    case 'checking': return { phase: 'checking' }
    case 'available': return withVersion('available')
    case 'downloading': return { phase: 'downloading',
      ...(state.downloadPercent === null ? {} : { percent: state.downloadPercent }),
      ...(version === undefined ? {} : { version }) }
    case 'downloaded': return withVersion('ready')
    case 'installing': return withVersion('installing')
    case 'error': return { ...withVersion('error'), failure: upstreamActiveOperation }
    default: return { phase: 'idle' }
  }
}

/** window.dshDesktop.updates -- the update presentation the official settings
 *  shell consumes. */
export interface DesktopUpdatesApi {
  status(): Promise<DesktopUpdatePresentation>
  open(): Promise<void>
  subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
}

/** The dshDesktop.update-* capability: the official settings shell hangs its
 *  OWN update badge into the sidebar seat from this carrier. open() follows the
 *  upstream action semantics (bring the update presentation up) -- here the
 *  update check, which on the native shell fronts the standard Sparkle window. */
function desktopUpdatesApi(): DesktopUpdatesApi {
  return {
    status: () => (ipcRenderer.invoke('dsh-chamber:update-state') as Promise<UpdateState>).then(toUpstreamUpdatePresentation),
    open: () => (ipcRenderer.invoke('dsh-chamber:update-check') as Promise<unknown>).then(() => undefined),
    subscribe: (listener) => {
      if (typeof listener !== 'function') return () => {};
      const handle = (_event: IpcRendererEvent, state: UpdateState) => { listener(toUpstreamUpdatePresentation(state)); };
      ipcRenderer.on('dsh-chamber:update-state-changed', handle);
      return () => ipcRenderer.removeListener('dsh-chamber:update-state-changed', handle);
    },
  };
}

/** The dshDesktop.keyboard capability (upstream preload-app.ts createProductApi
 *  keyboard arm): native inputs are re-checked against the live embedding
 *  element before they reach the document consumer. */
function keyboardApi(): DesktopKeyboardApi {
  return {
    closeWindow: revision => ipcRenderer.invoke(DESKTOP_SHORTCUTS_CHANNELS.CLOSE_WINDOW, revision),
    subscribe: (listener) => {
      const handle = (_event: IpcRendererEvent, input: DesktopShortcutInput): void => {
        if (input.kind === 'iframe') {
          const element = document.activeElement
          if (!(element instanceof HTMLIFrameElement) || !element.isConnected
            || !element.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')) return
          if (input.frameName === '' || element.name !== input.frameName) return
        }
        if (input.kind === 'webview') {
          const element = document.activeElement
          if (element?.matches('webview[data-sidebar-browser-frame]') !== true || !element.isConnected
            || input.frameName === '' || element.getAttribute('name') !== input.frameName) return
        }
        listener(input)
      }
      ipcRenderer.on(DESKTOP_SHORTCUTS_CHANNELS.INPUT, handle)
      return () => { ipcRenderer.removeListener(DESKTOP_SHORTCUTS_CHANNELS.INPUT, handle) }
    },
  }
}

/** The dshDesktop.shortcuts capability: main owns userData/keybindings.json and
 *  mints the revision the keyboard input is gated on. */
function shortcutsApi(): DesktopShortcutsApi {
  return {
    get: definitions => ipcRenderer.invoke(DESKTOP_SHORTCUTS_CHANNELS.GET, definitions),
    edit: (edit, revision) => ipcRenderer.invoke(DESKTOP_SHORTCUTS_CHANNELS.EDIT, edit, revision),
    recording: active => ipcRenderer.invoke(DESKTOP_SHORTCUTS_CHANNELS.RECORDING, active),
    subscribe(listener) {
      const handle = (_event: IpcRendererEvent, snapshot: DesktopShortcutsSnapshot): void => { listener(snapshot) };
      ipcRenderer.on(DESKTOP_SHORTCUTS_CHANNELS.CHANGED, handle);
      return () => { ipcRenderer.removeListener(DESKTOP_SHORTCUTS_CHANNELS.CHANGED, handle) };
    },
  }
}

/** Expose the upstream desktop carrier (apps/desktop/src/preload-app.ts
 *  createProductApi): rc.2 official client families read
 *  globalThis.dshDesktop.keyboard/shortcuts/updates. Installed before the
 *  bridge payload is requested because the official shell constructs its
 *  shortcuts service during boot, not after info hydration. */
function exposeDesktopCarrier(): void {
  contextBridge.exposeInMainWorld('dshDesktop', {
    protocolVersion: 1,
    updates: desktopUpdatesApi(),
    keyboard: keyboardApi(),
    shortcuts: shortcutsApi(),
  });
}

/** Upstream markDocumentPlatform() (apps/desktop/src/preload-platform.ts),
 *  mirrored verbatim: the document root carries the host platform so the
 *  shared Web UI -- including the shortcuts service's desktop detection --
 *  sees a desktop runtime. Deferred to DOMContentLoaded when the preload runs
 *  before the document root exists. */
function markDocumentPlatform(): void {
  // A host without a document (text-level test harnesses) skips: a real renderer
  // always has the root, which is what upstream assumes too.
  if (typeof document === 'undefined' || document === null || document.documentElement === undefined) return;
  const mark = () => { document.documentElement.dataset.platform = process.platform; };
  const root = document.documentElement;
  if (root === null) window.addEventListener('DOMContentLoaded', mark);
  else mark();
}

/**
 * Fetch the app-info payload for the bridge. The main-process IPC sender
 * fence (design 05 §7.4) may reject a bootstrap invoke fired before the main
 * frame has committed its trusted URL (senderFrame/URL timing during initial
 * load). Retry briefly so the bridge never starts from null info; the fence
 * still guards every actual request, and the null fallback below remains the
 * last resort.
 */
const INFO_RETRY_MS = 50;
const INFO_MAX_ATTEMPTS = 10;

function requestAppInfo(): Promise<Partial<DshChamberBridge>> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = () => {
      ipcRenderer.invoke('dsh-chamber:info').then(resolve, (err: unknown) => {
        if (attempts < INFO_MAX_ATTEMPTS) {
          attempts += 1;
          setTimeout(attempt, INFO_RETRY_MS);
        } else {
          reject(err);
        }
      });
    };
    attempt();
  });
}

// Upstream parity bootstrap (the S-52 desktop carrier + the desktop platform
// mark): independent of info hydration, so both are installed before the
// bridge payload is requested -- the official shortcuts service reads
// window.dshDesktop during boot, not after the info round-trip.
markDocumentPlatform();
markWindowsTitlebar();
exposeDesktopCarrier();

requestAppInfo().then(
  (info: Partial<DshChamberBridge>) => {
    contextBridge.exposeInMainWorld('dshChamber', {
      controlPlaneUrl: info?.controlPlaneUrl,
      dshVersion: info?.dshVersion,
      version: info?.version,
      platform: info?.platform ?? null,
      desktopSsh: desktopSshApi(),
      update: updateApi(),
      settings: settingsApi(),
      systemResume: systemResumeApi(),
      rendererStall: rendererStallApi(),
      openIn: openInApi(),
      deepLink: deepLinkApi(),
      runtime: runtimeApi(),
      notifications: notificationsApi(),
      badge: badgeApi(),
    });
  },
  (err: unknown) => {
    console.error('[dsh-chamber] 获取应用信息失败：', err);
    contextBridge.exposeInMainWorld('dshChamber', {
      controlPlaneUrl: null,
      dshVersion: null,
      version: null,
      platform: null,
      desktopSsh: desktopSshApi(),
      update: updateApi(),
      settings: settingsApi(),
      systemResume: systemResumeApi(),
      rendererStall: rendererStallApi(),
      openIn: openInApi(),
      deepLink: deepLinkApi(),
      runtime: runtimeApi(),
      notifications: notificationsApi(),
      badge: badgeApi(),
    });
  },
);
