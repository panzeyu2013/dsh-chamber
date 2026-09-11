/**
 * Control-plane REST client for the connections section (design 04 §3 /
 * 05 §7.2): /health, /api/connections (the single local row), /api/host/logs
 * — plus the per-instance-proxy gateway host-logs endpoint (design 17 §9.3:
 * /api/i/gateway-<id>/api/host/logs, same control-plane host-logs shape).
 *
 * The REST transport + wire shapes are the SINGLE shared copy in the chamber
 * sidebar package (shared/control-plane-client.ts — B2 convergence): both
 * this plugin and the renderer App layer consume it, so the two former
 * copies can never drift again. This module keeps the plugin-side `cp`
 * method surface and the plugin-management IPC wrappers (design 13
 * §4.1/§3/§5), which stay local. Every value is non-secret: tunnel URLs
 * and SSH material never cross this module.
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
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import { classifyGatewayReadFence } from './managed-restart.ts'
import type {
  GatewayPluginApplyIpcResult, GatewayPluginApplyInput, GatewayPluginMaterializeIpcResult, GatewayPluginSyncIpcResult, LocalPluginManifest, NpmSearchPackage, PluginApplyInput, PluginApplyResult, RemotePluginManifest,
  SshExecIpcResult, SshLocalPluginExecIpcResult, SshMaterializeResult, SshPluginUndoIpcResult, SshSeedHostGraphResult,
} from '../global.d.ts'
import type { GatewayTasksShape } from './plugin-model.ts'

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

  /**
   * GET /api/connections/local/writers → 写者静默诊断（2026-09-10，02 §3.4）。
   * 没有该路由的形态（501/404）返回 null：页面不渲染该块。
   */
  localWriters: async (): Promise<LocalWriterDiagnosisWire | null> => {
    try {
      return toLocalWriterDiagnosis(await request<unknown>('/api/connections/local/writers'))
    } catch (err) {
      const status = (err as ApiError)?.status
      if (status === 501 || status === 404) return null
      throw err
    }
  },

  /**
   * POST /api/connections/local/reclaim → 清理并接管：清除本状态目录自己的
   * 陈旧/孤儿托管写者记录后启动本地实例（仍在运行的其它应用实例不受影响）。
   * 仍有活写者时 409 connection_busy（带结构化 detail）。
   */
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

  /** GET /api/i/gateway-<id>/api/host/logs?limit=&offset= → the GATEWAY's own
   *  control-plane host logs (design 17 §9.3 / 03 §3): the desktop control
   *  plane strips the /api/i/gateway-<id> prefix and forwards /api/host/logs
   *  to the gateway (injecting its sanctioned Authorization/Cookie headers at
   *  forward time — the renderer never holds the token); the gateway's
   *  dispatch claims /api/host/* for its OWN api.handle, so the response is
   *  the same control-plane host-logs shape ({port, lines, truncated}) the
   *  local card parses — the managed dsh spawn logs of the gateway's
   *  stateDir. */
  gatewayHostLogs: (id: string, limit?: number, offset?: number): Promise<HostLogsResponse> => {
    const params: string[] = []
    if (typeof limit === 'number' && Number.isFinite(limit)) params.push(`limit=${limit}`)
    if (typeof offset === 'number' && Number.isFinite(offset)) params.push(`offset=${offset}`)
    const query = params.length === 0 ? '' : `?${params.join('&')}`
    return request(`/api/i/gateway-${id}/api/host/logs${query}`)
  },
}

/**
 * Plugin-management IPC wrappers (design 13 §4.1/§3/§5). These ride the
 * desktop SSH surface (window.dshChamber.desktopSsh.*) — the main process is
 * the only authority for exec/whitelisting/materialization; the renderer only
 * computes the view (plugin-diff.ts) and forwards explicit user intents.
 * The bridge is exposed asynchronously after dsh-chamber:info; a null surface
 * is a loud error (never a silent no-op), matching ConnectionsSection's guard.
 */

/** The desktop SSH surface, or a loud throw when the bridge is not yet up. */
function desktopSsh() {
  const surface = window.dshChamber?.desktopSsh
  // English verbatim per the unlocalized-error convention (main-process /
  // capability errors surface as-is in both locales).
  if (surface == null) throw new Error('The desktop SSH surface is unavailable (desktopSsh not ready)')
  return surface
}

export type LocalPluginListResult = { ok: true; manifest: LocalPluginManifest } | { ok: false; error: string }
export type RemotePluginListResult = { ok: true; manifest: RemotePluginManifest } | { ok: false; error: string }
/** plugin_apply (ssh) result — exactly the main-process SSH_PLUGIN_APPLY
 *  union (renderer global.d.ts DesktopSshSurface.plugin_apply / preload
 *  SshPluginApplyIpcResult). NO `{ok:true,cancelled:true}` arm: the ssh apply
 *  handler has no confirmation dialog or picker to dismiss (design 21 §7 —
 *  the ssh apply confirm gap is a registered open item; the gateway apply
 *  union carries the cancelled arm instead), so this wrapper can never see a
 *  user-cancelled result (ipc-surface-mirror.test.ts pins the producer
 *  union). */
