/**
 * The window.dshChamber bridge contract (desktop preload.cts, design 05
 * §3.3). The Electron shell exposes this via contextBridge; the web build
 * has no injection, so the property is optional and every consumer guards
 * with ?. / typeof checks.
 *
 * Mirrors the interface declared in packages/desktop/preload.cts; the two
 * declarations must stay structurally identical (interface merging).
 */

/** Transport lifecycle phase machine（隧道生命周期 phase 机）. */
export type SshPhase = 'idle' | 'connecting' | 'ready' | 'degraded' | 'error'

/** Normalized non-secret instance spec as held by the registry (design 05 §8). */
export interface SshInstanceSpec {
  id: string
  label: string
  /** Transport provider kind (v1: 'ssh'). */
  kind: string
  host: string
  user: string | null
  /** SSH daemon port; null = ssh default (22 or the host's ~/.ssh/config Port). */
  sshPort: number | null
  /** The remote dsh web profile port on 127.0.0.1 (the tunnel destination). */
  remotePort: number
  serviceName: string | null
  /**
   * Remote DSH_HOME (design 13 §4.2); null = default ~/.dsh. Optional input,
   * whitelisted `^~?/[a-zA-Z0-9._/-]+$` on the main side.
   */
  remoteDshHome: string | null
}

/** Instance spec as accepted on save (kind/user/sshPort/serviceName are optional inputs). */
export interface SshInstanceInput {
  id: string
  label: string
  /** Transport provider kind; omitted/legacy entries default to 'ssh'. */
  kind?: string
  host: string
  user?: string | null
  sshPort?: number | null
  remotePort: number
  serviceName?: string | null
  /** Remote DSH_HOME; omitted/legacy entries default to ~/.dsh. */
  remoteDshHome?: string | null
}

/** The non-secret status projection (design 05 §8): never a transport URL. */
export interface SshStatusProjection {
  /** Transport provider kind (v1: 'ssh'). */
  kind: string
  phase: SshPhase
  localPort: number | null
  sshPort: number | null
  remotePort: number
  /** Configured remote dsh home ($DSH_HOME); null = ssh default. */
  remoteDshHome: string | null
  retryAttempt: number
  requiresUserAction: boolean
  /**
   * Last known systemd activation state; null = no serviceName configured
   * for the instance, or isActive/start/stop has not run yet (on-demand
   * writes only — no polling).
   */
  serviceActive: boolean | null
  logSummary: string
}

/** One ring-buffer log line. */
export interface SshLogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

/** Main-process push payload for status changes ({id, status projection}). */
export interface SshStatusChangedPayload {
  id: string
  status: SshStatusProjection
}

/** Remote systemd exec result over IPC: the fresh projection or {error}. */
export type SshExecIpcResult = SshStatusProjection | { error: string }

/** Chamber-injected host-graph state (design 09 方案 A, module A+B): module A
 *  package present in the profile + the boot layer carrying the client-graph
 *  insert (local: the `--patch` overlay; remote: the profile's cordis.patch.yml).
 *  Both must hold for the row to resolve at boot; the plugin UI renders the
 *  half-injected state distinctly — the injection is never a silent modification.
 *  `version` = module A's own package version (null when not installed);
 *  `live` = whether the RUNNING remote instance has loaded the module (true) /
 *  restart still pending (false) / not probed (null; local side stays null). */
export interface ChamberHostGraphState {
  installed: boolean
  patched: boolean
  version: string | null
  live: boolean | null
}

/** Probe outcome: ok:false = the injection state could not be read (remote ssh
 *  exec failure / unparseable patch) — loud, never a silent "not injected". */
export type ChamberInjectionState =
  | {
    ok: true
    hostGraph: ChamberHostGraphState
    gitWorktree: { installed: boolean; patched: boolean; version: string | null; live: boolean | null }
  }
  | { ok: false; error: string }

/** Remote plugin manifest projection (design 13 §4.3): the remote profile
 *  package.json dependencies + the active bundle layer. profileExists=false
 *  means the remote profile is not yet initialized (first `dsh plugin add`
 *  creates it); error is the loud reason when cat/parse failed. */
export interface RemotePluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
  profileExists: boolean
  error?: string
  /** Chamber-injected component state (design 09), probed over the wire. */
  chamber: ChamberInjectionState
}

/** Local plugin manifest projection (design 13 §4.3): the local profile
 *  dependencies + bundle/client classification (main reads each dep's
 *  manifest) + the unsyncable set (workspace:/git+/URL/range/alias — refused
 *  for direct pass, §7.2). */
export interface LocalPluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
  clientLines: string[]
  /** Deps whose own manifest declares a `dsh.bundle` (verifyApplied bundles half-assertion). */
  bundleLines: string[]
  unsyncable: { name: string; reason: string }[]
  /** Chamber-injected component state (design 09), always readable locally. */
  chamber: ChamberInjectionState
}

/** One failed plugin_apply entry (single-item isolation; never blocks others). */
export interface PluginApplyFailure {
  spec: string
  error: string
}

