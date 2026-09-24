/**
 * The dsh RPC wire envelope — single source of truth for the unary fetch-carrier
 * envelope shape and the shared host-identity probe contract.
 *
 * Wire: POST `/api/<method>` (application/json) with a client-request
 * `{type:'client-request', rpcId, method, payload}`; the host answers a
 * server-response `{type:'server-response', rpcId, result}` whose `result.ok`
 * selects the value/error branch.
 *
 * Identity probe: every chamber identity/health/readiness probe converges on
 * `session/canOpenWorkspacePath` (zero-arg Remote → boolean; present since dsh
 * 0.1.2-rc.1), a fixed-size answer that never touches session data. Trees that
 * predate it answer 404 and are served by the legacy `session/list` probe (whose
 * response grows with session data — the one bounded-1 MiB exception). The
 * dsh-runtime activation probe mirrors the same wire by design.
 *
 * Invariants: rpcId is minted by the initiator and must echo back; `payload` passes
 * through verbatim; parseServerResponse NEVER guesses; `result.ok` is not required to
 * be boolean by the shared parse — each consumer applies its own strictness.
 */

import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

/** The client-request wire envelope (exact key order = the wire order). */
export interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

/**
 * The narrow server-response wire envelope as parsed. `result.ok` stays `unknown`
 * on purpose: the parse validates only the structure both consumers share; whether
 * `ok` must be boolean or merely `=== true` is each caller's own strictness.
 */
export interface ServerResponseEnvelope {
  type: 'server-response'
  rpcId: string
  result: {
    ok?: unknown
    value?: unknown
    error?: unknown
  }
}

/** The parse classification of one response body against one expected rpcId. */
export type ServerResponseParse =
  | { kind: 'ok'; envelope: ServerResponseEnvelope }
  /** Not a server-response envelope at all (missing type / rpcId mismatch /
   *  non-object body). */
  | { kind: 'no-envelope' }
  /** A matching server-response whose result slot is not an object. */
  | { kind: 'malformed-result' }

/** Mint a fresh correlation id (the initiator's job per the dsh contract). */
export function mintRpcId(): string {
  return randomUUID()
}

/** Build the client-request wire envelope for one unary call. */
export function buildClientRequest(
  rpcId: string,
  method: string,
  payload: unknown,
): ClientRequestEnvelope {
  return { type: 'client-request', rpcId, method, payload }
}

// Shared host-identity probe contract (single source): every probe sharing this package
// boundary speaks the SAME method, payload shapes and 64 KiB cap so the fetch and
// node:http carriers never drift. dsh-runtime mirrors the wire by design.

/**
 * The unified host-identity probe method: `session/canOpenWorkspacePath`, a zero-arg
 * Typert Remote → boolean on the upstream SessionController. Pure platform detection:
 * no session read, no Agent activation, no IO, so the response is a fixed-size boolean
 * regardless of session count. HTTP 404 = the tree predates it; fall back to legacy.
 */
export const HOST_IDENTITY_METHOD = 'session/canOpenWorkspacePath'

/**
 * Earliest pinned generation whose SessionController registers
 * {@link HOST_IDENTITY_METHOD}; named so the operator-facing legacy-fallback warning
 * has ONE home and a re-anchor changes one line.
 */
export const HOST_IDENTITY_METHOD_SINCE = '0.1.2-rc.1'

/**
 * The legacy host probe method (`session/list`). Its response GROWS with the session
 * list — consumers bound it at 1 MiB and only reach it on an identity-method 404.
 */
export const LEGACY_HOST_PROBE_METHOD = 'session/list'

/**
 * Response cap for the identity probe (64 KiB). The boolean answer is tiny; the cap
 * bounds memory on a misbehaving endpoint with an enormous margin.
 */
export const HOST_PROBE_MAX_RESPONSE_BYTES = 64 * 1024

/** Client-request payload of the zero-arg identity Remote (no typed args). */
export function buildHostIdentityProbePayload(): { args: Record<string, never> } {
  return { args: {} }
}

