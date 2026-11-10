/**
 * Remote Browser forward client — the launcher's LOCAL contract for the
 * trusted main-process forward manager (design 28 §16, forward wire v3).
 *
 * The carrier is the trusted `chamberForward` namespace (preload/Swift shim);
 * the renderer adapter translates the wire contract into this small face. This
 * module declares the exact shape the panel consumes and the runtime guards that
 * keep an untrusted async IPC projection out of the render:
 *
 *   request({sourceId, sourceFingerprint, port, scheme?, consumer?, path?})
 *       -> {ok: true, record, frameUrl?} | {ok:false, code}
 *   release({sourceId, sourceFingerprint, id, consumer?}) -> {ok} | {ok:false, code}
 *   list({sourceId, sourceFingerprint})
 *       -> {ok: true, records} | {ok:false, code}
 *     (the LOCAL identity is accepted on list only; the iframe-era local-frame
 *      origin projection is retired with the iframe carrier and wire v3)
 *   openInBrowser({sourceId, sourceFingerprint, id, path?}) -> {ok} | {ok:false, code}
 *
 * v3 shape decisions (design 28 §3; the native guest carrier consumes this face):
 *   - `consumer` is the renderer-minted tab-occurrence id. Present on request =
 *     attach (or renew) this tab's claim; present on release = detach only this
 *     claim (the listener dies with the LAST consumer); absent = the v1
 *     pinned/force-close semantics used by the system-browser leg.
 *   - `frameUrl` stays a main-composed convenience field; in v3 the guest loads
 *     from the recordId+path main itself composes, so the renderer never passes
 *     an alias URL back. The alias exit is the record's display-only projection.
 *   - `record.frameError` is a diagnostic classification main may attach; the v3
 *     guest reports its own load failures through `browser.state`, so no launcher
 *     UI reads it and it never carries page content.
 *
 * The canonical wire contract is `@dsh-chamber/dsh-chamber-wire/forward`.
 * `packages/renderer/src/chamber-forward-adapter.ts` is the ONE translation
 * between the two faces: record field names (`targetPort`/`targetHost`/
 * `sourceId`/`namespace`/timestamps), the state set (7 wire states → 3 here),
 * the error envelope (`{code, detail}` → `{ok:false, code}`), and the code
 * table (wire codes → 11 here). This module intentionally stays a small local
 * face so the panel cannot depend on wire-only facts.
 *
 * Pure: no DOM, no Node APIs, no imports beyond local types.
 */

/** Transport scheme a forward record was opened with (remote https is passed through). */
export type ForwardScheme = 'http' | 'https'

/** Forward lifecycle state observed by the launcher (v2 keeps the v1 three buckets). */
export type ForwardState = 'bound' | 'binding' | 'error'

export type ForwardFrameError =
  | 'blocked_by_response'
  | 'certificate_error'
  | 'load_failed'
  | 'timeout'

/** Failure codes the launcher can render (wire v2 adds `release-timeout`). */
export type ForwardFailureCode =
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


/** One active/known forward. `aliasHost` + `localPort` are display facts only. */
export interface ForwardRecord {
  /** Opaque record id minted by main. */
  id: string
  /** Remote loopback port (the user's typed port). */
  remotePort: number
  /** Local listener port (never below 1024). */
  localPort: number
  scheme: ForwardScheme
  /** Per-source loopback alias in 127.0.0.2-254 (never 127.0.0.1). */
  aliasHost: string
  state: ForwardState
  /** A reconnect/port change invalidated this record; the panel offers reopen. */
  stale: boolean
  /** Main-provided error code/message when `state === 'error'`. */
  error?: string
  /** Diagnostic frame-failure classification (absent/null = unknown; no launcher UI reads it). */
  frameError?: ForwardFrameError | null
}

/** Inputs / results of the four calls. */
export interface ForwardRequestInput {
  sourceId: string
  sourceFingerprint: string
  port: number
  scheme: ForwardScheme
  /** v2 tab-occurrence claim (attach/renew). Absent = v1 pinned/system-browser request. */
  consumer?: string
  /** Same-origin relative path used by main to compose `frameUrl` (fragment dropped). */
  path?: string
}

export interface ForwardReleaseInput {
  sourceId: string
  sourceFingerprint: string
  id: string
  /** v2: present = detach only this claim; absent = force-close the record. */
  consumer?: string
}

export interface ForwardListInput {
  sourceId: string
  sourceFingerprint: string
}

export interface ForwardOpenInput {
  sourceId: string
  sourceFingerprint: string
  id: string
  /** Remote-side path + query (`/a?b=1`), validated by main against the record's origin. */
  path?: string
}

export interface ForwardFailure {
  ok: false
  code: ForwardFailureCode
  message?: string
}

export type ForwardRequestResult =
  | { ok: true; record: ForwardRecord; frameUrl?: string }
  | ForwardFailure
export type ForwardListResult =
  | {
    ok: true
    records: ForwardRecord[]
  }
  | ForwardFailure
export type ForwardOpenResult = { ok: true } | ForwardFailure
export type ForwardReleaseResult = { ok: true } | ForwardFailure

/** The local face the launcher consumes (implemented by the S1 preload bridge / renderer adapter). */
export interface BrowserForwardBridge {
  request(input: ForwardRequestInput): Promise<ForwardRequestResult>
  release(input: ForwardReleaseInput): Promise<ForwardReleaseResult>
  list(input: ForwardListInput): Promise<ForwardListResult>
  openInBrowser(input: ForwardOpenInput): Promise<ForwardOpenResult>
}

/** Renderer-minted consumer grammar (mirrors the wire `FORWARD_CONSUMER_PATTERN`). */
export const FORWARD_CONSUMER_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u

