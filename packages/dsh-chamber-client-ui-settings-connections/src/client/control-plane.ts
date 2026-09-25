/**
 * Control-plane REST client for the connections section (design 04 §3 / 05 §7.2):
 * /health, /api/connections, /api/host/logs, plus the per-instance-proxy gateway
 * host-logs endpoint (same control-plane shape).
 *
 * The REST transport + wire shapes are the SINGLE shared copy in the chamber sidebar
 * package (shared/control-plane-client.ts), consumed by both this plugin and the
 * renderer App layer, so the two cannot drift. This module keeps the plugin-side `cp`
 * method surface and the RETAINED plugin IPC wrappers: the plugin read face
 * (plugin_list / local_plugin_list) and chamber host-package provisioning
 * (seed_host_graph / gateway_plugin_sync). The user plugin write wrappers
 * (apply/remove/materialize/undo/npm search) and the gateway admin write routes
 * were retired (D1). Every value is non-secret: tunnel URLs and SSH material
 * never cross this module.
 */

import {
  controlPlaneUrl,
  post,
  request,
  toConnectionSummary,
  toLocalWriterDiagnosis,
  type LocalWriterDiagnosisWire,
  type ApiError,
  type ApiErrorBody,
  type ConnectionRowWire,
  type ConnectionSummary,
  type HealthResponse,
  type HostLogLine,
  type HostLogsResponse,
} from '@dsh-chamber/dsh-chamber-client-core'
import { classifyGatewayReadFence } from './managed-restart.ts'
import type {
  GatewayPluginSyncIpcResult, LocalPluginManifest, RemotePluginManifest,
  SshExecIpcResult, SshSeedHostGraphResult,
} from '../global.d.ts'
// The refusal-code vocabulary is THE single definition in the neutral wire package, reached
// through client-core's browser face.
import type { PluginProfileRefusalCode } from '@dsh-chamber/dsh-chamber-client-core/plugin-manifest'
import type { PluginRowShape } from './plugin-model.ts'

/** 统一错误形状（{error, code?}）+ HTTP 状态 + 响应体 + 限流提示。 */
export type {
  ApiErrorBody, ApiError, HealthResponse, ConnectionSummary, HostLogLine, HostLogsResponse,
}

export const cp = {
  /** GET /health → 本地 dsh 进程状态。 */
  health: (): Promise<HealthResponse> => request('/health'),

  /** SSE push channel: 当前快照 + 每次状态迁移。 */
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

  /** GET /api/connections/local/writers → 写者静默诊断。没有该路由的形态（501/404）
   *  返回 null：页面不渲染该块。 */
  localWriters: async (): Promise<LocalWriterDiagnosisWire | null> => {
    try {
      return toLocalWriterDiagnosis(await request<unknown>('/api/connections/local/writers'))
    } catch (err) {
      const status = (err as ApiError)?.status
      if (status === 501 || status === 404) return null
      throw err
    }
  },

  /** POST /api/connections/local/reclaim → 清理并接管：清除本状态目录自己的陈旧/孤儿
   *  托管写者记录后启动本地实例（其它运行实例不受影响）。仍有活写者时 409 connection_busy（带结构化 detail）。 */
  reclaimLocal: async (): Promise<{ connection: ConnectionSummary; reclaimed: number[] }> => {
    const body = await post<{ connection?: ConnectionRowWire; reclaimed?: unknown }>(
      '/api/connections/local/reclaim', {})
    return {
      connection: toConnectionSummary(body?.connection ?? { id: 'local', status: 'starting' }),
      reclaimed: Array.isArray(body?.reclaimed)
        ? body.reclaimed.filter((pid): pid is number => typeof pid === 'number')
        : [],
    }
  },

  /** DELETE /api/connections/<id> → {stopped:true}（本面上只有 local 行）。 */
  removeLocal: (connectionId: string): Promise<{ stopped: boolean }> =>
    request(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),

  /** GET /api/host/logs?limit=&offset=（缺省 limit 200，上限 1000）。 */
  hostLogs: (limit?: number, offset?: number): Promise<HostLogsResponse> => {
    const params: string[] = []
    if (typeof limit === 'number' && Number.isFinite(limit)) params.push(`limit=${limit}`)
    if (typeof offset === 'number' && Number.isFinite(offset)) params.push(`offset=${offset}`)
    return request(params.length === 0 ? '/api/host/logs' : `/api/host/logs?${params.join('&')}`)
  },

  /** GET /api/i/gateway-<id>/api/host/logs?limit=&offset= → the GATEWAY's own host logs:
   *  the desktop strips the proxy prefix and forwards /api/host/logs with its sanctioned
   *  Authorization/Cookie headers injected (the renderer never holds the token), so the response
   *  is the same {port, lines, truncated} shape the local card parses. */
  gatewayHostLogs: (id: string, limit?: number, offset?: number): Promise<HostLogsResponse> => {
    const params: string[] = []
    if (typeof limit === 'number' && Number.isFinite(limit)) params.push(`limit=${limit}`)
    if (typeof offset === 'number' && Number.isFinite(offset)) params.push(`offset=${offset}`)
    const query = params.length === 0 ? '' : `?${params.join('&')}`
    return request(`/api/i/gateway-${id}/api/host/logs${query}`)
  },
}

