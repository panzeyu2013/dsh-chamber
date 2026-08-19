/**
 * The window.dshChamber page bridge as consumed by the connections section
 * (desktop preload.cts, design 05 §3.3). Mirrors the renderer's
 * global.d.ts declaration structurally (interface merging): non-secret
 * projections only — never a tunnel URL, never SSH material.
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
  /** Last known systemd activation state; null when not yet queried. */
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
  | { ok: true; hostGraph: ChamberHostGraphState }
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
 * The desktop_ssh_* IPC surface (design 05 §3.3) — non-secret only. The
 * systemd ops require the registry spec's serviceName (format whitelist
 * enforced on the main side).
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
  plugin_apply(id: string, input: PluginApplyInput): Promise<{ ok: true; result: PluginApplyResult } | { ok: false; error: string }>
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

/** Update lifecycle phase (design 11 §3.2). `up-to-date` = a check ran and
 *  found nothing newer (distinct from `idle`, which means not checked yet). */
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

/** window.dshChamber.update — query / subscribe / user-initiated check / user-confirmed download.
 *  Structural mirror of renderer/src/global.d.ts (merge must stay shape-identical). */
export interface UpdateSurface {
  state(): Promise<UpdateState>
  /** User-initiated check (the「检查更新」button) — never downloads. */
  check(): Promise<{ ok: true } | { ok: false; error: string }>
  download(): Promise<{ ok: true } | { ok: false; error: string }>
  onChanged(callback: (state: UpdateState) => void): () => void
  /** Open a release page in the system browser (main-process allowlisted). */
  openReleasePage(url: string): Promise<{ ok: true } | { ok: false; error: string }>
}

/** Close-window behavior (design 14 D1): hide to tray (dsh keeps running) or quit. */
export type WindowCloseBehavior = 'hide-to-tray' | 'quit'

/** Chamber-global runtime settings (design 14 v1 scope) — structural mirror of
 *  renderer/src/global.d.ts (merge must stay shape-identical). */
export interface ChamberSettings {
  windowCloseBehavior: WindowCloseBehavior
  /** Login autostart (design 14 D6): mac/linux; win gated off in v1. */
  launchAtLogin: boolean
  /** prevent-app-suspension (design 14 D5); default off. */
  keepAwake: boolean
  /** Quit confirmation (design 14 D2): confirm only while the local dsh
   *  instance runs; remote tunnels never prompt. Default on. */
  quitConfirmation: boolean
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

/** Chamber-global runtime settings (design 14 D7) — non-secret projection,
 *  structural mirror of renderer/src/global.d.ts (2026-08 review: the mirror
 *  drifted when the settings/systemResume surfaces were added — kept in
 *  lockstep so the merge stays clean if this package joins the root typecheck). */
export interface SettingsSurface {
  get(): Promise<ChamberSettingsStatus>
  set(patch: Partial<ChamberSettings>): Promise<ChamberSettingsStatus | { error: string }>
  onChanged(callback: (status: ChamberSettingsStatus) => void): () => void
}

/** OS wake-from-sleep notification (design 14 D4): reconnect immediately. */
export interface SystemResumeSurface {
  onResume(callback: (payload: { timestamp: number }) => void): () => void
}

declare global {
  /**
   * Structurally mirrors renderer/src/global.d.ts's DshChamberBridge so the
   * two declarations merge cleanly if this package ever joins the root
   * typecheck program (interface merging requires identical property types).
   */
  interface Window {
    dshChamber?: {
      controlPlaneUrl: string | null
      dshVersion: string | null
      version: string | null
      desktopSsh: DesktopSshSurface
      update: UpdateSurface
      settings: SettingsSurface
      systemResume: SystemResumeSurface
    }
  }
}

export {}
