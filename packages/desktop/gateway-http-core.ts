/**
 * Bounded gateway HTTP request core, shared by the plugin-sync adapters and the
 * runtime-identity probe: the mechanics live here ONCE, and each caller maps
 * `BoundedHttpOutcome` onto its own contract.
 *
 * Deliberately electron-free (W-14): it speaks node:http(s) and the shared
 * control-plane SPKI pin helper only.
 *
 * The core NEVER rejects. A caller that wants throw-based semantics maps
 * `oversize`/`network` itself — the former callers disagreed on exactly that,
 * so settling uniformly would silently change one of them.
 */
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { attachSpkiPinVerifier, SPKI_PIN_MISMATCH_CODE } from './control-plane-module.ts'

/** How a bounded request settled. `json`: `empty` = no bytes (payload null),
 *  `invalid` = bytes not JSON (payload null), `ok` = parsed JSON. `oversize`
 *  carries no status — the body bound was hit while reading, so the caller's
 *  size-bound verdict wins. `network` folds every transport-level failure,
 *  including the timeout destroy and an SPKI pin mismatch. */
export type BoundedHttpOutcome =
  | { kind: 'response'; status: number; payload: unknown; json: 'ok' | 'empty' | 'invalid' }
  | { kind: 'oversize' }
  | { kind: 'network'; error: Error; timedOut: boolean; spkiMismatch: boolean }

export interface BoundedGatewayRequestOptions {
  method: 'GET' | 'PUT' | 'POST'
  /** Sent verbatim (each caller owns its accept/content-type assembly). */
  headers: Record<string, string>
  /** Omitted = no body; a Buffer is sent raw, anything else is JSON-encoded. */
  body?: unknown
  /** Plain http when true; https otherwise (testable without TLS). */
  insecure: boolean
  /** SPKI trust anchor; null = no pin gate. */
  spkiPin: string | null
  timeoutMs: number
  /** Response body bound, in bytes. On overflow the response is destroyed
   *  and the outcome is `oversize` (never a rejection). */
  maxBodyBytes: number
  /** Error text the timeout destroy carries; callers preserve their wording. */
  timeoutMessage?: string
  /** Return false to settle from the status line alone, draining the body
   *  instead of buffering it: classification keys on the status and must not
   *  wait for (or bound) a body it never reads. */
  readBodyForStatus?: (status: number) => boolean
  /** Destroy the request once settled (no keep-alive reuse on this path). */
  destroyOnSettle?: boolean
}

export function boundedGatewayRequest(
  url: string,
  options: BoundedGatewayRequestOptions,
): Promise<BoundedHttpOutcome> {
  return new Promise<BoundedHttpOutcome>(resolve => {
    const request = options.insecure ? httpRequest : httpsRequest
    const pin = options.spkiPin
    let settled = false
    let timedOut = false
    const settle = (outcome: BoundedHttpOutcome): void => {
      if (settled) return
      settled = true
      if (options.destroyOnSettle === true) req.destroy()
      resolve(outcome)
    }
    const req = request(url, {
      method: options.method,
      headers: options.headers,
      // With a configured pin the request opens a FRESH https connection whose
      // trust anchor is the pin (rejectUnauthorized false — the internal-CA
      // case); dispatch stays gated until the peer key matches, so credential
      // headers are never queued early.
      ...(options.insecure || pin === null ? {} : { rejectUnauthorized: false, agent: false }),
    }, res => {
      const status = res.statusCode ?? 0
      if (options.readBodyForStatus !== undefined && !options.readBodyForStatus(status)) {
        res.resume()
        settle({ kind: 'response', status, payload: null, json: 'empty' })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size > options.maxBodyBytes) {
          res.destroy()
          settle({ kind: 'oversize' })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        let payload: unknown = null
        let json: 'ok' | 'empty' | 'invalid'
        if (chunks.length === 0) {
          json = 'empty'
        } else {
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            json = 'ok'
          } catch {
            payload = null
            json = 'invalid'
          }
        }
        settle({ kind: 'response', status, payload, json })
      })
      res.on('error', error => settle({ kind: 'network', error, timedOut: false, spkiMismatch: false }))
    })
    req.on('error', error => {
      const spkiMismatch = (error as NodeJS.ErrnoException).code === SPKI_PIN_MISMATCH_CODE
      settle({ kind: 'network', error, timedOut, spkiMismatch })
    })
    const timer = setTimeout(() => {
      timedOut = true
      req.destroy(new Error(options.timeoutMessage ?? `gateway request timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    timer.unref?.()
    req.on('close', () => clearTimeout(timer))
    const dispatch = (): void => {
      if (options.body === undefined) req.end()
      else if (Buffer.isBuffer(options.body)) req.end(options.body)
      else req.end(JSON.stringify(options.body))
    }
    if (pin === null || options.insecure) dispatch()
    else attachSpkiPinVerifier(req, pin, dispatch)
  })
}
