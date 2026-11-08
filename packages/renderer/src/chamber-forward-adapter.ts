/**
 * chamberForward adapter — the page-level bridge between the trusted preload
 * forward namespace and the remote-browser launcher (design 28, W0/S1 slice).
 *
 * WHY IT EXISTS. The launcher (`@dsh-chamber/dsh-chamber-client-ui-browser`,
 * a deferred composite chunk) probes `ctx.chamberForward`, then a page-global
 * fallback that deliberately does not exist, and renders one row per record.
 * The trusted carrier is `window.dshChamber.forward` (packages/desktop/electron/preload.cts
 * in Electron, the Swift shim on macOS), whose vocabulary is the wire contract
 * `@dsh-chamber/dsh-chamber-wire/forward`: `record` / `records`, seven states,
 * a closed table of snake_case error codes, and
 * `{ ok: false, error: { code, detail } }`. The launcher speaks a smaller UI
 * vocabulary: three states, eleven kebab-case codes, `{ ok: false, code }`.
 * v2 also adds the renderer-minted `consumer` (attach/detach lifetime),
 * main-composed `frameUrl`, the `embedding` capability, the
 * `record.frameError` iframe-failure projection and the local-only
 * `list.frameErrors` origin projection (a direct local iframe has no record,
 * design 28 §16.7 / W-15).
 *
 * This module is the ONE translation between those two vocabularies: preload
 * and main stay wire-shaped (design 28 §7: no main-side rewrite, or Electron
 * and Swift would each need their own copy), and the launcher stays UI-shaped.
 * The service is provided on the per-entry cordis ctx exactly like the shell's
 * boot facts — no page global is added (`globalThis.chamberForward` stays
 * forbidden: the single page-level namespace is `window.dshChamber`).
 *
 * WHAT IS PURE. Everything here is a pure function of its arguments; the one
 * page read (`readPageForwardHost`) takes its scope as an argument and
 * defaults to `globalThis`. No DOM, no timers, no Node APIs, and NO RUNTIME
 * IMPORT: the wire faces are type-only (erased under Node type stripping), which
 * is what lets the translation tables be unit-tested without a workspace install.
 * The wire tables are keyed BY the wire unions, so a new wire state or error
 * code fails the real type check here; the suite re-reads the wire source and
 * the launcher source to pin the same sets at review time
 * (test/lifecycle/chamber-forward-adapter.test.ts).
 *
 * RECORD SEMANTICS. `bound` means the local listener accepted a probe, not
 * that the remote service is reachable; `stale` passes through unchanged, so a
 * reconnecting record renders as stale with a "reopen" action. `closing` /
 * `closed` are transient (the manager removes closed records) and fold into the
 * launcher's non-actionable `binding` bucket: the three-state UI cannot express
 * a shutdown state, and calling it `error` would claim a failure that did not
 * happen. Error `detail` is main-composed diagnostics and never reaches the
 * row: only the mapped launcher code does (the panel renders it as a token).
 */
import type {
  ForwardErrorCode as WireForwardErrorCode,
  ForwardRecord as WireForwardRecord,
  ForwardState as WireForwardState,
} from '@dsh-chamber/dsh-chamber-wire/forward'

/** Service name the deferred browser launcher probes on its ctx. */
const CHAMBER_FORWARD_SERVICE = 'chamberForward'

/** Page-level namespace the trusted preload / Swift shim owns (design 28 §9). */
const PAGE_BRIDGE_KEY = 'dshChamber'
const PAGE_FORWARD_KEY = 'forward'

/** The launcher's state bucket (`ForwardState` in the browser package). */
export type LauncherForwardState = 'bound' | 'binding' | 'error'

/** The launcher's failure vocabulary (`ForwardFailureCode`; eleven codes, kebab-case). */
export type LauncherForwardFailureCode =
  | 'forbidden-source'
  | 'invalid-port'
  | 'limit'
  | 'stale'
  | 'not-found'
  | 'spawn-failed'
  | 'bind-failed'
  | 'confirm-declined'
  | 'release-timeout'
  | 'unavailable'
  | 'unknown'

