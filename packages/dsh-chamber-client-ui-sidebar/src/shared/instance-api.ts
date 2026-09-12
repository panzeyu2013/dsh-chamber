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
 * (`vendor/harness-checkout/packages/client/connection/src/client/rpc.ts:34`;
 * this repo's base-path-patched copy of the same implementation is
 * `packages/dsh-client-connection/src/client/rpc.ts:61`).
 * 2026-09-11 review-fix: both citations are spelled so they resolve from this
 * repo. The retired form gave the upstream monorepo's own layout bare, which
 * exists only inside the pinned vendor checkout and resolved to nothing here.
 *
 * Lives in this package's shared/ so the chamber App layer (renderer main
 * entry) and the sidebar plugin consume one copy (vite shared chunk, design
 * 05 §3); the renderer consumes it through `@dsh-chamber/dsh-chamber-client-ui-sidebar/shared`.
 *
 * Types are intentionally local rows mirroring the v0.1.2-alpha.1
 * api-session-controller / api-workspace-controller `@Remote` faces
 * (types.ts). Consumers resolve this shared face from the real source (root
 * tsconfig paths / the sidebar package exports), not the retired renderer
 * vendor-modules.d.ts ambient overlay (P4-4, 2026-09).
 */
import { DirectoryBrowseError } from './directory-browse-error.ts'
// 2026-09-11 upstream-alignment T7: one derivation for the active-Schedule fact
// (shared by this module's unary row build and derive.ts's mounted-store
// projection). derive.ts type-imports this module only, so no runtime cycle.
// I3: the display-title ladder and its basename helper live in derive.ts for
// the same reason (one resolver, no cycle); `basenameOf` is re-exported below
// so existing importers (workspace-echo.ts) keep their import site.
import { basenameOf, hasActiveScheduleOf, sessionDisplayTitle } from './derive.ts'
import {
  decodeSessionCreateValue, decodeWorkspaceCreateValue, decodeWorkspaceDeleteValue,
} from './instance-mutation-values.ts'
import { InstanceRpcError } from './instance-rpc-error.ts'
import { mintRpcId } from './wire-common.ts'
export { basenameOf } from './derive.ts'
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
  /**
   * The official display label resolved at BUILD time — `title ?? basename(cwd)
   * ?? id` (shared/derive.ts `sessionDisplayTitle`), never empty. Kept separate
   * from `title`, which stays the durable title projection: rename/fork copy
   * and the archive manager must not treat a directory-name fallback as a
   * durable name. Absent on pre-revision producers; the derive layer then
   * re-applies the ladder (I3: a label never renders 「未命名」 for "unknown").
   */
  displayTitle?: string
  /**
   * 2026-09-11 upstream-alignment T7: the session owns at least one ACTIVE
   * schedule (upstream `SessionNode.hasActiveSchedule`, derived from
   * `projectionValues.schedule` — vendor ui-workspace tree.ts:161-163). SPARSE:
   * present only when true, so the snapshot signature stays byte-identical for
   * the (overwhelmingly common) sessions without a schedule.
   */
  hasActiveSchedule?: boolean
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
  /**
   * Whether this snapshot's archivedSessionIds is AUTHORITATIVE (true = the
   * mounted workspace-follow baseline projected the registry archive set —
   * even an empty set is a true "nothing archived" fact). The unary-fallback
   * snapshot has NO archive-set wire source (KNOWN DEGRADATION below), so it
   * must mark itself archiveSetKnown: false — consumers (archive manager)
   * then never claim "no archived sessions" from an unknown set. Absent on
   * pre-revision producers = unknown.
   */
  archiveSetKnown?: boolean
}

export type InstanceAggregateState = 'ok' | 'error' | 'not-connected'

/** Per-instance sidebar data (state 'not-connected' = instance not reachable/ready). */
export interface InstanceAggregate extends InstanceSnapshot {
  state: InstanceAggregateState
  error: string | null
}

export function emptyAggregate(state: InstanceAggregateState, error: string | null = null): InstanceAggregate {
  return { state, workspaces: [], sessions: [], archivedSessionIds: [], archiveSetKnown: false, error }
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
export class InstanceUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstanceUnavailableError'
  }
}

/** True when a wire failure is the proxy's explicit not-ready 503 (03 §3.3). */
export function isInstanceUnavailable(err: unknown): boolean {
  return err instanceof InstanceUnavailableError
}

/**
 * The host answered HTTP 404 for a method that should exist once the chamber
 * host domain is mounted (design 24 §5): the domain is absent or the runtime
 * tree predates it. NOT raised for the control plane's own unknown-instance
 * 404 (`instance_not_found` body code — that is an instance-layer fact, not
 * a domain fact). Mirrors the InstanceUnavailableError pattern so the UI can
 * project the honest "seed/sync then restart dsh" message instead of a
 * generic transport failure.
 */
class InstanceDomainMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstanceDomainMissingError'
  }
}

/** True when a wire failure is the chamber-domain-absent 404 (design 24 §5). */
export function isInstanceDomainMissing(err: unknown): boolean {
  return err instanceof InstanceDomainMissingError
}

