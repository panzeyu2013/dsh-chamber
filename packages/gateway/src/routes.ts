/**
 * Gateway chamber surface: the gateway-owned `/chamber/*` routes behind the
 * auth gate (dispatch.ts) — channels projection, the desktop-synced
 * host-package seed cache, the managed-profile plugin projections and write
 * surface (installed / tasks / install / materialize / remove / undo), the
 * read-only session-state watcher, the browser dashboard, and the separately
 * dispatched `/chamber/runtime/*` controller.
 * The installed projection shares the managed-profile write fence: a write in
 * flight answers a retryable 409, and a fence probe that itself fails withholds
 * the projection with a loud retryable 503 — never an unfenced read. Every
 * route reads/writes gateway-owned state; authoritative dsh facts stay on dsh.
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

/** The mutation-orchestrator surface the routes drive: submit + projection
 * only — the routes never drain or reconcile (index.ts owns the ready-edge
 * drain and boot reconciliation). */
export interface ChamberSurfacePluginTasks {
  submit(input: PluginTaskSubmitInput, opts?: { defer?: boolean }): Promise<PluginTaskSubmitResult>
  tasks(): PluginTaskTasksProjection
}

export interface ChamberSurfaceDeps {
  logger: Logger
  /** The channel registry (MVP empty). */
  channels: ChannelRegistry
  /** The desktop-synced host-package seed cache. */
  plugins: ChamberPlugins
  /** The managed web-profile plugin read projection (read-only). */
  installed: ChamberInstalled
  /** The mutation orchestrator: install/materialize/remove submissions
   * (202-async, journal + lease + deferred intents) and the task projection. */
  tasks: ChamberSurfacePluginTasks
  /** The gateway stateDir — the materialize route stages uploaded archives
   * under its chamber-plugins/third-party tree. */
  stateDir: string
  /** The read-only session-state watcher: snapshot, SSE deltas and read marks
   * under /chamber/session-state*. Optional so the surface stays additive; when
   * absent the prefix falls through to this surface's own 404. */
  sessionState?: ChamberSessionState
}

export interface ChamberSurface {
  /** Handle a `/chamber/*` request. Returns true when the path was claimed
   * (including a 404 for an unknown /chamber route). */
  handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean>
}

/** Bounded JSON body reader for the plugin-sync upload. Cap: 8 MiB — a host
 * package's artifact (up to 4 MiB) + manifest as JSON strings. An oversized
 * body is answered 413 and the socket destroyed rather than drained, so a slow
 * authenticated upload cannot pin the connection. */
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

// Gateway-owned browser assets: the full dsh frontend stays proxied at `/`;
// `/chamber/` is a deliberately small gateway-owned operations surface.

const CHAMBER_APP_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'"

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

/** Uploaded materialize archive cap: this route has its own STREAMED body
 * reader, so readUploadJsonBody's 8 MiB cap does not apply; oversize is
 * answered 413 + socket destroy. */
const MATERIALIZE_MAX_BYTES = 32 * 1024 * 1024
/** Materialize version header whitelist (exact three-part semver core with
 * an optional prerelease/build suffix). */
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

type MaterializeReadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; code: 'length_required' | 'too_large' | 'request_aborted'; error: string }

/** Independent streamed body reader for PUT /chamber/plugins/materialize:
 * Content-Length is REQUIRED (411 when absent), the cap is enforced while
 * collecting (oversize → 413 + socket destroy), and the bounded buffer goes to
 * the tgz scan. Resolves instead of throwing; the raw bytes are preserved
 * because tgz content is binary. */
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
/** Map an orchestrator refusal onto the HTTP family: input/reserved failures
 * are the client's (400); queue/runtime/state failures are 409 (retryable). */
function submitRefusalStatus(code: string): number {
  if (code === 'invalid_name' || code === 'invalid_spec' || code === 'reserved' || code === 'invalid-name') return 400
  // Protected-set / generation refusals: well-formed but must not be executed.
  if (code === 'protected' || code === 'needs-version' || code === 'needs-exact-version'
    || code === 'generation-mismatch' || code === 'runtime-version-unknown') return 400
  // Derivation failure (missing runtime facts) is the GATEWAY's own state, not
  // the client's; retry once the instance is up.
  if (code === 'protected-set-unavailable') return 503
  // Corrupt/unreadable journal: the undo record set is UNKNOWN, not empty.
  if (code === 'journal_unavailable') return 503
  // A journal/deferred-store write failure is the GATEWAY's, never the client's — 500 persistence_failed.
  if (code === 'persistence_failed') return 500
  return 409
}

/** The shared read/write fence probe outcome.
 *
 * `ok: false` means the probe itself threw: the writer state is UNKNOWN, not
 * "no writer is in flight". The caller must not publish a projection it cannot
 * prove unfenced, so it answers a loud retryable 503 — no fail-open fallback.
 * The tasks projection is the seam: an op stays journal-`pending` for exactly
 * its lease lifetime (including the queued window right after the 202), while
 * `busy` covers only the running child; both are read. Deferred intents (no
 * lease) stay deliberately unfenced; observation only, never a lease
 * acquisition (the following manifest read is synchronous). */
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