/** The launcher's frame-failure vocabulary (same closed tokens as the wire table). */
export type LauncherForwardFrameError =
  | 'blocked_by_response'
  | 'certificate_error'
  | 'load_failed'
  | 'timeout'

/** v2 embedding capability (list-only, default enabled, emergency rollback only). */
export interface LauncherForwardEmbedding {
  enabled: boolean
  reason?: string
}

/**
 * v2 local-frame failure projection (list-only, additive): an origin-scoped
 * classification for a browser child frame that main observed failing without a
 * forward record (the direct local loopback leg). The launcher maps it onto the
 * CURRENT iframe origin so an engine error page can never settle as live.
 */
export interface LauncherForwardFrameErrorEntry {
  /** Canonical http(s) loopback/alias origin (scheme://host:port). */
  origin: string
  code: LauncherForwardFrameError
}

/** One row as the launcher renders it (display facts only; never a URL to open). */
export interface LauncherForwardRecord {
  id: string
  /** Remote loopback port; the launcher's field name for wire `targetPort`. */
  remotePort: number
  localPort: number
  scheme: 'http' | 'https'
  /** 127.0.0.2-254 display host (main builds the browser URL from the record id). */
  aliasHost: string
  state: LauncherForwardState
  stale: boolean
  /** Mapped launcher code; present iff `state === 'error'`. */
  error?: string
  /** main's best-effort iframe failure projection; absent = unknown. */
  frameError?: LauncherForwardFrameError
}

export type LauncherForwardFailure = { ok: false; code: LauncherForwardFailureCode }
export type LauncherForwardListResult =
  | {
    ok: true
    records: LauncherForwardRecord[]
    embedding?: LauncherForwardEmbedding
    /** v2 local-frame failures (origin-scoped; local list only). */
    frameErrors?: LauncherForwardFrameErrorEntry[]
  }
  | LauncherForwardFailure
export type LauncherForwardRequestResult =
  | { ok: true; record: LauncherForwardRecord; frameUrl?: string }
  | LauncherForwardFailure
export type LauncherForwardAck = { ok: true } | LauncherForwardFailure

/** The four launcher calls; one input object each (same shape as the wire args). */
export interface ChamberForwardBridge {
  request(input: {
    sourceId: string
    sourceFingerprint: string
    port: number
    scheme?: 'http' | 'https'
    /** v2 tab-occurrence claim (attach/renew). */
    consumer?: string
    /** Same-origin relative path main appends to the composed frameUrl. */
    path?: string
  }): Promise<LauncherForwardRequestResult>
  release(input: {
    sourceId: string
    sourceFingerprint: string
    id: string
    /** v2: present = detach this claim; absent = force-close. */
    consumer?: string
  }): Promise<LauncherForwardAck>
  list(input: {
    sourceId: string
    sourceFingerprint: string
  }): Promise<LauncherForwardListResult>
  openInBrowser(input: {
    sourceId: string
    sourceFingerprint: string
    id: string
    path?: string
  }): Promise<LauncherForwardAck>
}

/**
 * The wire fields this projection reads. The `Pick` keeps the field names
 * wire-owned: a rename in `@dsh-chamber/dsh-chamber-wire/forward` breaks the
 * real type check here instead of silently dropping every row. `error` is
 * widened to the already-mapped launcher code (the raw `{code, detail}` is a
 * wire envelope, and `detail` never reaches the row).
 */
type WireRecordFacts =
  & Omit<Pick<
    WireForwardRecord,
    'id' | 'targetPort' | 'localPort' | 'scheme' | 'aliasHost' | 'state' | 'stale' | 'error'
  >, 'error'>
  & {
    error: LauncherForwardFailureCode | null
    frameError: LauncherForwardFrameError | null
  }

