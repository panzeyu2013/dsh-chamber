/**
 * Remote Browser launcher model — the pure decisions the panel renders.
 *
 * The component owns no policy: it feeds the parsed address, the source and the
 * polled forward list through these functions, so the address-table behaviour,
 * row eligibility and the i18n key mapping are all testable without React/DOM.
 *
 * v1 lifecycle (report v4 §3): no pin/retry/subscribe. The launcher only polls
 * `list`, labels a record stale, and offers "reopen"; closing the launcher never
 * kills a forward.
 *
 * Pure: no DOM, no Node APIs; imports are type-only except the local limit
 * constants and the i18n key maps.
 */
import type { AddressRefusalReason, BrowserAddress, BrowserAddressScheme, PublicReachability } from './address.ts'
import type { BrowserSource } from './source.ts'
import type { ForwardFailureCode, ForwardRecord, ForwardScheme, ForwardState } from './forward-bridge.ts'
import { PER_SOURCE_FORWARD_LIMIT, forwardDisplayUrl } from './forward-bridge.ts'
import type { BrowserKey } from '../locales.ts'

/** What pressing "open" must do for one submitted address. */
export type AddressPlan =
  | { kind: 'reject'; reason: AddressRefusalReason }
  | { kind: 'system-browser'; url: string; reachability: PublicReachability }
  | {
    kind: 'forward'
    port: number
    scheme: BrowserAddressScheme
    path: string
    requestPath: string
    /** True for a remote HTTPS target: the system browser will warn about the certificate. */
    certificateWarning: boolean
  }

/**
 * Decide one submit against the source gate.
 *
 * A public URL always goes through the system-browser link leg (even from a
 * remote source). A remote loopback target forwards when the source has an SSH
 * tunnel; on the local instance the same address IS this machine, so it opens
 * directly in the system browser instead of being refused.
 *
 * @param result - the parsed address, or null for an empty input.
 * @param source - the launcher's source (already gated by apply()).
 * @returns the action the panel executes.
 */
export function planAddressSubmit(
  result: BrowserAddress | null,
  source: BrowserSource,
): AddressPlan {
  if (result === null) return { kind: 'reject', reason: 'empty' }
  if (result.kind === 'unsupported') return { kind: 'reject', reason: result.reason }
  if (result.kind === 'public') {
    return { kind: 'system-browser', url: result.url, reachability: result.reachability }
  }
  if (!source.mayForward) {
    return { kind: 'system-browser', url: result.url, reachability: 'local-machine' }
  }
  return {
    kind: 'forward',
    port: result.port,
    scheme: result.scheme,
    path: result.path,
    requestPath: result.requestPath,
    certificateWarning: result.scheme === 'https',
  }
}

/** One rendered remote-section row (all copy keys resolved here). */
export interface RemoteRow {
  id: string
  remotePort: number
  localPort: number
  scheme: ForwardScheme
  aliasHost: string
  /** Display-only `scheme://alias:localPort` (never fed back to main). */
  displayUrl: string
  state: ForwardState
  stale: boolean
  errorCode?: string
  /** Primary action is "open" on a bound, non-stale record. */
  openable: boolean
  /** Stale/error records can be re-requested ("reopen"). */
  reissuable: boolean
  /** Every live record can be released, including a binding/starting one. */
  closable: boolean
  /** Chip copy key for this record's state. */
  stateKey: BrowserKey
  /** Primary action copy key. */
  actionKey: BrowserKey
}

/**
 * Project the polled list into stable, copy-resolved rows.
 * Order is remote port ascending, then record id — restart order never reorders rows.
 */
export function buildRemoteRows(records: readonly ForwardRecord[]): RemoteRow[] {
  return [...records]
    .map((record) => {
      const openable = record.state === 'bound' && !record.stale
      return {
        id: record.id,
        remotePort: record.remotePort,
        localPort: record.localPort,
        scheme: record.scheme,
        aliasHost: record.aliasHost,
        displayUrl: forwardDisplayUrl(record),
        state: record.state,
        stale: record.stale,
        ...(record.error === undefined ? {} : { errorCode: record.error }),
        openable,
        // A binding record is not actionable yet for open/reopen, but it still
        // owns a child/port (or will once it settles) and MUST be releasable.
        reissuable: record.stale || record.state === 'error',
        closable: true,
        stateKey: forwardStateKey(record),
        actionKey: openable ? 'remote.open' as const : 'remote.reopen' as const,
      }
    })
    .sort((left, right) => left.remotePort - right.remotePort || compareText(left.id, right.id))
}

