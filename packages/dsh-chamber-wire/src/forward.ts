/**
 * Remote-browser forward wire contract (design 28 — remote Browser v4, W0/S1).
 *
 * WHY THIS MODULE EXISTS. The browser launcher (renderer) and the main-process
 * ForwardManager exchange one record/state/error vocabulary. If either side
 * re-types the enums, a new state ("reconnecting") or a new error code lands on
 * one side and is silently dropped on the other. This module is the single
 * declaration: the values, the record shape, the four method argument tables,
 * the result unions, the (reserved) change event, and the guards that make an
 * untrusted renderer payload safe to read.
 *
 * SCOPE / NON-GOALS.
 * - Zero runtime dependencies (same rule as every other wire module): it is
 *   inlined into the renderer bundle and imported by the bridge/IPC layer.
 * - No clock, no storage, no transport: every timestamp is a caller-supplied
 *   watermark, every list is ordered by the caller.
 * - v1 is POLL-ONLY. {@link FORWARD_CHANGED_CHANNEL} and
 *   {@link ForwardChangedEvent} are declared now so a later push channel does
 *   not renumber the contract, but the v1 bridge exposes no subscription (the
 *   launcher polls `forward.list` every 1-2s). Do not wire the event before
 *   that decision is recorded.
 * - The alias host is a BEHAVIOURAL contract, not a display string: the
 *   launcher may show `localHost:localPort`, but it may never construct the
 *   external URL itself — `forward.openInBrowser` receives only an id plus a
 *   path and main composes the URL (security ruling: no generic URL IPC).
 *
 * RECORD SEMANTICS.
 * - `state`: closed enum, see {@link FORWARD_STATES}; `bound` means the local
 *   listener accepted a probe, NOT that the remote service is reachable.
 * - `stale`: true while the record is reconnecting or while the owning source
 *   identity changed; the launcher must offer "reopen", never treat a stale
 *   record as usable.
 * - `error`: null unless `state === 'error'` (release/closed records do not
 *   exist on the wire — the manager removes them) OR a retrying record carries
 *   the last failure code. The detail string is always main-composed and never
 *   carries ssh material (stderr stays in the main log ring).
 * - `targetHost` is the fixed remote loopback; v1 never forwards to RFC1918,
 *   host names or IPv6 (the address-bar classifier rejects those before a
 *   forward is requested).
 */
import { isRecord, isWatermark } from './json-guards.ts'

/** Wire version of this contract (a semantic change bumps it; additive only in 0.4.x). */
export const FORWARD_WIRE_VERSION = 1

/** IPC/bridge namespace name reserved for this domain (not mounted by v1 S1). */
export const FORWARD_DOMAIN = 'forward'

/** The four methods of the v1 API, in canonical order. */
export const FORWARD_METHODS = ['request', 'release', 'list', 'openInBrowser'] as const

/** Forward scheme preserved end to end: https is passed through, never downgraded. */
export const FORWARD_SCHEMES = ['http', 'https'] as const

/** The only remote target host v1 supports (loopback of the SSH host). */
export const FORWARD_TARGET_HOST = '127.0.0.1'

/**
 * Forward lifecycle states.
 *   requested   - validated, resource allocation in progress (record visible)
 *   starting    - ssh child spawned, waiting for the local listener probe
 *   bound       - local listener accepted a probe (remote reachability unproven)
 *   reconnecting- the child died; a bounded relaunch is scheduled (stale=true)
 *   closing     - release/retire in progress
 *   closed      - terminal; the manager removes the record after this state
 *   error       - terminal failure; the record stays for display until released
 */
export const FORWARD_STATES = [
  'requested',
  'starting',
  'bound',
  'reconnecting',
  'closing',
  'closed',
  'error',
] as const

/** Forward states as a TS union. */
export type ForwardState = (typeof FORWARD_STATES)[number]

/**
 * Closed error-code table. Every code maps to one launcher message + action;
 * the string is stable (never localized here) so the renderer owns i18n.
 */
