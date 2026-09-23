/**
 * Gateway chamber surface (design 17 §10): the gateway-owned `/chamber/*`
 * routes behind the auth gate (dispatch.ts). This surface keeps only:
 *
 *   - `/chamber/channels`        — channel registry projection (MVP empty);
 *   - `/chamber/plugins`          — desktop-synced host-package seed cache
 *                                  (GET projection + PUT upload);
 *   - `/chamber/plugins/installed` — managed web-profile plugin projection
 *                                   (design 21 §6.2; shares the write fence →
 *                                   retryable 409 while a profile write is in
 *                                   flight; a failed fence probe withholds the
 *                                   projection with a loud retryable 503 —
 *                                   never an unfenced read);
 *   - `/chamber/plugins/tasks`    — mutation task projection (journal ops +
 *                                   deferred intents + executor busy, design
 *                                   21 §6.2);
 *   - `/chamber/plugins/install`  — registry-spec plugin install (design 21
 *                                   §6.2 write surface: 202 async, queue
 *                                   serial + single-writer fence, deferred on
 *                                   busy/pending/absent profile);
 *   - `/chamber/plugins/materialize` — folder/tarball push (streamed upload
 *                                   ≤ 32 MiB, bounded tgz scan, staged under
 *                                   third-party/ and installed via file:);
 *   - `/chamber/plugins/remove`   — installed-list remove (never deferred,
 *                                   usable while the managed dsh is stopped);
 *   - `/chamber/plugins/undo`     — undo = RESTORE the managed profile's
 *                                   package.json + lockfile from the latest
 *                                   ok op's preImage backup (design 21 §6.3/
 *                                   §6.8 r2; 202 async through the same queue/
 *                                   lease/single-flight fence as install);
 *   - `/chamber/session-state*`   — the read-only session-state watcher:
 *                                  snapshot / SSE / read / read-all, delegated
 *                                  to sessionState;
 *   - `/chamber/` + assets       — the browser dashboard (Credentials +
 *                                  dsh runtime management only);
 *   - `/chamber/runtime/*`       — the runtime controller (design 18 §9.3,
 *                                  dispatched separately in dispatch.ts).
 *
 * The dashboard also carries a Credentials panel (design 17 §7) that drives
 * the runtime credential endpoints (/auth/change-password, /auth/change-token,
 * /auth/credentials). It never renders secret values: the rotated token is
 * shown once in a readonly textarea (no innerHTML injection) and cleared after
 * a successful copy.
 *
 * Every route reads/writes gateway-owned state; the authoritative dsh facts
 * stay on dsh — the gateway never becomes authoritative over host business
 * (design 17 §10, chamber discipline).
 */

import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  SESSION_STATE_PATH,
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  type ApiRequest,
  type ApiResponse,
  type Logger,
} from '@dsh-chamber/control-plane'
import { PLUGIN_NAME_PATTERN } from '@dsh-chamber/control-plane'
import type { ChannelRegistry } from './channels.ts'
import type { ChamberPlugins } from './plugins.ts'
import type { ChamberInstalled } from './plugins-installed.ts'
import { thirdPartyRoot } from './plugins-journal.ts'
import type { PluginTaskSubmitInput, PluginTaskSubmitResult, PluginTaskTasksProjection } from './plugins-tasks.ts'
import { scanTgzMetadata, TGZ_MAX_ENTRIES, TGZ_MAX_UNPACKED_BYTES } from './tgz-scan.ts'
import { sanitizeRouteError } from './sanitize-route-error.ts'
import { CHAMBER_APP_HTML, CHAMBER_APP_JS, MOBILE_HTML } from './chamber-assets.ts'
import type { ChamberSessionState } from './session-state.ts'
import { codedError, headerValue, jsonResponse, readBoundedBody } from './http-utils.ts'

/** The mutation-orchestrator surface the routes drive (design 21 §6.2):
 * submit + projection only — the routes never drain or reconcile (index.ts
 * owns the ready-edge drain and boot reconciliation). */
export interface ChamberSurfacePluginTasks {
  submit(input: PluginTaskSubmitInput, opts?: { defer?: boolean }): Promise<PluginTaskSubmitResult>
  tasks(): PluginTaskTasksProjection
}