/** Chip copy for one record. */
export function forwardStateKey(record: Pick<ForwardRecord, 'state' | 'stale'>): BrowserKey {
  if (record.stale) return 'remote.stale'
  switch (record.state) {
    case 'bound': return 'remote.bound'
    case 'binding': return 'remote.binding'
    case 'error': return 'remote.failed'
    default: return 'remote.failed'
  }
}

/** Result of comparing two polled lists (one launcher tick). */
export interface ForwardListDelta {
  added: ForwardRecord[]
  removed: ForwardRecord[]
  changed: ForwardRecord[]
}

/** Diff two polls by record id; used for the "one row changed" notice, never for state ownership. */
export function diffForwardRecords(
  previous: readonly ForwardRecord[],
  next: readonly ForwardRecord[],
): ForwardListDelta {
  const before = new Map(previous.map((record) => [record.id, record]))
  const after = new Map(next.map((record) => [record.id, record]))
  const added: ForwardRecord[] = []
  const changed: ForwardRecord[] = []
  for (const record of next) {
    const old = before.get(record.id)
    if (old === undefined) added.push(record)
    else if (!sameForwardRecord(old, record)) changed.push(record)
  }
  const removed = previous.filter((record) => !after.has(record.id))
  return { added, removed, changed }
}

/** Insert or replace one record (a request result lands in the polled list immediately). */
export function mergeForwardRecord(
  records: readonly ForwardRecord[],
  record: ForwardRecord,
): ForwardRecord[] {
  const index = records.findIndex((candidate) => candidate.id === record.id)
  if (index < 0) return [...records, record]
  const next = [...records]
  next[index] = record
  return next
}

/** True when this source has no room for another forward. */
export function sourceForwardLimitReached(
  records: readonly ForwardRecord[],
  limit: number = PER_SOURCE_FORWARD_LIMIT,
): boolean {
  return records.length >= limit
}

/** Copy key for an address refusal. */
export function addressErrorKey(reason: AddressRefusalReason): BrowserKey {
  switch (reason) {
    case 'empty': return 'error.address.empty'
    case 'too-long': return 'error.address.tooLong'
    case 'invalid': return 'error.address.invalid'
    case 'protocol': return 'error.address.protocol'
    case 'credentials': return 'error.address.credentials'
    case 'application-origin': return 'error.address.applicationOrigin'
    case 'ipv6-loopback': return 'error.address.ipv6Loopback'
    case 'unspecified-host': return 'error.address.unspecifiedHost'
    case 'alias-host': return 'error.address.aliasHost'
    case 'loopback-other': return 'error.address.loopbackOther'
    case 'port': return 'error.address.port'
    default: return 'error.address.invalid'
  }
}

/** Copy key for a forward failure code. */
export function forwardErrorKey(code: ForwardFailureCode): BrowserKey {
  switch (code) {
    case 'forbidden-source': return 'error.forward.forbiddenSource'
    case 'invalid-port': return 'error.forward.invalidPort'
    case 'limit': return 'error.forward.limit'
    case 'stale': return 'error.forward.stale'
    case 'not-found': return 'error.forward.notFound'
    case 'spawn-failed': return 'error.forward.spawnFailed'
    case 'bind-failed': return 'error.forward.bindFailed'
    case 'confirm-declined': return 'error.forward.confirmDeclined'
    case 'unavailable': return 'error.forward.unavailable'
    case 'unknown': return 'error.forward.unknown'
    default: return 'error.forward.unknown'
  }
}

function sameForwardRecord(left: ForwardRecord, right: ForwardRecord): boolean {
  return left.remotePort === right.remotePort
    && left.localPort === right.localPort
    && left.scheme === right.scheme
    && left.aliasHost === right.aliasHost
    && left.state === right.state
    && left.stale === right.stale
    && left.error === right.error
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