export const FORWARD_ERROR_CODES = [
  /** No such source, or the fingerprint no longer matches (retarget/remove). */
  'source_unknown',
  /** The source is not a dsh target (gateway/local entries never get a browser). */
  'source_not_dsh',
  /** The source does not ride SSH (http locals cannot be forwarded). */
  'transport_not_ssh',
  /** The source identity changed while a forward/confirm was in flight. */
  'source_changed',
  /** Per-source browser enablement is off and no confirmation seam exists. */
  'browser_disabled',
  /** The user declined the per-port confirmation. */
  'confirmation_declined',
  /** The source changed while the native confirmation was open. */
  'confirmation_late',
  /** Target port is not an integer in 1..65535. */
  'target_port_invalid',
  /** Target port equals the instance's own tunnel port (that is not a browser target). */
  'target_port_reserved',
  /** Scheme outside {http,https}. */
  'scheme_invalid',
  /** 8 active forwards for this source already. */
  'too_many_for_source',
  /** 32 active forwards overall already. */
  'too_many_global',
  /** The persisted browser-namespace store is unreadable/corrupt (fail closed). */
  'namespace_unavailable',
  /** All 253 alias hosts are retired; no new interface can ever be allocated. */
  'alias_exhausted',
  /** No local port could be allocated on the alias host. */
  'port_exhausted',
  /** The ssh child never bound the local listener (bind race lost repeatedly). */
  'local_bind_failed',
  /** Authentication failed terminally (askpass/OTP/permission). */
  'auth_failed',
  /** The forward child failed for an unclassified reason. */
  'forward_failed',
  /** Unknown forward id for this source. */
  'forward_not_found',
  /** The forward id belongs to another source/fingerprint. */
  'forward_not_owned',
  /** openInBrowser on a record that is not bound. */
  'forward_not_bound',
  /** The record belongs to an older source identity. */
  'forward_stale',
  /** The path argument is not a same-origin relative path. */
  'invalid_path',
  /** The per-source open budget was exhausted. */
  'rate_limited',
  /** The OS/browser refused to open the URL. */
  'open_failed',
] as const

/** Forward error codes as a TS union. */
export type ForwardErrorCode = (typeof FORWARD_ERROR_CODES)[number]

/** One forward scheme. */
export type ForwardScheme = (typeof FORWARD_SCHEMES)[number]

/** The fixed remote target of one forward. */
export interface ForwardTarget {
  /** Always {@link FORWARD_TARGET_HOST} in v1. */
  readonly host: typeof FORWARD_TARGET_HOST
  readonly port: number
  readonly scheme: ForwardScheme
}

/** One non-secret failure, safe to render (message text is the renderer's i18n). */
export interface ForwardError {
  readonly code: ForwardErrorCode
  /** Main-composed, redacted diagnostics; null when the code alone is the answer. */
  readonly detail: string | null
}

/**
 * One forwarded port as shown by the launcher and owned by the manager.
 * The record is the WHOLE cross-process surface: it carries no child handle,
 * no ssh argv, no credentials, no stderr.
 */
export interface ForwardRecord {
  /** Main-minted opaque id (`fwd-<hex>`), stable for the record lifetime. */
  readonly id: string
  /** Source id (`dsh-<instanceId>`; legacy `ssh-<instanceId>` is a dsh alias). */
  readonly sourceId: string
  /** 16-bit persisted browser namespace that minted this alias (rotation evidence). */
  readonly namespace: number
  /** 127.0.0.2..127.0.0.254 — never 127.0.0.1. */
  readonly aliasHost: string
  /** Local listener port (>= 1024 when same-port; ephemeral otherwise). */
  readonly localPort: number
  readonly scheme: ForwardScheme
  /** Fixed remote loopback host. */
  readonly targetHost: typeof FORWARD_TARGET_HOST
  /** Remote service port. */
  readonly targetPort: number
  readonly state: ForwardState
  /** True while reconnecting or after the source identity changed. */
  readonly stale: boolean
  readonly error: ForwardError | null
  /** Watermarks (main clock); never wall-clock strings. */
  readonly createdAt: number
  readonly updatedAt: number
  /** First successful local-listener probe, null until bound. */
  readonly boundAt: number | null
}