export interface ChamberSurfaceDeps {
  logger: Logger
  /** The channel registry (design 17 §2.4; MVP empty). */
  channels: ChannelRegistry
  /** The desktop-synced host-package seed cache. */
  plugins: ChamberPlugins
  /** The managed web-profile plugin read projection (design 21 §6.2):
   * readManifest's gateway implementation, read-only. */
  installed: ChamberInstalled
  /** The design 21 mutation orchestrator: install/
   * materialize/remove submissions (202-async, journal + lease + deferred
   * intents) and the task projection. */
  tasks: ChamberSurfacePluginTasks
  /** The gateway stateDir — the materialize route stages uploaded archives
   * under its chamber-plugins/third-party tree. */
  stateDir: string
  /** The read-only session-state watcher surface: snapshot,
   * SSE deltas and read marks under /chamber/session-state*. Optional so the
   * surface stays additive for the existing composition tests; the production
   * gateway always supplies it (index.ts), and when absent the prefix falls
   * through to this surface's own 404. */
  sessionState?: ChamberSessionState
}

export interface ChamberSurface {
  /** Handle a `/chamber/*` request. Returns true when the path was claimed
   * (including a 404 for an unknown /chamber route). */
  handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean>
}

/** Bounded JSON body reader for the plugin-sync upload.
 * Cap: 8 MiB — a host package's artifact (up to 4 MiB) + manifest, as
 * JSON strings. An oversized body is answered 413 and the request socket is
 * destroyed instead of drained (a slow authenticated upload must not pin the
 * connection). */
async function readUploadJsonBody(req: ApiRequest): Promise<unknown> {
  const outcome = await readBoundedBody(req, 8 * 1024 * 1024)
  if (outcome.kind === 'oversize') throw codedError('body_too_large', 'request body exceeds 8 MiB')
  if (outcome.kind === 'aborted') throw codedError('request_aborted', 'request body was aborted')
  if (outcome.kind === 'closed') throw codedError('request_aborted', 'request body was closed')
  if (outcome.kind === 'stream-error') throw codedError('request_aborted', 'request body stream failed')
  try {
    return outcome.buffer.length === 0 ? {} : JSON.parse(outcome.buffer.toString('utf8'))
  } catch {
    throw codedError('bad_request', 'request body is not valid JSON')
  }
}

// Gateway-owned browser assets (design 17 §10/§9). The full dsh frontend
// remains proxied at `/`; `/chamber/` is a deliberately small operations
// surface backed only by gateway-owned routes. The dashboard keeps
// Credentials + dsh runtime management only.

const CHAMBER_APP_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'"

/** Serve a gateway-owned static asset at a /chamber/* path. */
function serveAsset(
  res: ApiResponse,
  contentType: string,
  body: string,
  head: boolean,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  })
  res.end(head ? undefined : body)
}

function isAssetMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD'
}

function methodNotAllowed(res: ApiResponse): true {
  jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
  return true
}

// Write-surface helpers (design 21 §6.2)

/** Uploaded materialize archive cap (design 21 §6.2: the materialize route
 * has its own STREAMED body reader — the 8 MiB readUploadJsonBody cap does
 * not apply; ≤ 32 MiB, answered 413 + socket destroy on oversize). */
const MATERIALIZE_MAX_BYTES = 32 * 1024 * 1024
/** Materialize version header whitelist (exact three-part semver core with
 * an optional prerelease/build suffix). */
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

type MaterializeReadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; code: 'length_required' | 'too_large' | 'request_aborted'; error: string }

/** Independent streamed body reader for PUT /chamber/plugins/materialize
 * (design 21 §6.2): Content-Length is REQUIRED (411 when absent), the cap is
 * enforced while collecting (an oversize body is answered 413 and the
 * request socket destroyed instead of drained — a slow authenticated upload
 * must not pin the connection), and the bounded buffer is handed to the tgz
 * scan. The reader resolves a result instead of throwing; the raw bytes are
 * preserved (binary tgz content — the shared kernel collects bytes, only the
 * text readers decode utf8). */
async function readMaterializeBody(req: ApiRequest, maxBytes = MATERIALIZE_MAX_BYTES): Promise<MaterializeReadResult> {
  const rawLength = Array.isArray(req.headers['content-length'])
    ? req.headers['content-length'][0]
    : req.headers['content-length']
  const declared = typeof rawLength === 'string' ? Number(rawLength) : NaN
  if (!Number.isFinite(declared) || declared < 0) {
    return { ok: false, code: 'length_required', error: 'content-length header is required' }
  }
  if (declared > maxBytes) {
    return { ok: false, code: 'too_large', error: `archive exceeds the ${maxBytes} byte upload cap` }
  }
  const outcome = await readBoundedBody(req, maxBytes)
  if (outcome.kind === 'body') return { ok: true, buffer: outcome.buffer }
  if (outcome.kind === 'oversize') {
    return { ok: false, code: 'too_large', error: `archive exceeds the ${maxBytes} byte upload cap` }
  }
  if (outcome.kind === 'aborted') {
    return { ok: false, code: 'request_aborted', error: 'request body was aborted' }
  }
  if (outcome.kind === 'closed') {
    return { ok: false, code: 'request_aborted', error: 'request body was closed' }
  }
  return { ok: false, code: 'request_aborted', error: 'request body stream failed' }
}
/** Map an orchestrator refusal onto the design 21 §6.2 HTTP family: input/
 * reserved failures are the client's (400); queue/runtime/state failures
 * are 409 (retryable). */
