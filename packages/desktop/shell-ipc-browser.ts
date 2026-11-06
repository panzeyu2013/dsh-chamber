/**
 * shell-ipc-browser — remote-browser forward IPC registrar (design 28 §7).
 *
 * Four invoke channels (`dsh-chamber:forward-{request,release,list,open-in-browser}`)
 * and ZERO push channels. v1 is poll-only (design 28 D6): `forward.list` is the
 * refresh face, and the wire's reserved `FORWARD_CHANGED_CHANNEL`
 * ('forward:changed') must NEVER enter `IPC_CHANNELS` — it would become the 10th
 * push channel and renumber the whole manifest/Swift/surface lockstep.
 *
 * WHAT THIS LAYER OWNS.
 *   - payload shape guards: an untrusted renderer payload is never destructured;
 *   - the source proof chain, in the same order as `shell-ipc-open-in.ts`:
 *     registry lookup by `<kind>-<id>` → kind/transport gate → fingerprint
 *     validity → fingerprint match → incarnation capture → the same proof again
 *     across the await boundary (source_changed on any drift);
 *   - the main-side `path` normalization for `openInBrowser`
 *     (`normalizeForwardPath`: absolute URLs, protocol-relative `//host`,
 *     userinfo, CR/LF, encoded control bytes and >2048-byte strings are refused
 *     before the manager composes any URL; the fragment is dropped);
 *   - forward-record ownership re-check on the two calls that return records —
 *     an answer naming another source is refused instead of relayed.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN (the manager stays authoritative):
 * limits (8/32), idempotency/single-flight, the state machine, the per-source
 * open budget (5/60s, never the global 8/10s bucket), the URL composition
 * (`scheme://alias:localPort + path`), `edges.openExternal` and the typed
 * failure table. This registrar never composes a URL, never receives a URL from
 * the renderer, and never logs the payload (no console.* in this file).
 *
 * WIRE AUTHORITY. The cross-process contract is
 * `packages/dsh-chamber-wire/src/forward.ts`. `packages/desktop` cannot take a
 * runtime dependency on that package yet (a node_modules TS import breaks the
 * packaged app and a lockfile change is outside this slice), so the shapes used
 * below are the desktop mirror `remote-forward-manager.ts` already carries —
 * locked in both directions by `test/forward/forward-wire.test.ts`. Keep the
 * three in step: `record`/`records` (not forward/forwards) and
 * `{ ok: false, error: { code, detail } }`.
 *
 * MOUNT POINT (w0-ipc-gate-map §3.2 option C). `installIpcHandlers` is the
 * single registration point for both flavors, but `shell-core.ts` is a
 * 1318/1318 ratchet: registering from it costs +2 lines and a `--force`
 * budget raise (design 27 §6.17). This slice therefore mounts from
 * `shell-ipc-open-in.ts` (same `ShellIpcCtx`, same `openExternal` edge family,
 * unbudgeted file). Moving it into `installIpcHandlers` with the budget raise is
 * the cleaner end state and remains the design 28 §6.1 option A.
 *
 * The production assembly lives in `remote-forward-service.ts` and is created
 * once by `shell-ipc-open-in.ts`; both flavors pass that singleton here. A
 * construction-level failure (no derivable <userData>) keeps every channel
 * answering a typed `forward_failed` — an honest refusal, never a fake success
 * and never a missing handler.
 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import type { NotificationSourceToken } from './notifications.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { isValidNotificationSourceFingerprint } from './notifications.ts'
import { normalizeForwardPath } from './remote-forward-manager.ts'
import type {
  ForwardError,
  ForwardErrorCode,
  ForwardListArgs,
  ForwardListResult,
  ForwardOpenArgs,
  ForwardOpenResult,
  ForwardReleaseArgs,
  ForwardReleaseResult,
  ForwardRequestArgs,
  ForwardRequestResult,
  ForwardScheme,
} from './remote-forward-manager.ts'

/**
 * The four operations this registrar relays to. `RemoteForwardManager` satisfies
 * it structurally; tests drive the registrar with a plain fake of it.
 */
export interface ForwardIpcService {
  request(args: ForwardRequestArgs): Promise<ForwardRequestResult>
  release(args: ForwardReleaseArgs): Promise<ForwardReleaseResult>
  list(args: ForwardListArgs): Promise<ForwardListResult>
  openInBrowser(args: ForwardOpenArgs): Promise<ForwardOpenResult>
}