/** Frame-failure classification table (closed; mirrors the wire table). */
export const FORWARD_FRAME_ERRORS: ReadonlySet<ForwardFrameError> = new Set<ForwardFrameError>([
  'blocked_by_response',
  'certificate_error',
  'load_failed',
  'timeout',
])

const ALIAS_HOST = /^127\.0\.0\.(\d{1,3})$/u
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const FAILURE_CODES: ReadonlySet<string> = new Set<ForwardFailureCode>([
  'forbidden-source',
  'invalid-port',
  'limit',
  'stale',
  'not-found',
  'spawn-failed',
  'bind-failed',
  'confirm-declined',
  'release-timeout',
  'unavailable',
  'unknown',
])

/** True only for the 127.0.0.2-254 alias range (127.0.0.1 / .0 / .255 are forbidden). */
export function isBrowserAliasHost(host: string): boolean {
  const match = ALIAS_HOST.exec(host)
  if (match === null) return false
  const octet = Number(match[1])
  return octet >= 2 && octet <= 254
}

/** Narrow an untrusted value to a frame-failure classification. */
export function isForwardFrameError(value: unknown): value is ForwardFrameError {
  return typeof value === 'string' && FORWARD_FRAME_ERRORS.has(value as ForwardFrameError)
}

/** Narrow an untrusted value to a known launcher failure code. */
export function isForwardFailureCode(value: unknown): value is ForwardFailureCode {
  return typeof value === 'string' && FAILURE_CODES.has(value)
}

/**
 * Main-composed iframe URL guard (mirrors the wire `isForwardFrameUrl`): absolute
 * http(s), bounded, no credentials/fragment/control bytes.
 */
export function isForwardFrameUrl(value: unknown): value is string {
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

/** Project one untrusted record; null when any invariant is broken. */
export function parseForwardRecord(value: unknown): ForwardRecord | null {
  if (!isRecord(value)) return null
  let id: unknown
  let remotePort: unknown
  let localPort: unknown
  let scheme: unknown
  let aliasHost: unknown
  let state: unknown
  let stale: unknown
  let error: unknown
  let frameError: unknown
  try {
    ;({ id, remotePort, localPort, scheme, aliasHost, state, stale, error, frameError } = value)
  } catch {
    // Hostile getters are one malformed record, not a list-wide failure.
    return null
  }
  if (typeof id !== 'string' || !RECORD_ID.test(id)) return null
  if (!isPort(remotePort, 1) || !isPort(localPort, 1024)) return null
  if (scheme !== 'http' && scheme !== 'https') return null
  if (typeof aliasHost !== 'string' || !isBrowserAliasHost(aliasHost)) return null
  if (state !== 'bound' && state !== 'binding' && state !== 'error') return null
  if (stale !== undefined && typeof stale !== 'boolean') return null
  if (error !== undefined && (typeof error !== 'string' || error === '')) return null
  if (frameError !== undefined && frameError !== null && !isForwardFrameError(frameError)) return null
  // The literal assignments keep the projection typed even if the runtime guard
  // above is ever relaxed; no untrusted value reaches the row untyped.
  const schemeValue: ForwardScheme = scheme === 'https' ? 'https' : 'http'
  const stateValue: ForwardState = state === 'bound'
    ? 'bound'
    : state === 'binding' ? 'binding' : 'error'
  return {
    id,
    remotePort,
    localPort,
    scheme: schemeValue,
    aliasHost,
    state: stateValue,
    stale: stale === true,
    ...(error === undefined ? {} : { error }),
    ...(frameError === undefined || frameError === null ? {} : { frameError }),
  }
}

/** Project an untrusted request envelope. */
export function parseForwardRequestResult(value: unknown): ForwardRequestResult {
  if (!isRecord(value)) return { ok: false, code: 'unknown' }
  if (value.ok === true) {
    const record = parseForwardRecord(value.record)
    if (record === null) return { ok: false, code: 'unknown' }
    // A malformed frameUrl is dropped, not trusted: the caller then treats the
    // attach as failed rather than setting an unvalidated src.
    return isForwardFrameUrl(value.frameUrl)
      ? { ok: true, record, frameUrl: value.frameUrl }
      : { ok: true, record }
  }
  return parseForwardFailure(value)
}

/** Project an untrusted open/release envelope. */
export function parseForwardAck(value: unknown): ForwardOpenResult {
  if (!isRecord(value)) return { ok: false, code: 'unknown' }
  if (value.ok === true) return { ok: true }
  return parseForwardFailure(value)
}

/** Project the untrusted failure tail (unknown codes collapse to 'unknown'). */
export function parseForwardFailure(value: unknown): ForwardFailure {
  if (!isRecord(value)) return { ok: false, code: 'unknown' }
  let code: unknown
  let message: unknown
  try {
    ;({ code, message } = value)
  } catch {
    return { ok: false, code: 'unknown' }
  }
  const normalized = typeof code === 'string' && FAILURE_CODES.has(code)
    ? (code as ForwardFailureCode)
    : 'unknown'
  return typeof message === 'string' && message !== ''
    ? { ok: false, code: normalized, message }
    : { ok: false, code: normalized }
}

/**
 * Structural probe for the `chamberForward` service.
 *
 * @param value - the untyped ctx value.
 * @returns the bridge when all four methods are functions, else null.
 */
export function asBrowserForwardBridge(value: unknown): BrowserForwardBridge | null {
  if (!isRecord(value)) return null
  for (const method of ['request', 'release', 'list', 'openInBrowser'] as const) {
    let member: unknown
    try {
      member = value[method]
    } catch {
      return null
    }
    if (typeof member !== 'function') return null
  }
  return value as unknown as BrowserForwardBridge
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPort(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 65535
}