function submitRefusalStatus(code: string): number {
  if (code === 'invalid_name' || code === 'invalid_spec' || code === 'reserved' || code === 'invalid-name') return 400
  // Protected-set / generation refusals are client-visible 400s (design 21
  // §6.11.3): the request is well-formed but must not be executed.
  if (code === 'protected' || code === 'needs-version' || code === 'needs-exact-version'
    || code === 'generation-mismatch' || code === 'runtime-version-unknown') return 400
  // Derivation failure (missing runtime facts) is the GATEWAY's own state, not
  // the client's mistake — the caller may retry once the instance is up.
  if (code === 'protected-set-unavailable') return 503
  // The undo target cannot be picked because the durable journal is corrupt /
  // unreadable: the record set is UNKNOWN, not empty. Gateway-side state.
  if (code === 'journal_unavailable') return 503
  // A journal/deferred-store write failure is the GATEWAY's, never the
  // client's — 500 persistence_failed (design 21 §6.2 code table).
  if (code === 'persistence_failed') return 500
  return 409
}

/** The design 21 §6.2 "读与写面共享栅栏" probe outcome.
 *
 * `ok: false` means the probe itself could not be evaluated (the task
 * projection threw): the writer state is UNKNOWN, which is a different fact
 * from "no writer is in flight". The caller must not publish a projection it
 * cannot prove unfenced, so the route answers a loud retryable 503 — there is
 * deliberately no fail-open/unfenced fallback (a fence that may not be
 * trusted is not a fence).
 *
 * Why the tasks projection is the fence seam: the orchestrator takes the
 * runtime-manager `ProfileWriteLease` at submit acceptance and releases it
 * from the op's per-op TERMINAL hook (plugins-tasks.ts submitWithLease), and
 * the executor writes the journal pending record synchronously inside the
 * same enqueue call that precedes the worker (plugins-exec.ts enqueue). An op
 * is therefore journal-`pending` for exactly the lifetime of its lease —
 * including the queued-but-not-yet-running window right after the 202, which
 * is the window a client reads in — while `busy` (executor workerBusy) covers
 * only the mutation child currently running. Both are read: `busy ||
 * <a pending op>`.
 *
 * Deliberately NOT fenced: deferred intents (no lease, no writer — design 21
 * §6.8 r1 keeps the installed read available while the managed dsh is
 * stopped, and a deferred install must never fence that recovery surface),
 * and writers outside this gateway's fence (an operator running `dsh plugin
 * add` against the managed profile, or the managed dsh's own boot-time
 * profile write during a spawn) — that tear is exactly what the projection's
 * `profile_corrupt` outcome reports.
 *
 * Observation only, never a lease acquisition: the manifest read that follows
 * is synchronous (readPrivateFileNoFollow), so no in-process writer can start
 * between the probe and the read. */
type PluginWriteFenceProbe = { ok: true; inFlight: boolean } | { ok: false; error: string }

function probePluginProfileWriteFence(tasks: ChamberSurfacePluginTasks, logger: Logger): PluginWriteFenceProbe {
  try {
    const projection = tasks.tasks()
    return { ok: true, inFlight: projection.busy || projection.tasks.some(op => op.status === 'pending') }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.warn(`chamber-plugins-installed: write-fence probe failed: ${detail} — withholding the installed projection (503)`)
    return { ok: false, error: detail }
  }
}

/** Answer an accepted (202) submission: enqueued ops carry opId; deferred
 * intents carry intentId + deferred:true (the task projection exposes the
 * intent until the ready-edge drain picks it up). */
function submitAccepted(res: ApiResponse, result: Extract<PluginTaskSubmitResult, { ok: true }>): void {
  if (result.deferred) {
    jsonResponse(res, 202, { accepted: true, deferred: true, intentId: result.intentId })
  } else {
    jsonResponse(res, 202, { accepted: true, opId: result.opId })
  }
}

/** The mutation initiator label (design 21 §6.2 who-when attribution): the
 * request's Host header when present, 'chamber' otherwise. */