/** Hard caps and port ranges, shared so the launcher can explain a refusal. */
export const FORWARD_LIMITS = Object.freeze({
  maxPerSource: 8,
  maxGlobal: 32,
  /** Local ports below 1024 need privileges and are never used for a forward. */
  minLocalPort: 1024,
  maxLocalPort: 65535,
  minTargetPort: 1,
  maxTargetPort: 65535,
})

/** Alias octet table (2..254; .0/.1/.255 are excluded by construction). */
export const FORWARD_ALIAS_OCTETS = Object.freeze({ min: 2, max: 254, capacity: 253 })

/** Canonical alias host for one octet; throws outside the policy range. */
export function forwardAliasHost(octet: number): string {
  if (!Number.isInteger(octet) || octet < FORWARD_ALIAS_OCTETS.min || octet > FORWARD_ALIAS_OCTETS.max) {
    throw new RangeError('forward alias octet out of range: ' + String(octet))
  }
  return '127.0.0.' + String(octet)
}

/**
 * Alias-host predicate: 127.0.0.2 .. 127.0.0.254 only.
 * This is the ONE wire-level spelling; the manager's namespace module has its
 * own leaf constant and a lockstep test proves the two agree on the full grid.
 */
export function isForwardAliasHost(value: unknown): value is string {
  return typeof value === 'string'
    && /^127\.0\.0\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/u.test(value)
}

/** Display origin of one record (no path, no credentials). */
export function forwardLocalOrigin(record: Pick<ForwardRecord, 'scheme' | 'aliasHost' | 'localPort'>): string {
  return record.scheme + '://' + record.aliasHost + ':' + String(record.localPort)
}

/** `forward.request` arguments (idempotent on (sourceId, targetPort)). */
export interface ForwardRequestArgs {
  readonly sourceId: string
  readonly sourceFingerprint: string
  /** Remote loopback port to forward. */
  readonly port: number
  /** Defaults to http. */
  readonly scheme?: ForwardScheme
}

/** `forward.release` arguments: closing one record the caller owns. */
export interface ForwardReleaseArgs {
  readonly sourceId: string
  readonly sourceFingerprint: string
  readonly id: string
}

/** `forward.list` arguments: the per-source snapshot the launcher polls. */
export interface ForwardListArgs {
  readonly sourceId: string
  readonly sourceFingerprint: string
}

/** Current cap usage, so the launcher can name what holds the last slot. */
export interface ForwardLimitsSnapshot {
  readonly perSource: number
  readonly global: number
  readonly perSourceUsed: number
  readonly globalUsed: number
}

/** `forward.list` result: newest-last record order is the manager's contract. */
export type ForwardListResult =
  | { readonly ok: true; readonly records: readonly ForwardRecord[]; readonly limits: ForwardLimitsSnapshot }
  | { readonly ok: false; readonly error: ForwardError }

/**
 * `forward.request` result: the record after the start attempt settled.
 * `ok: true` means A RECORD EXISTS (bound or failed); a failed start is carried
 * by `record.state === 'error'` + `record.error`, and releasing that record is
 * the caller's cleanup. `ok: false` is reserved for refusals where no record
 * was created (gate, caps, authorization, allocation).
 */
export type ForwardRequestResult =
  | { readonly ok: true; readonly record: ForwardRecord }
  | { readonly ok: false; readonly error: ForwardError }

/** `forward.release` result. */
export type ForwardReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ForwardError }

/** `forward.openInBrowser` arguments: main composes the URL, never the renderer. */
export interface ForwardOpenArgs {
  readonly sourceId: string
  readonly sourceFingerprint: string
  readonly id: string
  /** Same-origin relative path (`/`, `/app?x=1`); fragment is dropped. */
  readonly path?: string
}

/** `forward.openInBrowser` result: honest "handed to the OS" vs a typed refusal. */
export type ForwardOpenResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ForwardError }

/**
 * Reserved change-event shape (v2 push; v1 polls and never emits it).
 * A snapshot is complete: the consumer replaces its list, it does not merge.
 */
export interface ForwardChangedEvent {
  readonly sourceId: string
  /** Monotonic per-manager revision (the launcher drops out-of-order snapshots). */
  readonly revision: number
  readonly records: readonly ForwardRecord[]
}