/** plugin_apply result projection (design 13 §4.5): the honest outcome. */
export interface PluginApplyResult {
  applied: number
  skipped: number
  failed: PluginApplyFailure[]
  /** Whether a restart was executed and reported success. */
  restarted: boolean
  /** User chose "install only, don't restart" (restart === false). */
  deferred: boolean
  /** package.json assertion result (false = fail-loud, no rollback). */
  verified: boolean
  /** Post-restart readiness re-check; null = no restart attempted. */
  ready: boolean | null
  /** When ready is null because the instance was not connected before restart
   *  (readiness not re-checked), this explains why — the result view displays
   *  it verbatim when restarted && ready === null. */
  readyNote?: string
}

/** plugin_apply input (renderer → main; main re-validates every spec, §7.2). */
export interface PluginApplyInput {
  add: string[]
  remove: string[]
  restart?: boolean
}

/** One npm registry search hit (non-secret projection). */
export interface NpmSearchPackage {
  name: string
  version: string
  description?: string
}

/**
 * The desktop_ssh_* IPC surface (design 05 §3.3) — non-secret only: never a
 * tunnel URL, never SSH material. start_service/stop_service/is_active drive
 * remote systemd control (serviceName comes from the registry spec; format
 * whitelist `^[a-zA-Z0-9_.-]+$` enforced on the main side).
 *
 * Mirrors packages/desktop/preload.cts structurally (interface merging).
 */
export interface DesktopSshSurface {
  instances_get(): Promise<SshInstanceSpec[]>
  instances_set(instances: SshInstanceInput[]): Promise<SshInstanceSpec[]>
  /**
   * Store the SSH password in main-process memory plus the owner-only
   * plaintext fallback (design 05 §8); never logged; '' / null clears it.
   * Resolves {ok:true} or {error} (unknown id / platform not supported).
   */
  set_password(id: string, password: string | null): Promise<{ ok: true } | { error: string }>
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
  /** systemd restart (design 13 §4.1): exit-code honest, never silent. */
  restart_service(id: string): Promise<SshExecIpcResult>
  /** Remote plugin manifest (design 13 §4.3): cat → parse → projection. */
  plugin_list(id: string): Promise<{ ok: true; manifest: RemotePluginManifest } | { ok: false; error: string }>
  /** Apply plugin add/remove (design 13 §4.5): main re-validates, execs serially,
   *  restarts (unless deferred), asserts, and re-checks readiness. */
  plugin_apply(id: string, input: PluginApplyInput): Promise<{ ok: true; result: PluginApplyResult } | { ok: true; cancelled: true } | { ok: false; error: string }>
  /** Local plugin manifest (design 13 §4.3): main reads the authoritative local
   *  profile path (never dsh-chamber:info.dshHome). */
  local_plugin_list(): Promise<{ ok: true; manifest: LocalPluginManifest } | { ok: false; error: string }>
  /** npm registry search (design 13 §5.8): main-side, non-secret projection. */
  npm_search(query: string): Promise<{ ok: true; packages: NpmSearchPackage[] } | { ok: false; error: string }>
  /** Seed module A onto a remote instance (design 13 §4.6, 09 遗留 1). */
  seed_host_graph(id: string): Promise<SshSeedHostGraphResult>
  /** Materialize a named dependency; MAIN resolves its authoritative path. */
  plugin_materialize_add(id: string, name: string): Promise<SshMaterializeResult>
  /** Pick a local folder in MAIN and materialize it remotely (pick-only). */
  plugin_materialize_add_pick(id: string): Promise<SshMaterializeResult>
  /** Install a spec into the LOCAL dsh profile (design 13 §5.1). */
  local_plugin_add(spec: string): Promise<SshLocalPluginExecIpcResult>
  /** Pick a local folder and install it into the LOCAL dsh profile (pick-only). */
  local_plugin_add_file(): Promise<SshLocalPluginExecIpcResult>
  /** Remove a plugin from the LOCAL dsh profile (design 13 §5.1). */
  local_plugin_remove(name: string): Promise<SshLocalPluginExecIpcResult>
  onStatusChanged(callback: (payload: SshStatusChangedPayload) => void): () => void
  /** Registry changed (add/edit/delete via instances_set): re-pull the roster. */
  onInstancesChanged(callback: () => void): () => void
}

/** One discovered ~/.ssh/config host — non-secret projection only. */
export interface SshConfigHost {
  alias: string
  hostName: string
  user: string | null
  port: number | null
}

/** Discovery result: the entry list, or a loud error (never a silent empty). */
export type SshConfigDiscovery =
  | { hosts: SshConfigHost[] }
  | { error: string }

/** Host-graph seed outcome (design 13 §4.6): wrote = a module A file was written,
 *  patched = cordis.patch.yml gained the insert line. */
export type SshSeedHostGraphResult =
  | { ok: true; wrote: boolean; patched: boolean }
  | { ok: true; cancelled: true }
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

/**
 * The desktop update surface (design 11) — non-secret only: versions,
 * channel, a release-page URL, a short error text. Mirrors
 * packages/desktop/preload.cts structurally (interface merging).
 */
export type UpdatePhase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