/** The refusal half shared by all four results. */
type ForwardFailure = { readonly ok: false; readonly error: ForwardError }

/** Source-id grammar (wire mirror; `local` can never match). */
const SOURCE_ID_PATTERN = /^(?:dsh|gateway|ssh)-[A-Za-z0-9_-]{1,64}$/u
/** Main-minted forward id grammar (wire mirror). */
const FORWARD_ID_PATTERN = /^fwd-[0-9a-f]{16,64}$/u
/** Bounded remote loopback target port (wire FORWARD_LIMITS mirror). */
const MIN_TARGET_PORT = 1
const MAX_TARGET_PORT = 65535
/** Detail for the not-assembled refusal: a constant, never payload text. */
const NOT_ASSEMBLED_DETAIL = 'forward ipc service is not assembled'

/**
 * One typed refusal. `detail` is null on every registrar-composed failure: the
 * launcher owns the i18n and a main-composed detail must never echo untrusted
 * payload content (path/id/port/sourceId stay out of the log ring by design).
 */
function failure(code: ForwardErrorCode): ForwardFailure {
  return { ok: false, error: { code, detail: null } }
}

function notAssembled(): ForwardFailure {
  return { ok: false, error: { code: 'forward_failed', detail: NOT_ASSEMBLED_DETAIL } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTargetPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_TARGET_PORT && value <= MAX_TARGET_PORT
}

function isScheme(value: unknown): value is ForwardScheme {
  return value === 'http' || value === 'https'
}

/** A source proven for one call: the canonical id, its fingerprint and the
 *  main-process incarnation token captured before any await. */
interface ProvenSource {
  readonly sourceId: string
  readonly fingerprint: string
  readonly token: NotificationSourceToken
}

type ProofResult = { readonly ok: true; readonly source: ProvenSource } | ForwardFailure

/**
 * The main-process source proof (design 28 §7 four-step verification, the same
 * shape as `shell-ipc-open-in.ts`):
 *   1. source-id grammar (rejects 'local' and any non-<kind>-<id> spelling);
 *   2. fingerprint validity for this source;
 *   3. registry lookup + kind/transport gate ('dsh'/'gateway' over 'ssh' — an
 *      http source never gets a browser);
 *   4. fingerprint match against the live incarnation, then capture the token.
 * The caller re-proves the token after the await (see `stillOwns`).
 */
function proveSource(ctx: ShellIpcCtx, sourceId: unknown, fingerprint: unknown): ProofResult {
  if (typeof sourceId !== 'string' || !SOURCE_ID_PATTERN.test(sourceId)) return failure('source_unknown')
  if (typeof fingerprint !== 'string' || !isValidNotificationSourceFingerprint(sourceId, fingerprint)) {
    return failure('source_unknown')
  }
  const instance = ctx.deps.ctx.transportManager
    .listInstances()
    .find(candidate => `${candidate.kind}-${candidate.id}` === sourceId)
  if (instance === undefined) return failure('source_unknown')
  if (instance.kind !== 'dsh' && instance.kind !== 'gateway') return failure('source_not_dsh')
  if (instance.transport !== 'ssh') return failure('transport_not_ssh')
  if (!ctx.matchesNotificationSource(sourceId, fingerprint)) return failure('source_unknown')
  const token = ctx.captureVscodeSource(instance.id)
  if (token === null) return failure('source_unknown')
  return { ok: true, source: { sourceId, fingerprint, token } }
}

/** Post-await re-proof: same incarnation AND same live fingerprint. */
function stillOwns(ctx: ShellIpcCtx, source: ProvenSource): boolean {
  return ctx.ownsNotificationSource(source.token)
    && ctx.matchesNotificationSource(source.sourceId, source.fingerprint)
}

/** `request`: idempotent manager call, record ownership re-checked. */
async function requestForward(
  ctx: ShellIpcCtx,
  service: ForwardIpcService | null,
  payload: unknown,
): Promise<ForwardRequestResult> {
  if (service === null) return notAssembled()
  const input = isRecord(payload) ? payload : {}
  const proof = proveSource(ctx, input.sourceId, input.sourceFingerprint)
  if (!proof.ok) return proof
  if (!isTargetPort(input.port)) return failure('target_port_invalid')
  const scheme = input.scheme === undefined ? 'http' : input.scheme
  if (!isScheme(scheme)) return failure('scheme_invalid')
  const result = await service.request({
    sourceId: proof.source.sourceId,
    sourceFingerprint: proof.source.fingerprint,
    port: input.port,
    scheme,
  })
  if (!stillOwns(ctx, proof.source)) return failure('source_changed')
  // Defense in depth: a record minted for another source never crosses the IPC
  // boundary (the manager already refuses it; this keeps a future adapter honest).
  if (result.ok && result.record.sourceId !== proof.source.sourceId) return failure('forward_not_owned')
  return result
}

/** `release`: closing one record the caller owns (manager proves ownership). */
async function releaseForward(
  ctx: ShellIpcCtx,
  service: ForwardIpcService | null,
  payload: unknown,
): Promise<ForwardReleaseResult> {
  if (service === null) return notAssembled()
  const input = isRecord(payload) ? payload : {}
  const proof = proveSource(ctx, input.sourceId, input.sourceFingerprint)
  if (!proof.ok) return proof
  if (typeof input.id !== 'string' || !FORWARD_ID_PATTERN.test(input.id)) return failure('forward_not_found')
  const result = await service.release({
    sourceId: proof.source.sourceId,
    sourceFingerprint: proof.source.fingerprint,
    id: input.id,
  })
  if (!stillOwns(ctx, proof.source)) return failure('source_changed')
  return result
}

/** `list`: the poll face; every returned record must belong to this source. */
async function listForwards(
  ctx: ShellIpcCtx,
  service: ForwardIpcService | null,
  payload: unknown,
): Promise<ForwardListResult> {
  if (service === null) return notAssembled()
  const input = isRecord(payload) ? payload : {}
  const proof = proveSource(ctx, input.sourceId, input.sourceFingerprint)
  if (!proof.ok) return proof
  const result = await service.list({
    sourceId: proof.source.sourceId,
    sourceFingerprint: proof.source.fingerprint,
  })
  if (!stillOwns(ctx, proof.source)) return failure('source_changed')
  if (result.ok && result.records.some(record => record.sourceId !== proof.source.sourceId)) {
    return failure('forward_not_owned')
  }
  return result
}

/**
 * `openInBrowser`: main composes the URL. The renderer supplies only
 * `{ sourceId, sourceFingerprint, id, path? }`; the path is normalized here so
 * the manager receives a same-origin relative path (or `/`), never a URL.
 */
async function openForward(
  ctx: ShellIpcCtx,
  service: ForwardIpcService | null,
  payload: unknown,
): Promise<ForwardOpenResult> {
  if (service === null) return notAssembled()
  const input = isRecord(payload) ? payload : {}
  const proof = proveSource(ctx, input.sourceId, input.sourceFingerprint)
  if (!proof.ok) return proof
  if (typeof input.id !== 'string' || !FORWARD_ID_PATTERN.test(input.id)) return failure('forward_not_found')
  const normalized = normalizeForwardPath(input.path)
  if (!normalized.ok) return failure('invalid_path')
  const result = await service.openInBrowser({
    sourceId: proof.source.sourceId,
    sourceFingerprint: proof.source.fingerprint,
    id: input.id,
    path: normalized.path,
  })
  if (!stillOwns(ctx, proof.source)) return failure('source_changed')
  return result
}

/**
 * Register the four forward invoke channels on the shared registrar
 * (`deps.ipc.handle` → the trusted-IPC fence wraps every handler at the
 * assembly injection point, so the main-frame/shell-document checks stay there).
 *
 * `service` is the assembled ForwardManager (S1 wiring) or null while the
 * adapters are still TODO — null keeps the channels present and answers a typed
 * refusal instead of disappearing from the bridge surface.
 */
export function registerForwardHandlers(ctx: ShellIpcCtx, service: ForwardIpcService | null = null): void {
  ctx.deps.ipc.handle(IPC_CHANNELS.FORWARD_REQUEST, (payload: unknown) => requestForward(ctx, service, payload))
  ctx.deps.ipc.handle(IPC_CHANNELS.FORWARD_RELEASE, (payload: unknown) => releaseForward(ctx, service, payload))
  ctx.deps.ipc.handle(IPC_CHANNELS.FORWARD_LIST, (payload: unknown) => listForwards(ctx, service, payload))
  ctx.deps.ipc.handle(IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER, (payload: unknown) => openForward(ctx, service, payload))
}