/**
 * Wire state → launcher bucket, EXHAUSTIVE over the wire union (a new wire state
 * is a type error here, and the suite reads the wire source to pin the same set).
 */
const WIRE_STATE_TO_LAUNCHER: Readonly<Record<WireForwardState, LauncherForwardState>> = {
  requested: 'binding',
  starting: 'binding',
  bound: 'bound',
  reconnecting: 'binding',
  closing: 'binding',
  closed: 'binding',
  error: 'error',
}

/**
 * Wire error code → launcher code, EXHAUSTIVE over the wire union. The fold is
 * deliberate (the UI has eleven codes): caps and budgets share `limit`, ownership
 * and transport gates share `forbidden-source`, start/authentication failures
 * share `spawn-failed`, alias/namespace/browser-open failures share
 * `unavailable`, and client-side path/scheme violations fall back to `unknown`.
 * v2 passes `release_timeout` through as its own code: the row must be able to
 * say "still reaping, retry" instead of claiming an unknown failure.
 */
const WIRE_CODE_TO_LAUNCHER: Readonly<Record<WireForwardErrorCode, LauncherForwardFailureCode>> = {
  source_unknown: 'not-found',
  source_not_dsh: 'forbidden-source',
  transport_not_ssh: 'forbidden-source',
  source_changed: 'stale',
  browser_disabled: 'confirm-declined',
  confirmation_declined: 'confirm-declined',
  confirmation_late: 'stale',
  target_port_invalid: 'invalid-port',
  target_port_reserved: 'invalid-port',
  scheme_invalid: 'unknown',
  too_many_for_source: 'limit',
  too_many_global: 'limit',
  namespace_unavailable: 'unavailable',
  alias_exhausted: 'unavailable',
  port_exhausted: 'bind-failed',
  local_bind_failed: 'bind-failed',
  auth_failed: 'spawn-failed',
  forward_failed: 'spawn-failed',
  forward_not_found: 'not-found',
  forward_not_owned: 'forbidden-source',
  forward_not_bound: 'stale',
  forward_stale: 'stale',
  invalid_path: 'unknown',
  rate_limited: 'limit',
  open_failed: 'unavailable',
  release_timeout: 'release-timeout',
}

/** The alias range 127.0.0.2-254 (never .1/.0/.255); display host only. */
const ALIAS_HOST = /^127\.0\.0\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/u

/** The wire frame-failure table, re-declared locally (no runtime wire import). */
const LAUNCHER_FRAME_ERRORS: ReadonlySet<string> = new Set<LauncherForwardFrameError>([
  'blocked_by_response',
  'certificate_error',
  'load_failed',
  'timeout',
])

/** Narrow an untrusted projection to the launcher's frame-failure vocabulary. */
function isLauncherFrameError(value: unknown): value is LauncherForwardFrameError {
  return typeof value === 'string' && LAUNCHER_FRAME_ERRORS.has(value)
}

/**
 * Main-composed iframe URL guard (the adapter has no runtime wire import; the
 * same bounds are mirrored from the wire's isForwardFrameUrl). A malformed URL
 * is dropped, never trusted into a row.
 */
function isLauncherFrameUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 9 || value.length > 4096) return false
  if (!/^https?:\/\//u.test(value) || /[\u0000-\u0020\u007f\\#]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/**
 * Frame-origin guard (no runtime wire import): canonical http(s) origin of a
 * loopback browser frame — 127.0.0.1 / localhost or a 127.0.0.2..254 alias. The
 * value must be the CANONICAL origin spelling (URL.origin), never a URL with a
 * path, credentials or a non-canonical port.
 */
function isLauncherFrameOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return false
  if (url.origin !== value) return false
  if (url.hostname === 'localhost') return true
  if (url.hostname === '127.0.0.1') return true
  return ALIAS_HOST.test(url.hostname)
}