/** Client-request payload of the legacy session/list probe (the empty typed request is carried by the wire `_request` marker). */
export function buildLegacyHostProbePayload(): { args: { _request: Record<string, never> } } {
  return { args: { _request: {} } }
}

/**
 * The canonical legacy session/list answer shape: a PLAIN RECORD carrying an `items`
 * array. An `ok:true` value with any other shape is a damaged legacy host and must
 * fail closed, never pass a health probe. Single-sourced so the control-plane fallback,
 * dsh-runtime's injected `legacyShape` seam and the desktop SSH probes apply the SAME
 * predicate.
 */
export function isLegacyHostProbeValue(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Array.isArray((value as { items?: unknown }).items)
}

/**
 * Narrow a parsed response body to a matching server-response envelope. Never guesses:
 * anything that is not provably a matching server-response with an object result slot
 * is classified explicitly. `body` null means absent/unparseable — callers treat that
 * exactly like a non-envelope.
 */
export function parseServerResponse(body: unknown, expectedRpcId: string): ServerResponseParse {
  if (typeof body !== 'object' || body === null) return { kind: 'no-envelope' }
  const record = body as Record<string, unknown>
  if (record.type !== 'server-response' || record.rpcId !== expectedRpcId) {
    return { kind: 'no-envelope' }
  }
  if (typeof record.result !== 'object' || record.result === null) {
    return { kind: 'malformed-result' }
  }
  return {
    kind: 'ok',
    envelope: {
      type: 'server-response',
      rpcId: expectedRpcId,
      result: record.result as ServerResponseEnvelope['result'],
    },
  }
}

/** The outcome of one raw unary POST over the node:http carrier. */
export interface RawUnaryOutcome {
  /** HTTP status when the endpoint answered; null when it did not (timeout / connection failure / premature close). */
  status: number | null
  /** Parsed JSON body of a 200 answer; null when absent or unparseable. */
  body: unknown
  /** True when the TOTAL deadline fired before any answer completed. */
  timeout: boolean
  /** True when the 200 body exceeded maxBodyBytes (bounded memory on a misbehaving endpoint). */
  oversized: boolean
}

/**
 * One-shot raw unary call over node:http (the desktop transport probes' carrier; the
 * control-plane unary client uses fetch instead).
 *
 * Semantics: TOTAL deadline, not a socket-idle timeout; non-200 answers resolve
 * immediately with the status (body never accumulated) while 200 bodies accumulate
 * under maxBodyBytes; a premature close after the settle destroy never escapes as an
 * uncaught error; the request is destroyed on settle so a late error is a no-op.
 */
export function postClientRequest(options: {
  url: string
  envelope: ClientRequestEnvelope
  timeoutMs: number
  maxBodyBytes: number
}): Promise<RawUnaryOutcome> {
  const { url, envelope, timeoutMs, maxBodyBytes } = options
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (outcome: RawUnaryOutcome) => {
      if (settled) return
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      // Destroy after settle: a late 'error' is consumed by its own handler (settled guard makes it a no-op).
      req.destroy()
      resolve(outcome)
    }
    const req = httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, res => {
      // A premature close after our destroy must never escape as an uncaught error (main-process safety discipline).
      res.on('error', () => {})
      if (res.statusCode !== 200) {
        // Non-200: the caller classifies from the status alone — never accumulate a non-200 body.
        res.resume()
        done({ status: res.statusCode ?? null, body: null, timeout: false, oversized: false })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', chunk => {
        if (settled) return
        size += chunk.length
        if (size > maxBodyBytes) {
          done({ status: 200, body: null, timeout: false, oversized: true })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (settled) return
        let body: unknown = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          // An unparseable body is not an RPC envelope; null collapses with the absent-body case.
          body = null
        }
        done({ status: 200, body, timeout: false, oversized: false })
      })
    })
    // TOTAL deadline, not a socket-idle timeout: a slow endpoint must never hang the call.
    timer = setTimeout(() => done({ status: null, body: null, timeout: true, oversized: false }), timeoutMs)
    timer.unref?.()
    req.on('error', () => done({ status: null, body: null, timeout: false, oversized: false }))
    req.end(JSON.stringify(envelope))
  })
}