function mutationInitiator(req: ApiRequest): string {
  const value = headerValue(req.headers, 'host')
  return typeof value === 'string' && value !== '' ? value : 'chamber'
}

/** Parse a mutation JSON body ({name, spec}) with the shared 8 MiB reader
 * and answer the established error family on failure. Returns null when the
 * route already settled the response. */
async function readMutationJsonBody(
  req: ApiRequest,
  res: ApiResponse,
): Promise<{ name?: unknown; spec?: unknown } | null> {
  let body: unknown
  try {
    body = await readUploadJsonBody(req)
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    if (code === 'body_too_large') {
      jsonResponse(res, 413, { error: 'body_too_large', code: 'body_too_large' })
      req.destroy?.()
      return null
    }
    if (code === 'bad_request') {
      jsonResponse(res, 400, { error: 'bad_request', code: 'bad_request' })
      return null
    }
    // aborted/closed body: the client is gone — nothing to answer.
    return null
  }
  const record = (body ?? {}) as { name?: unknown; spec?: unknown }
  return record
}

/** Directory slug for a staged materialize archive (design 21 §6.2:
 * `<stateDir>/chamber-plugins/third-party/<slug>/`): the scope slash and any
 * path-unfriendly punctuation are flattened — scoped names cannot introduce
 * directory traversal or nested paths. */
function materializeSlug(name: string): string {
  return name.replace(/^@/u, '').replace(/[^\w.-]+/gu, '-')
}

/**
 * The gateway's own `/chamber/*` surface (design 17 §10): channels projection
 * + plugin-sync seed cache + the design 21 plugin write surface
 * (install/materialize/remove/tasks) + browser dashboard assets. Reads are GET/HEAD; the plugin MUTATION routes answer
 * 202 asynchronously and hand every write to the A1 orchestrator
 * (deps.tasks), whose per-op runtime-manager profile-write lease and journal
 * make each mutation durable and serialized — the route tails settle before
 * the mutation runs (202), the dispatch quiesce + orchestrator dispose kill
 * in-flight children at stop (index.ts stop ordering), and the plugin-sync
 * cache PUT stays a synchronous atomic write with no async tail.
 */