/**
 * Retained plugin IPC wrappers: the plugin READ face (plugin_list / local_plugin_list)
 * and chamber host-package provisioning (seed_host_graph / gateway_plugin_sync), riding
 * the desktop SSH surface (window.dshChamber.desktopSsh.*) — the main process is the only
 * authority for exec/whitelisting/seed-cache upload; the renderer computes the view and
 * forwards explicit user intents. The user plugin write wrappers were retired with the
 * write surfaces. The bridge appears after dsh-chamber:info; a null surface is a loud
 * error, never a silent no-op.
 */

/** The desktop SSH surface, or a loud throw when the bridge is not yet up. */
function desktopSsh() {
  const surface = window.dshChamber?.desktopSsh
  // English verbatim per the unlocalized-error convention (main-process / capability errors surface as-is).
  if (surface == null) throw new Error('The desktop SSH surface is unavailable (desktopSsh not ready)')
  return surface
}

export type LocalPluginListResult = { ok: true; manifest: LocalPluginManifest } | { ok: false; error: string }
export type RemotePluginListResult = { ok: true; manifest: RemotePluginManifest } | { ok: false; error: string }

/** GET /chamber/plugins seed-cache projection: name + version per synced chamber host
 *  package; version null = never synced onto the gateway yet. */
export interface ChamberSeedCacheProjection {
  name: string
  version: string | null
}

/** GET /chamber/plugins/installed projection: the managed web profile's (masked) dependency
 *  map + the row projection; HTTP 404/500 map to absent/corrupt codes, the read/write fence's
 *  409 maps to the retryable busy arm, every other refusal stays a loud ApiError. The refusal
 *  codes come from the wire single source; this module owns only the HTTP-status mapping.
 *  `rows` is REQUIRED: gateway and frontend ship from the same release and every backend
 *  projects it (design 21 §6.11.7 — the old-gateway fallback was deleted); a missing/malformed
 *  payload still renders as an explicit empty projection in plugin-model.ts. */
export type GatewayInstalledProjection =
  | {
    ok: true
    /** Masked dependency map (the manifest half this read face still projects). */
    dependencies: Record<string, string>
    /** Read-face row projection — one row per declared dependency. */
    rows: readonly PluginRowShape[]
    profileExists: true
  }
  | { ok: false; code: PluginProfileRefusalCode }
  /** The read/write fence: a plugin mutation held the managed-profile write lease, so the
   *  gateway withheld the projection with 409 `runtime_busy` rather than publishing a torn one.
   *  NOT a read failure and NOT a profile state — the caller renders the busy copy and retries.
   *  `refusalCode` is the server's own code (null when the refusal body carried none). */
  | { ok: false; code: 'runtime_busy'; refusalCode: string | null }

/** Local plugin manifest (main reads the authoritative local profile path). */
export function localPluginList(): Promise<LocalPluginListResult> {
  return desktopSsh().local_plugin_list()
}

/** Remote plugin manifest (cat → parse → projection). */
export function pluginList(id: string): Promise<RemotePluginListResult> {
  return desktopSsh().plugin_list(id)
}

