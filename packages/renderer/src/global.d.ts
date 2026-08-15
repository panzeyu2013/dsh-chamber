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
}

/** The non-secret status projection (design 05 §8): never a transport URL. */
export interface SshStatusProjection {
  /** Transport provider kind (v1: 'ssh'). */
  kind: string
  phase: SshPhase
  localPort: number | null
  sshPort: number | null
  remotePort: number
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
   * Store the SSH password for one instance in main-process memory ONLY
   * (design 05 §8): never persisted, never logged; '' / null clears it.
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

/** The full bridge: app info fields + the ssh surface. */
export interface DshChamberBridge {
  controlPlaneUrl: string | null
  dshWorkspace: string | null
  dshVersion: string | null
  dshHome: string | null
  version: string | null
  desktopSsh: DesktopSshSurface
}

declare global {
  interface Window {
    dshChamber?: DshChamberBridge
  }
}

export {}
