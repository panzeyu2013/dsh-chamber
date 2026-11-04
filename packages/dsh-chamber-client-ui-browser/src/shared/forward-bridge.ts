/**
 * Remote Browser forward client — the launcher's LOCAL contract for the
 * trusted main-process forward manager.
 *
 * The carrier is the trusted `chamberForward` namespace (preload/Swift shim);
 * the renderer adapter translates the wire contract into this small face. This
 * module declares the exact shape the panel consumes and the runtime guards that
 * keep an untrusted async IPC projection out of the render:
 *
 *   request({sourceId, sourceFingerprint, port, scheme}) -> {ok, record} | {ok:false, code}
 *   release({sourceId, sourceFingerprint, id})            -> {ok} | {ok:false, code}
 *   list({sourceId, sourceFingerprint})                   -> {ok, records} | {ok:false, code}
 *   openInBrowser({sourceId, sourceFingerprint, id, path?}) -> {ok} | {ok:false, code}
 *
 * Deliberate shape decisions (report v4 §3, security round-2 nit 1):
 *   - the renderer never receives a full URL to pass back: a record carries
 *     `aliasHost` + `localPort` for DISPLAY only, and main builds the browser
 *     URL itself from the record id + a validated path;
 *   - `scheme` is part of the record so a remote HTTPS target is never
 *     silently downgraded to http;
 *   - `stale` is a list fact (no system-browser tab is observable) and the
 *     panel offers "reopen" instead of pretending it can update the old page.
 *
 * The canonical wire contract is `@dsh-chamber/dsh-chamber-wire/forward`.
 * `packages/renderer/src/chamber-forward-adapter.ts` is the ONE translation
 * between the two faces: record field names (`targetPort`/`targetHost`/
 * `sourceId`/`namespace`/timestamps), the state set (7 wire states → 3 here),
 * the error envelope (`{code, detail}` → `{ok:false, code}`), and the code table
 * (25 wire codes → 10 here). This module intentionally stays a small local face
 * so the panel cannot depend on wire-only facts.
 *
 * Pure: no DOM, no Node APIs, no imports beyond local types.
 */

/** Transport scheme a forward record was opened with (remote https is passed through). */
export type ForwardScheme = 'http' | 'https'

/** Forward lifecycle state observed by the launcher (no pin/retry/subscribe in v1). */
export type ForwardState = 'bound' | 'binding' | 'error'

/** Failure codes the launcher can render; the S1 table may extend this union. */
export type ForwardFailureCode =
  | 'forbidden-source'
  | 'invalid-port'
  | 'limit'
  | 'stale'
  | 'not-found'
  | 'spawn-failed'
  | 'bind-failed'
  | 'confirm-declined'
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
}

/** Inputs / results of the four calls. */
export interface ForwardRequestInput {
  sourceId: string
  sourceFingerprint: string
  port: number
  scheme: ForwardScheme
}

export interface ForwardReleaseInput {
  sourceId: string
  sourceFingerprint: string
  id: string
}

export interface ForwardListInput {
  sourceId: string
  sourceFingerprint: string
}

export interface ForwardOpenInput extends ForwardReleaseInput {
  /** Remote-side path + query (`/a?b=1`), validated by main against the record's origin. */
  path?: string
}

export interface ForwardFailure {
  ok: false
  code: ForwardFailureCode
  message?: string
}

export type ForwardRequestResult = { ok: true; record: ForwardRecord } | ForwardFailure
export type ForwardListResult = { ok: true; records: ForwardRecord[] } | ForwardFailure
export type ForwardOpenResult = { ok: true } | ForwardFailure
export type ForwardReleaseResult = { ok: true } | ForwardFailure

/** The local face the launcher consumes (implemented by the S1 preload bridge). */
export interface BrowserForwardBridge {
  request(input: ForwardRequestInput): Promise<ForwardRequestResult>
  release(input: ForwardReleaseInput): Promise<ForwardReleaseResult>
  list(input: ForwardListInput): Promise<ForwardListResult>
  openInBrowser(input: ForwardOpenInput): Promise<ForwardOpenResult>
}

/** Per-source forward cap (report v4 §3; W0 freezes the final table). */
export const PER_SOURCE_FORWARD_LIMIT = 8
/** Launcher list polling cadence (report v4: 1-2 s; v1 has no push channel). */
export const FORWARD_POLL_INTERVAL_MS = 1500

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
  try {
    ;({ id, remotePort, localPort, scheme, aliasHost, state, stale, error } = value)
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
  }
}

/** Project an untrusted record list, dropping malformed entries (never the whole list). */
export function parseForwardRecords(value: unknown): ForwardRecord[] {
  if (!Array.isArray(value)) return []
  const out: ForwardRecord[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const record = parseForwardRecord(entry)
    if (record === null || seen.has(record.id)) continue
    seen.add(record.id)
    out.push(record)
  }
  return out
}

/** Project an untrusted list envelope. */
export function parseForwardListResult(value: unknown): ForwardListResult {
  if (!isRecord(value)) return { ok: false, code: 'unknown' }
  if (value.ok === true) {
    if (!Array.isArray(value.records)) return { ok: false, code: 'unknown' }
    return { ok: true, records: parseForwardRecords(value.records) }
  }
  return parseForwardFailure(value)
}

/** Project an untrusted request envelope. */
export function parseForwardRequestResult(value: unknown): ForwardRequestResult {
  if (!isRecord(value)) return { ok: false, code: 'unknown' }
  if (value.ok === true) {
    const record = parseForwardRecord(value.record)
    return record === null ? { ok: false, code: 'unknown' } : { ok: true, record }
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
 * Structural probe for the future `chamberForward` service.
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

/**
 * Display-only host for one record: scheme + alias + local port. It is NEVER
 * fed back into openInBrowser (main builds the URL from the record id).
 */
export function forwardDisplayUrl(record: ForwardRecord): string {
  return `${record.scheme}://${record.aliasHost}:${record.localPort}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPort(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 65535
}
