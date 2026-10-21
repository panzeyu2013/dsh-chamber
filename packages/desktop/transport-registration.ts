/** Registration identity for the control-plane reverse proxy. A status push that
 *  only changes link health must NOT re-register: the proxy revokes every
 *  in-flight HTTP response and WS splice when a connectionId is replaced. */
import { createHash } from 'node:crypto'

export function authHeadersFingerprint(headers: Record<string, string> | undefined): string {
  const canonical = headers === undefined
    ? 'none'
    : Object.keys(headers).sort().map(key => key + ':' + headers[key]).join('|')
  return createHash('sha256').update(canonical).digest('hex')
}

export function sanitizedRegistrationHeaders(
  headers: Record<string, string>,
): Record<string, string> | undefined {
  return Object.keys(headers).length === 0 ? undefined : headers
}

export function registrationKey(
  url: string,
  transport: string | undefined,
  headers: Record<string, string> | undefined,
  spkiPin: string | undefined,
  authority: string | undefined,
): string {
  return [url, transport ?? '', authHeadersFingerprint(headers), spkiPin ?? '', authority ?? ''].join('|')
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