/** Project the optional additive frameErrors array; malformed entries are dropped. */
function readFrameErrors(value: unknown): LauncherForwardFrameErrorEntry[] {
  if (!Array.isArray(value)) return []
  const out: LauncherForwardFrameErrorEntry[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    let origin: unknown
    let code: unknown
    try {
      ;({ origin, code } = entry as Record<string, unknown>)
    } catch {
      continue
    }
    if (!isLauncherFrameOrigin(origin) || !isLauncherFrameError(code) || seen.has(origin)) continue
    seen.add(origin)
    out.push({ origin, code })
  }
  return out
}

/** Read the optional embedding capability; absent/malformed = absent (= enabled). */
function readEmbedding(value: unknown): LauncherForwardEmbedding | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  let enabled: unknown
  let reason: unknown
  try {
    ;({ enabled, reason } = value as Record<string, unknown>)
  } catch {
    return undefined
  }
  if (typeof enabled !== 'boolean') return undefined
  if (reason !== undefined && (typeof reason !== 'string' || reason === '' || reason.length > 128)) {
    return undefined
  }
  return reason === undefined ? { enabled } : { enabled, reason }
}

/** The four wire calls this adapter forwards, in wire order. */
const FORWARD_METHODS = ['request', 'release', 'list', 'openInBrowser'] as const

type WireForwardHost = {
  [method in (typeof FORWARD_METHODS)[number]]: (input: unknown) => Promise<unknown>
}

/** A page-owned forward namespace was found and satisfies the four-call shape. */
function asWireForwardHost(value: unknown): WireForwardHost | null {
  if (typeof value !== 'object' || value === null) return null
  for (const method of FORWARD_METHODS) {
    let member: unknown
    try {
      member = (value as Record<string, unknown>)[method]
    } catch {
      return null
    }
    if (typeof member !== 'function') return null
  }
  return value as WireForwardHost
}

/**
 * Read `<scope>.dshChamber.forward` without assuming the scope is a window and
 * without ever throwing on a hostile getter.
 */
function readPageForwardHost(scope: unknown): unknown {
  if (typeof scope !== 'object' || scope === null) return undefined
  let chamber: unknown
  try {
    chamber = (scope as Record<string, unknown>)[PAGE_BRIDGE_KEY]
  } catch {
    return undefined
  }
  if (typeof chamber !== 'object' || chamber === null) return undefined
  try {
    return (chamber as Record<string, unknown>)[PAGE_FORWARD_KEY]
  } catch {
    return undefined
  }
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum
}

type WireErrorRead =
  | { ok: true; code: LauncherForwardFailureCode | null }
  | { ok: false }

/**
 * Read one wire error object. `null` means "no error" (valid only outside
 * `state === 'error'`); an unknown code keeps the record and folds to the
 * launcher's `unknown` (the same forward-compatible fold the launcher's own
 * envelope guard applies), so a newer main is never rendered as "no row".
 */
function readWireError(value: unknown): WireErrorRead {
  if (value === null) return { ok: true, code: null }
  if (typeof value !== 'object' || value === null) return { ok: false }
  let code: unknown
  let detail: unknown
  try {
    ;({ code, detail } = value as Record<string, unknown>)
  } catch {
    return { ok: false }
  }
  if (typeof code !== 'string' || code === '') return { ok: false }
  if (detail !== null && detail !== undefined && typeof detail !== 'string') return { ok: false }
  return { ok: true, code: launcherCode(code) }
}

/** Map one wire error code (an unknown/absent code is the launcher's `unknown`). */
function launcherCode(code: unknown): LauncherForwardFailureCode {
  return typeof code === 'string' && Object.hasOwn(WIRE_CODE_TO_LAUNCHER, code)
    ? WIRE_CODE_TO_LAUNCHER[code as WireForwardErrorCode]
    : 'unknown'
}

/**
 * Validate one untrusted wire record and narrow it to the fields this adapter
 * reads. Extra wire fields (sourceId / namespace / targetHost / watermarks) are
 * ignored: they belong to main and the manager, never to the row.
 */