/** Reserved push channel name (see {@link ForwardChangedEvent}). */
export const FORWARD_CHANGED_CHANNEL = 'forward:changed'

/** Source-id grammar shared with the registry projection (`local` is not a source). */
const FORWARD_SOURCE_ID_PATTERN = /^(?:dsh|gateway|ssh)-[A-Za-z0-9_-]{1,64}$/u

/** Main-minted forward id grammar. */
const FORWARD_ID_PATTERN = /^fwd-[0-9a-f]{16,64}$/u

/** Fingerprint grammar (notification source proofs use the same alphabet). */
const FORWARD_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u

/** Narrow an untrusted value to a known forward state. */
export function isForwardState(value: unknown): value is ForwardState {
  return typeof value === 'string' && (FORWARD_STATES as readonly string[]).includes(value)
}

/** Narrow an untrusted value to a known forward error code. */
export function isForwardErrorCode(value: unknown): value is ForwardErrorCode {
  return typeof value === 'string' && (FORWARD_ERROR_CODES as readonly string[]).includes(value)
}

/** Narrow an untrusted value to a known forward scheme. */
export function isForwardScheme(value: unknown): value is ForwardScheme {
  return typeof value === 'string' && (FORWARD_SCHEMES as readonly string[]).includes(value)
}

/** Narrow an untrusted value to a source id. */
export function isForwardSourceId(value: unknown): value is string {
  return typeof value === 'string' && FORWARD_SOURCE_ID_PATTERN.test(value)
}

/** Narrow an untrusted value to a main-minted forward id. */
export function isForwardId(value: unknown): value is string {
  return typeof value === 'string' && FORWARD_ID_PATTERN.test(value)
}

/** Narrow an untrusted value to a source fingerprint. */
export function isForwardFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FORWARD_FINGERPRINT_PATTERN.test(value)
}

/** Bounded target port (1..65535). */
export function isForwardTargetPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= FORWARD_LIMITS.minTargetPort && value <= FORWARD_LIMITS.maxTargetPort
}

/** Bounded local port (>= 1024; 65535 max). */
export function isForwardLocalPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= FORWARD_LIMITS.minLocalPort && value <= FORWARD_LIMITS.maxLocalPort
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value)
  return present.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isNullableWatermark(value: unknown): value is number | null {
  return value === null || isWatermark(value)
}

/** Narrow an untrusted value to a forward error. */
export function isForwardError(value: unknown): value is ForwardError {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, ['code', 'detail'])) return false
  return isForwardErrorCode(value.code)
    && (value.detail === null || (typeof value.detail === 'string' && value.detail.length <= 512))
}

/** Narrow an untrusted value to a forward target. */
export function isForwardTarget(value: unknown): value is ForwardTarget {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, ['host', 'port', 'scheme'])) return false
  return value.host === FORWARD_TARGET_HOST
    && isForwardTargetPort(value.port)
    && isForwardScheme(value.scheme)
}

/** Narrow an untrusted value to a complete forward record. */
export function isForwardRecord(value: unknown): value is ForwardRecord {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, [
    'id', 'sourceId', 'namespace', 'aliasHost', 'localPort', 'scheme', 'targetHost',
    'targetPort', 'state', 'stale', 'error', 'createdAt', 'updatedAt', 'boundAt',
  ])) return false
  if (!isForwardId(value.id) || !isForwardSourceId(value.sourceId)) return false
  if (typeof value.namespace !== 'number' || !Number.isSafeInteger(value.namespace)
    || value.namespace < 0 || value.namespace > 0xffff) return false
  if (!isForwardAliasHost(value.aliasHost)) return false
  if (!isForwardLocalPort(value.localPort)) return false
  if (!isForwardScheme(value.scheme)) return false
  if (value.targetHost !== FORWARD_TARGET_HOST) return false
  if (!isForwardTargetPort(value.targetPort)) return false
  if (!isForwardState(value.state)) return false
  if (typeof value.stale !== 'boolean') return false
  if (value.error !== null && !isForwardError(value.error)) return false
  if (!isWatermark(value.createdAt) || !isWatermark(value.updatedAt)) return false
  if (!isNullableWatermark(value.boundAt)) return false
  // Timestamp causality is part of the contract; a record that breaks it is corrupt.
  if (value.updatedAt < value.createdAt) return false
  if (value.boundAt !== null && (value.boundAt < value.createdAt || value.boundAt > value.updatedAt)) return false
  if ((value.state === 'error') !== (value.error !== null)) return false
  return true
}