/** Default timeout for bounded unary calls (mirrors the retired apiproxy 30s default). */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Purge call budget (design 24 §5): deleting many archived subtrees can far
 * exceed the 30s unary default. The host keeps running when the client gives
 * up (timeout ≠ failure), so a timed-out purge is re-verified by a later
 * preview/purge — repeated execution is safe (idempotent per session).
 */
export const PURGE_CALL_TIMEOUT_MS = 5 * 60_000

/** Per-call overrides for `call` (design 24 §5); all optional and
 *  backward-compatible — existing callers keep the 30s default and the
 *  generic non-2xx mapping. */
export interface CallOptions {
  /** Bounded budget for this call (defaults to DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number
  /** Map a 404 whose body is NOT `instance_not_found` to a domain-missing
   *  error (design 24 §5). Only the archiveCleanup accessors pass it — the
   *  control plane answers unknown instance ids with the same status. */
  notFoundAsDomainMissing?: boolean
}

/** Browser origin with the same Node fallback the retired connection client used. */
function resolveOrigin(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  return location?.origin !== undefined && location.origin !== 'null' ? location.origin : 'http://dsh.internal'
}

/** 404-body read cap (review follow-up F10): the domain-missing
 *  discrimination only needs the tiny `instance_not_found` code JSON. */
const NOT_FOUND_BODY_CAP_BYTES = 4 * 1024

/**
 * Bounded 404-body probe for the design 24 §5 discrimination (review
 * follow-up F10): read at most NOT_FOUND_BODY_CAP_BYTES and parse it as JSON.
 * Oversized or unparseable bodies resolve null — the caller keeps the
 * current conservative outcome (domain-missing throw) instead of trusting a
 * body it never needed in full. (The pre-existing 503 and 2xx envelope reads
 * stay unbounded — out of scope for this fix.)
 */