function readWireRecord(value: unknown): WireRecordFacts | null {
  if (typeof value !== 'object' || value === null) return null
  let id: unknown
  let targetPort: unknown
  let localPort: unknown
  let scheme: unknown
  let aliasHost: unknown
  let state: unknown
  let stale: unknown
  let error: unknown
  let frameError: unknown
  try {
    ;({ id, targetPort, localPort, scheme, aliasHost, state, stale, error, frameError }
      = value as Record<string, unknown>)
  } catch {
    // Hostile getters are one malformed record, not a list-wide failure.
    return null
  }
  if (typeof id !== 'string' || id === '' || id.length > 128) return null
  if (!isBoundedInteger(targetPort, 1, 65535)) return null
  if (!isBoundedInteger(localPort, 1024, 65535)) return null
  if (scheme !== 'http' && scheme !== 'https') return null
  if (typeof aliasHost !== 'string' || !ALIAS_HOST.test(aliasHost)) return null
  if (typeof state !== 'string' || !Object.hasOwn(WIRE_STATE_TO_LAUNCHER, state)) return null
  if (typeof stale !== 'boolean') return null
  const wireState = state as WireForwardState
  const wireError = readWireError(error)
  if (!wireError.ok) return null
  // Wire invariant (`isForwardRecord`): an error is present iff state is 'error'.
  if ((wireError.code === null) !== (wireState !== 'error')) return null
  // frameError is optional/null (absent = unknown); an unknown future token is
  // dropped (the row still renders) instead of failing the whole record.
  const projectedFrameError = isLauncherFrameError(frameError) ? frameError : null
  return {
    id,
    targetPort,
    localPort,
    scheme,
    aliasHost,
    state: wireState,
    stale,
    error: wireError.code,
    frameError: projectedFrameError,
  }
}

/** Translate one validated wire record into the launcher's row shape. */
function translateRecord(facts: WireRecordFacts): LauncherForwardRecord {
  return {
    id: facts.id,
    remotePort: facts.targetPort,
    localPort: facts.localPort,
    scheme: facts.scheme,
    aliasHost: facts.aliasHost,
    state: WIRE_STATE_TO_LAUNCHER[facts.state],
    stale: facts.stale,
    ...(facts.error === null ? {} : { error: facts.error }),
    ...(facts.frameError === null ? {} : { frameError: facts.frameError }),
  }
}

/** Project an untrusted record, or null when any invariant is broken. */
function projectRecord(value: unknown): LauncherForwardRecord | null {
  const facts = readWireRecord(value)
  return facts === null ? null : translateRecord(facts)
}

/** Project an untrusted record list, dropping malformed entries and duplicate ids. */
function projectRecords(value: readonly unknown[]): LauncherForwardRecord[] {
  const out: LauncherForwardRecord[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const record = projectRecord(entry)
    if (record === null || seen.has(record.id)) continue
    seen.add(record.id)
    out.push(record)
  }
  return out
}

/** Read the ok/not-ok envelope discriminator without trusting the value. */
function readEnvelope(value: unknown): { ok: boolean; value: Record<string, unknown> } | null {
  if (typeof value !== 'object' || value === null) return null
  let ok: unknown
  try {
    ok = (value as Record<string, unknown>).ok
  } catch {
    return null
  }
  if (typeof ok !== 'boolean') return null
  return { ok, value: value as Record<string, unknown> }
}

/** Translate a wire failure envelope (`{ ok:false, error:{code,detail} }`). */
function projectFailure(value: Record<string, unknown>): LauncherForwardFailure {
  let error: unknown
  try {
    error = value.error
  } catch {
    return { ok: false, code: 'unknown' }
  }
  const wireError = readWireError(error)
  return { ok: false, code: wireError.ok && wireError.code !== null ? wireError.code : 'unknown' }
}

