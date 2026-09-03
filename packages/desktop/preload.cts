import type { IpcRendererEvent } from 'electron';
import type {
  TransportInstanceInput as SshInstanceInput,
  TransportInstanceSpec as RegistrySshInstanceSpec,
  TransportLogEntry as SshLogEntry,
  TransportStatusProjection as SshStatusProjection,
} from './transport-provider.ts';
import type { SshConfigDiscovery } from './ssh-config.ts';
import type { UpdateState } from './updater.ts';
import type { RuntimeState } from './dsh-runtime-controller.ts';
const { contextBridge, ipcRenderer } = require('electron');

// Keep preload runtime self-contained: importing a value from a TypeScript ESM
// module crosses the emitted CommonJS preload boundary. This strict mirror is
// intentionally local; main remains authoritative for the delta contents.
const INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/;
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
}

export interface ConnectionCredentialMutations {
  sshPassword?: string
  gatewayToken?: string
  gatewayPassword?: string
}

export type SaveConnectionResult =
  | { ok: true; instances: SshInstanceSpec[] }
  | { ok: false; instances: SshInstanceSpec[]; error: string; metadataCommitted: boolean }

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
  /** Legacy compatibility channel: exact unchanged no-op roster only. */
  instances_set(instances: SshInstanceSpec[]): Promise<SshInstanceSpec[]>
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
  /**
   * Batch registry add/remove + restart-to-apply on a gateway instance's
   * registered transport (design 21 §6.5): the main process confirms first
   * (cancelled = the user dismissed the dialog) and re-validates every spec.
   */
  gateway_plugin_apply(id: string, input: GatewayPluginApplyInput): Promise<GatewayPluginApplyIpcResult>
  /**
   * Pick a local plugin-source FOLDER in the main process and upload it to a
   * gateway instance (pick-only, design 21 §6.5): no renderer-supplied path
   * is ever accepted.
   */
  gateway_plugin_materialize(id: string): Promise<GatewayPluginMaterializeIpcResult>
  /** ~/.ssh/config discovery: non-secret host projections or {error}. */
  config_list(): Promise<SshConfigDiscovery>
  connect(id: string): Promise<SshStatusProjection | null>
  disconnect(id: string): Promise<SshStatusProjection | null>
  status(id: string): Promise<SshStatusProjection | null>
  logs(id: string): Promise<SshLogEntry[]>
  logs_clear(id: string): Promise<boolean>
  start_service(id: string): Promise<SshExecIpcResult>
  stop_service(id: string): Promise<SshExecIpcResult>
  is_active(id: string): Promise<SshExecIpcResult>
  /** Restart the remote systemd service (design 13 M2): fresh projection or {error}. */
  restart_service(id: string): Promise<SshExecIpcResult>
  /** Read the remote instance's plugin manifest (design 13 §4.3). */
  plugin_list(id: string): Promise<SshRemotePluginListResult>
  /** Apply a plugin-set change to a remote instance (design 13 §4.3/§4.5). */
  plugin_apply(id: string, input: SshPluginApplyInput): Promise<SshPluginApplyIpcResult>
  /** Undo the latest OK plugin change of a remote instance (design 21 §6.4):
   *  main-process journal + confirm; id-only, no renderer-supplied spec. */
  ssh_plugin_undo(id: string): Promise<SshPluginUndoIpcResult>
  /** Read the LOCAL instance's plugin manifest (design 13 §4.3). */
  local_plugin_list(): Promise<SshLocalPluginListResult>
  /** Best-effort npm registry search (main-process fetch; design 13 §5.8). */
  npm_search(query: string): Promise<SshNpmSearchResult>
  /** Seed module A onto a remote instance (design 13 §4.6, 09 遗留 1). */
  seed_host_graph(id: string): Promise<SshSeedHostGraphResult>
  /** Pack a named local-manifest dependency and install it remotely. Main
   *  resolves the directory; renderer paths are never accepted. */
  plugin_materialize_add(id: string, name: string): Promise<SshMaterializeResult>
  /** Pack a user-PICKED local plugin dir and install it remotely (pick-only; the
   *  main process opens the folder picker, no renderer-supplied path, design 13 §5.8). */
  plugin_materialize_add_pick(id: string): Promise<SshMaterializeResult>
  /** Install a spec into the LOCAL dsh profile (design 13 §5.1). */
  local_plugin_add(spec: string): Promise<SshLocalPluginExecIpcResult>
  /** Pick a local folder and install it into the LOCAL dsh profile (pick-only). */
  local_plugin_add_file(): Promise<SshLocalPluginExecIpcResult>
  /** Remove a plugin from the LOCAL dsh profile (design 13 §5.1). */
  local_plugin_remove(name: string): Promise<SshLocalPluginExecIpcResult>
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
export interface ChamberHostGraphState {
  installed: boolean
  patched: boolean
  version: string | null
  live: boolean | null
}
/** Chamber-injected component state (design 09): ok:false = unreadable (loud,
 *  never a silent "not injected"). The preload mirror of plugin-sync.ts /
 *  renderer global.d.ts — the L3 lockstep test guards shape drift. */
