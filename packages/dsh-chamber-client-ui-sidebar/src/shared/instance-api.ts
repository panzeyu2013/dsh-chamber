/**
 * Per-instance unary wire client (design 03 §3.1). The dsh v0.1.2-alpha.1
 * connection client no longer ships an API client class (upstream deleted
 * `AbstractApiClient`/`IApiClient` together with the host-apiproxy package),
 * so the chamber per-instance unary client is self-hosted here: a plain
 * same-origin fetch that posts the new generic-RPC envelope
 * (`{type:'client-request', rpcId, method, payload}` with slash two-segment
 * endpoints like `session/list`, payload `{args:{...}}`) to
 * `/api/i/<id>/api/<endpoint>`, and parses the `server-response`
 * `{ok, value | error}` result — the exact wire the upstream
 * `ClientConnectionRpc.call('/api', endpoint, {args}, signal)` produces
 * (packages/client/connection/src/client/rpc.ts).
 *
 * Lives in this package's shared/ so the chamber App layer (renderer main
 * entry) and the sidebar plugin consume one copy (vite shared chunk, design
 * 05 §3); the renderer consumes it through `@dsh-chamber/dsh-client-ui-sidebar/shared`.
 *
 * Types are intentionally local rows (chamber code consumes dsh packages
 * through the loose ambient module table, see renderer vendor-modules.d.ts);
 * the wire shapes mirror the v0.1.2-alpha.1 api-session-controller /
 * api-workspace-controller `@Remote` faces (types.ts).
 */
import { DirectoryBrowseError } from './directory-browse-error.ts'
import {
  decodeSessionCreateValue, decodeWorkspaceCreateValue, decodeWorkspaceDeleteValue,
} from './instance-mutation-values.ts'
import { InstanceRpcError } from './instance-rpc-error.ts'
export { InstanceRpcError } from './instance-rpc-error.ts'

/** One workspace row (WorkspaceView wire shape). */
export interface WorkspaceRow {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
  /**
   * True ONLY for the fallback's cwd-derived groups (workspaceId
   * `__cwd__:<path>`). Such rows are display-only: they carry no host
   * workspace identity, so every workspace-scoped mutation (session.create,
   * workspace.rename/delete/insertBefore/insertSessionBefore) on them fails
   * fail-closed with `workspace/not-found` on the host. The sidebar must
   * disable those affordances for synthetic rows (ungrouped-bucket parity).
   */
  synthetic?: boolean
}

/** One session row (SessionSummary wire shape; title rides projections.values.title). */
export interface SessionRow {
  sessionId: string
  /**
   * Epoch ms of last activity, set only when the wire provides a number (a
   * missing field stays undefined — never coerced to 0, which would render
   * "54y ago"). The UI must hide the time cell when this is undefined OR 0.
   */
  updatedAt?: number
  running: boolean
  blank: boolean
  /** Coarse durable origin (wire: absent or 'subagent'); subagent rows never surface in navigation. */
  origin?: 'subagent'
  cwd?: string
  title?: string
  parentSessionId?: string
}

/** Combined snapshot the sidebar aggregation renders. */
export interface InstanceSnapshot {
  workspaces: WorkspaceRow[]
  sessions: SessionRow[]
  archivedSessionIds: string[]
}

export type InstanceAggregateState = 'ok' | 'error' | 'not-connected'

/** Per-instance sidebar data (state 'not-connected' = instance not reachable/ready). */
export interface InstanceAggregate extends InstanceSnapshot {
  state: InstanceAggregateState
  error: string | null
}

export function emptyAggregate(state: InstanceAggregateState, error: string | null = null): InstanceAggregate {
  return { state, workspaces: [], sessions: [], archivedSessionIds: [], error }
}

/**
 * New generic-RPC unary result (v0.1.2-alpha.1 `ConnectionRpcResult`): the
 * `server-response` result slot decoded flat — `{ok:true, value}` for success,
 * `{ok:false, error:{code,message,details}}` for a business failure. Transport
 * failures (offline, HTTP non-2xx, not-ready 503, abort, timeout) THROW instead
 * of resolving — the same split the old apiproxy client had.
 */
export type UnaryResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: unknown } }

/**
 * The control plane answers non-ready instances with an explicit
 * `instance_unavailable` 503 (design 03 §3.3, proxy honesty). This error
 * carries the proxy's message so callers can surface "not ready" instead of
 * the generic transport-failure text.
 */
class InstanceUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstanceUnavailableError'
  }
}