function projectListResult(value: unknown): LauncherForwardListResult {
  const envelope = readEnvelope(value)
  if (envelope === null) return { ok: false, code: 'unknown' }
  if (!envelope.ok) return projectFailure(envelope.value)
  const records = envelope.value.records
  if (!Array.isArray(records)) return { ok: false, code: 'unknown' }
  const embedding = readEmbedding(envelope.value.embedding)
  const frameErrors = readFrameErrors(envelope.value.frameErrors)
  return {
    ok: true,
    records: projectRecords(records),
    ...(embedding === undefined ? {} : { embedding }),
    ...(frameErrors.length === 0 ? {} : { frameErrors }),
  }
}

function projectRequestResult(value: unknown): LauncherForwardRequestResult {
  const envelope = readEnvelope(value)
  if (envelope === null) return { ok: false, code: 'unknown' }
  if (!envelope.ok) return projectFailure(envelope.value)
  const record = projectRecord(envelope.value.record)
  if (record === null) return { ok: false, code: 'unknown' }
  return isLauncherFrameUrl(envelope.value.frameUrl)
    ? { ok: true, record, frameUrl: envelope.value.frameUrl }
    : { ok: true, record }
}

function projectAck(value: unknown): LauncherForwardAck {
  const envelope = readEnvelope(value)
  if (envelope === null) return { ok: false, code: 'unknown' }
  if (!envelope.ok) return projectFailure(envelope.value)
  return { ok: true }
}

/**
 * Build the launcher-facing bridge over the page's wire namespace.
 *
 * Every call projects the RESULT (the fixture of trust is the preload/shim
 * boundary); inputs are passed as explicit key sets, never spread, so the
 * payload shape stays reviewable at this seam. A rejected invoke (bridge torn
 * down, main refusing the channel) is an infrastructure failure and surfaces as
 * the launcher's own `unavailable`, never as an invented forward error code.
 */
function createBridge(host: WireForwardHost): ChamberForwardBridge {
  return {
    async request(input) {
      try {
        return projectRequestResult(await host.request({
          sourceId: input.sourceId,
          sourceFingerprint: input.sourceFingerprint,
          port: input.port,
          scheme: input.scheme,
          consumer: input.consumer,
          path: input.path,
        }))
      } catch {
        return { ok: false, code: 'unavailable' }
      }
    },
    async release(input) {
      try {
        return projectAck(await host.release({
          sourceId: input.sourceId,
          sourceFingerprint: input.sourceFingerprint,
          id: input.id,
          consumer: input.consumer,
        }))
      } catch {
        return { ok: false, code: 'unavailable' }
      }
    },
    async list(input) {
      try {
        return projectListResult(await host.list({
          sourceId: input.sourceId,
          sourceFingerprint: input.sourceFingerprint,
        }))
      } catch {
        return { ok: false, code: 'unavailable' }
      }
    },
    async openInBrowser(input) {
      try {
        return projectAck(await host.openInBrowser({
          sourceId: input.sourceId,
          sourceFingerprint: input.sourceFingerprint,
          id: input.id,
          path: input.path,
        }))
      } catch {
        return { ok: false, code: 'unavailable' }
      }
    },
  }
}

/**
 * Install the adapter on the per-entry cordis ctx as the `chamberForward`
 * service, exactly like the shell's boot facts (never a page global).
 *
 * The composite entry calls this BEFORE the deferred chunks mount, so the
 * browser launcher's `ctx.chamberForward` probe resolves by the time its apply
 * runs. A page without the trusted forward namespace (gateway / plain browser
 * deployment, or an older preload) gets NO service: the launcher then renders
 * its honest "no bridge" state instead of a fake empty list.
 *
 * @param ctx - the per-entry context (structural: only `provide` is used).
 * @param page - the page scope to read; defaults to `globalThis` (tests pass a
 *   literal scope).
 * @returns true when the service was provided.
 */
export function installChamberForward(
  ctx: { provide(name: string, value: unknown): void },
  page: unknown = globalThis,
): boolean {
  const host = asWireForwardHost(readPageForwardHost(page))
  if (host === null) return false
  ctx.provide(CHAMBER_FORWARD_SERVICE, createBridge(host))
  return true
}