/** Non-secret update state projection (design 11 §3.2). */
export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  latestVersion: string | null
  channel: 'stable' | 'beta'
  downloadPercent: number | null
  releaseUrl: string | null
  installBlockedReason: string | null
  error: string | null
}

/** window.dshChamber.update — query / subscribe / user-initiated check / user-confirmed download. */
export interface UpdateSurface {
  state(): Promise<UpdateState>
  /** User-initiated check (the「检查更新」button) — never downloads. */
  check(): Promise<{ ok: true } | { ok: false; error: string }>
  download(): Promise<{ ok: true } | { ok: false; error: string }>
  onChanged(callback: (state: UpdateState) => void): () => void
  /** Open a release page in the system browser (main-process allowlisted). */
  openReleasePage(url: string): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * The dsh-chamber settings surface (design 14 D7) — chamber-GLOBAL runtime
 * settings owned by the main process (<userData>/chamber-settings.json),
 * non-secret only. Mirrors packages/desktop/preload.cts structurally
 * (interface merging requires identical shapes).
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
  /** 桌面通知设置（design 19 §3.4）：嵌套键，默认值镜像 desktop
   *  chamber-settings.ts 的 DEFAULT_CHAMBER_SETTINGS.notifications。 */
  notifications: ChamberNotificationSettings
}

/** 桌面通知设置子块（design 19 §3.4）——结构与 desktop/chamber-settings.ts
 *  的 ChamberNotificationSettings 保持一致（镜像同步纪律）。 */
export interface ChamberNotificationSettings {
  /** 主开关（默认 false：低打扰，用户显式开启）。 */
  enabled: boolean
  /** 通知时机（默认 'hidden-only'：窗口聚焦时不打扰）。 */
  mode: 'hidden-only' | 'always'
  /** 会话完成时（默认 true）。 */
  onComplete: boolean
  /** 代理提问时（默认 true）。 */
  onAsk: boolean
  /** 审批请求时（默认 true）。 */
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
  set(patch: Partial<ChamberSettings>): Promise<ChamberSettingsStatus | { error: string }>
  onChanged(callback: (status: ChamberSettingsStatus) => void): () => void
}

/** OS wake-from-sleep notification (design 14 D4): reconnect immediately. */
export interface SystemResumeSurface {
  onResume(callback: (payload: { timestamp: number }) => void): () => void
}

/** 桌面原生通知请求（design 19 §3.3）：renderer 组装 → 主进程裁决/呈现。
 *  载荷全为非秘密投影（会话 id/标题/来源 label），无隧道 URL、无 SSH 材料。 */
export interface NotificationRequest {
  /** 来源 id（'local' | 'ssh-<id>'）。 */
  sourceId: string
  sessionId: string
  /** 'test' 由设置页「发送测试通知」直调（主进程跳过门禁直接显示）。 */
  kind: 'complete' | 'ask' | 'request' | 'test'
  title: string
  body: string
  /** 正在屏幕上查看的会话（主进程再查一次窗口焦点作权威豁免）。 */
  requireHidden: boolean
}

/** window.dshChamber.notifications — 桌面原生通知（design 19 §3.3）。
 *  桥与 desktopSsh 同一批 expose，desktopSsh 存在则 notifications 必存在。 */
export interface NotificationSurface {
  /** invoke 'dsh-chamber:notify'；返回主进程是否实际显示了通知。 */
  notify(payload: NotificationRequest): Promise<boolean>
  /** 就绪信号（invoke 'dsh-chamber:notifications-ready'）：onOpen 监听注册后
   *  调用——主进程只在就绪后放行 notification-open 推送（did-finish-load 早于
   *  监听注册，窗口重建路径的事件不能丢）。 */
  ready(): Promise<boolean>
  /** 主进程推送通知点击（'dsh-chamber:notification-open'）→ renderer 打开会话。 */
  onOpen(listener: (req: { sourceId: string; sessionId: string }) => void): () => void
}

/** window.dshChamber.openIn — registry capability negotiation + unified open action (open-in.ts). */
export interface OpenInAppInfo {
  id: string
  remoteCapable: boolean
  available: boolean
}
export interface OpenInSurface {
  /** Registry capability negotiation (fixed order); availability re-probed in the main process on every call. */
  apps(): Promise<OpenInAppInfo[]>
  /** The renderer trigger — the same runOpenInLaunch pipeline every entry point shares. */
  open(appId: string, instanceId: string, path: string): Promise<{ ok: true } | { ok: false; error: string }>
}

/** Normalized deep-link intent pushed from the main process (design 16 §2). */
export interface DeepLinkIntent {
  /** Raw registry id ('local' | registry id); the App layer prefixes 'ssh-' for remote sources. */
  instanceId: string
  path: string
}

/** window.dshChamber.deepLink — best-effort source-activation push for OS deep links. */
export interface DeepLinkSurface {
  onIntent(callback: (intent: DeepLinkIntent) => void): () => void
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
  notifications: NotificationSurface
}

declare global {
  interface Window {
    dshChamber?: DshChamberBridge
  }
}

export {}