export type ChamberInjectionState =
  | {
    ok: true
    hostGraph: ChamberHostGraphState
    gitWorktree: { installed: boolean; patched: boolean; version: string | null; live: boolean | null }
  }
  | { ok: false; error: string }
/** Remote plugin manifest projection (design 13 §4.3). */
export interface SshRemotePluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
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

/** Local plugin manifest projection (design 13 §4.3). */
export interface SshLocalPluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
  clientLines: string[]
  /** Deps whose own manifest declares a `dsh.bundle` (verifyApplied bundles half-assertion). */
  bundleLines: string[]
  unsyncable: { name: string; reason: string }[]
  chamber: ChamberInjectionState
}
export type SshLocalPluginListResult =
  | { ok: true; manifest: SshLocalPluginManifest }
  | { ok: false; error: string }

/** Apply outcome (design 13 §4.5). */
export interface SshPluginApplyResult {
  applied: number
  skipped: number
  failed: { spec: string; error: string }[]
  restarted: boolean
  deferred: boolean
  verified: boolean
  ready: boolean | null
  /** When ready is null because the instance was not connected before restart
   *  (readiness not re-checked), this explains why. */
  readyNote?: string
}
export type SshPluginApplyIpcResult =
  | { ok: true; result: SshPluginApplyResult }
  | { ok: false; error: string }

/** Undo outcome of the ssh plugin journal (design 21 §6.4, plan Phase 5):
 *  the main process confirms the undo (cancelled = the user dismissed the
 *  dialog), re-executes the inverse op through the same ssh plugin_apply
 *  flow (restart-to-apply), and journals the undo op so further undos chain.
 *  ok:true undone.kind = the kind of the op that was undone ('add' — a
 *  fresh install was removed again, an in-place upgrade was restored to its
 *  previous spec; 'remove' — the name was re-added with its previous
 *  registry spec). undone carries NO further fields on a CLEAN undo (rows
 *  executed + restart ok + verified + no failed readiness re-check); when
 *  the change executed but is not fully effective (restart failed /
 *  verification failed / readiness failed) the arm carries {restarted,
 *  ready, readyNote?} — the presence of undone.restarted is the renderer's
 *  "executed but not fully effective" signal, never a fake clean success.
 *  ok:false carries unavailable: 'none' when there is no undoable op (or
 *  the previous spec cannot be restored) or 'file-backed' when the previous
 *  spec was a remote file: package that v1 cannot re-add. */
export type SshPluginUndoIpcResult =
  | { ok: true; cancelled: true }
  | { ok: true; undone: { kind: 'add' | 'remove'; name: string; restarted?: boolean; ready?: boolean | null; readyNote?: string } }
  | { ok: false; error: string; unavailable?: 'none' | 'file-backed' }

/** Apply input (renderer → main; main re-validates every spec, design 13 §7.2). */
export interface SshPluginApplyInput {
  add: string[]
  remove: string[]
  restart?: boolean
}

/** Best-effort npm search package projection (design 13 §5.8). */
export interface SshNpmSearchPackage {
  name: string
  version: string
  description?: string
}
export type SshNpmSearchResult =
  | { ok: true; packages: SshNpmSearchPackage[] }
  | { ok: false; error: string }

/** Host-graph seed outcome (design 13 §4.6). */
export type SshSeedHostGraphResult =
  | { ok: true; wrote: boolean; patched: boolean }
  | { ok: false; error: string }

/** Materialize-and-add outcome (design 13 §4.6). `cancelled` = the user dismissed
 *  the folder picker (a silent no-op, not an error). */
export type SshMaterializeResult =
  | { ok: true; spec: string; remotePath: string }
  | { ok: true; cancelled: true }
  | { ok: false; error: string }

/** Local `dsh plugin` exec outcome (design 13 §5.1). `cancelled` = the user
 *  dismissed the folder picker on the `local_plugin_add_file` path. */
export type SshLocalPluginExecIpcResult =
  | { ok: true }
  | { ok: true; cancelled: true }
  | { ok: false; error: string }

/** Manual chamber-plugin sync outcome (design 21 §6.5): the seed-cache sync
 *  the gateway ready registration performs automatically, re-run on demand.
 *  ok:true carries the same {uploaded, skipped} projection as the auto path;
 *  ok:false is loud (no ready registration / instance gone / sync error). */