/** Narrow an untrusted value to `forward.request` arguments. */
export function isForwardRequestArgs(value: unknown): value is ForwardRequestArgs {
  if (!isRecord(value)) return false
  if (!isForwardSourceId(value.sourceId) || !isForwardFingerprint(value.sourceFingerprint)) return false
  if (!isForwardTargetPort(value.port)) return false
  if (value.scheme !== undefined && !isForwardScheme(value.scheme)) return false
  return true
}

/** Narrow an untrusted value to `forward.release` arguments. */
export function isForwardReleaseArgs(value: unknown): value is ForwardReleaseArgs {
  if (!isRecord(value)) return false
  return isForwardSourceId(value.sourceId)
    && isForwardFingerprint(value.sourceFingerprint)
    && isForwardId(value.id)
}

/** Narrow an untrusted value to `forward.list` arguments. */
export function isForwardListArgs(value: unknown): value is ForwardListArgs {
  if (!isRecord(value)) return false
  return isForwardSourceId(value.sourceId) && isForwardFingerprint(value.sourceFingerprint)
}

/** Narrow an untrusted value to `forward.openInBrowser` arguments. */
export function isForwardOpenArgs(value: unknown): value is ForwardOpenArgs {
  if (!isRecord(value)) return false
  if (!isForwardSourceId(value.sourceId) || !isForwardFingerprint(value.sourceFingerprint)) return false
  if (!isForwardId(value.id)) return false
  if (value.path !== undefined
    && (typeof value.path !== 'string' || value.path.length > 2048)) return false
  return true
}

/** Narrow an untrusted value to a limits snapshot. */
export function isForwardLimitsSnapshot(value: unknown): value is ForwardLimitsSnapshot {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, ['perSource', 'global', 'perSourceUsed', 'globalUsed'])) return false
  return Number.isSafeInteger(value.perSource) && Number.isSafeInteger(value.global)
    && Number.isSafeInteger(value.perSourceUsed) && Number.isSafeInteger(value.globalUsed)
    && (value.perSourceUsed as number) >= 0 && (value.globalUsed as number) >= 0
    && (value.perSourceUsed as number) <= (value.perSource as number)
    && (value.globalUsed as number) <= (value.global as number)
    && (value.perSource as number) >= 0 && (value.global as number) >= 0
}

/** Narrow an untrusted value to a `forward.list` result. */
export function isForwardListResult(value: unknown): value is ForwardListResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    return Array.isArray(value.records) && value.records.every(isForwardRecord)
      && isForwardLimitsSnapshot(value.limits)
  }
  if (value.ok === false) return isForwardError(value.error)
  return false
}

/** Narrow an untrusted value to a `forward.request` result. */
export function isForwardRequestResult(value: unknown): value is ForwardRequestResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isForwardRecord(value.record)
  if (value.ok === false) return isForwardError(value.error)
  return false
}

/** Narrow an untrusted value to a `forward.release` result. */
export function isForwardReleaseResult(value: unknown): value is ForwardReleaseResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return true
  if (value.ok === false) return isForwardError(value.error)
  return false
}

/** Narrow an untrusted value to a `forward.openInBrowser` result. */
export function isForwardOpenResult(value: unknown): value is ForwardOpenResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return true
  if (value.ok === false) return isForwardError(value.error)
  return false
}

/** Narrow an untrusted value to a reserved change event. */
export function isForwardChangedEvent(value: unknown): value is ForwardChangedEvent {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, ['sourceId', 'revision', 'records'])) return false
  return isForwardSourceId(value.sourceId)
    && isWatermark(value.revision)
    && Array.isArray(value.records) && value.records.every(isForwardRecord)
}