/** systemd restart for one remote instance (exit-code honest). */
export function restartService(id: string): Promise<SshExecIpcResult> {
  return desktopSsh().restart_service(id)
}

/** Seed module A onto a remote instance (chamber provisioning, not a user plugin write). */
export function seedHostGraph(id: string): Promise<SshSeedHostGraphResult> {
  return desktopSsh().seed_host_graph(id)
}

/* ---- Gateway A0 read side + manual chamber sync ----
 * The reads ride the per-instance proxy like gatewayHostLogs above; the sync IPC takes the RAW
 * registry instance id (no `gateway-` proxy prefix — main validates INSTANCE_ID_PATTERN against
 * the registry key). Every value is non-secret: package names/versions, statuses, and an id-only
 * sync intent — never a URL or credential. */

/** GET /chamber/plugins seed cache: name+version per synced chamber host package (version
 *  null = never synced). A non-2xx answer throws the shared ApiError — never a silent empty list. */
export async function gatewayChamberSeedCache(id: string): Promise<{ items: ChamberSeedCacheProjection[] }> {
  return request<{ items: ChamberSeedCacheProjection[] }>(`/api/i/gateway-${id}/chamber/plugins`)
}

/** The read fence's bounded retry budget: the fence is released at the mutation's terminal
 *  edge, which can trail the 202 by a few hundred ms, so ONE short-backoff re-read absorbs that
 *  window. A longer-lived fence (a real install running for seconds, or ANOTHER client's mutation)
 *  is never polled from here — the caller shows the busy state and the dialog's reload rhythm retries. */
const INSTALLED_FENCE_RETRIES = 1
const INSTALLED_FENCE_BACKOFF_MS = 400

/** Wait out the fence's backoff, cut short by the caller's signal: an aborted read must not
 *  fire its pending retry. The shared request() carries no signal, so the retry LOOP is what is
 *  abortable here — which is what bounds the request count. */
function installedFenceBackoff(signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, INSTALLED_FENCE_BACKOFF_MS)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** GET /chamber/plugins/installed: 200 ok / 404 profile_absent / 500 profile_corrupt map to
 *  the typed union; the read/write fence's 409 becomes the `runtime_busy` arm after a bounded
 *  re-read (a busy state, never a read failure); any other refusal (network, 401/403, proxy 503 …)
 *  rethrows the shared ApiError — a failure is never folded into an ok shape.
 *  @param id - the RAW registry instance id (the proxy prefix is added here).
 *  @param options.signal - bounds the fence retry loop; an already-aborted signal keeps the read single-shot. */
export async function gatewayInstalled(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<GatewayInstalledProjection> {
  const path = `/api/i/gateway-${id}/chamber/plugins/installed`
  const signal = options.signal
  // Re-read through a call: the abort state changes across the backoff await; an inline read would be narrowed to a constant.
  const readAborted = (): boolean => signal?.aborted === true
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request<GatewayInstalledProjection>(path)
    } catch (error) {
      const status = (error as ApiError)?.status
      if (status === 404) return { ok: false, code: 'profile_absent' }
      if (status === 500) return { ok: false, code: 'profile_corrupt' }
      // 409 = the read/write fence, classified by the SHARED 409 classifier; anything it does not
      // classify is an ordinary read failure and stays loud.
      const fence = classifyGatewayReadFence((error as ApiError)?.body, status ?? 0)
      if (fence === null) throw error
      if (attempt < INSTALLED_FENCE_RETRIES && !readAborted()) {
        await installedFenceBackoff(signal)
        if (!readAborted()) continue
      }
      return { ok: false, code: 'runtime_busy', refusalCode: fence.code }
    }
  }
}

/** Re-run the chamber host-package seed-cache sync on a gateway instance: the ready
 *  registration's auto-sync on demand, over the main-process-owned registered transport —
 *  {uploaded, skipped} answers the awaited path; ok:false is loud (no registration / instance gone). */
export function gatewayPluginSync(id: string): Promise<GatewayPluginSyncIpcResult> {
  return desktopSsh().gateway_plugin_sync(id)
}