export type GatewayPluginSyncIpcResult =
  | { ok: true; uploaded: boolean; skipped: boolean }
  | { ok: false; error: string }

/** Batch apply input (renderer → main; main re-validates every spec against
 *  the same shared whitelists the gateway routes use — defense in depth). */
export interface GatewayPluginApplyInput {
  add: string[]
  remove: string[]
  /** true = record the change only; the restart-to-apply is skipped. */
  deferRestart?: boolean
}

/** Partial outcome of a failed batch: the ops already accepted by the
 *  gateway executor before the failure (restart refusal included) — never
 *  hidden behind the error text. */
export interface GatewayPluginApplyPartial {
  installed: string[]
  removed: string[]
}

/** Batch apply outcome (design 21 §6.5): cancelled = the user dismissed the
 *  main-process confirmation; ok:true carries installed/removed (accepted
 *  ops), restarted (restart confirmed via the status poll) and deferred
 *  (true when some submissions were cached as ready-edge install intents);
 *  ok:false is loud and carries `partial` when ops executed before it. */
export type GatewayPluginApplyIpcResult =
  | { ok: true; cancelled: true }
  | { ok: true; installed: string[]; removed: string[]; restarted: boolean; deferred?: boolean }
  | { ok: false; error: string; partial?: GatewayPluginApplyPartial }

/** Folder materialize outcome (design 21 §6.5): cancelled = the user
 *  dismissed the picker; ok:true deferred = the gateway cached the install
 *  intent for the next ready edge (false = accepted onto the executor
 *  queue); ok:false is loud. */
export type GatewayPluginMaterializeIpcResult =
  | { ok: true; cancelled: true }
  | { ok: true; deferred: boolean }
  | { ok: false; error: string }

/**
 * The dsh-chamber update surface (design 11) — non-secret only: versions,
 * channel, a release-page URL, a short error text. state() resolves the
 * current snapshot; onChanged subscribes to the main-process push and
 * returns an unsubscribe; check() is the user-initiated「检查更新」action
 * (same silent check path as the startup/6h checks — never downloads);
 * download() is the user-confirmed download action (the「更新」button) —
 * checking itself never downloads (autoDownload=false).
 */
export interface UpdateSurface {
  state(): Promise<UpdateState>
  /** User-initiated check (the「检查更新」button). */
  check(): Promise<{ ok: true } | { ok: false; error: string }>
  download(): Promise<{ ok: true } | { ok: false; error: string }>
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
  /** Login autostart (design 14 D6): mac/linux; win gated off in v1. */
  launchAtLogin: boolean
  /** prevent-app-suspension (design 14 D5); default off. */
  keepAwake: boolean
  /** Quit confirmation (design 14 D2): confirm only while the local dsh
   *  instance runs; remote tunnels never prompt. Default on. */
  quitConfirmation: boolean
  /** dsh runtime npm registry origin (design 18 M4): default npmjs; a
   *  user-selected mirror/custom https origin (trust anchor). */
  registryOrigin: string
  /** 桌面通知设置（design 19 §3.4）：嵌套键，与 chamber-settings.ts 权威 store
   *  及 renderer global.d.ts 的结构镜像保持一致（镜像同步纪律）。 */
  notifications: ChamberNotificationSettings
}

/** 桌面通知设置子块（design 19 §3.4）——结构与 desktop/chamber-settings.ts 的
 *  ChamberNotificationSettings 保持一致。 */
export interface ChamberNotificationSettings {
  enabled: boolean
  mode: 'hidden-only' | 'always'
  onComplete: boolean
  onAsk: boolean
  onRequest: boolean
}