async function readNotFoundBody(response: Response): Promise<{ code?: string } | null> {
  try {
    const body = response.body
    if (body === null) return null
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > NOT_FOUND_BODY_CAP_BYTES) {
        // Give up past the cap: cancel the rest of the stream and keep the
        // conservative null outcome.
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const code = (parsed as { code?: unknown }).code
    return { code: typeof code === 'string' ? code : undefined }
  } catch {
    return null
  }
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
    options: CallOptions = {},
  ): Promise<UnaryResult<T>> {
    const url = new URL(`${this.basePath}/api/${endpoint}`, resolveOrigin())
    const rpcId = mintRpcId()
    const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? options.timeoutMs as number
      : DEFAULT_TIMEOUT_MS
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
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
    // Design 24 §5: with the opt-in flag, a 404 that is NOT the control
    // plane's own unknown-instance answer is a chamber host domain the
    // runtime tree does not mount (missing/old host package) — a distinct
    // error class so the UI can project the honest recovery message. The
    // body is read BOUNDED (review follow-up F10): the discrimination only
    // needs the tiny `instance_not_found` code JSON, so an oversized or
    // unparseable body resolves null and keeps this conservative outcome
    // (domain-missing throw).
    if (response.status === 404 && options.notFoundAsDomainMissing === true) {
      const payload404 = await readNotFoundBody(response)
      if (payload404?.code !== 'instance_not_found') {
        // The message names the METHOD: this opt-in belongs to the chamber host
        // domains, and a 404 on one must never claim another is missing.
        throw new InstanceDomainMissingError(
          `该实例未挂载 chamber 宿主域 ${endpoint}：宿主包同步/seed 后需重启 dsh 生效`,
        )
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
   * host gateway rejects any other payload shape. The args keys must be the
   * @Remote METHOD PARAMETER names — session-controller's `list(_request)`
   * and every other unary `request` — so the caller's request object is
   * nested under that exact name; a bare `{args: payload}` is rejected with
   * arguments-invalid.
   */
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
    /** Official stop wire: aborts the session's running turn
     *  (`agent.cancel({kind:'user'}, {keepInbox:true})`; a no-op on an idle
     *  agent, `session/not-found` when the session is not attached). */
    cancel: (payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('session/cancel', { args: { request: payload } }, signal),
  }

  /**
   * workspace-controller unary Remotes. NOTE: `workspace/list` was deleted
   * upstream — the new workspace face is the `workspace/follow` stream.
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

  /** directoryPicker unary Remotes — POSITIONAL-argument face. */
  readonly directoryPicker = {
    list: (path: string | undefined, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('directoryPicker/list', { args: path === undefined ? {} : { path } }, signal),
    createDirectory: (path: string, name: string): Promise<UnaryResult<any>> =>
      this.call('directoryPicker/createDirectory', { args: { path, name } }),
  }

  /**
   * archiveCleanup unary Remotes (design 24 chamber host domain). preview is
   * zero-arg — the payload envelope is `{args:{}}`. purge takes an OPTIONAL
   * `sessionIds` subset filter (2026-09 wire amendment): absent = delete the
   * whole archived set (legacy zero-arg shape, `{args:{}}` — old hosts keep
   * working); present = delete only the listed archived members. A provided
   * EMPTY array deletes NO CONTENT (never the full-set interpretation) but —
   * since design 24 §12 — the host still runs its registry-global orphan
   * sweep, so an empty filter is not a zero-work request (2026-09 §4 step 5).
   * The OPTIONAL `force` flag (2026-09 revision, design 24 §3) additionally
   * deletes subtrees that are merely LOADED in the host process; a RUNNING
   * member is still refused. Both carry the domain-missing 404 opt-in; purge
   * rides the long call budget (the host keeps running past a client timeout
   * — rerun is
   * idempotent). See previewArchiveCleanup / purgeArchivedSessions wrappers.
   */
  readonly archiveCleanup = {
    preview: (_payload: unknown, signal?: AbortSignal): Promise<UnaryResult<any>> =>
      this.call('archiveCleanup/preview', { args: {} }, signal, { notFoundAsDomainMissing: true }),
    purge: (sessionIds?: readonly string[], force?: boolean): Promise<UnaryResult<any>> =>
      this.call(
        'archiveCleanup/purge',
        {
          args: {
            ...(sessionIds === undefined ? {} : { sessionIds }),
            ...(force === true ? { force: true } : {}),
          },
        },
        undefined,
        {
          timeoutMs: PURGE_CALL_TIMEOUT_MS,
          notFoundAsDomainMissing: true,
        },
      ),
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
  if (err instanceof InstanceDomainMissingError) {
    // Keep the class identity (isInstanceDomainMissing, design 24 §5): the
    // message already carries the honest recovery text.
    return err
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return err
  }
  return new Error(`实例不可达：${err instanceof Error ? err.message : String(err)}`)
}

/**
 * A no-response transport outcome (timeout / abort / undici fetch failure):
 * the host may have completed the work anyway, so the caller must never
 * treat it as a deterministic failure (design 24 §5 — purge keeps running
 * past a client timeout).
 */
export function isNoResponseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true
  return error.name === 'TypeError' && /fetch failed|network request failed|networkerror/i.test(error.message)
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
    // Chamber-local synthetic code (no upstream wire code exists for "host
    // returned no created path"); consumers match it only via
    // DirectoryBrowseError.
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
 * v0.1.2-alpha.1 deleted the unary `workspace.list` upstream (the new
 * workspace face is the `workspace/follow` stream, which a unary HTTP client
 * cannot open), so the fallback derives workspace groups from each session's
 * `cwd` fact instead: one synthetic workspace row per canonical cwd, titled
 * by basename — the same cwd-derived grouping semantics the official
 * ui-workspace search leg uses (tree.ts workspaceLabel), and a strict subset
 * of what the authoritative mounted-ctx store path (projectInstanceSnapshot
 * in client/index.ts) carries.
 *
 * KNOWN DEGRADATION (documented): `archivedSessionIds` has NO unary wire
 * source — the archive set exists only on the workspace follow baseline —
 * so the fallback returns an empty archive set (marked `archiveSetKnown:
 * false`) and archived sessions resurface in the list. Consumers must never
 * read the empty set as "nothing archived": the archive manager shows an
 * honest degraded branch with NO destructive action (no list to select;
 * whole-set purge was retired with the standalone delete-all — 2026 user
 * decision, design 24 §6) on snapshots
 * that are not archive-set-authoritative. Acceptable only while the fallback
 * serves genuinely unmounted sources or the pre-baseline window; the mounted
 * path (which carries the archive set) must never be replaced by this
 * fallback once it has pushed (renderer App withdrawal rule).
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
    // Official display label (I3). The unary wire has no `displayTitle`, so the
    // ladder is applied here, where the cwd is in hand: title → directory name
    // → session id. A row whose title the host could not read (a predecessor
    // cache record) therefore renders its project directory name instead of
    // 「未命名会话」.
    row.displayTitle = sessionDisplayTitle({
      title,
      ...(row.cwd === undefined ? {} : { cwdBasename: basenameOf(row.cwd) }),
      sessionId: row.sessionId,
    })
    if (typeof summary.parentSessionId === 'string') row.parentSessionId = summary.parentSessionId
    // 2026-09-11 upstream-alignment T7: the unary wire row publishes the
    // registered projections (`projections.values`, the very block `titleOf`
    // above reads) — the schedule fact rides it, so an unmounted source's
    // fallback view reports the marker exactly like the mounted store path
    // (projectInstanceSnapshot) does. Absent/unknown = no active schedule.
    if (hasActiveScheduleOf(summary?.projections?.values)) row.hasActiveSchedule = true
    return [row]
  })
  // cwd-derived workspace groups: group visible sessions by canonical cwd;
  // groups ordered by their newest session (official bootstrap ordering),
  // titles are cwd basenames. The synthetic id is namespaced (`__cwd__:` —
  // never collides with UNGROUPED_WORKSPACE_ID or real registered ids), and
  // every row is marked `synthetic: true` — DISPLAY-ONLY: the host does not
  // know these ids, so the sidebar must disable all workspace-scoped
  // mutations on them (new session / rename / delete / drag).
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
  return { workspaces, sessions, archivedSessionIds: [], archiveSetKnown: false }
}

// `basenameOf` MOVED to shared/derive.ts (the display-title resolver needs it,
// and a value import in this direction would be a runtime cycle). It is
// re-exported at the top of this module, so the workspace-echo row builder and
// every existing importer keep their import site.

async function callAndThrow(_client: InstanceApiClient, call: () => Promise<UnaryResult<any>>): Promise<UnaryResult<any>> {
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
 * session/fork，返回子会话 id（atSeq 省略 = 以源最后完成的回合为 cut，与
 * 官方 ui-workspace forkSession 的 cut 规则一致）。wire payload 仅收
 * `{ sessionId, atSeq? }`——官方客户端面的 increaseTitle 便捷标志（fork
 * 成功后对子会话做标题递增 rename）不是 wire 字段，宿主 schema 剥离未知
 * 键；chamber 在 SidebarRoot.onForkSession 里自行实现该递增
 * （shared/derive.ts increasedForkTitle，逐字移植官方 service）。
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

/**
 * Stop one session's running turn through the OFFICIAL `session/cancel` wire
 * (`{sessionId}` → `{accepted:true}`; host side `agent.cancel({kind:'user'},
 * {keepInbox:true})`). Safe to call on an idle agent (no-op) and idempotent;
 * a session that is not attached answers `session/not-found`, which callers
 * treating "already not running" as success must swallow themselves.
 */
export async function cancelSession(client: InstanceApiClient, sessionId: string): Promise<void> {
  await callAndThrow(client, () => client.session.cancel({ sessionId }))
}

/** True when an error is the official "session is not attached" refusal —
 *  i.e. nothing is running there, so a cancel is a no-op success. */
export function isSessionNotAttached(error: unknown): boolean {
  return error instanceof InstanceRpcError && error.code === 'session/not-found'
}

/** archiveCleanup/preview result counts (design 24 §3). */
export interface ArchiveCleanupPreview {
  readonly archived: number
  readonly deletableSessions: number
  readonly deletableSubagents: number
  readonly skippedRunning: number
  /** Subtrees skipped only because a member is loaded (idle) in the host
   *  process — deletable through an explicit force purge. */
  readonly skippedLoaded: number
}

/** One per-item failure of an archiveCleanup/purge run (design 24 §3). */
export interface ArchiveCleanupPurgeItemError {
  readonly sessionId: string
  readonly code: string
  readonly message: string
}

/** archiveCleanup/purge result (design 24 §3; ok:true with errors[] = partial
 *  failure — the UI must surface it, never treat it as a clean success). */
export interface ArchiveCleanupPurgeResult {
  readonly deletedSessions: number
  readonly deletedSubagents: number
  readonly skippedRunning: number
  /** Roots skipped because a member is loaded (idle) — never deleted by this
   *  run; a force run (after the caller cancelled the run) removes them. */
  readonly skippedLoaded: number
  /** Roots deleted DESPITE a loaded member because this run authorized force. */
  readonly forcedLoaded: number
  /** True when this run ASKED for force and the host refused the flag, so the
   *  run was repeated with the legacy shape (design 24 §8 compatibility leg):
   *  loaded-but-idle subtrees were therefore skipped, and the caller must say
   *  so — the force intent is never dropped silently. */
  readonly forceUnsupported: boolean
  readonly errors: readonly ArchiveCleanupPurgeItemError[]
  /** True when item errors were truncated at the host cap (1000). */
  readonly truncated: boolean
  /** Archived-set members removed by the host's registry-global ORPHAN SWEEP
   *  this run (design 24 §12 F4): record-less ids that sat in the
   *  archived set with no content — membership-only removal, never counted in
   *  deletedSessions/deletedSubagents. Absent on older hosts / when zero. */
  readonly clearedOrphanMembers?: number
}

function countField(value: unknown, key: string): number {
  const field = (value as Record<string, unknown> | null | undefined)?.[key]
  return typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : 0
}

/**
 * No-response classification after callAndThrow: raw TimeoutError/AbortError/
 * fetch TypeErrors pass through wrapWireError, while OTHER network failures
 * arrive wrapped as `实例不可达：<fetch message>` — both are no-response
 * outcomes the caller must not treat as deterministic failures.
 */
function looksNoResponse(error: unknown): boolean {
  if (isNoResponseError(error)) return true
  if (error instanceof Error && error.message.startsWith('实例不可达：')) {
    // A proxy/gateway 504 upstream_timeout means the host MAY still be
    // running the purge — same honest wording as a client-side timeout,
    // never a deterministic failure.
    return /fetch failed|network request failed|networkerror|HTTP 504/i.test(error.message)
  }
  return false
}

/**
 * Decode the TWO-level archiveCleanup wire: the generic RPC layer answers ok
 * at the transport level, and the host domain carrier rides NESTED inside
 * `result.value` (`{ok:true,value}|{ok:false,error}`). A nested ok:false is
 * a DETERMINISTIC business failure (busy / registry-unreadable /
 * purge-capacity / storage…) and must surface — never silently decode into
 * empty counts (git-api parity). The thrown message keeps the `${code}:
 * ${message}` shape so UI classifiers (busy prefix…) and existing callers
 * behave identically to RPC-level failures.
 *
 * FAIL-CLOSED SHAPE CONTRACT: the nested carrier must be an object carrying
 * a boolean `ok`, and a nested `ok:true` must carry an OBJECT `value` (for
 * these two endpoints the domain value is always an object). Every other
 * nested shape — carrier absent or not an object, `ok` not a boolean,
 * `ok:true` without an object value — is a malformed domain answer and
 * THROWS loud (zh, hardcoded inline like the file's other strings), never
 * silently decoding into zero counts / empty purge results (host-probe
 * accept-semantics and git-api fail-closed parity).
 */
function decodeDomainResult<T>(result: UnaryResult<any>): { ok: true; value: T } {
  // callAndThrow already refused ok:false answers — but its static type keeps
  // the union, so read the value through the ok:true branch explicitly.
  const rpcValue = (result as { ok: true; value?: unknown }).value
  const carrier = (rpcValue ?? null) as Record<string, unknown> | null
  if (carrier === null || typeof carrier !== 'object' || Array.isArray(carrier)) {
    throw new Error('归档清理域返回了畸形结果：域结果载体缺失或不是对象')
  }
  if (typeof carrier.ok !== 'boolean') {
    throw new Error('归档清理域返回了畸形结果：ok 不是布尔值')
  }
  if (carrier.ok === false) {
    const error = (carrier.error ?? null) as Record<string, unknown> | null
    const code = typeof error?.code === 'string' ? error.code : 'unknown'
    const message = typeof error?.message === 'string' ? error.message : '未知错误'
    throw new Error(`${code}: ${message}`)
  }
  const domainValue = carrier.value
  if (domainValue === null || typeof domainValue !== 'object' || Array.isArray(domainValue)) {
    throw new Error('归档清理域返回了畸形结果：ok:true 但 value 不是对象')
  }
  return { ok: true, value: domainValue as T }
}

/**
 * archiveCleanup/preview wrapper (design 24 §5): read-only point-in-time
 * counts. Domain-missing 404s surface as isInstanceDomainMissing errors;
 * not-ready 503s keep the existing wording; no-response outcomes
 * (timeout/abort/network) map to an honest retry message — never a bare
 * browser timeout string.
 *
 * KEPT DELIBERATELY (review round 2026-09): the archive manager derives its
 * list from the snapshot (no preview call), so this wrapper currently has no
 * UI caller — it stays as the tested client half of the still-live host
 * preview endpoint (informational counts; a natural consumer for future
 * authoritative-count confirmations) and pins the nested-carrier decode.
 */
export async function previewArchiveCleanup(client: InstanceApiClient): Promise<ArchiveCleanupPreview> {
  let result: UnaryResult<any>
  try {
    result = await callAndThrow(client, () => client.archiveCleanup.preview({}))
  } catch (error) {
    if (looksNoResponse(error)) throw new Error('预览超时或网络中断，请重试。')
    throw error
  }
  const { value } = decodeDomainResult<ArchiveCleanupPreview>(result)
  return {
    archived: countField(value, 'archived'),
    deletableSessions: countField(value, 'deletableSessions'),
    deletableSubagents: countField(value, 'deletableSubagents'),
    skippedRunning: countField(value, 'skippedRunning'),
    skippedLoaded: countField(value, 'skippedLoaded'),
  }
}

/**
 * archiveCleanup/purge wrapper (design 24 §5): long-budget destructive run.
 * `sessionIds` is the OPTIONAL subset filter (2026-09): undefined = delete
 * the whole archived set (legacy behavior); an array = delete exactly those
 * archived sessions' trees. A client timeout/network loss does NOT cancel
 * the host run — the honest wording is "may still be running; re-preview/
 * retry later" (idempotent per session). Only a resolved ok:false is a
 * deterministic failure.
 *
 * VERSION-SKEW LEG (review round 2026-09): a NEW client sending a subset
 * filter to an OLD seeded host (zero-param purge, running instance that has
 * not restarted since the update) is REFUSED by the host gateway's exact
 * args validation (`gateway/arguments-invalid` — empirically verified: the
 * generic gateway rejects any key the method descriptor does not declare,
 * so the old host NEVER runs its legacy full purge on a subset request).
 * The refusal is remapped here to an honest restart hint. Since the manager
 * retired its whole-set path (2026 user decision — no standalone delete-all,
 * every purge carries an explicit id list), an old host now refuses EVERY
 * manager delete until the instance restarts with the current seed; the
 * `undefined` whole-set shape below remains only as the tested wire-level
 * legacy contract (no UI caller).
 *
 * FORCE LEG (2026-09 revision): `force: true` authorizes the host to delete
 * subtrees that are merely LOADED (idle agent / attached session). The caller
 * MUST cancel the run first (official `session/cancel`) — the manager does
 * this automatically; a RUNNING member is refused by the host either way.
 *
 * FORCE-SKEW FALLBACK (2026-09 P1 round): a host that predates the flag
 * refuses the WHOLE call (`gateway/arguments-invalid`), so a hard refusal
 * would break deletion entirely on every not-yet-restarted instance. The
 * force intent is already satisfied by the caller's cancel pass, so the call
 * is retried ONCE with the legacy shape and the outcome carries
 * `forceUnsupported: true` — the caller must then state that loaded-but-idle
 * subtrees were skipped and that the instance's dsh needs a restart. The
 * intent is never dropped silently. If the legacy shape is refused too, the
 * host predates force AND the subset filter: the force refusal plus the
 * restart hint is reported (either fact is true; the restart is the action).
 */
export async function purgeArchivedSessions(
  client: InstanceApiClient,
  sessionIds?: readonly string[],
  force?: boolean,
): Promise<ArchiveCleanupPurgeResult> {
  const attempt = async (withForce?: boolean): Promise<UnaryResult<any>> => {
    try {
      return await callAndThrow(client, () => client.archiveCleanup.purge(sessionIds, withForce))
    } catch (error) {
      if (looksNoResponse(error)) {
        throw new Error('清理超时或网络中断——清理可能仍在进行，请稍后重试（重复执行是安全的）。')
      }
      throw error
    }
  }
  let result: UnaryResult<any>
  let forceUnsupported = false
  try {
    result = await attempt(force)
  } catch (error) {
    const refusedShape = error instanceof InstanceRpcError && error.code === 'gateway/arguments-invalid'
    if (!refusedShape) throw error
    if (force === true) {
      try {
        result = await attempt(undefined)
        forceUnsupported = true
      } catch (retryError) {
        if (retryError instanceof InstanceRpcError && retryError.code === 'gateway/arguments-invalid') {
          throw new Error('该实例的归档清理域版本过旧，不支持强制删除——请重启该实例的 dsh 后再试。')
        }
        throw retryError
      }
    } else if (sessionIds !== undefined) {
      // Old host domain refusing a shape it does not declare: the subset
      // filter (2026-09). The legacy whole-set shape (both absent) is
      // accepted by old hosts, so it never takes this branch.
      throw new Error('该实例的归档清理域版本过旧，不支持按条删除——请重启该实例的 dsh 后再试。')
    } else {
      throw error
    }
  }
  const { value } = decodeDomainResult<Record<string, unknown> | undefined>(result)
  const rawErrors = (value as Record<string, unknown> | null | undefined)?.errors
  const errors: ArchiveCleanupPurgeItemError[] = Array.isArray(rawErrors)
    ? rawErrors.flatMap((item: unknown) => {
      const record = item as Record<string, unknown> | null
      if (record === null || typeof record !== 'object') return []
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
      const code = typeof record.code === 'string' ? record.code : ''
      // A missing code is a host contract violation — never fabricate one.
      if (code === '') return []
      const message = typeof record.message === 'string' ? record.message : '未知错误'
      return [{ sessionId, code, message }]
    })
    : []
  const clearedOrphanMembers = countField(value, 'clearedOrphanMembers')
  return {
    deletedSessions: countField(value, 'deletedSessions'),
    deletedSubagents: countField(value, 'deletedSubagents'),
    skippedRunning: countField(value, 'skippedRunning'),
    skippedLoaded: countField(value, 'skippedLoaded'),
    forcedLoaded: countField(value, 'forcedLoaded'),
    forceUnsupported,
    truncated: (value as Record<string, unknown> | null | undefined)?.truncated === true,
    ...(clearedOrphanMembers > 0 ? { clearedOrphanMembers } : {}),
    errors,
  }
}

/**
 * One `session/list` read projected onto the facts a pre-purge stop pass
 * needs: the running bits AND the SUBAGENT-origin parent edges of the same
 * rows.
 *
 * WHY lineage (2026-09 P1 closure round, design 24 §5): the host skips an
 * archived TREE whose any member is running, and subagent-origin rows are
 * never listed by the archive manager — a running descendant is therefore
 * invisible in the UI and, with roots-only cancels, permanently undeletable.
 * `parents` is child → parent; a row without a non-empty `parentSessionId`
 * contributes NO edge, so a caller can never invent a parent chain.
 *
 * SUBAGENT EDGES ONLY (2026-09 fail-open fix): the official row carries
 * `origin: 'subagent'` for DELEGATION children and NOTHING for forks —
 * upstream `session/fork` records `parentSessionId` with no origin. The purge
 * tree (design 24) follows subagent-origin descendants only, so a fork child
 * of a selected archived root is never inside it; cancelling such a child
 * would abort a live, unrelated session. A row whose origin is absent (fork)
 * or unknown therefore contributes NO edge, and without any edge the closure
 * degrades to the requested roots — a parent is never guessed.
 */
export interface SessionRunningLineage {
  /** Running session ids (subagent-origin rows included). */
  readonly running: ReadonlySet<string>
  /** child → parent edges from SUBAGENT-ORIGIN rows only (fork rows carry no
   *  edge — the purge tree never contains a fork descendant). A subagent row
   *  whose parent link is missing/empty contributes NO entry: row presence is
   *  tracked separately in `subagentIds`, so the absence stays detectable. */
  readonly parents: ReadonlyMap<string, string>
  /** EVERY session id present in this read. The vendor list skips cold
   *  records without a cwd (`api-session-controller/src/list.ts` filters
   *  `record.header.cwd === undefined`), so a row can be absent even though
   *  the session exists — callers must be able to tell "no edge" from
   *  "no row". */
  readonly listed: ReadonlySet<string>
  /** Ids whose row is SUBAGENT-origin, whether or not its parent link is
   *  usable. This is what makes an incomplete upward chain detectable. */
  readonly subagentIds: ReadonlySet<string>
}

/**
 * Running session ids + subagent lineage from the OFFICIAL session list
 * (`session/list` rows carry the live running bit, `parentSessionId` and the
 * coarse `origin`). Subagent-origin rows are INCLUDED: a running descendant
 * makes its whole archived tree undeletable, so callers that wait for
 * "nothing running" must see it. Fork rows are included in `running` (their
 * liveness is real) but never in `parents` (their edge is not lineage).
 */
export async function fetchSessionRunningLineage(client: InstanceApiClient): Promise<SessionRunningLineage> {
  let result: UnaryResult<{ items?: readonly unknown[] }>
  try {
    result = await client.session.list({})
  } catch (error) {
    throw wrapWireError(error)
  }
  const failure = resultError(result)
  if (failure !== null) throw failure
  const items = ((result.ok ? result.value?.items : undefined) ?? []) as readonly any[]
  const running = new Set<string>()
  const parents = new Map<string, string>()
  const listed = new Set<string>()
  const subagentIds = new Set<string>()
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId : ''
    if (sessionId === '') continue
    listed.add(sessionId)
    if (item.running === true) running.add(sessionId)
    // Delegation children only. An absent/unknown origin (fork lineage) and a
    // drifted value both contribute NO edge — never guess a parent chain.
    if (item.origin !== 'subagent') continue
    subagentIds.add(sessionId)
    const parent = typeof item.parentSessionId === 'string' ? item.parentSessionId : ''
    // A self-referencing row is malformed, not a lineage fact — never an edge.
    if (parent !== '' && parent !== sessionId) parents.set(sessionId, parent)
  }
  return { running, parents, listed, subagentIds }
}

/**
 * TRUE when the upward subagent chain from `sessionId` is fully resolvable
 * over the SAME read: every link has a row, and the chain ends at a row that
 * is not subagent-origin (a top-level session or a fork edge).
 *
 * WHY (2026-09 fail-closed round, design 24 §5): a PARTIALLY incomplete
 * list — the vendor skips cwd-less cold records, and a subagent inherits its
 * parent's cwd only when the parent has one — silently drops an intermediate
 * ancestor's edge. The client would then neither exclude nor refuse the viewed
 * session while the HOST (full corpus, no cwd filter) deletes the whole
 * subagent tree. An unresolvable link is therefore UNKNOWN and callers refuse.
 */
export function upwardChainComplete(sessionId: string, lineage: SessionRunningLineage): boolean {
  const seen = new Set<string>()
  let current: string | undefined = sessionId
  while (current !== undefined) {
    // A malformed cycle cannot be resolved to a top-level row: unknown.
    if (seen.has(current)) return false
    seen.add(current)
    // The row is absent from this read (cold cwd-less record / transient
    // gap): its origin is unknowable, so the chain is incomplete.
    if (!lineage.listed.has(current)) return false
    // Not a delegation child (top-level or fork edge): the chain ends here.
    if (!lineage.subagentIds.has(current)) return true
    const parent: string | undefined = lineage.parents.get(current)
    // A subagent row without a usable parent link is an incomplete chain.
    if (parent === undefined) return false
    current = parent
  }
  return true
}

/** Outcome of the pre-purge stop pass (design 24 §5). */
export interface StopSessionsResult {
  /** Ids whose running turn was aborted by this pass (closure members). */
  readonly cancelled: readonly string[]
  /** Closure ids still reported running after the settle wait. */
  readonly stillRunning: readonly string[]
  /** Per-id cancel failures (other than "not attached" = already not running). */
  readonly failures: readonly { readonly sessionId: string; readonly message: string }[]
  /** TRUE when the initial `session/list` read failed: the stop pass was
   *  SKIPPED (caught, never thrown — design 24 §5) and the caller must then
   *  REFUSE the force path because the closure is unknown. */
  readonly unavailable: boolean
  /** Requested roots REFUSED because an excluded id (the session currently
   *  being viewed) appears in their closure: never cancelled, and the caller
   *  must not purge them either (the host would delete the viewed session's
   *  content with the tree). */
  readonly refusedRoots: readonly string[]
  /** The lineage read this pass used, or null when the read failed. Callers
   *  use it to verify the viewed session's upward chain is complete
   *  (`upwardChainComplete`) before trusting the closure. */
  readonly lineage: SessionRunningLineage | null
}

/**
 * Roots plus every transitive SUBAGENT-origin descendant of the roots (BFS
 * over the child → parent edges). Roots keep their caller order and
 * descendants follow in edge order, so the cancel order is deterministic;
 * `seen` makes a malformed/cyclic parent chain terminate instead of looping.
 * Exported for the archive manager's closure-based current-session refusal
 * (design 24 §5) and for tests; it is the ONE closure definition both paths
 * share.
 */
export function sessionPurgeClosure(
  roots: readonly string[],
  lineage: SessionRunningLineage | null,
): string[] {
  const closure: string[] = []
  const seen = new Set<string>()
  const queue = [...roots]
  const parents = lineage?.parents ?? new Map<string, string>()
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    closure.push(id)
    for (const [child, parent] of parents) {
      if (parent === id && !seen.has(child)) queue.push(child)
    }
  }
  return closure
}