export function createChamberSurface(deps: ChamberSurfaceDeps): ChamberSurface {
  const { channels, logger } = deps
  async function handleRoute(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    // /chamber/channels: the channel registry projection (§7; MVP empty).
    if (pathname === '/chamber/channels') {
      if (req.method !== 'GET') {
        jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
        return true
      }
      jsonResponse(res, 200, { items: channels.list() })
      return true
    }

    // /chamber/plugins: the desktop-synced host-package
    // seed cache. GET = non-secret projection (name + version); PUT = upload
    // one syncable host package (validated + atomically cached; the next dsh
    // spawn re-seeds from the cache, and the syncing desktop triggers the
    // controlled /chamber/runtime/restart to refresh the running profile).
    if (pathname === '/chamber/plugins' || pathname === '/chamber/plugins/') {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { items: deps.plugins.list() })
        return true
      }
      if (req.method === 'PUT') {
        try {
          const body = (await readUploadJsonBody(req)) as { name?: unknown; files?: unknown }
          const name = typeof body?.name === 'string' ? body.name : null
          if (name === null || body?.files === null || typeof body?.files !== 'object' || Array.isArray(body.files)) {
            jsonResponse(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          const files = body.files as Record<string, unknown>
          const packageJson = typeof files['package.json'] === 'string' ? files['package.json'] : null
          const distIndex = typeof files['dist/index.js'] === 'string' ? files['dist/index.js'] : null
          if (packageJson === null || distIndex === null) {
            jsonResponse(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          const outcome = await deps.plugins.put(name, { 'package.json': packageJson, 'dist/index.js': distIndex })
          jsonResponse(res, 200, { ok: true, changed: outcome.changed })
        } catch (error) {
          const code = (error as { code?: unknown })?.code
          if (code === 'body_too_large') {
            jsonResponse(res, 413, { error: 'body_too_large', code: 'body_too_large' })
            req.destroy?.()
            return true
          }
          if (code === 'bad_request') {
            jsonResponse(res, 400, { error: 'bad_request', code: 'bad_request' })
            return true
          }
          if (code === 'request_aborted') return true
          if (code === 'invalid_input') {
            // Echo the REASON (sanitized — names/size bounds only, never a
            // path or credential), not a bare code: a syncing desktop that
            // meets an older gateway must see why its package was refused
            // (e.g. "unsyncable package … — this gateway release does not
            // know it"), instead of an unexplained 400. The thrower may hand
            // over its own non-secret vocabulary (`error.keep`): a scoped
            // package name is path-shaped and would otherwise be redacted to
            // `[path]`, erasing exactly the fact this message carries.
            const detail = error instanceof Error && error.message !== '' ? error.message : 'invalid_input'
            const keep = (error as { keep?: unknown }).keep
            jsonResponse(res, 400, {
              error: sanitizeRouteError(detail, Array.isArray(keep) ? keep.filter(entry => typeof entry === 'string') as string[] : []),
              code: 'invalid_input',
            })
            return true
          }
          // Any other throw is a persistence failure (fs write, permissions,
          // disk full …) — the client must be able to distinguish "your input
          // was bad" from "the gateway could not write" (proxy honesty).
          logger.warn(`chamber-plugins: persistence failure: ${String(error)}`)
          jsonResponse(res, 500, { error: 'persistence_failed', code: 'persistence_failed' })
          return true
        }
        return true
      }
      jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
      return true
    }

    // GET /chamber/plugins/installed (design 21 §6.2): the
    // gateway readManifest projection of the MANAGED dsh web profile
    // (<stateDir>/dsh-home/profiles/web/package.json — the manifest the
    // desktop's localPluginList reads for its own instance). Read-only; the
    // write side (install/materialize/remove below) shares the same manifest
    // through the orchestrator's installed-projection checks.
    // HTTP mapping (design 21 §6.2 leaves the absent status open; this side
    // follows the gateway's {error, code} convention, keeping the machine
    // code so the future model layer maps profile_absent → deferred flows):
    //   profile present   → 200 {ok:true, dependencies, bundles,
    //                            profileExists:true}
    //   profile not made  → 404 {error:'managed profile is not initialized',
    //                            code:'profile_absent'}
    //   unreadable/corrupt → 500 {error:'managed profile is corrupted',
    //                             code:'profile_corrupt'} (detail logged, not
    //                             echoed — it may name stateDir-internal
    //                             paths)
    //   write in flight    → 409 {code:'runtime_busy'} — the shared read/write
    //                             fence (§6.2): a mutation holds the managed-
    //                             profile write lease, so the manifest on disk
    //                             is mid-change and any projection published
    //                             now would be stale or torn. Retryable (the
    //                             lease family's code — the same 409
    //                             /chamber/runtime answers while a plugin
    //                             mutation holds that lease).
    //   fence unreadable   → 503 {code:'write_fence_unavailable'} — the fence
    //                             probe itself failed, so the writer state is
    //                             UNKNOWN. The projection is withheld (loud,
    //                             retryable); there is no unfenced fallback.
    //                             A stopped/error instance still reads 200/404:
    //                             this 503 is about the probe, never about the
    //                             managed runtime's connection state.
    // file: dependency values are already masked by the projection module.
    if (pathname === '/chamber/plugins/installed' || pathname === '/chamber/plugins/installed/') {
      if (req.method !== 'GET') return methodNotAllowed(res)
      const fence = probePluginProfileWriteFence(deps.tasks, logger)
      if (!fence.ok) {
        jsonResponse(res, 503, {
          error: 'managed profile write fence is unavailable; the installed projection was withheld rather than published unfenced — retry after the gateway task store recovers',
          code: 'write_fence_unavailable',
        })
        return true
      }
      if (fence.inFlight) {
        jsonResponse(res, 409, {
          error: 'managed profile write in flight (plugin mutation); the installed projection is fenced — retry after the task settles',
          code: 'runtime_busy',
        })
        return true
      }
      const projection = deps.installed.read()
      if (!projection.ok) {
        if (projection.code === 'profile_absent') {
          jsonResponse(res, 404, { error: 'managed profile is not initialized', code: 'profile_absent' })
        } else {
          logger.warn(`chamber-plugins-installed: ${projection.error ?? projection.code}`)
          jsonResponse(res, 500, { error: 'managed profile is corrupted', code: 'profile_corrupt' })
        }
        return true
      }
      jsonResponse(res, 200, projection)
      return true
    }

    // PUT /chamber/plugins/install (design 21 §6.2): registry-spec install —
    // 202 accepted (opId) or deferred
    // (intentId; ready-edge drain), 400 invalid/reserved input, 409 queue/
    // runtime busy (the lease family), 413/400 body errors.
    if (pathname === '/chamber/plugins/install' || pathname === '/chamber/plugins/install/') {
      if (req.method !== 'PUT') return methodNotAllowed(res)
      const body = await readMutationJsonBody(req, res)
      if (body === null) return true
      const name = typeof body.name === 'string' ? body.name : ''
      const spec = typeof body.spec === 'string' ? body.spec : ''
      let result: PluginTaskSubmitResult
      try {
        result = await deps.tasks.submit({ kind: 'install', name, spec, initiator: mutationInitiator(req) })
      } catch (error) {
        // Deferred-intent persistence failure (design 21 §6.2 persistence_
        // failed 500 family) — never a generic uncoded 500.
        logger.warn(`chamber-plugins-install: deferred-intent persistence failure: ${String(error)}`)
        jsonResponse(res, 500, { error: 'persistence_failed', code: 'persistence_failed' })
        return true
      }
      if (result.ok) {
        submitAccepted(res, result)
      } else {
        jsonResponse(res, submitRefusalStatus(result.code), { error: result.error, code: result.code })
      }
      return true
    }

    // POST /chamber/plugins/remove (design 21 §6.2): installed-list removal —
    // usable while the managed dsh is stopped (no ready-window dependency),
    // never deferred, membership + reserved-name checks inside the
    // orchestrator (409 not_installed/no_manifest).
    if (pathname === '/chamber/plugins/remove' || pathname === '/chamber/plugins/remove/') {
      if (req.method !== 'POST') return methodNotAllowed(res)
      const body = await readMutationJsonBody(req, res)
      if (body === null) return true
      const name = typeof body.name === 'string' ? body.name : ''
      let result: PluginTaskSubmitResult
      try {
        result = await deps.tasks.submit({ kind: 'remove', name, initiator: mutationInitiator(req) })
      } catch (error) {
        logger.warn(`chamber-plugins-remove: deferred-intent persistence failure: ${String(error)}`)
        jsonResponse(res, 500, { error: 'persistence_failed', code: 'persistence_failed' })
        return true
      }
      if (result.ok) {
        submitAccepted(res, result)
      } else {
        jsonResponse(res, submitRefusalStatus(result.code), { error: result.error, code: result.code })
      }
      return true
    }

    // POST /chamber/plugins/undo (design 21 §3 undoJournal / §6.3 write order
    // / §6.8 r2): undo = RESTORE the latest ok op's preImage pair
    // (package.json + pnpm-lock.yaml, pair-validated, byte-for-byte) — the same
    // 撤销=恢复 semantics as the ssh backend, deliberately NOT a remove-only
    // shortcut. The orchestrator owns the single-flight and fence: nothing to
    // undo → 409 no_undoable_op, corrupt journal → 503 journal_unavailable,
    // writer in flight → 409 runtime_busy (the lease family), queue refusals
    // → their usual 409 family; an accepted undo is 202 + opId and runs
    // through the SAME serial queue/lease as install/remove.
    if (pathname === '/chamber/plugins/undo' || pathname === '/chamber/plugins/undo/') {
      if (req.method !== 'POST') return methodNotAllowed(res)
      let result: PluginTaskSubmitResult
      try {
        // The target, its spec and its preImage are selected by the
        // orchestrator from the durable journal — the request carries only
        // attribution. No body is read: a body-less POST is the contract
        // (the client cannot pick an arbitrary op id).
        result = await deps.tasks.submit({ kind: 'undo', name: '', initiator: mutationInitiator(req) })
      } catch (error) {
        logger.warn(`chamber-plugins-undo: undo submission failed: ${String(error)}`)
        jsonResponse(res, 500, { error: 'persistence_failed', code: 'persistence_failed' })
        return true
      }
      if (result.ok) {
        submitAccepted(res, result)
      } else {
        jsonResponse(res, submitRefusalStatus(result.code), { error: result.error, code: result.code })
      }
      return true
    }

    // GET /chamber/plugins/tasks (design 21 §6.2): the
    // durable task projection — journal ops (newest first, retention-capped)
    // + deferred intents + executor busy flag. Never gated: the projection
    // is the read side of the 202 contract.
    if (pathname === '/chamber/plugins/tasks' || pathname === '/chamber/plugins/tasks/') {
      if (req.method !== 'GET') return methodNotAllowed(res)
      jsonResponse(res, 200, { ok: true, ...deps.tasks.tasks() })
      return true
    }

    // PUT /chamber/plugins/materialize (design 21 §6.2): folder/tarball push
    // with its OWN streamed body reader (Content-Length required; ≤ 32 MiB →
    // 413 + destroy on oversize; readUploadJsonBody's 8 MiB cap does NOT
    // apply). The bounded buffer is scanned (tgz metadata caps: ≤ 4096
    // entries / ≤ 256 MiB unpacked) and the archive is staged under
    // chamber-plugins/third-party/<slug>/ (0700/0600 atomic no-follow) before
    // the orchestrator submit (`add file:<staged>`), so an accepted 202 has a
    // durable archive on disk — including when the submission defers.
    if (pathname === '/chamber/plugins/materialize' || pathname === '/chamber/plugins/materialize/') {
      if (req.method !== 'PUT') return methodNotAllowed(res)
      const read = await readMaterializeBody(req)
      if (!read.ok) {
        if (read.code === 'length_required') {
          jsonResponse(res, 411, { error: read.error, code: 'length_required' })
        } else if (read.code === 'too_large') {
          jsonResponse(res, 413, { error: 'archive too large', code: 'too_large' })
          req.destroy?.()
        }
        return true
      }
      const scan = await scanTgzMetadata(read.buffer)
      if (!scan.ok) {
        // Not a gzip/tar stream or truncated mid-parse → tgz_invalid; the
        // two cap errors keep their machine codes.
        const failure = scan.error === 'not_gzip' || scan.error === 'corrupt'
          ? { error: 'invalid tgz archive', code: 'tgz_invalid' }
          : scan.error === 'too_many_entries'
            ? { error: `archive has more than ${TGZ_MAX_ENTRIES} entries`, code: 'too_many_entries' }
            : { error: `archive unpacks beyond ${TGZ_MAX_UNPACKED_BYTES} bytes`, code: 'too_large' }
        jsonResponse(res, 400, failure)
        return true
      }
      const name = headerValue(req.headers, 'x-plugin-name')
      const version = headerValue(req.headers, 'x-plugin-version')
      if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
        jsonResponse(res, 400, { error: 'invalid plugin name header (x-plugin-name)', code: 'invalid_input' })
        return true
      }
      // NOTE (design 21 §6.11.5): the protected-set + generation judgement is
      // NOT duplicated here. The name-only shape check stays fast-fail, and
      // the authoritative decision runs in the submit path
      // (plugins-tasks.validateSubmission → decidePluginMutation), which owns
      // the runtime facts. The header's version rides the submit input so the
      // generation check sees it. A refused submit deletes the staged archive
      // (staged-archive GC below).
      if (typeof version !== 'string' || !PLUGIN_VERSION_PATTERN.test(version)) {
        jsonResponse(res, 400, { error: 'invalid plugin version header (x-plugin-version)', code: 'invalid_input' })
        return true
      }
      // Identity binding (design 21 §6.2/§6.11): the headers are
      // CLIENT-ASSERTED, and the protected-set judgement judges exactly those
      // headers. pnpm installs the ARCHIVE's own name, so an archive whose
      // `package/package.json` disagrees with (or is missing/oversized relative
      // to) the headers would let a protected/official name into the profile as a
      // direct dependency — exempt from the post-install verifier. The scan
      // captured that manifest (bounded); require it to match, byte-for-byte on
      // both fields.
      if (scan.manifest === null) {
        jsonResponse(res, 400, {
          error: `the archive carries no readable npm-pack manifest (package/package.json${scan.manifestError === undefined ? '' : `: ${scan.manifestError}`}) — the submitted name/version cannot be verified`,
          code: 'tgz_invalid',
        })
        return true
      }
      if (scan.manifest.name !== name || scan.manifest.version !== version) {
        jsonResponse(res, 400, {
          error: `the archive declares ${scan.manifest.name}@${scan.manifest.version}, but the request declares ${name}@${version}`,
          code: 'identity_mismatch',
        })
        return true
      }
      // Stage the archive (gateway-owned tree, 0700 dir + 0600 atomic
      // no-follow leaf) — the path handed to the submit must be exactly the
      // path we just wrote.
      const slug = materializeSlug(name)
      const stagedDir = join(thirdPartyRoot(deps.stateDir), slug)
      const stagedPath = join(stagedDir, `${slug}-${version}-${randomBytes(4).toString('hex')}.tgz`)
      try {
        ensurePrivateDirectoryNoFollow(stagedDir, 0o700)
        atomicWritePrivateFileNoFollow(stagedPath, read.buffer, { mode: 0o600 })
      } catch (error) {
        logger.warn(`chamber-plugins-materialize: staging failure: ${String(error)}`)
        jsonResponse(res, 500, { error: 'persistence_failed', code: 'persistence_failed' })
        return true
      }
      let result: PluginTaskSubmitResult
      try {
        result = await deps.tasks.submit(
          { kind: 'materialize', name, spec: `file:${stagedPath}`, version, initiator: mutationInitiator(req) },
        )
      } catch (error) {
        // The submission could not even be persisted (deferred store full/
        // unwritable): the staged archive can never be consumed — remove it
        // exactly like the refusal branch below (design 21 staged-archive GC).
        try {
          rmSync(stagedPath, { force: true })
        } catch (unlinkError) {
          logger.warn(`chamber-plugins-materialize: could not remove the staged archive ${stagedPath}: ${String(unlinkError)}`)
        }
        logger.warn(`chamber-plugins-materialize: deferred-intent persistence failure: ${String(error)}`)
        jsonResponse(res, 500, { error: 'persistence_failed', code: 'persistence_failed' })
        return true
      }
      if (!result.ok) {
        // The submission was refused (queue/busy/invalid) — the staged
        // archive can never be consumed; remove it (staged-archive GC).
        // Best effort.
        try {
          rmSync(stagedPath, { force: true })
        } catch (error) {
          logger.warn(`chamber-plugins-materialize: could not remove the staged archive ${stagedPath}: ${String(error)}`)
        }
        jsonResponse(res, submitRefusalStatus(result.code), { error: result.error, code: result.code })
        return true
      }
      submitAccepted(res, result)
      return true
    }

    // Gateway-owned browser operations surface (design 17 §10).
    // It is already behind dispatch.ts's mandatory auth gate. The document
    // uses an external same-origin script so the control-plane CSP can keep
    // inline script closed; neither asset accepts credentials in its URL.
    if (pathname === '/chamber/') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'text/html; charset=utf-8', CHAMBER_APP_HTML, req.method === 'HEAD', {
        'content-security-policy': CHAMBER_APP_CSP,
      })
      return true
    }
    if (pathname === '/chamber/app.js') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'application/javascript; charset=utf-8', CHAMBER_APP_JS, req.method === 'HEAD')
      return true
    }

    // Mobile light surface (design 17 §9/§18). The PWA trio
    // (manifest.webmanifest / sw-register.js / sw.js) is not served: nothing
    // in the repository references those URLs — the HTML link/registration
    // injection is deferred (middleware.ts), so serving them would have no
    // consumer.
    if (pathname === '/chamber/mobile.html') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'text/html; charset=utf-8', MOBILE_HTML, req.method === 'HEAD')
      return true
    }

    // /chamber/session-state* (design 17 §10 read-only
    // carve-out): snapshot / SSE / read / read-all. Exact-prefix match only —
    // '/chamber/session-stateevil' must NOT be claimed. Host-down still
    // answers 200 with host.serviceable=false (host semantics); the
    // disabled switch answers 503 session_state_disabled.
    if (deps.sessionState !== undefined
      && (pathname === SESSION_STATE_PATH || pathname.startsWith(SESSION_STATE_PATH + '/'))) {
      return await deps.sessionState.handle(req, res, pathname)
    }

    // Unknown /chamber/* → 404 (claimed, so the default dispatch does not run).
    jsonResponse(res, 404, { error: 'not_found', code: 'not_found' })
    return true
  }

  // `/chamber/*` is NOT read-only, and a managed-profile mutation fence DOES
  // exist (the same file carries the write routes and consults that fence).
  // Behind dispatch.ts's mandatory auth gate the gateway's public boundary is
  // the `/` proxy to the managed dsh (gateway-proxy.ts), the gateway-owned
  // READ routes handled above (channels / plugins seed cache / tasks /
  // installed projections + dashboard assets), and the write families: the
  // third-party plugin MANAGEMENT surface (design 21 §1/§6.2) and the
  // separately dispatched /chamber/runtime controller (design 18 §9.3).
  // The write routes are PUT /chamber/plugins (the design 17 §10.2 desktop
  // host-package seed cache — a synchronous atomic gateway-owned write with no
  // async tail) plus the design 21 §6.2 trio PUT …/install (registry
  // spec), POST …/remove and PUT …/materialize, which are executed through the
  // managed dsh's OWN CLI (plugins-exec.ts spawns `plugin --profile web
  // add|remove …` under the recorded env discipline): the gateway owns no
  // plugin execution surface of its own, so plugin state stays a dsh fact.
  // Admission is the managed-profile write lease, admitted
  // explicitly rather than duplicated — the orchestrator (deps.tasks) takes
  // the runtime-manager profile-write lease (design 21 decision 6, the same
  // single-writer fence restart/apply share, re-checked at
  // beforeSpawnCheckpoint in index.ts), and the READ side is fenced by that
  // same lease: GET /chamber/plugins/installed answers 409 runtime_busy while
  // a mutation is in flight (probePluginProfileWriteFence above, design 21
  // §6.2). No further server-side admission gate exists — a fully
  // authenticated caller is trusted at /chamber/runtime action level (design
  // 21 decision 14).
  return {
    async handle(req, res, pathname): Promise<boolean> {
      return handleRoute(req, res, pathname)
    },
  }
}