function submitAccepted(res: ApiResponse, result: Extract<PluginTaskSubmitResult, { ok: true }>): void {
  if (result.deferred) {
    jsonResponse(res, 202, { accepted: true, deferred: true, intentId: result.intentId })
  } else {
    jsonResponse(res, 202, { accepted: true, opId: result.opId })
  }
}

/** The mutation initiator: the request's Host header when present, 'chamber' otherwise. */
function mutationInitiator(req: ApiRequest): string {
  const value = headerValue(req.headers, 'host')
  return typeof value === 'string' && value !== '' ? value : 'chamber'
}

/** Parse a mutation JSON body ({name, spec}) with the shared 8 MiB reader and
 * answer the established error family on failure; null = response already sent. */
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

/** Directory slug for a staged materialize archive under
 * chamber-plugins/third-party/: the scope slash and path-unfriendly punctuation
 * are flattened, so scoped names cannot introduce traversal or nested paths. */
function materializeSlug(name: string): string {
  return name.replace(/^@/u, '').replace(/[^\w.-]+/gu, '-')
}

/**
 * The gateway's own `/chamber/*` surface: channels projection + plugin-sync
 * seed cache + the plugin write surface (install/materialize/remove/tasks) +
 * browser dashboard assets (GET/HEAD reads). Mutation routes answer 202 and
 * hand every write to the orchestrator (deps.tasks), whose per-op profile-write
 * lease and journal make each mutation durable and serialized; route tails
 * settle before the mutation runs. index.ts owns the stop ordering (dispatch
 * quiesce + orchestrator dispose kill in-flight children).
 */