/**
 * Stop the selected archived sessions' running turns before a purge, using
 * the official `session/cancel` wire — the "已归档的对话应该终止" semantics
 * (design 24 §5): the host's force purge may then delete the merely LOADED
 * content, while a RUNNING member is still refused host-side (so this pass is
 * a best-effort accelerator, never the safety boundary).
 *
 * CLOSURE (2026-09 P1 round): the host skips an archived tree whose ANY member
 * runs, and a running subagent descendant has no row in the manager — so the
 * pass cancels the running members of the closure of the requested roots
 * (roots + all transitive SUBAGENT-origin descendants from the same
 * `session/list` lineage) and waits until no closure member is running.
 * Without lineage facts (rows without a subagent-origin edge) the closure
 * degrades to the roots exactly as before — a parent is never guessed.
 *
 * ADVISORY (2026-09 fix): a failed initial read must NOT abort the delete
 * (the purge is the operation the user asked for; the stop pass only improves
 * its outcome). The pass then reports `unavailable: true` and the caller
 * continues with the force purge plus an honest note.
 *
 * EXCLUSION (2026-09 fix): `exclude` ids (the session currently being viewed)
 * are never cancelled, and a requested root whose closure contains one is
 * returned in `refusedRoots` so the caller can skip it entirely — the host
 * would otherwise delete that root's whole tree, viewed session included.
 *
 * Idle agents are skipped (cancel would be a no-op), `session/not-found` is
 * treated as already-settled, and the pass waits up to
 * `attempts × intervalMs` for the aborted turns to leave the running set. A
 * mid-wait list failure stops the polling and reports the last known state.
 */
