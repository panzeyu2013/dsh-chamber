/**
 * Control-plane REST client for the connections section (design 04 §3 /
 * 05 §7.2): /health, /api/connections (the single local row), /api/host/logs.
 *
 * The REST transport + wire shapes are the SINGLE shared copy in the chamber
 * sidebar package (shared/control-plane-client.ts — B2 convergence): both
 * this plugin and the renderer App layer consume it, so the two former
 * copies can never drift again. This module keeps the plugin-side `cp`
 * method surface and the plugin-management IPC wrappers (design 13
 * §4.3/§4.5/§5.8), which stay local. Every value is non-secret: tunnel URLs
 * and SSH material never cross this module.
 */

import {
  controlPlaneUrl,
  post,
  request,
  toConnectionSummary,
  type ApiError,
  type ApiErrorBody,
  type ConnectionRowWire,
  type ConnectionSummary,
  type HealthResponse,
  type HostLogLine,
  type HostLogsResponse,
} from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import type {
  LocalPluginManifest, NpmSearchPackage, PluginApplyInput, PluginApplyResult, RemotePluginManifest,
  SshExecIpcResult, SshLocalPluginExecIpcResult, SshMaterializeResult, SshSeedHostGraphResult,
} from '../global.d.ts'

/** 统一错误形状（design 04 D1：{error, code?}）+ HTTP 状态 + 响应体 + 限流提示。 */
export type {
  ApiErrorBody, ApiError, HealthResponse, ConnectionSummary, HostLogLine, HostLogsResponse,
}

export const cp = {
  /** GET /health → 本地 dsh 进程状态。 */
  health: (): Promise<HealthResponse> => request('/health'),

  /** SSE push channel (设计 05 §3): 当前快照 + 每次状态迁移。 */
  healthEvents: (): EventSource => new EventSource(controlPlaneUrl() + '/api/host/health-events'),

  /** GET /api/connections → 本地连接行（无行 404 → null）。 */
  connectionsList: async (): Promise<ConnectionSummary | null> => {
    try {
      const body = await request<{ connection?: ConnectionRowWire }>('/api/connections')
      const row = body?.connection
      return row === undefined || row === null ? null : toConnectionSummary(row)
    } catch (err) {
      if ((err as ApiError)?.status === 404) return null
      throw err
    }
  },

  /** POST /api/connections {kind:'local'} → 幂等启动本地实例。 */
  createLocal: async (): Promise<ConnectionSummary> => {
    const body = await post<{ connection?: ConnectionRowWire }>('/api/connections', { kind: 'local' })
    return toConnectionSummary(body?.connection ?? { id: 'local', status: 'starting' })
  },

  /** DELETE /api/connections/<id> → {stopped:true}（04 §3.2；本面上只有 local 行）。 */
  removeLocal: (connectionId: string): Promise<{ stopped: boolean }> =>
    request(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),

  /** GET /api/host/logs?limit=&offset=（04 §3.3；缺省 limit 200，上限 1000）。 */
  hostLogs: (limit?: number, offset?: number): Promise<HostLogsResponse> => {
    const params: string[] = []
    if (typeof limit === 'number' && Number.isFinite(limit)) params.push(`limit=${limit}`)
    if (typeof offset === 'number' && Number.isFinite(offset)) params.push(`offset=${offset}`)
    return request(params.length === 0 ? '/api/host/logs' : `/api/host/logs?${params.join('&')}`)
  },
}

/**
 * Plugin-management IPC wrappers (design 13 §4.3/§4.5/§5.8). These ride the
 * desktop SSH surface (window.dshChamber.desktopSsh.*) — the main process is
 * the only authority for exec/whitelisting/materialization; the renderer only
 * computes the view (plugin-diff.ts) and forwards explicit user intents.
 * The bridge is exposed asynchronously after dsh-chamber:info; a null surface
 * is a loud error (never a silent no-op), matching ConnectionsSection's guard.
 */

/** The desktop SSH surface, or a loud throw when the bridge is not yet up. */
function desktopSsh() {
  const surface = window.dshChamber?.desktopSsh
  if (surface == null) throw new Error('桌面端 SSH 面不可用（desktopSsh 未就绪）')
  return surface
}

export type LocalPluginListResult = { ok: true; manifest: LocalPluginManifest } | { ok: false; error: string }
export type RemotePluginListResult = { ok: true; manifest: RemotePluginManifest } | { ok: false; error: string }
export type PluginApplyResult2 = { ok: true; result: PluginApplyResult } | { ok: true; cancelled: true } | { ok: false; error: string }
export type NpmSearchResult = { ok: true; packages: NpmSearchPackage[] } | { ok: false; error: string }

/** Local plugin manifest (main reads the authoritative local profile path). */
export function localPluginList(): Promise<LocalPluginListResult> {
  return desktopSsh().local_plugin_list()
}

/** Remote plugin manifest (cat → parse → projection). */
export function pluginList(id: string): Promise<RemotePluginListResult> {
  return desktopSsh().plugin_list(id)
}

/** Apply plugin add/remove for one remote instance (main re-validates every spec). */
export function pluginApply(id: string, input: PluginApplyInput): Promise<PluginApplyResult2> {
  return desktopSsh().plugin_apply(id, input)
}

/** npm registry search (main-side, non-secret projection). */
export function npmSearch(query: string): Promise<NpmSearchResult> {
  return desktopSsh().npm_search(query)
}

/** systemd restart for one remote instance (exit-code honest). */
export function restartService(id: string): Promise<SshExecIpcResult> {
  return desktopSsh().restart_service(id)
}

/** Seed module A onto a remote instance (09 遗留 1). */
export function seedHostGraph(id: string): Promise<SshSeedHostGraphResult> {
  return desktopSsh().seed_host_graph(id)
}

/** Ask MAIN to resolve a named local-manifest dependency and install it remotely. */
export function pluginMaterializeAdd(id: string, name: string): Promise<SshMaterializeResult> {
  return desktopSsh().plugin_materialize_add(id, name)
}

/** Pack a user-picked local plugin dir and install it remotely (pick-only). */
export function pluginMaterializeAddPick(id: string): Promise<SshMaterializeResult> {
  return desktopSsh().plugin_materialize_add_pick(id)
}

/** Install a spec into the LOCAL dsh profile. */
export function localPluginAdd(spec: string): Promise<SshLocalPluginExecIpcResult> {
  return desktopSsh().local_plugin_add(spec)
}

/** Pick a local folder and install it into the LOCAL dsh profile (pick-only). */
export function localPluginAddFile(): Promise<SshLocalPluginExecIpcResult> {
  return desktopSsh().local_plugin_add_file()
}

/** Remove a plugin from the LOCAL dsh profile. */
export function localPluginRemove(name: string): Promise<SshLocalPluginExecIpcResult> {
  return desktopSsh().local_plugin_remove(name)
}