export function createChamberSurface(deps: ChamberSurfaceDeps): ChamberSurface {
  const { channels, logger } = deps
  async function handleRoute(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    // /chamber/channels: the channel registry projection (MVP empty).
    if (pathname === '/chamber/channels') {
      if (req.method !== 'GET') {
        jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
        return true
      }
      jsonResponse(res, 200, { items: channels.list() })
      return true
    }

    // /chamber/plugins: the desktop-synced host-package seed cache. GET = the
    // non-secret projection (name + version); PUT = upload one syncable host
    // package (validated + atomically cached; the next dsh spawn re-seeds it,
    // and the syncing desktop triggers /chamber/runtime/restart to refresh).
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
            // Echo the sanitized REASON (names/size bounds only, never a path
            // or credential), not a bare code, so a syncing desktop meeting an
            // older gateway sees why its package was refused. The thrower may
            // hand over its own non-secret vocabulary (`error.keep`): a scoped
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
          // disk full …): the client must distinguish "your input was bad" from
          // "the gateway could not write" (proxy honesty).
          logger.warn(`chamber-plugins: persistence failure: ${String(error)}`)
          jsonResponse(res, 500, { error: 'persistence_failed', code: 'persistence_failed' })
          return true
        }
        return true
      }
      jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
      return true
    }

    // GET /chamber/plugins/installed: the gateway readManifest projection of the
    // MANAGED dsh web profile manifest the desktop's localPluginList reads.
    // Read-only; the write side below shares it through the orchestrator's
    // installed-projection checks. Status matrix:
    //   200 profile present (ok + dependencies/bundles/profileExists)
    //   404 profile_absent (not made)
    //   500 profile_corrupt (unreadable; detail logged, not echoed — it may
    //       name stateDir-internal paths)
    //   409 runtime_busy — shared fence, write in flight: the manifest on disk is
    //       mid-change, so a published projection would be stale or torn
    //   503 write_fence_unavailable — the probe itself failed, so the writer
    //       state is UNKNOWN and the projection is withheld, never published
    //       unfenced. A stopped/error instance still reads 200/404 (this is the
    //       probe, not the runtime's connection state).
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

    // PUT /chamber/plugins/install: registry-spec install — 202 accepted (opId)
    // or deferred (intentId; ready-edge drain), 400 invalid/reserved input, 409
    // queue/runtime busy (the lease family), 413/400 body errors.
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
        // Deferred-intent persistence failure — never a generic uncoded 500.
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

    // POST /chamber/plugins/remove: installed-list removal — usable while the
    // managed dsh is stopped (no ready-window dependency), never deferred;
    // membership + reserved-name checks live in the orchestrator (409
    // not_installed/no_manifest).
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

    // POST /chamber/plugins/undo: undo = RESTORE the latest ok op's preImage
    // pair (package.json + pnpm-lock.yaml, pair-validated, byte-for-byte) —
    // deliberately NOT a remove-only shortcut, matching the ssh backend's
    // 撤销=恢复 semantics. The orchestrator owns the single-flight and fence:
    // nothing to undo → 409 no_undoable_op, corrupt journal → 503
    // journal_unavailable, writer in flight → 409 runtime_busy; an accepted undo
    // is 202 + opId and runs through the SAME serial queue/lease as install/
    // remove.
    if (pathname === '/chamber/plugins/undo' || pathname === '/chamber/plugins/undo/') {
      if (req.method !== 'POST') return methodNotAllowed(res)
      let result: PluginTaskSubmitResult
      try {
        // The orchestrator selects the target, spec and preImage from the
        // durable journal: no body is read, so the client cannot pick an op id.
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

    // GET /chamber/plugins/tasks: the durable task projection — journal ops
    // (newest first, retention-capped) + deferred intents + executor busy flag.
    // Never gated: the projection is the read side of the 202 contract.
    if (pathname === '/chamber/plugins/tasks' || pathname === '/chamber/plugins/tasks/') {
      if (req.method !== 'GET') return methodNotAllowed(res)
      jsonResponse(res, 200, { ok: true, ...deps.tasks.tasks() })
      return true
    }

    // PUT /chamber/plugins/materialize: folder/tarball push with its OWN
    // streamed body reader (Content-Length required; ≤ 32 MiB → 413 + destroy;
    // readUploadJsonBody's 8 MiB cap does NOT apply). The bounded buffer is
    // scanned (tgz metadata caps: ≤ 4096 entries / ≤ 256 MiB unpacked) and the
    // archive is staged under chamber-plugins/third-party/<slug>/
    // (0700/0600 atomic no-follow) before the orchestrator submit, so an
    // accepted 202 has a durable archive on disk — including when it defers.
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
        // Not gzip/tar or truncated mid-parse → tgz_invalid; cap errors keep their codes.
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
      // NOTE: the protected-set + generation judgement is NOT duplicated here —
      // the name-only shape check stays fast-fail and the authoritative decision
      // runs in the submit path (plugins-tasks.validateSubmission →
      // decidePluginMutation), which owns the runtime facts. The header's version
      // rides the submit input so the generation check sees it. A refused submit
      // deletes the staged archive (staged-archive GC below).
      if (typeof version !== 'string' || !PLUGIN_VERSION_PATTERN.test(version)) {
        jsonResponse(res, 400, { error: 'invalid plugin version header (x-plugin-version)', code: 'invalid_input' })
        return true
      }
      // Identity binding: the headers are CLIENT-ASSERTED, and the protected-set
      // judgement judges exactly those headers. pnpm installs the ARCHIVE's own
      // name, so an archive whose `package/package.json` disagrees with (or is
      // missing/oversized relative to) the headers would let a protected/official
      // name into the profile as a direct dependency — exempt from the
      // post-install verifier. Require the scan-captured manifest to match,
      // byte-for-byte on both fields.
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
      // Stage the archive (gateway-owned tree, 0700 dir + 0600 atomic no-follow
      // leaf); the path handed to the submit must be exactly the path written.
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
        // The submission could not be persisted: the staged archive can never be
        // consumed — remove it like the refusal branch below (staged-archive GC).
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
        // Refused submission — the staged archive can never be consumed; remove
        // it (staged-archive GC). Best effort.
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

    // Gateway-owned browser operations surface, already behind dispatch.ts's
    // mandatory auth gate. The document uses an external same-origin script so
    // the control-plane CSP can keep inline script closed; no credentials in URLs.
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

    // Mobile light surface. The PWA trio (manifest.webmanifest /
    // sw-register.js / sw.js) is deliberately NOT served: nothing references
    // those URLs — the HTML link/registration injection is deferred
    // (middleware.ts), so serving them would have no consumer.
    if (pathname === '/chamber/mobile.html') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'text/html; charset=utf-8', MOBILE_HTML, req.method === 'HEAD')
      return true
    }

    // /chamber/session-state*: snapshot / SSE / read / read-all. Exact-prefix
    // match only — '/chamber/session-stateevil' must NOT be claimed. Host-down
    // still answers 200 with host.serviceable=false; the disabled switch answers
    // 503 session_state_disabled.
    if (deps.sessionState !== undefined
      && (pathname === SESSION_STATE_PATH || pathname.startsWith(SESSION_STATE_PATH + '/'))) {
      return await deps.sessionState.handle(req, res, pathname)
    }

    // Unknown /chamber/* → 404 (claimed, so the default dispatch does not run).
    jsonResponse(res, 404, { error: 'not_found', code: 'not_found' })
    return true
  }

  // `/chamber/*` is NOT read-only, and a managed-profile mutation fence DOES
  // exist. The public boundary is the `/` proxy to the managed dsh
  // (gateway-proxy.ts), the READ routes above, and the write families: the
  // third-party plugin MANAGEMENT surface (PUT /chamber/plugins + PUT
  // …/install, POST …/remove, PUT …/materialize) and the separately dispatched
  // /chamber/runtime controller. Plugin writes run through the managed dsh's OWN
  // CLI (plugins-exec.ts spawns `plugin --profile web add|remove …`), so plugin
  // state stays a dsh fact. Admission is the managed-profile write lease taken
  // by the orchestrator (deps.tasks, the same single-writer fence restart/apply
  // share, re-checked at beforeSpawnCheckpoint in index.ts), and the READ side
  // is fenced by that same lease: GET /chamber/plugins/installed answers 409
  // runtime_busy while a mutation is in flight. No further server-side
  // admission gate exists.
  return {
    async handle(req, res, pathname): Promise<boolean> {
      return handleRoute(req, res, pathname)
    },
  }
}
