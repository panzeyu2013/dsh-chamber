import type { IpcRendererEvent } from 'electron';
import type { SshInstanceInput, SshInstanceSpec, SshLogEntry, SshStatusProjection } from './transport-provider.ts';
import type { SshConfigDiscovery } from './ssh-config.ts';
import type { UpdateState } from './updater.ts';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The window.dshChamber bridge contract (design 05 §7.4) — the typed
 * surface the renderer consumes. The desktop_ssh_* surface is non-secret
 * only: never a transport URL, never credential material. onStatusChanged
 * subscribes to the main-process push and returns an unsubscribe. The
 * provider exec channels (ssh: systemd) resolve the fresh status projection
 * (serviceActive included) or {error} — loud failures, never silent empty
 * success.
 */
export interface DesktopSshSurface {
  instances_get(): Promise<SshInstanceSpec[]>
  instances_set(instances: SshInstanceInput[]): Promise<SshInstanceSpec[]>
  /**
   * Forward the SSH password to the main process, which holds it in memory
   * and mirrors it to the documented 0600 password store (design 05 §8).
   * The value is never returned or logged; '' / null clears it.
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
  /** Restart the remote systemd service (design 13 M2): fresh projection or {error}. */
  restart_service(id: string): Promise<SshExecIpcResult>
  /** Read the remote instance's plugin manifest (design 13 §4.3). */
  plugin_list(id: string): Promise<SshRemotePluginListResult>
  /** Apply a plugin-set change to a remote instance (design 13 §4.3/§4.5). */
  plugin_apply(id: string, input: SshPluginApplyInput): Promise<SshPluginApplyIpcResult>
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
  /** Registry changed (add/edit/delete via instances_set): re-pull the roster. */
  onInstancesChanged(callback: () => void): () => void
}

/** Main-process push payload for status changes ({id, status projection}). */
export interface SshStatusChangedPayload {
  id: string
  status: SshStatusProjection
}

/** Remote systemd exec result over IPC: the fresh projection or {error}. */
export type SshExecIpcResult = SshStatusProjection | { error: string }

/** Remote plugin manifest projection (design 13 §4.3). */
export interface SshRemotePluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
  profileExists: boolean
  error?: string
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

/** OS wake-from-sleep notification (design 14 D4): the renderer reconnects
 *  immediately instead of waiting for the heartbeat watchdog. */
export interface SystemResumeSurface {
  onResume(callback: (payload: { timestamp: number }) => void): () => void
}

/**
 * The VS Code deep-link surface (design 16 §5.2/§6.4): availability() is the
 * main-process probe (getter, re-probed on every call — no stale cache);
 * open() is the renderer button trigger — the same runVscodeLaunch pipeline as
 * the OS deep link, loud {error} on failure, never a silent empty success.
 */
export interface VscodeSurface {
  availability(): Promise<{ available: boolean }>
  open(instanceId: string, path: string): Promise<{ ok: true } | { ok: false; error: string }>
}

/** Normalized deep-link intent push payload (design 16 §2). */
export interface DeepLinkIntent {
  instanceId: string
  path: string
}

/** The deep-link intent push surface (design 16 §2): onIntent subscribes to the
 *  main-process push and returns an unsubscribe. */
export interface DeepLinkSurface {
  onIntent(callback: (intent: DeepLinkIntent) => void): () => void
}

/** The full bridge: app info + ssh + update + chamber settings + system resume
 *  + vscode deep-link surfaces. */
export interface DshChamberBridge {
  controlPlaneUrl: string | null
  dshVersion: string | null
  version: string | null
  desktopSsh: DesktopSshSurface
  update: UpdateSurface
  settings: SettingsSurface
  systemResume: SystemResumeSurface
  vscode: VscodeSurface
  deepLink: DeepLinkSurface
}

/**
 * The desktop_ssh_* IPC surface (design 05 §7.4) — non-secret only:
 * never a transport URL, never credential material. onStatusChanged
 * subscribes to the main-process push and returns an unsubscribe.
 */
function desktopSshApi(): DesktopSshSurface {
  return {
    instances_get: () => ipcRenderer.invoke('desktop_ssh_instances_get'),
    instances_set: instances => ipcRenderer.invoke('desktop_ssh_instances_set', instances),
    set_password: (id, password) => ipcRenderer.invoke('desktop_ssh_set_password', { id, password }),
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
      const listener = (_event: IpcRendererEvent) => callback();
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

/**
 * The dsh-chamber:vscode-availability / dsh-chamber:open-vscode IPC surface
 * (design 16 §5.2/§6.4): availability re-probed on every call (no stale cache);
 * open() is the renderer button trigger — the same runVscodeLaunch pipeline as
 * the OS deep link, loud {error} on failure.
 */
function vscodeApi(): VscodeSurface {
  return {
    availability: () => ipcRenderer.invoke('dsh-chamber:vscode-availability'),
    open: (instanceId, path) => ipcRenderer.invoke('dsh-chamber:open-vscode', { instanceId, path }),
  };
}

/** The dsh-chamber:deep-link-intent push surface (design 16 §2). */
function deepLinkApi(): DeepLinkSurface {
  return {
    onIntent: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event: IpcRendererEvent, intent: DeepLinkIntent) => callback(intent);
      ipcRenderer.on('dsh-chamber:deep-link-intent', listener);
      return () => ipcRenderer.removeListener('dsh-chamber:deep-link-intent', listener);
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
      desktopSsh: desktopSshApi(),
      update: updateApi(),
      settings: settingsApi(),
      systemResume: systemResumeApi(),
      vscode: vscodeApi(),
      deepLink: deepLinkApi(),
    });
  },
  (err: unknown) => {
    console.error('[dsh-chamber] 获取应用信息失败：', err);
    contextBridge.exposeInMainWorld('dshChamber', {
      controlPlaneUrl: null,
      dshVersion: null,
      version: null,
      desktopSsh: desktopSshApi(),
      update: updateApi(),
      settings: settingsApi(),
      systemResume: systemResumeApi(),
      vscode: vscodeApi(),
      deepLink: deepLinkApi(),
    });
  },
);