export async function stopSessionsForPurge(
  client: InstanceApiClient,
  sessionIds: readonly string[],
  deps: {
    readonly fetchRunning?: (client: InstanceApiClient) => Promise<SessionRunningLineage>
    readonly cancel?: (client: InstanceApiClient, sessionId: string) => Promise<void>
    readonly delay?: (ms: number) => Promise<void>
    readonly attempts?: number
    readonly intervalMs?: number
    /** Ids that must never be cancelled and whose presence in a requested
     *  root's closure refuses that root (design 24 §5). */
    readonly exclude?: readonly string[]
  } = {},
): Promise<StopSessionsResult> {
  const fetchRunning = deps.fetchRunning ?? fetchSessionRunningLineage
  const cancel = deps.cancel ?? cancelSession
  const delay = deps.delay ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
  const attempts = deps.attempts ?? 10
  const intervalMs = deps.intervalMs ?? 300
  const cancelled: string[] = []
  const failures: { sessionId: string; message: string }[] = []
  const excluded = new Set(deps.exclude ?? [])

  let snapshot: SessionRunningLineage
  try {
    snapshot = await fetchRunning(client)
  } catch {
    // CAUGHT, never thrown: the caller must REFUSE the force path (the closure
    // is unknown) and report honestly. Raw wire text never surfaces.
    return {
      cancelled: [],
      stillRunning: [],
      failures: [],
      unavailable: true,
      refusedRoots: [],
      lineage: null,
    }
  }
  const roots = [...new Set(sessionIds)]
  const refusedRoots = excluded.size === 0
    ? []
    : roots.filter(root => sessionPurgeClosure([root], snapshot).some(id => excluded.has(id)))
  const kept = roots.filter(root => !refusedRoots.includes(root))
  let running = snapshot.running
  const wanted = sessionPurgeClosure(kept, snapshot).filter(id => !excluded.has(id))
  for (const sessionId of wanted) {
    if (!running.has(sessionId)) continue
    try {
      await cancel(client, sessionId)
      cancelled.push(sessionId)
    } catch (error) {
      // Not attached = nothing was running there (idempotent success).
      if (isSessionNotAttached(error)) continue
      failures.push({ sessionId, message: error instanceof Error ? error.message : String(error) })
    }
  }
  if (cancelled.length > 0) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await delay(intervalMs)
      try {
        running = (await fetchRunning(client)).running
      } catch {
        break
      }
      if (wanted.every(id => !running.has(id))) break
    }
  }
  return {
    cancelled,
    stillRunning: wanted.filter(id => running.has(id)),
    failures,
    unavailable: false,
    refusedRoots,
    lineage: snapshot,
  }
}

export interface CreateWorkspaceResult {
  workspaceId: string
  path: string
  /** False means the host reused the workspace already registered at `path`. */
  created: boolean
}

export async function createWorkspace(client: InstanceApiClient, path: string): Promise<CreateWorkspaceResult> {
  const result = await callAndThrow(client, () => client.workspace.create({ path }))
  return decodeWorkspaceCreateValue(result.ok ? result.value : undefined)
}

export async function renameWorkspace(client: InstanceApiClient, workspaceId: string, title: string): Promise<void> {
  await callAndThrow(client, () => client.workspace.rename({ workspaceId, title }))
}

export async function deleteWorkspace(client: InstanceApiClient, workspaceId: string): Promise<void> {
  const result = await callAndThrow(client, () => client.workspace.delete({ workspaceId }))
  decodeWorkspaceDeleteValue(result.ok ? result.value : undefined)
}