export type PluginApplyResult2 = { ok: true; result: PluginApplyResult } | { ok: false; error: string }
export type NpmSearchResult = { ok: true; packages: NpmSearchPackage[] } | { ok: false; error: string }

/** GET /chamber/plugins seed-cache projection (design 17 §9.3, unchanged):
 *  name + version per synced chamber host package; version null = that
 *  package was never synced onto the gateway yet. */
export interface ChamberSeedCacheProjection {
  name: string
  version: string | null
}

/** GET /chamber/plugins/installed projection (design 21 §6.2 readManifest —
 *  the gateway implementation of the model readManifest verb): the managed
 *  web profile's (already masked) dependency map + bundles; HTTP 404/500 map
 *  to the absent/corrupt codes, the §6.2 read/write fence's 409 maps to the
 *  retryable busy arm (see gatewayInstalled), every other refusal stays a
 *  loud ApiError. */
export type GatewayInstalledProjection =
  | { ok: true; dependencies: Record<string, string>; bundles: string[]; profileExists: true }
  | { ok: false; code: 'profile_absent' | 'profile_corrupt' }
  /** The §6.2 读/写面共享栅栏 (2026-12 接线): a plugin mutation held the
   *  managed-profile write lease, so the gateway withheld the projection with
   *  409 `runtime_busy` rather than publishing a torn one. NOT a read failure
   *  and NOT a profile state: the caller renders the dedicated busy copy
   *  (gatewayReadFenceText) and the dialog's own reload rhythm retries.
   *  `refusalCode` is the server's own code — null when the refusal body
   *  carried none (gateway routes.ts answers `{error, code:'runtime_busy'}`). */
  | { ok: false; code: 'runtime_busy'; refusalCode: string | null }

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

/** Pack/upload a user-picked local plugin source (dir or .tgz archive,
 *  design 21 §6.5 archive-pick) and install it remotely (pick-only). */
export function pluginMaterializeAddPick(id: string): Promise<SshMaterializeResult> {
  return desktopSsh().plugin_materialize_add_pick(id)
}

/** Install a spec into the LOCAL dsh profile. */
export function localPluginAdd(spec: string): Promise<SshLocalPluginExecIpcResult> {
  return desktopSsh().local_plugin_add(spec)
}

/** Pick a local plugin source (folder or .tgz archive) and install it into
 *  the LOCAL dsh profile (pick-only). */
export function localPluginAddFile(): Promise<SshLocalPluginExecIpcResult> {
  return desktopSsh().local_plugin_add_file()
}

/** Remove a plugin from the LOCAL dsh profile. */
export function localPluginRemove(name: string): Promise<SshLocalPluginExecIpcResult> {
  return desktopSsh().local_plugin_remove(name)
}

/** Undo the latest ok ssh plugin change of a remote instance (design 21
 *  §6.4, plan Phase 5 ssh 统一增量): the MAIN process consults its ssh
 *  journal, confirms with the user (cancelled = dismissed), and re-executes
 *  the inverse row through the same ssh plugin_apply flow (restart-to-apply,
 *  journaled). The renderer never supplies a spec — the id-only intent keeps
 *  the journal authoritative. */
export function sshPluginUndo(id: string): Promise<SshPluginUndoIpcResult> {
  return desktopSsh().ssh_plugin_undo(id)
}

/* ---- Gateway A0 read side + manual chamber sync (design 21 §6.2/§6.5, plan
 * Phase 3) ----
 * The reads ride the per-instance proxy like gatewayHostLogs above
 * (`/api/i/gateway-<id>/…` — the shared request throws the unified ApiError
 * on any non-2xx); the sync IPC takes the RAW registry instance id (no
 * `gateway-` proxy prefix — the main process validates INSTANCE_ID_PATTERN
 * against the registry key, the same id `save_connection`/`connect` use).
 * Every value is non-secret: package names/versions and ok/code statuses,
 * plus an id-only sync intent — never a URL or credential. */

/** GET /chamber/plugins (design 17 §9.3 seed cache, unchanged): name+version
 *  per synced chamber host package (version null = never synced). A non-2xx
 *  answer throws the shared ApiError — never a silent empty list. */
export async function gatewayChamberSeedCache(id: string): Promise<{ items: ChamberSeedCacheProjection[] }> {
  return request<{ items: ChamberSeedCacheProjection[] }>(`/api/i/gateway-${id}/chamber/plugins`)
}

