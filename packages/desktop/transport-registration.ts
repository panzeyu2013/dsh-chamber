/** Registration identity for the control-plane reverse proxy. A status push that
 *  only changes link health must NOT re-register: the proxy revokes every
 *  in-flight HTTP response and WS splice when a connectionId is replaced. */
import { createHash } from 'node:crypto'

export function authHeadersFingerprint(headers: Record<string, string> | undefined): string {
  // JSON-encoded [name, value] pairs: a ':' / '|' INSIDE a value must never be
  // able to collide with a different header set (the previous join let
  // {a: 'x|b:y'} and {a: 'x', b: 'y'} hash identically, which would keep the old
  // credential registered under a health-only update).
  const canonical = headers === undefined
    ? 'none'
    : JSON.stringify(Object.keys(headers).sort().map(key => [key, headers[key]]))
  return createHash('sha256').update(canonical).digest('hex')
}

export function sanitizedRegistrationHeaders(
  headers: Record<string, string>,
): Record<string, string> | undefined {
  return Object.keys(headers).length === 0 ? undefined : headers
}

/**
 * Everything that identifies one registered proxy target. An OBJECT, not five
 * positional strings: with positional parameters a simple pin/authority swap at
 * one of the four call sites is type-compatible and would silently turn a real
 * re-registration into a health-only update (or the reverse).
 */
export interface RegistrationTarget {
  readonly url: string
  /** The transport mechanism ('ssh' | 'http'); undefined = not reported. */
  readonly transport?: string | undefined
  /** The sanctioned auth headers AFTER sanitization (undefined = none). */
  readonly headers?: Record<string, string> | undefined
  readonly spkiPin?: string | undefined
  readonly authority?: string | undefined
}

export function registrationKey(target: RegistrationTarget): string {
  // Same escaping rule as the fingerprint: one JSON array, never a delimiter join.
  return JSON.stringify([
    target.url,
    target.transport ?? '',
    authHeadersFingerprint(target.headers),
    target.spkiPin ?? '',
    target.authority ?? '',
  ])
}

/** Same key means the live registration already carries this exact target and
 *  credential; only the health sub-state may change. Any key change is a real
 *  registration edge (url/transport/auth fingerprint/pin/authority). */
export function transportRegistrationAction(
  previousKey: string | undefined,
  nextKey: string,
): 'register' | 'health-only' {
  return previousKey === nextKey ? 'health-only' : 'register'
}

/** Apply the edge decision at the call site: a health-only update must never run
 *  the register body (which revokes in-flight HTTP/WS on the proxy). */
export function applyTransportRegistration(
  previousKey: string | undefined,
  nextKey: string,
  effects: { setHealth(): void; register(): void },
): 'register' | 'health-only' {
  const action = transportRegistrationAction(previousKey, nextKey)
  if (action === 'health-only') effects.setHealth()
  else effects.register()
  return action
}
