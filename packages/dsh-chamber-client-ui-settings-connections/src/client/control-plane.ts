/**
 * Control-plane REST client for the connections section (design 04 §3 / 05 §7.2):
 * /health, /api/connections, /api/host/logs, plus the per-instance-proxy gateway
 * host-logs endpoint (same control-plane shape).
 *
 * The REST transport + wire shapes are the SINGLE shared copy in the chamber sidebar
 * package (shared/control-plane-client.ts), consumed by both this plugin and the
 * renderer App layer, so the two cannot drift. This module keeps the plugin-side `cp`
 * method surface and the plugin-management IPC wrappers. Every value is non-secret:
 * tunnel URLs and SSH material never cross this module.
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
import { errorMessage } from './error-text.ts'
import type {
  GatewayPluginApplyIpcResult, GatewayPluginApplyInput, GatewayPluginMaterializeIpcResult, GatewayPluginSyncIpcResult, LocalPluginManifest, NpmSearchPackage, PluginApplyInput, PluginApplyResult, RemotePluginManifest,
  SshExecIpcResult, SshLocalPluginExecIpcResult, SshMaterializeResult, SshPluginUndoIpcResult, SshSeedHostGraphResult,
} from '../global.d.ts'
// The manifest projection model (dependencies + bundles) and the refusal-code vocabulary
// are THE single definition in the neutral wire package, reached through client-core's browser face.
import type { PluginManifestModel, PluginProfileRefusalCode } from '@dsh-chamber/dsh-chamber-client-core/plugin-manifest'
import type { GatewayTasksShape, PluginRowShape } from './plugin-model.ts'

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
 * Plugin-management IPC wrappers: they ride the desktop SSH surface
 * (window.dshChamber.desktopSsh.*) — the main process is the only authority for
 * exec/whitelisting/materialization; the renderer computes the view and forwards
 * explicit user intents. The bridge appears after dsh-chamber:info; a null surface
 * is a loud error, never a silent no-op.
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
/** plugin_apply (ssh) result — exactly the main-process SSH_PLUGIN_APPLY union (renderer
 *  global.d.ts / preload SshPluginApplyIpcResult). NO `{ok:true,cancelled:true}` arm: the ssh
 *  apply handler has no confirmation dialog or picker to dismiss (the gateway union carries it). */
export type PluginApplyResult2 = { ok: true; result: PluginApplyResult } | { ok: false; error: string }
export type NpmSearchResult = { ok: true; packages: NpmSearchPackage[] } | { ok: false; error: string }

/** GET /chamber/plugins seed-cache projection: name + version per synced chamber host
 *  package; version null = never synced onto the gateway yet. */
export interface ChamberSeedCacheProjection {
  name: string
  version: string | null
}

/** GET /chamber/plugins/installed projection: the managed web profile's (masked) dependency
 *  map + bundles + the additive row projection; HTTP 404/500 map to absent/corrupt codes, the
 *  read/write fence's 409 maps to the retryable busy arm, every other refusal stays a loud
 *  ApiError. The manifest half and refusal codes come from the wire single source; this module
 *  owns only the HTTP-status mapping.
 *  `rows` is OPTIONAL on purpose: an older in-place gateway answers without it, and the dialog
 *  then falls back to the legacy dependencies filter + the "gateway is older" hint. */
export type GatewayInstalledProjection =
  | ({
    ok: true
    /** Additive row projection; absent on an OLDER gateway. */
    rows?: readonly PluginRowShape[]
    profileExists: true
  } & PluginManifestModel)
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

/** Seed module A onto a remote instance. */
export function seedHostGraph(id: string): Promise<SshSeedHostGraphResult> {
  return desktopSsh().seed_host_graph(id)
}

/** Pack/upload a user-picked local plugin source (dir or .tgz archive) and install it remotely (pick-only). */
export function pluginMaterializeAddPick(id: string): Promise<SshMaterializeResult> {
  return desktopSsh().plugin_materialize_add_pick(id)
}

/** Install a spec into the LOCAL dsh profile. */
export function localPluginAdd(spec: string): Promise<SshLocalPluginExecIpcResult> {
  return desktopSsh().local_plugin_add(spec)
}

/** Pick a local plugin source (folder or .tgz archive) and install it into the LOCAL dsh profile (pick-only). */
export function localPluginAddFile(): Promise<SshLocalPluginExecIpcResult> {
  return desktopSsh().local_plugin_add_file()
}

/** Remove a plugin from the LOCAL dsh profile. */
export function localPluginRemove(name: string): Promise<SshLocalPluginExecIpcResult> {
  return desktopSsh().local_plugin_remove(name)
}

