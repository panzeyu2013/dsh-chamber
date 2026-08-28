/**
 * Control-plane REST client for the connections section (design 04 §3 /
 * 05 §7.2): /health, /api/connections (the single local row), /api/host/logs.
 *
 * The wire contract mirrors packages/renderer/src/api.ts — both derive from
 * the control-plane api.ts header comment (04 §3 verbatim); this package
 * bundles independently of the renderer, so the client lives here. Every
 * value is non-secret: tunnel URLs and SSH material never cross this module.
 */

import type {
  LocalPluginManifest, NpmSearchPackage, PluginApplyInput, PluginApplyResult, RemotePluginManifest,
  SshExecIpcResult, SshLocalPluginExecIpcResult, SshMaterializeResult, SshSeedHostGraphResult,
} from '../global.d.ts'

export interface ApiErrorBody {
  error?: string
  code?: string
  message?: string
}

export interface ApiError extends Error {
  status?: number
  body?: ApiErrorBody | null
  retryAfter?: number
}

const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:17500'

function controlPlaneUrl(): string {
  const injected = window.dshChamber?.controlPlaneUrl
  return String(injected || DEFAULT_CONTROL_PLANE_URL).replace(/\/+$/, '')
}

async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const url = controlPlaneUrl() + path
  const headers = new Headers(options.headers)
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let res: Response
  try {
    res = await fetch(url, { ...options, headers })
  } catch (err) {
    throw new Error(`无法访问控制面（${url}）：${err instanceof Error ? err.message : '网络错误'}`)
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // 非 JSON 响应（如 500 纯文本），下面按状态码兜底
  }

  if (!res.ok) {
    // Unified error shape (design 04 D1): {error: string, code?: string}.
    const body = data as ApiErrorBody | null
    const code = body?.code
    const message = body?.error || body?.message
    const error = new Error(
      `请求失败 ${res.status} ${path}${code ? `（${code}）` : ''}${message ? `：${message}` : ''}`
    ) as ApiError
    error.status = res.status
    error.body = body
    const retryAfter = Number(res.headers.get('retry-after'))
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter
    throw error
  }

  return data as T
}

function post<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}

/** GET /health → {ok, dsh:{status, port, error?}}（04 §3.1）。 */
export interface HealthResponse {
  ok: boolean
  dsh: { status: string; port: number | null; error?: string | null }
}

/** 本地连接行公共投影（04 §3.2；kind:'local' 恒为本地行）。 */
export interface ConnectionSummary {
  connectionId: string
  kind: 'local'
  label?: string
  accentColor?: string
  status: string
  dshPort?: number | null
  error?: string
}

/** 一行主机滚动日志（04 §3.3）。 */
export interface HostLogLine {
  ts: number
  stream: 'stdout' | 'stderr'
  line: string
}

/** GET /api/host/logs 响应（04 §3.3）。 */
export interface HostLogsResponse {
  port: number
  lines: HostLogLine[]
  truncated: boolean
}

/** /api/connections 行的 wire 形状（04 §3.2；控制面为权威）。 */
interface ConnectionRowWire {
  id: string
  label?: string
  accentColor?: string
  status: string
  dshPort?: number
  error?: string
}

/** wire 行 → 摘要（kind 恒为 'local'；connectionId 即行 id）。 */
function toSummary(row: ConnectionRowWire): ConnectionSummary {
  const summary: ConnectionSummary = { connectionId: row.id, kind: 'local', status: row.status }
  if (typeof row.label === 'string' && row.label !== '') summary.label = row.label
  if (typeof row.accentColor === 'string' && row.accentColor !== '') summary.accentColor = row.accentColor
  if (typeof row.dshPort === 'number' && row.dshPort > 0) summary.dshPort = row.dshPort
  if (typeof row.error === 'string' && row.error !== '') summary.error = row.error
  return summary
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
      return row === undefined || row === null ? null : toSummary(row)
    } catch (err) {
      if ((err as ApiError)?.status === 404) return null
      throw err
    }
  },

  /** POST /api/connections {kind:'local'} → 幂等启动本地实例。 */
  createLocal: async (): Promise<ConnectionSummary> => {
    const body = await post<{ connection?: ConnectionRowWire }>('/api/connections', { kind: 'local' })
    return toSummary(body?.connection ?? { id: 'local', status: 'starting' })
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