/** The read fence's bounded retry budget (design 21 §6.2 fence / §7 接线): the
 *  fence is released at the mutation's terminal edge, which can trail the 202
 *  the caller just observed by a few hundred ms (the orchestrator writes the
 *  journal `pending` record before the worker runs), so ONE short-backoff
 *  re-read absorbs that window. A longer-lived fence — a real install running
 *  for seconds to minutes, or ANOTHER client's mutation — is never polled from
 *  here: the caller shows the busy state and the dialog's existing reload
 *  rhythm (open / post-op / 「刷新」) retries, so no request storm can build up
 *  behind a manual refresh or a competing writer. */
const INSTALLED_FENCE_RETRIES = 1
const INSTALLED_FENCE_BACKOFF_MS = 400

/** Wait out the fence's backoff, cut short by the caller's signal: an aborted
 *  read (dialog reloaded / unmounted) must not fire its pending retry. The
 *  shared request() carries no signal (its RequestOptions is the converged
 *  cross-package transport face), so the in-flight fetch is not abortable
 *  here — the retry LOOP is, which is what bounds the request count. */
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

/** GET /chamber/plugins/installed (design 21 §6.2 readManifest): 200 ok
 *  projection / 404 profile_absent / 500 profile_corrupt map to the typed
 *  union; the read/write fence's 409 becomes the `runtime_busy` arm after a
 *  bounded re-read (it is a busy state, never a read failure — the caller
 *  localizes it via gatewayReadFenceText); any other refusal (network,
 *  401/403, proxy 503 …) rethrows the shared ApiError — a failure is never
 *  folded into an ok shape.
 * @param id - the RAW registry instance id (the proxy prefix is added here).
 * @param options.signal - bounds the fence retry loop; an already-aborted
 *   signal keeps the read single-shot (the first attempt still runs — the
 *   caller asked for it). */
export async function gatewayInstalled(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<GatewayInstalledProjection> {
  const path = `/api/i/gateway-${id}/chamber/plugins/installed`
  const signal = options.signal
  // Re-read through a call: the abort state changes across the backoff await,
  // and an inline `signal?.aborted` read would be narrowed to a constant.
  const readAborted = (): boolean => signal?.aborted === true
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request<GatewayInstalledProjection>(path)
    } catch (error) {
      const status = (error as ApiError)?.status
      if (status === 404) return { ok: false, code: 'profile_absent' }
      if (status === 500) return { ok: false, code: 'profile_corrupt' }
      // 409 = the §6.2 read/write fence, classified by the SHARED 409
      // classifier (the /chamber/runtime lease family, managed-restart.ts):
      // anything it does not classify is an ordinary read failure and stays
      // loud.
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

/** GET /chamber/plugins/tasks (design 21 §6.2 task projection, plan Phase
 *  5.③): journal ops (newest first, retention-capped) + durable deferred
 *  intents + the executor busy flag — the read side of the 202 contract.
 *  The wire type is the model layer's structural twin
 *  (plugin-model.ts GatewayTasksShape — single twin shared by the REST
 *  boundary and the row projection); a non-2xx answer throws the shared
 *  ApiError, never a silent empty list. */
export async function gatewayTasks(id: string): Promise<GatewayTasksShape> {
  return request<GatewayTasksShape>(`/api/i/gateway-${id}/chamber/plugins/tasks`)
}

/** Re-run the chamber host-package seed-cache sync on a gateway instance
 *  (design 21 §6.5): the ready registration's auto-sync on demand, over the
 *  main-process-owned registered transport — {uploaded, skipped} answers the
 *  awaited auto path, ok:false is loud (no registration / instance gone). */
export function gatewayPluginSync(id: string): Promise<GatewayPluginSyncIpcResult> {
  return desktopSsh().gateway_plugin_sync(id)
}

/** Batch registry add/remove + restart-to-apply on a gateway instance
 *  (design 21 §6.5/§6.6): id-only (the main process validates every spec
 *  against the shared whitelist family), main-process confirmation first
 *  (cancelled = the user dismissed it), ok:true executed arm / ok:false
 *  loud with partial ops. Classified through the model layer
 *  (classifyGatewayApplyResult) by the callers. */
export function gatewayPluginApply(id: string, input: GatewayPluginApplyInput): Promise<GatewayPluginApplyIpcResult> {
  return desktopSsh().gateway_plugin_apply(id, input)
}

/** Pick a local plugin source (folder or .tgz archive) in MAIN and upload it
 *  to a gateway instance (pick-only, design 21 §6.5): cancelled = the
 *  picker was dismissed; ok:true deferred = the gateway cached the install
 *  intent for the next ready edge (false = accepted onto the executor queue). */
export function gatewayPluginMaterialize(id: string): Promise<GatewayPluginMaterializeIpcResult> {
  return desktopSsh().gateway_plugin_materialize(id)
}