/** True when a wire failure is the proxy's explicit not-ready 503 (03 §3.3). */
export function isInstanceUnavailable(err: unknown): boolean {
  return err instanceof InstanceUnavailableError
}

/** Default timeout for bounded unary calls (mirrors the retired apiproxy 30s default). */
const DEFAULT_TIMEOUT_MS = 30_000

/** Browser origin with the same Node fallback the retired connection client used. */
function resolveOrigin(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  return location?.origin !== undefined && location.origin !== 'null' ? location.origin : 'http://dsh.internal'
}

/** Correlation id minted per request and echoed by the server-response envelope. */
function mintRpcId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * HTTP carrier with the per-instance proxy prefix injected before every api
 * path. One unary `call(endpoint, payload, signal)` posts the new wire
 * envelope to `/api/i/<id>/api/<endpoint>`; the namespaced accessors below
 * mirror the retired IApiClient property shape so the wrapper functions keep
 * their `client.<namespace>.<method>` call sites.
 */
class InstanceApiClient {
  private readonly basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
  }

  /** One new-face unary Remote call (slash endpoint, `{args}` payload, flat result). */
  private async call<T = unknown>(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<UnaryResult<T>> {
    const url = new URL(`${this.basePath}/api/${endpoint}`, resolveOrigin())
    const rpcId = mintRpcId()
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      : AbortSignal.any([AbortSignal.timeout(DEFAULT_TIMEOUT_MS), signal])
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
      signal: requestSignal,
    })
    if (response.status === 503) {
      let payload503: { code?: string; error?: string } | null = null
      try {
        payload503 = await response.json()
      } catch {
        payload503 = null
      }
      if (payload503?.code === 'instance_unavailable') {
        throw new InstanceUnavailableError(payload503.error ?? 'the instance is not ready')
      }
    }
    if (!response.ok) throw new Error(`transport failure for ${endpoint}: HTTP ${response.status}`)
    const envelope = await response.json() as {
      type?: unknown
      rpcId?: unknown
      result?: { ok?: unknown; value?: unknown; error?: { code?: string; message?: string; details?: unknown } }
    } | null
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${String(envelope?.rpcId)}`)
    }
    const result = envelope.result
    if (result?.ok === true) return { ok: true, value: result.value as T }
    return {
      ok: false,
      error: {
        code: result?.error?.code ?? 'internal',
        message: result?.error?.message ?? '实例返回未知错误',
        details: result?.error?.details ?? {},
      },
    }
  }

  /**
   * session-controller unary Remotes (v0.1.2-alpha.1 `@Remote` names). Every
   * call wraps the request object in the wire `{args:{...}}` envelope — the
   * host gateway rejects any other payload shape.
   */
  // NOTE (review round 1): the 0.1.2 TypertGatewayService requires the args
  // keys to be the @Remote METHOD PARAMETER names — session-controller's
  // `list(_request)` and every other unary `request` — so the caller's request
  // object is nested under that exact name; a bare `{args: payload}` is
  // rejected with arguments-invalid.
  readonly session = {
    list: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('session/list', { args: { _request: payload } }, signal),
    search: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('session/search', { args: { request: payload } }, signal),
    create: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('session/create', { args: { request: payload } }, signal),
    fork: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('session/fork', { args: { request: payload } }, signal),
    rename: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('session/rename', { args: { request: payload } }, signal),
  }

  /**
   * workspace-controller unary Remotes. NOTE: `workspace/list` was deleted
   * upstream (W11 — the new workspace face is the `workspace/follow` stream).
   */
  readonly workspace = {
    create: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('workspace/create', { args: { request: payload } }, signal),
    rename: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('workspace/rename', { args: { request: payload } }, signal),
    delete: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('workspace/delete', { args: { request: payload } }, signal),
    insertBefore: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('workspace/insertBefore', { args: { request: payload } }, signal),
    insertSessionBefore: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('workspace/insertSessionBefore', { args: { request: payload } }, signal),
    archiveSession: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('workspace/archiveSession', { args: { request: payload } }, signal),
  }

  /** directoryPicker unary Remotes — POSITIONAL-argument face (`{args:{...}}` envelope, P1-5). */
  readonly directoryPicker = {
    list: (path: string | undefined, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('directoryPicker/list', { args: path === undefined ? {} : { path } }, signal),
    createDirectory: (path: string, name: string): Promise<UnaryResult<any>> =>
      this.call('directoryPicker/createDirectory', { args: { path, name } }),
  }
}

const clients = new Map<string, InstanceApiClient>()

export function getInstanceClient(instanceId: string): InstanceApiClient {
  let client = clients.get(instanceId)
  if (client === undefined) {
    client = new InstanceApiClient(`/api/i/${instanceId}`)
    clients.set(instanceId, client)
  }
  return client
}

/** Drop the cached unary client when its registry source is removed. */
export function releaseInstanceClient(instanceId: string): void {
  clients.delete(instanceId)
}

/**
 * Fold a wire result into a thrown Error. The new unary face resolves
 * `{ok, error}` directly (transport failures throw separately), so a resolved
 * non-ok result always carries the business failure vocabulary.
 */
function resultError(result: UnaryResult): Error | null {
  if (result.ok === true) return null
  const error = result.error
  return new InstanceRpcError(
    String(error.code ?? 'unknown'),
    String(error.message ?? '未知错误'),
    error.details,
  )
}

/**
 * Wrap a wire failure with an honest prefix: not-ready 503s vs transport
 * loss. AbortError/TimeoutError pass through untouched — superseding a scan
 * or a wire-side timeout is not an unreachability fact, and callers already
 * treat these as first-class (abort guards / dialog error surfaces).
 */
function wrapWireError(err: unknown): Error {
  if (err instanceof InstanceUnavailableError) {
    // Keep the class identity (isInstanceUnavailable) — the message gets the
    // honest not-ready prefix.
    return new InstanceUnavailableError(`实例未就绪：${err.message}`)
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return err
  }
  return new Error(`实例不可达：${err instanceof Error ? err.message : String(err)}`)
}

/** One directory row of a listing (DirectoryEntry shape, dsh-host-directory-picker/types). */
export interface DirectoryEntryRow {
  name: string
  path: string
  hidden: boolean
}

/** directoryPicker.list response value (DirectoryListing shape, dsh-host-directory-picker/types). */
export interface DirectoryListingRow {
  path: string
  home: string
  crumbs: DirectoryEntryRow[]
  entries: DirectoryEntryRow[]
  truncated: boolean
}

/**
 * directoryPicker.list wrapper (design 05 §4): the in-app browse dialog's
 * listing leg, driven over the per-source unary client. The new face takes
 * the path POSITIONALLY (`list(path, signal)` → envelope `{args:{path}}`);
 * business failures become DirectoryBrowseError, which the browse dialog
 * surfaces verbatim.
 */
export async function listHostDirectory(
  client: InstanceApiClient,
  path: string | undefined,
  signal?: AbortSignal,
): Promise<DirectoryListingRow> {
  let result: UnaryResult<DirectoryListingRow>
  try {
    result = await client.directoryPicker.list(path, signal)
  } catch (err) {
    throw wrapWireError(err)
  }
  if (result.ok !== true) throw new DirectoryBrowseError(result.error)
  return result.value
}

/**
 * directoryPicker.createDirectory wrapper (design 05 §4): one child directory
 * under an existing parent (single-segment name validation is the Host's).
 * Returns the created directory's absolute path (a missing path is a loud
 * error — the dialog must never navigate to an empty target).
 */
export async function createHostDirectory(client: InstanceApiClient, path: string, name: string): Promise<string> {
  let result: UnaryResult<string>
  try {
    result = await client.directoryPicker.createDirectory(path, name)
  } catch (err) {
    throw wrapWireError(err)
  }
  if (result.ok !== true) throw new DirectoryBrowseError(result.error)
  const created = String(result.value ?? '')
  if (created === '') {
    // Chamber-local synthetic code (display-level; no upstream wire code
    // exists for "host returned no created path"). Not part of the 0.1.2
    // namespace vocabulary — consumers match it only via DirectoryBrowseError.
    throw new DirectoryBrowseError({
      code: 'directory-create-failed',
      message: '宿主未返回新建目录路径',
      details: {},
    })
  }
  return created
}

function titleOf(summary: any): string | undefined {
  const title = summary?.projections?.values?.title
  return typeof title === 'string' && title !== '' ? title : undefined
}

/**
 * session/list unary pull (the bounded fallback for unmounted sources).
 * v0.1.2-alpha.1: the unary `workspace.list` was DELETED upstream (W11 — the
 * new workspace face is the `workspace/follow` stream, which a unary HTTP
 * client cannot open), so the fallback derives workspace groups from each
 * session's `cwd` fact instead (STATUS.md D-item, 2026-09): one synthetic
 * workspace row per canonical cwd, titled by basename — the same
 * cwd-derived grouping semantics the official ui-workspace search leg uses
 * (tree.ts workspaceLabel), and a strict subset of what the authoritative
 * mounted-ctx store path (projectInstanceSnapshot in client/index.ts)
 * carries.
 *
 * KNOWN DEGRADATION (documented): `archivedSessionIds` has NO unary wire
 * source — the archive set exists only on the workspace follow baseline —
 * so the fallback returns an empty archive set and archived sessions
 * resurface in the list. This is acceptable only while the fallback serves
 * genuinely unmounted sources or the pre-baseline window; the mounted path
 * (which carries the archive set) must never be replaced by this fallback
 * once it has pushed (renderer App withdrawal rule, 2026-09 fix).
 */
export async function fetchInstanceSnapshot(client: InstanceApiClient): Promise<InstanceSnapshot> {
  let sessionResult: UnaryResult<{ items?: readonly unknown[] }>
  try {
    sessionResult = await client.session.list({})
  } catch (err) {
    throw wrapWireError(err)
  }
  const ssError = resultError(sessionResult)
  if (ssError !== null) throw ssError

  const summaries = ((sessionResult.ok ? sessionResult.value?.items : undefined) ?? []) as any[]
  const sessions: SessionRow[] = summaries.flatMap((summary: any) => {
    if (summary?.origin === 'subagent') return []
    const row: SessionRow = {
      sessionId: String(summary.sessionId),
      running: summary.running === true,
      blank: summary.blank === true,
    }
    if (typeof summary.updatedAt === 'number') row.updatedAt = summary.updatedAt
    const title = titleOf(summary)
    if (title !== undefined) row.title = title
    if (typeof summary.cwd === 'string' && summary.cwd !== '') row.cwd = summary.cwd
    if (typeof summary.parentSessionId === 'string') row.parentSessionId = summary.parentSessionId
    return [row]
  })
  // cwd-derived workspace groups (2026-09, STATUS.md D-item): group visible
  // sessions by canonical cwd; groups are ordered by their newest session
  // (the official bootstrap ordering), titles are cwd basenames. The
  // synthetic id is namespaced (`__cwd__:` — never collides with the
  // UNGROUPED_WORKSPACE_ID bucket or real registered ids) and every row is
  // marked `synthetic: true` — DISPLAY-ONLY: the host does not know these
  // ids, so the sidebar must disable all workspace-scoped mutations on them
  // (new session / rename / delete / drag, 2026-11 fix).
  const byCwd = new Map<string, { workspaceId: string; sessions: SessionRow[]; newestAt: number }>()
  for (const session of sessions) {
    if (session.origin === 'subagent' || session.cwd === undefined) continue
    let group = byCwd.get(session.cwd)
    if (group === undefined) {
      group = {
        workspaceId: `__cwd__:${session.cwd}`,
        sessions: [],
        newestAt: 0,
      }
      byCwd.set(session.cwd, group)
    }
    group.sessions.push(session)
    group.newestAt = Math.max(group.newestAt, session.updatedAt ?? 0)
  }
  const workspaces: WorkspaceRow[] = [...byCwd.values()]
    .sort((left, right) => right.newestAt - left.newestAt)
    .map(group => ({
      workspaceId: group.workspaceId,
      path: group.workspaceId.slice('__cwd__:'.length),
      title: basenameOf(group.workspaceId.slice('__cwd__:'.length)),
      sessionIds: group.sessions.map(session => session.sessionId),
      createdAt: '',
      updatedAt: '',
      synthetic: true,
    }))
  return { workspaces, sessions, archivedSessionIds: [] }
}

/** Trailing path segment ('' for root); the cwd-derived group title. */
function basenameOf(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const base = separator === -1 ? trimmed : trimmed.slice(separator + 1)
  return base === '' ? cwd : base
}

async function callAndThrow(client: InstanceApiClient, call: () => Promise<UnaryResult<any>>): Promise<UnaryResult<any>> {
  let result: UnaryResult<any>
  try {
    result = await call()
  } catch (err) {
    throw wrapWireError(err)
  }
  const error = resultError(result)
  if (error !== null) throw error
  return result
}

/** One session.search result row (SessionSearchItem wire shape, design 06 §1.1). */
export interface SearchRow {
  sessionId: string
  snippet: string
}

/**
 * session/search wrapper (design 06 §1.1). Unlike callAndThrow the signal
 * passes through to the unary call (the UI merges debounce + 30s timeout);
 * transport/errors fold the same way.
 */
export async function searchSessions(
  client: InstanceApiClient,
  query: string,
  signal: AbortSignal,
): Promise<{ items: SearchRow[]; hasMore: boolean }> {
  let result: UnaryResult<{ items?: readonly unknown[]; hasMore?: unknown }>
  try {
    result = await client.session.search({ query }, signal)
  } catch (err) {
    throw wrapWireError(err)
  }
  const error = resultError(result)
  if (error !== null) throw error
  const value = result.ok ? result.value : undefined
  const items = (value?.items ?? []) as any[]
  return {
    items: items.map((item: any) => ({
      sessionId: String(item.sessionId),
      snippet: String(item.snippet ?? ''),
    })),
    hasMore: value?.hasMore === true,
  }
}

/**
 * workspace.insertSessionBefore wrapper (design 06 §2.1). The anchor key is
 * omitted when undefined — the wire treats an omitted anchor as append-to-end
 * and null as illegal.
 */
export async function insertSessionBefore(
  client: InstanceApiClient,
  workspaceId: string,
  sessionId: string,
  beforeSessionId?: string,
): Promise<void> {
  const payload: { workspaceId: string; sessionId: string; beforeSessionId?: string } = { workspaceId, sessionId }
  if (beforeSessionId !== undefined) payload.beforeSessionId = beforeSessionId
  await callAndThrow(client, () => client.workspace.insertSessionBefore(payload))
}

/** workspace.insertBefore wrapper (design 06 §2.1); omitted anchor = append to end. */
export async function insertWorkspaceBefore(
  client: InstanceApiClient,
  workspaceId: string,
  beforeWorkspaceId?: string,
): Promise<void> {
  const payload: { workspaceId: string; beforeWorkspaceId?: string } = { workspaceId }
  if (beforeWorkspaceId !== undefined) payload.beforeWorkspaceId = beforeWorkspaceId
  await callAndThrow(client, () => client.workspace.insertBefore(payload))
}

/**
 * session.create under a workspace; returns the published session id. A
 * caller-supplied id makes multi-step sagas retryable without minting a second
 * session after an ambiguous response.
 */
export async function createSession(
  client: InstanceApiClient,
  workspaceId: string,
  sessionId?: string,
): Promise<string> {
  const payload: { workspaceId: string; sessionId?: string } = { workspaceId }
  if (sessionId !== undefined) payload.sessionId = sessionId
  const result = await callAndThrow(client, () => client.session.create(payload))
  return decodeSessionCreateValue(result.ok ? result.value : undefined, sessionId)
}

/**
 * session/fork，返回子会话 id（atSeq 省略 = 源最后完成的回合为 cut，与官方
 * ui-workspace forkSession 的 cut 规则一致）。wire payload 仅收
 * `{ sessionId, atSeq? }`——官方客户端面的 increaseTitle 便捷标志（fork
 * 成功后对子会话做标题递增 rename）不是 wire 字段，宿主 schema 剥离未知键；
 * chamber 在 SidebarRoot.onForkSession 里自行实现该递增（shared/derive.ts
 * increasedForkTitle，逐字移植官方 service，P1-4）。
 */
export async function forkSession(client: InstanceApiClient, sessionId: string): Promise<string> {
  const result = await callAndThrow(client, () => client.session.fork({ sessionId }))
  const childId = result.ok ? (result.value as { sessionId?: unknown } | undefined)?.sessionId : undefined
  if (typeof childId !== 'string' || childId === '') {
    throw new Error('instance-session-fork: 实例未返回子会话 id')
  }
  return childId
}

export async function renameSession(client: InstanceApiClient, sessionId: string, title: string): Promise<void> {
  await callAndThrow(client, () => client.session.rename({ sessionId, title }))
}

export async function archiveSession(client: InstanceApiClient, sessionId: string): Promise<void> {
  await callAndThrow(client, () => client.workspace.archiveSession({ sessionId }))
}

export interface CreateWorkspaceResult {
  workspaceId: string
  path: string
  /** False means the host reused the workspace already registered at `path`. */
  created: boolean
}

export async function createWorkspace(client: InstanceApiClient, path: string): Promise<CreateWorkspaceResult> {
  const result = await callAndThrow(client, () => client.workspace.create({ path }))
  return decodeWorkspaceCreateValue(result.ok ? result.value : undefined, path)
}

export async function renameWorkspace(client: InstanceApiClient, workspaceId: string, title: string): Promise<void> {
  await callAndThrow(client, () => client.workspace.rename({ workspaceId, title }))
}

export async function deleteWorkspace(client: InstanceApiClient, workspaceId: string): Promise<void> {
  const result = await callAndThrow(client, () => client.workspace.delete({ workspaceId }))
  decodeWorkspaceDeleteValue(result.ok ? result.value : undefined)
}
