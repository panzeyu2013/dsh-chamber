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
 * v2 also adds the renderer-minted `consumer` (attach/detach lifetime) and the
 * forward recordRef routing used by the native guest carrier (design 28 v3
 * §2.10). The iframe-era paper list fields are retired with the iframe carrier
 * and the wire (design 28 v3 §3). The
 * per-record `frameError` stays as a diagnostic classification only: the native
 * guest reports its own load failures through `browser.state`, so no UI reads it.
 *
 * This module is the ONE translation between those two vocabularies: preload
 * and main stay wire-shaped (design 28 §7: no main-side rewrite, or Electron
 * and Swift would each need their own copy), and the launcher stays UI-shaped.
 * The service is provided on the per-entry cordis ctx exactly like the shell's
 * boot facts — no page global is added (`globalThis.chamberForward` stays
 * forbidden: the single page-level namespace is `window.dshChamber`).
 *
 * WHAT IS PURE. Everything here is a pure function of its arguments; the two
 * page reads (`readPageForwardHost` / `readPageBrowserSurface`) take their scope
 * as an argument and default to `globalThis`. No DOM of its own (the guest-key
 * replay seam takes `document` from that page scope), no timers, no Node APIs.
 * The ONLY runtime import is the dependency-free wire frame-error TABLE
 * (`FORWARD_FRAME_ERRORS`, the single source for the launcher's frame-failure
 * tokens); every other wire face is type-only and erased under Node type
 * stripping, and nothing imports the launcher (a deferred chunk) or the desktop
 * host. The wire tables are keyed BY the wire unions, so a new wire state or
 * error code fails the real type check here; the suite re-reads the wire source
 * and the launcher source to pin the same sets at review time
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
import {
  FORWARD_FRAME_ERRORS,
  type ForwardErrorCode as WireForwardErrorCode,
  type ForwardFrameError,
  type ForwardRecord as WireForwardRecord,
  type ForwardState as WireForwardState,
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

/**
 * The launcher's frame-failure vocabulary — SINGLE SOURCE = wire
 * `FORWARD_FRAME_ERRORS` (no hand-copied token list; a wire addition flows here).
 */
export type LauncherForwardFrameError = ForwardFrameError

/** Narrow an untrusted value to a frame-failure classification. */
function isLauncherFrameError(value: unknown): value is LauncherForwardFrameError {
  return typeof value === 'string' && (FORWARD_FRAME_ERRORS as readonly string[]).includes(value)
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
  /**
   * Main's diagnostic frame-failure classification (wire keeps the per-record
   * field in v3). No launcher UI consumes it: the native guest reports its own
   * load failures through `browser.state` (design 28 v3 §4.3).
   */
  frameError?: LauncherForwardFrameError
}

export type LauncherForwardFailure = { ok: false; code: LauncherForwardFailureCode }
export type LauncherForwardListResult =
  | {
    ok: true
    records: LauncherForwardRecord[]
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

/**
 * Main-composed alias `frameUrl` guard (the v3 guest loads this alias URL in
 * place of the logical address; the iframe carrier is retired). The bounds mirror
 * the wire's `isForwardFrameUrl` — that guard is not imported at runtime (only
 * `FORWARD_FRAME_ERRORS` is). A malformed URL is dropped, never trusted into a row.
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

/** The alias range 127.0.0.2-254 (never .1/.0/.255); display host only. */
const ALIAS_HOST = /^127\.0\.0\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/u

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
  // frameError is an optional/null diagnostic (absent = unknown); an unknown
  // future token is dropped (the row still renders), never a dropped row.
  const projectedFrameError = isLauncherFrameError(frameError) ? frameError : null
  // Wire invariant (`isForwardRecord`): an error is present iff state is 'error'.
  if ((wireError.code === null) !== (wireState !== 'error')) return null
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
  return {
    ok: true,
    records: projectRecords(records),
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

/** Service name the deferred browser launcher probes on its ctx (design 28 v3 §3). */
const CHAMBER_BROWSER_SERVICE = 'chamberBrowser'

/** The browser guest surface the page (Swift shim) may own. */
type PageBrowserSurface = {
  acquire(input: unknown): Promise<unknown>
  release(input: unknown): Promise<unknown>
  navigate(input: unknown): Promise<unknown>
  command(input: unknown): Promise<unknown>
  frame(input: unknown): Promise<unknown>
  keymap?(input: unknown): Promise<unknown>
  events: {
    state(listener: (value: unknown) => void): () => void
    openRequested(listener: (value: unknown) => void): () => void
    input(listener: (value: unknown) => void): () => void
    forwardNeeded(listener: (value: unknown) => void): () => void
  }
}

/**
 * The six invokes the page carrier MUST expose (design 28 v3 §3): SINGLE
 * SOURCE = the launcher's BrowserBridge.ts (`REQUIRED_BROWSER_INVOKES` plus the
 * documented optional sixth `keymap`; the v3 Swift shim always exposes it, and
 * treating it as required keeps a half-built carrier fail-closed here). Kept as
 * a local literal on purpose: the adapter must not runtime-import the launcher
 * half (it is a deferred chunk; importing it here would pull it into the eager
 * composite). Its only runtime import is the dependency-free wire frame-error
 * table. The list is locked name-for-name to the launcher's documented six-name
 * face by chamber-forward-adapter.test.ts ⑧.
 */
const BROWSER_INVOKES = ['acquire', 'release', 'navigate', 'command', 'frame', 'keymap'] as const // = REQUIRED_BROWSER_INVOKES + optional 'keymap'
const BROWSER_EVENTS = ['state', 'openRequested', 'input', 'forwardNeeded'] as const

/** Structural probe for `<page>.dshChamber.browser` (Swift-only carrier). */
function readPageBrowserSurface(page: unknown): PageBrowserSurface | null {
  const chamber = readPageNamespace(page, 'dshChamber')
  if (typeof chamber !== 'object' || chamber === null) return null
  let browser: unknown
  try { browser = (chamber as Record<string, unknown>).browser } catch { return null }
  if (typeof browser !== 'object' || browser === null) return null
  for (const method of BROWSER_INVOKES) {
    let member: unknown
    try { member = (browser as Record<string, unknown>)[method] } catch { return null }
    if (typeof member !== 'function') return null
  }
  let events: unknown
  try { events = (browser as Record<string, unknown>).events } catch { return null }
  if (typeof events !== 'object' || events === null) return null
  for (const name of BROWSER_EVENTS) {
    let member: unknown
    try { member = (events as Record<string, unknown>)[name] } catch { return null }
    if (typeof member !== 'function') return null
  }
  return browser as PageBrowserSurface
}

function readPageNamespace(scope: unknown, key: string): unknown {
  if (typeof scope !== 'object' || scope === null) return undefined
  try { return (scope as Record<string, unknown>)[key] } catch { return undefined }
}

/** Project one invoke answer; a rejected invoke is an infrastructure failure. */
async function projectBrowserAck(run: () => Promise<unknown>): Promise<{ ok: boolean; code?: string; lease?: string }> {
  try {
    const value = await run()
    if (typeof value !== 'object' || value === null) return { ok: false, code: 'unknown' }
    const record = value as Record<string, unknown>
    if (record.ok !== true) {
      return { ok: false, code: typeof record.code === 'string' && record.code !== '' ? record.code : 'unknown' }
    }
    return typeof record.lease === 'string' ? { ok: true, lease: record.lease } : { ok: true }
  } catch {
    return { ok: false, code: 'unavailable' }
  }
}

/** Canonical guest input modifier vocabulary (design 28 §3 push input; lowercase DOM names). */
const GUEST_KEY_MODIFIERS = ['meta', 'alt', 'shift', 'control'] as const

/**
 * Normalize one guest key payload's modifier set.
 *
 * Canonical `modifiers: string[]` wins; the legacy boolean shape
 * (`primary` → meta, `alt`/`shift`/`control`) is the fallback only when no array
 * is present (design 28 §3 input contract: the legacy shape exists so a shim
 * rollout order cannot break the replay). Unknown/mixed-case tokens are ignored
 * (the canonical vocabulary is lowercase).
 *
 * @param record - the untrusted input push.
 * @returns the canonical modifier names in wire spelling.
 */
function readGuestKeyModifiers(record: Record<string, unknown>): readonly string[] {
  if (Array.isArray(record.modifiers)) {
    return record.modifiers.filter((item): item is string =>
      typeof item === 'string' && (GUEST_KEY_MODIFIERS as readonly string[]).includes(item))
  }
  const legacy: string[] = []
  if (record.primary === true) legacy.push('meta')
  for (const modifier of ['alt', 'shift', 'control'] as const) {
    if (record[modifier] === true) legacy.push(modifier)
  }
  return legacy
}

/** One normalized new-tab intent (RT-11: `lease` = the opener tab occurrence). */
type GuestOpenRequest = { readonly tabId: string; readonly url: string; readonly lease?: string }

/**
 * Narrow an untrusted open-request push.
 *
 * `lease` identifies the opener tab occurrence (design 28 §3:89); the launcher
 * checks it against the occurrence that received the push (attribution) before
 * opening the new tab. A malformed lease rejects the whole push (fail closed,
 * like `state`); an absent lease is the older-shim compatibility arm.
 *
 * @param value - the untrusted push payload.
 * @returns the normalized intent, or null when a required bound is broken.
 */
function projectGuestOpenRequest(value: unknown): GuestOpenRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const tabId = record.tabId
  const url = record.url
  if (typeof tabId !== 'string' || tabId === '' || tabId.length > 128) return null
  if (typeof url !== 'string' || url.length > 4096) return null
  let lease: string | undefined
  if (record.lease !== undefined) {
    if (typeof record.lease !== 'string' || record.lease === '' || record.lease.length > 128) return null
    lease = record.lease
  }
  return { tabId, url, ...(lease === undefined ? {} : { lease }) }
}

/**
 * Replay a guest-focused primary-modifier key into the shell's shortcut pipeline
 * (design 28 v3 §4.5, D12).
 *
 * The Shortcuts service exposes no programmatic dispatch: `dispatch` lives on its
 * package-private registry and is fed by the window keydown listener, which has NO
 * `isTrusted` gate (vendor `packages/client/shortcuts/src/client/dom.ts:66-99`). So
 * the seam is a synthetic `KeyboardEvent` targeted at the browser tab element,
 * which gives the shortcut context a real Element target.
 *
 * TARGET SELECTION (D12). One tab OCCURRENCE owns one guest lease, so the
 * presentation writes `data-chamber-browser-lease="<lease>"` on the placeholder
 * once the lease settles: a lease-carrying push is replayed to THAT element. When
 * the push carries no usable lease (older shim, or the acquire race before the
 * placeholder advertises it) the replay falls back to `data-chamber-browser-tab`,
 * the carrier's tab key. The payload is untrusted: a malformed lease/tab id is a
 * miss, never a throw (this listener runs inside the shim's push dispatch).
 */
function replayGuestKey(input: unknown, scope: unknown): void {
  if (typeof input !== 'object' || input === null) return
  const record = input as Record<string, unknown>
  const tabId = record.tabId
  const code = record.code
  if (typeof tabId !== 'string' || tabId === '' || typeof code !== 'string' || code === '') return
  const document = (typeof scope === 'object' && scope !== null ? (scope as { document?: Document }).document : undefined)
  if (document === undefined || typeof document.querySelector !== 'function') return
  const element = guestKeyTarget(document, tabId, record.lease)
  if (element === null) return
  const modifiers = readGuestKeyModifiers(record)
  const event = new KeyboardEvent('keydown', {
    code, key: code,
    ctrlKey: modifiers.includes('control'), altKey: modifiers.includes('alt'),
    shiftKey: modifiers.includes('shift'), metaKey: modifiers.includes('meta'),
    // The legacy shape carries repeat as a sibling boolean; the canonical shape
    // does too (design 28 §3:89), so both are passed through as a boolean.
    repeat: record.repeat === true,
    bubbles: true, cancelable: true, composed: true,
  })
  element.dispatchEvent(event)
}

/** Selector-safe lease grammar (the shell mints `[A-Za-z0-9_-]{1,128}` lease ids). */
const GUEST_KEY_LEASE = /^[A-Za-z0-9_-]{1,128}$/u

/** Query one dataset-targeted Element; a hostile token is a miss, never a throw. */
function queryGuestTarget(document: Document, attribute: string, value: string): Element | null {
  try {
    return document.querySelector('[' + attribute + '=' + JSON.stringify(value) + ']')
  } catch {
    return null
  }
}

/**
 * Resolve the Element a guest key replay targets.
 *
 * The lease wins (one occurrence = one placeholder = one shortcut context);
 * without a usable lease the tab key is the fallback so an older shim or a
 * pre-acquire push still reaches the right tab element.
 */
function guestKeyTarget(document: Document, tabId: string, lease: unknown): Element | null {
  if (typeof lease === 'string' && GUEST_KEY_LEASE.test(lease)) {
    const byLease = queryGuestTarget(document, 'data-chamber-browser-lease', lease)
    if (byLease !== null) return byLease
  }
  return queryGuestTarget(document, 'data-chamber-browser-tab', tabId)
}

/**
 * Page scopes whose guest-key replay subscription is already installed.
 *
 * `installChamberBrowser` runs once per N-ctx ENTRY on the SAME page (the
 * composite entry is per instance), while the shim's `browser.input` channel is
 * page-level: subscribing per entry would replay one guest key once per instance
 * (N synthetic keydowns through the one shortcut pipeline). The page scope is the
 * natural identity key — the module is loaded once per page. A WeakSet carries
 * this bookkeeping WITHOUT writing a marker onto the page (no new page global).
 */
const GUEST_KEY_REPLAY_PAGES = new WeakSet<object>()

/**
 * Install the page-level `chamberBrowser` service (design 28 v3 §3).
 *
 * Mirrors `installChamberForward`: the launcher's ctx probe resolves before the
 * deferred chunk mounts, a page without the Swift shim's browser namespace gets NO
 * service (the Browser row then stays absent, fail-closed), and the page-global
 * fallback in the launcher stays for early boots.
 *
 * @param ctx - the per-entry context (structural: only `provide` is used).
 * @param page - the page scope to read; defaults to `globalThis` (tests pass a literal scope).
 * @returns true when the service was provided.
 */
export function installChamberBrowser(
  ctx: { provide(name: string, value: unknown): void; get?(name: string): unknown },
  page: unknown = globalThis,
): boolean {
  const surface = readPageBrowserSurface(page)
  if (surface === null) return false
  // Effective keymap source over the per-entry Shortcuts service (design 28 v3
  // §4.5). Absent service => absent source => the launcher sends no keymap.
  const combos = typeof ctx.get === 'function'
    ? createComboSource({ get: name => ctx.get!(name) })
    : undefined
  ctx.provide(CHAMBER_BROWSER_SERVICE, {
    acquire: (input: unknown) => projectBrowserAck(() => surface.acquire(input)),
    release: (input: unknown) => projectBrowserAck(() => surface.release(input)),
    navigate: (input: unknown) => projectBrowserAck(() => surface.navigate(input)),
    command: (input: unknown) => projectBrowserAck(() => surface.command(input)),
    frame: (input: unknown) => projectBrowserAck(() => surface.frame(input)),
    ...(typeof surface.keymap === 'function'
      ? { keymap: (input: unknown) => projectBrowserAck(() => surface.keymap!(input)) }
      : {}),
    ...(combos === undefined ? {} : { combos }),
    events: {
      state: (listener: (value: unknown) => void) => surface.events.state(listener),
      // RT-11: normalize the push and retain the opener occurrence's lease on the
      // request. The launcher attributes it to the receiving tab occurrence before
      // the new-tab intent; no other behavior reads it (a new tab is a new occurrence).
      openRequested: (listener: (value: unknown) => void) => surface.events.openRequested(value => {
        const request = projectGuestOpenRequest(value)
        if (request !== null) listener(request)
      }),
      input: (listener: (value: unknown) => void) => surface.events.input(listener),
      forwardNeeded: (listener: (value: unknown) => void) => surface.events.forwardNeeded(listener),
    },
  })
  // Guest-focused keys ride the shortcut pipeline through the synthetic event
  // seam, subscribed ONCE per page (see GUEST_KEY_REPLAY_PAGES): the shim's push
  // channel is page-level, so a per-entry subscription would dispatch N times.
  const pageObject = typeof page === 'object' && page !== null ? page as object : undefined
  if (pageObject === undefined || !GUEST_KEY_REPLAY_PAGES.has(pageObject)) {
    if (pageObject !== undefined) GUEST_KEY_REPLAY_PAGES.add(pageObject)
    surface.events.input(value => { replayGuestKey(value, page) })
  }
  return true
}

/** The shell-facing combination (design 28 v3 §4.5): Swift KeyboardBridge keymap row. */
export interface ShortcutCombo {
  readonly code: string
  readonly primary: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly control: boolean
}

/** One normalized physical binding (vendor NormalizedBinding shape). */
type NormalizedBindingLike = {
  readonly code?: unknown
  readonly modifiers?: unknown
  /** Second key of a two-key chord (vendor NormalizedBinding.secondCode). */
  readonly secondCode?: unknown
}

/**
 * Map one effective normalized binding to the shell combination.
 *
 * primary is the platform's primary modifier: Command (meta) on macOS, Control
 * elsewhere. On macOS the literal Control key is still forwarded as control.
 *
 * TWO-KEY CHORDS ARE NOT FORWARDED (D13). The shell's keymap face is a per-key
 * table (one code + modifiers); the shell matches ONE keydown at a time, so
 * forwarding a chord's first key would consume it with no way to observe the
 * second key — the action could never fire AND the guest would lose the key
 * ("consumed without action"). A binding with a non-empty `secondCode` therefore
 * yields null: the whole chord stays inside the guest and is handled there
 * unchanged.
 *
 * @param binding - the binding from the Shortcuts catalog/fixed catalog.
 * @param platform - the Shortcuts platform word.
 * @returns the combo, or null when the binding has no usable code or is a chord.
 */
export function shortcutCombo(binding: NormalizedBindingLike, platform: unknown): ShortcutCombo | null {
  const code = binding.code
  if (typeof code !== 'string' || code === '') return null
  // Any present, non-empty second key is a chord (a malformed value is treated
  // the same way: forwarding a possibly-chord key is the failure mode to avoid).
  if (binding.secondCode !== undefined && binding.secondCode !== null && binding.secondCode !== '') return null
  const modifiers = Array.isArray(binding.modifiers)
    ? binding.modifiers.filter((item): item is string => typeof item === 'string')
    : []
  const mac = platform === 'macos'
  return {
    code,
    primary: mac ? modifiers.includes('meta') : modifiers.includes('control'),
    alt: modifiers.includes('alt'),
    shift: modifiers.includes('shift'),
    control: mac && modifiers.includes('control'),
  }
}

/** The Shortcuts snapshots the keymap source reads (vendor ObservableSnapshot). */
interface ShortcutSnapshots {
  readonly platform?: unknown
  readonly catalog?: { getSnapshot?(): unknown; subscribe?(listener: () => void): () => void }
  readonly config?: { getSnapshot?(): unknown; subscribe?(listener: () => void): () => void }
  readonly fixedCatalog?: { getSnapshot?(): unknown; subscribe?(listener: () => void): () => void }
}

/**
 * Enumerate the effective combinations the shell must forward.
 *
 * The catalog already folds config overrides in (the registry recomputes the
 * effective bindings on every config/locale change), so this reads the catalog
 * plus the fixed catalog (feature-owned reserved combinations).
 *
 * @param shortcuts - the Shortcuts service face.
 * @returns deduped combinations; an unreadable table yields an empty array.
 */
export function shortcutCombosFromSnapshots(shortcuts: ShortcutSnapshots): ShortcutCombo[] {
  const platform = shortcuts.platform
  const combos: ShortcutCombo[] = []
  const seen = new Set<string>()
  const add = (binding: NormalizedBindingLike): void => {
    const combo = shortcutCombo(binding, platform)
    if (combo === null) return
    const key = [combo.code, combo.primary, combo.alt, combo.shift, combo.control].join(':')
    if (seen.has(key)) return
    seen.add(key)
    combos.push(combo)
  }
  const readRows = (snapshot: { getSnapshot?(): unknown } | undefined): readonly unknown[] => {
    if (snapshot?.getSnapshot === undefined) return []
    let rows: unknown
    try { rows = snapshot.getSnapshot.call(snapshot) } catch { return [] }
    return Array.isArray(rows) ? rows : []
  }
  for (const row of readRows(shortcuts.catalog)) {
    if (typeof row !== 'object' || row === null) continue
    const binding = (row as { binding?: unknown }).binding
    if (typeof binding === 'object' && binding !== null) add(binding as NormalizedBindingLike)
  }
  for (const row of readRows(shortcuts.fixedCatalog)) {
    if (typeof row !== 'object' || row === null) continue
    const bindings = (row as { bindings?: unknown }).bindings
    if (!Array.isArray(bindings)) continue
    for (const binding of bindings) {
      if (typeof binding === 'object' && binding !== null) add(binding as NormalizedBindingLike)
    }
  }
  return combos
}

/**
 * Build the launcher-facing combination source over the per-entry Shortcuts service.
 *
 * Lazy by design: the Shortcuts service is materialized by a first-screen plugin
 * that may apply after this adapter. A service that never appears leaves the
 * source absent (no keymap push; guest keys stay inert, never swallowed). Reads
 * and subscriptions are fail-safe.
 *
 * @param ctx - entry context to read the shortcuts service from.
 * @returns the source, or undefined when no Shortcuts service is present.
 */
function createComboSource(ctx: { get(name: string): unknown }): { read(): ShortcutCombo[]; subscribe(listener: () => void): () => void } | undefined {
  const service = (): ShortcutSnapshots | undefined => {
    let value: unknown
    try { value = ctx.get('shortcuts') } catch { return undefined }
    return typeof value === 'object' && value !== null ? (value as ShortcutSnapshots) : undefined
  }
  if (service() === undefined) return undefined
  return {
    read: () => {
      const snapshots = service()
      return snapshots === undefined ? [] : shortcutCombosFromSnapshots(snapshots)
    },
    subscribe: (listener: () => void) => {
      const snapshots = service()
      if (snapshots === undefined) return () => undefined
      const stops: (() => void)[] = []
      for (const snapshot of [snapshots.catalog, snapshots.config, snapshots.fixedCatalog]) {
        if (snapshot === undefined || snapshot.subscribe === undefined) continue
        try { stops.push(snapshot.subscribe(listener)) } catch { /* fail-safe */ }
      }
      return () => { for (const stop of stops) { try { stop() } catch { /* fail-safe */ } } }
    },
  }
}