/** Non-secret status projection: current settings + platform capability gates. */
export interface ChamberSettingsStatus {
  settings: ChamberSettings
  supported: {
    /** false on win32 (v1 gate). */
    launchAtLogin: boolean
    /** false when no tray recovery surface exists (dev); macOS always safe. */
    closeToTray: boolean
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
}

/** 通知点击打开事件的载荷（design 19 §3.3）：渲染端据此 openSession。 */
export interface NotificationOpenRequest {
  sourceId: string
  /** Exact non-secret lifecycle proof captured by the native banner. */
  sourceFingerprint: string
  sessionId: string
  /** Stable across replay; attempt changes for each renderer generation. */
  deliveryId: number
  attempt: number
}

/** The dsh-chamber notification surface (design 19 §3.3): notify() invokes the
 *  main-process decision chain (returns whether a native notification was
 *  actually shown); ready() signals that the renderer registered its onOpen
 *  listener (the main process only drains notification-open pushes after this);
 *  onOpen subscribes to the notification-click push and returns an
 *  unsubscribe. */
export interface NotificationSurface {
  notify(payload: NotificationRequest): Promise<boolean>
  ready(): Promise<boolean>
  /** Commit only after App has accepted/queued this exact click. */
  ack(deliveryId: number, attempt: number): Promise<boolean>
  onOpen(callback: (req: NotificationOpenRequest) => void): () => void
}

/** The full bridge: app info + platform + ssh + update + chamber settings
 *  + system resume + open-in + deep-link + notifications surfaces. */
export interface DshChamberBridge {
  controlPlaneUrl: string | null
  dshVersion: string | null
  version: string | null
  platform: string | null
  desktopSsh: DesktopSshSurface
  update: UpdateSurface
  settings: SettingsSurface
  systemResume: SystemResumeSurface
  openIn: OpenInSurface
  deepLink: DeepLinkSurface
  runtime: RuntimeSurface
  notifications: NotificationSurface
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
    instances_set: instances => ipcRenderer.invoke('desktop_ssh_instances_set', instances),
    delete_connection: id => ipcRenderer.invoke('desktop_ssh_delete_connection', { id }),
    save_connection: (previousId, input, credentials) => ipcRenderer.invoke('desktop_ssh_save_connection', { previousId, input, credentials }),
    set_password: (id, password) => ipcRenderer.invoke('desktop_ssh_set_password', { id, password }),
    set_gateway_token: (id, token) => ipcRenderer.invoke('desktop_gateway_set_token', { id, token }),
    set_gateway_password: (id, password) => ipcRenderer.invoke('desktop_gateway_set_password', { id, password }),
    gateway_plugin_sync: id => ipcRenderer.invoke('desktop_gateway_plugin_sync', { id }),
    gateway_plugin_apply: (id, input) => ipcRenderer.invoke('desktop_gateway_plugin_apply', { id, add: input.add, remove: input.remove, deferRestart: input.deferRestart }),
    gateway_plugin_materialize: id => ipcRenderer.invoke('desktop_gateway_plugin_materialize', { id }),
    config_list: () => ipcRenderer.invoke('desktop_ssh_config_list'),
    connect: id => ipcRenderer.invoke('desktop_ssh_connect', { id }),
    disconnect: id => ipcRenderer.invoke('desktop_ssh_disconnect', { id }),
    status: id => ipcRenderer.invoke('desktop_ssh_status', { id }),
    logs: id => ipcRenderer.invoke('desktop_ssh_logs', { id }),
    logs_clear: id => ipcRenderer.invoke('desktop_ssh_logs_clear', { id }),
    start_service: id => ipcRenderer.invoke('desktop_ssh_start_service', { id }),
    stop_service: id => ipcRenderer.invoke('desktop_ssh_stop_service', { id }),
    is_active: id => ipcRenderer.invoke('desktop_ssh_is_active', { id }),
    restart_service: id => ipcRenderer.invoke('desktop_ssh_restart_service', { id }),
    plugin_list: id => ipcRenderer.invoke('desktop_ssh_plugin_list', { id }),
    plugin_apply: (id, input) => ipcRenderer.invoke('desktop_ssh_plugin_apply', { id, add: input.add, remove: input.remove, restart: input.restart }),
    ssh_plugin_undo: id => ipcRenderer.invoke('desktop_ssh_plugin_undo', { id }),
    local_plugin_list: () => ipcRenderer.invoke('desktop_local_plugin_list'),
    npm_search: query => ipcRenderer.invoke('desktop_npm_search', { query }),
    seed_host_graph: id => ipcRenderer.invoke('desktop_ssh_seed_host_graph', { id }),
    plugin_materialize_add: (id, name) => ipcRenderer.invoke('desktop_ssh_plugin_materialize_add', { id, name }),
    plugin_materialize_add_pick: id => ipcRenderer.invoke('desktop_ssh_plugin_materialize_add_pick', { id }),
    local_plugin_add: spec => ipcRenderer.invoke('desktop_local_plugin_add', { spec }),
    local_plugin_add_file: () => ipcRenderer.invoke('desktop_local_plugin_add_file'),
    local_plugin_remove: name => ipcRenderer.invoke('desktop_local_plugin_remove', { name }),
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
 * onStateChanged subscribes to the main-process push and returns an
 * unsubscribe; download() is the user-confirmed download action.
 */
function updateApi(): UpdateSurface {
  return {
    state: () => ipcRenderer.invoke('dsh-chamber:update-state'),
    check: () => ipcRenderer.invoke('dsh-chamber:update-check'),
    download: () => ipcRenderer.invoke('dsh-chamber:update-download'),
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
      openIn: openInApi(),
      deepLink: deepLinkApi(),
      runtime: runtimeApi(),
      notifications: notificationsApi(),
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
      openIn: openInApi(),
      deepLink: deepLinkApi(),
      runtime: runtimeApi(),
      notifications: notificationsApi(),
    });
  },
);