/** Undo the latest ok ssh plugin change: the MAIN process consults its ssh journal, confirms
 *  with the user (cancelled = dismissed), and re-executes the inverse row through the same ssh
 *  plugin_apply flow (restart-to-apply, journaled). The renderer never supplies a spec — the
 *  id-only intent keeps the journal authoritative. */
export function sshPluginUndo(id: string): Promise<SshPluginUndoIpcResult> {
  return desktopSsh().ssh_plugin_undo(id)
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

/** GET /chamber/plugins/tasks: journal ops (newest first, retention-capped) + durable deferred
 *  intents + the executor busy flag — the read side of the 202 contract. The wire type is the model
 *  layer's structural twin (plugin-model.ts GatewayTasksShape). A non-2xx throws the shared ApiError,
 *  never a silent empty list. */
export async function gatewayTasks(id: string): Promise<GatewayTasksShape> {
  return request<GatewayTasksShape>(`/api/i/gateway-${id}/chamber/plugins/tasks`)
}

/** Re-run the chamber host-package seed-cache sync on a gateway instance: the ready
 *  registration's auto-sync on demand, over the main-process-owned registered transport —
 *  {uploaded, skipped} answers the awaited path; ok:false is loud (no registration / instance gone). */
export function gatewayPluginSync(id: string): Promise<GatewayPluginSyncIpcResult> {
  return desktopSsh().gateway_plugin_sync(id)
}

/** Batch registry add/remove + restart-to-apply on a gateway instance: id-only (main validates
 *  every spec against the shared whitelist family), main-process confirmation first (cancelled = the
 *  user dismissed it), ok:true executed arm / ok:false loud with partial ops. Classified through the
 *  model layer by the callers. */
export function gatewayPluginApply(id: string, input: GatewayPluginApplyInput): Promise<GatewayPluginApplyIpcResult> {
  return desktopSsh().gateway_plugin_apply(id, input)
}

/** Pick a local plugin source (folder or .tgz) in MAIN and upload it to a gateway instance:
 *  cancelled = the picker was dismissed; ok:true deferred = the gateway cached the install intent
 *  for the next ready edge (false = accepted onto the executor queue). */
export function gatewayPluginMaterialize(id: string): Promise<GatewayPluginMaterializeIpcResult> {
  return desktopSsh().gateway_plugin_materialize(id)
}

/** POST /chamber/plugins/undo: the gateway-side 撤销=恢复 verb — RESTORE the latest ok op's
 *  preImage pair. Id-only by design (the durable journal picks the target under the backend's
 *  single-flight fence); a non-2xx {error, code} refusal is projected verbatim. */
export type GatewayPluginUndoResult =
  | { ok: true; opId: string }
  | { ok: false; error: string; code: string | null }

export async function gatewayPluginUndo(id: string): Promise<GatewayPluginUndoResult> {
  try {
    const body = await post<{ accepted?: unknown; opId?: unknown }>(`/api/i/gateway-${id}/chamber/plugins/undo`, {})
    if (body?.accepted !== true || typeof body.opId !== 'string' || body.opId === '') {
      return { ok: false, error: 'the gateway accepted the undo without an operation id', code: null }
    }
    return { ok: true, opId: body.opId }
  } catch (error) {
    const apiError = error as ApiError
    return {
      ok: false,
      error: apiError?.body?.error ?? errorMessage(error),
      code: apiError?.body?.code ?? null,
    }
  }
}

/** Terminal state of one gateway mutation op, as the renderer can see it through the task
 *  projection. `timeout` means the op was accepted but did not settle inside the bounded window —
 *  the caller must render the busy state, never a success claim. */
export type GatewayOpTerminal =
  | { status: 'ok' | 'failed' | 'blocked'; error: string | null }
  | { status: 'timeout' }

/** Wait for one accepted op to reach a terminal state by polling the SAME task projection the
 *  backend serves (1 s cadence, 120 s bound by default). Injectable sleep for the pure-node tests. */
export async function waitForGatewayOpTerminal(
  id: string,
  opId: string,
  deps: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<GatewayOpTerminal> {
  const pollMs = deps.pollMs ?? 1000
  const timeoutMs = deps.timeoutMs ?? 120_000
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const projection = await gatewayTasks(id)
    const op = projection.tasks.find(candidate => candidate.id === opId)
    if (op !== undefined && op.status !== 'pending') {
      return { status: op.status, error: op.error ?? null }
    }
    if (Date.now() >= deadline) return { status: 'timeout' }
    await sleep(pollMs)
  }
}
