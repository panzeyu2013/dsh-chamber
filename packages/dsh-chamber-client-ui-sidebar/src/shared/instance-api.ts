/**
 * Per-instance unary wire client (design 03 §3.1). An AbstractApiClient
 * subclass whose doFetch injects the per-instance proxy prefix
 * (`/api/i/<id>`) in front of every api pathname, so the workspace.* /
 * session.* unary methods land on the right dsh instance (the control
 * plane strips the prefix and forwards the remainder). The carrier is a
 * plain same-origin fetch; only the wire-provided methods are used.
 *
 * Lives in this package's shared/ so the chamber App layer (renderer main
 * entry) and the sidebar plugin consume one copy (vite shared chunk, design
 * 05 §3); the renderer consumes it through `@dsh-chamber/dsh-client-ui-sidebar/shared`.
 *
 * Types are intentionally local rows (chamber code consumes dsh packages
 * through the loose ambient module table, see renderer vendor-modules.d.ts);
 * the wire shapes mirror vendor dsh-host-apiproxy api/workspace.ts and
 * api/sessions.ts.
 */
import { AbstractApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { DirectoryBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
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

/** HTTP carrier with the per-instance proxy prefix injected before every api path. */
class InstanceApiClient extends AbstractApiClient {
  private readonly basePath: string

  constructor(basePath: string) {
    super()
    this.basePath = basePath
  }

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input)
    url.pathname = `${this.basePath}${url.pathname}`
    const response = await fetch(url, init)
    if (response.status === 503) {
      let payload: { code?: string; error?: string } | null = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload?.code === 'instance_unavailable') {
        throw new InstanceUnavailableError(payload.error ?? 'the instance is not ready')
      }
    }
    return response
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
 * Fold a wire response into a thrown Error. The unary client resolves
 * RpcResponse `{rpcId, result}`; business errors ride the `result` slot (the
 * transport throws separately on non-2xx, so a resolved response always
 * carries `result.ok`).
 */
function resultError(result: any): Error | null {
  const rpcResult = result?.result
  if (rpcResult?.ok === true) return null
  const error = rpcResult?.error
  if (error !== undefined && typeof error === 'object') {
    return new InstanceRpcError(
      String(error.code ?? 'unknown'),
      String(error.message ?? '未知错误'),
      error.details,
    )
  }
  return new InstanceRpcError('unknown', '实例返回未知错误')
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

/** One directory row of a listing (wire DirectoryEntry shape, host.ts). */
export interface DirectoryEntryRow {
  name: string
  path: string
  hidden: boolean
}

/** host.listDirectory response value (wire DirectoryListing shape, host.ts). */
export interface DirectoryListingRow {
  path: string
  home: string
  crumbs: DirectoryEntryRow[]
  entries: DirectoryEntryRow[]
  truncated: boolean
}

/**
 * host.listDirectory wrapper (design 05 §4): the in-app browse dialog's
 * listing leg, driven over the per-source unary client. Mirrors the runtime
 * service's unwrap (RpcResponse → result slot; business errors become
 * DirectoryBrowseError, which the browse dialog surfaces verbatim).
 */
export async function listHostDirectory(
  client: InstanceApiClient,
  path: string | undefined,
  signal?: AbortSignal,
): Promise<DirectoryListingRow> {
  let response: any
  try {
    response = await client.host.listDirectory(path === undefined ? {} : { path }, signal)
  } catch (err) {
    throw wrapWireError(err)
  }
  const rpcResult = response?.result
  if (rpcResult?.ok !== true) {
    const error = rpcResult?.error
    throw new DirectoryBrowseError({
      code: String(error?.code ?? 'unknown'),
      message: String(error?.message ?? '未知错误'),
      details: (error?.details ?? {}) as never,
    })
  }
  return rpcResult.value as DirectoryListingRow
}

/**
 * host.createDirectory wrapper (design 05 §4): one child directory under an
 * existing parent (single-segment name validation is the Host's). Returns
 * the created directory's absolute path (a missing path is a loud error —
 * the dialog must never navigate to an empty target).
 */
export async function createHostDirectory(client: InstanceApiClient, path: string, name: string): Promise<string> {
  let response: any
  try {
    response = await client.host.createDirectory({ path, name })
  } catch (err) {
    throw wrapWireError(err)
  }
  const rpcResult = response?.result
  if (rpcResult?.ok !== true) {
    const error = rpcResult?.error
    throw new DirectoryBrowseError({
      code: String(error?.code ?? 'unknown'),
      message: String(error?.message ?? '未知错误'),
      details: (error?.details ?? {}) as never,
    })
  }
  const created = String(rpcResult.value?.path ?? '')
  if (created === '') {
    throw new DirectoryBrowseError({
      code: 'directory-create-failed',
      message: '宿主未返回新建目录路径',
      details: {} as never,
    })
  }
  return created
}

function titleOf(summary: any): string | undefined {
  const title = summary?.projections?.values?.title
  return typeof title === 'string' && title !== '' ? title : undefined
}

/** workspace.list + session.list in one round trip. */
export async function fetchInstanceSnapshot(client: InstanceApiClient): Promise<InstanceSnapshot> {
  let workspaceResult: any
  let sessionResult: any
  try {
    ;[workspaceResult, sessionResult] = await Promise.all([
      client.workspace.list({}),
      client.sessions.list({}),
    ])
  } catch (err) {
    throw wrapWireError(err)
  }
  const wsError = resultError(workspaceResult)
  if (wsError !== null) throw wsError
  const ssError = resultError(sessionResult)
  if (ssError !== null) throw ssError

  const items: any[] = workspaceResult?.result?.value?.items ?? []
  const workspaces: WorkspaceRow[] = items.map((item: any) => ({
    workspaceId: String(item.workspaceId),
    path: String(item.path),
    title: String(item.title),
    sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map((id: unknown) => String(id)) : [],
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  }))
  const summaries: any[] = sessionResult?.result?.value?.items ?? []
  const sessions: SessionRow[] = summaries.map((summary: any) => {
    const row: SessionRow = {
      sessionId: String(summary.sessionId),
      running: summary.running === true,
      blank: summary.blank === true,
    }
    if (typeof summary.updatedAt === 'number') row.updatedAt = summary.updatedAt
    if (summary.origin === 'subagent') row.origin = 'subagent'
    const title = titleOf(summary)
    if (title !== undefined) row.title = title
    if (typeof summary.cwd === 'string' && summary.cwd !== '') row.cwd = summary.cwd
    if (typeof summary.parentSessionId === 'string') row.parentSessionId = summary.parentSessionId
    return row
  })
  const archived = workspaceResult?.result?.value?.archivedSessionIds
  const archivedSessionIds: string[] = Array.isArray(archived) ? archived.map((id: unknown) => String(id)) : []
  return { workspaces, sessions, archivedSessionIds }
}

async function callAndThrow(client: InstanceApiClient, call: () => Promise<any>): Promise<any> {
  let result: any
  try {
    result = await call()
  } catch (err) {
    throw wrapWireError(err)
  }
  const error = resultError(result)
  if (error !== null) throw error
  return result
}

/** One session.search result row (wire SessionSearchItem shape, design 06 §1.1). */
export interface SearchRow {
  sessionId: string
  snippet: string
}

/**
 * sessions.search wrapper (design 06 §1.1). Unlike callAndThrow the signal
 * passes through to the unary call (the UI merges debounce + 30s timeout);
 * transport/errors fold the same way.
 */
export async function searchSessions(
  client: InstanceApiClient,
  query: string,
  signal: AbortSignal,
): Promise<{ items: SearchRow[]; hasMore: boolean }> {
  let result: any
  try {
    result = await client.sessions.search({ query }, signal)
  } catch (err) {
    throw wrapWireError(err)
  }
  const error = resultError(result)
  if (error !== null) throw error
  const value = result?.result?.value
  const items: any[] = value?.items ?? []
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
  const result = await callAndThrow(client, () => client.sessions.create(payload))
  return decodeSessionCreateValue(result?.result?.value, sessionId)
}

/**
 * sessions.fork，返回子会话 id（atSeq 省略 = 源最后完成的回合为 cut，与官方
 * ui-workspace forkSession 的 cut 规则一致）。wire payload 仅收
 * { sessionId, atSeq? }——官方运行时客户端的 increaseTitle 便捷标志（fork
 * 成功后对子会话做标题递增 rename）不是 wire 字段，宿主 schema 剥离未知键；
 * chamber 在 SidebarRoot.onForkSession 里自行实现该递增（shared/derive.ts
 * increasedForkTitle，逐字移植官方 runtime service，P1-4）。
 */
export async function forkSession(client: InstanceApiClient, sessionId: string): Promise<string> {
  const result = await callAndThrow(client, () => client.sessions.fork({ sessionId }))
  const childId = result?.result?.value?.sessionId
  if (typeof childId !== 'string' || childId === '') {
    throw new Error('instance-session-fork: 实例未返回子会话 id')
  }
  return childId
}

export async function renameSession(client: InstanceApiClient, sessionId: string, title: string): Promise<void> {
  await callAndThrow(client, () => client.sessions.rename({ sessionId, title }))
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
  return decodeWorkspaceCreateValue(result?.result?.value, path)
}

export async function renameWorkspace(client: InstanceApiClient, workspaceId: string, title: string): Promise<void> {
  await callAndThrow(client, () => client.workspace.rename({ workspaceId, title }))
}

export async function deleteWorkspace(client: InstanceApiClient, workspaceId: string): Promise<void> {
  const result = await callAndThrow(client, () => client.workspace.delete({ workspaceId }))
  decodeWorkspaceDeleteValue(result?.result?.value)
}
