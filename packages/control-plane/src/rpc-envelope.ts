/**
 * The dsh RPC wire envelope — single source of truth for the unary
 * fetch-carrier envelope shape (A2 cross-package protocol single-sourcing).
 *
 * The dsh unary contract (mirror of @deepseek-ai/dsh-api-session-controller
 * src/client/contract — dsh-host-apiproxy was deleted upstream in
 * dsh-v0.1.2-alpha.1): a client-request `{type:'client-request', rpcId, method,
 * payload}` is POSTed to `/api/<method>` (content-type application/json) and
 * the host answers with a server-response `{type:'server-response', rpcId,
 * result}` whose `result.ok` boolean selects the value/error branch.
 *
 * Three implementations previously re-derived this shape:
 *   - control-plane dsh-client.ts `call()` (fetch carrier);
 *   - desktop ssh-provider.ts `verifyDshEndpoint` (node:http carrier,
 *     unary identity probe);
 *   - desktop ssh-provider.ts `probeRemoteMethod` (node:http carrier, Remote
 *     liveness probes).
 * This module owns the shared primitives; the consumers keep their own
 * transport orchestration (fetch vs node:http, pending tables, deadlines)
 * and only the wire shape / validation is centralized here.
 *
 * Invariants:
 * - rpcId is minted by the initiator on every unary call and echoes back in
 *   the server-response; a mismatch is a protocol violation.
 * - `payload` is passed through verbatim (a plain unary probe sends `{}`,
 *   Remote calls send `{args}` — both are caller decisions).
 * - parseServerResponse NEVER guesses: a body that is not a matching
 *   server-response, or whose result slot is not an object, is classified
 *   explicitly (no-envelope / malformed-result) so every caller keeps its
 *   exact failure semantics.
 * - `result.ok` is NOT enforced to be a boolean by the parse (the desktop
 *   probes treat `ok === true` vs "anything else" differently from the unary
 *   client, which requires a boolean) — each consumer applies its own
 *   strictness after the shared structural check.
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
 * The narrow server-response wire envelope as parsed from a response body.
 * `result.ok` stays `unknown` here on purpose: the parse validates only the
 * STRUCTURE both consumers share (type + rpcId echo + an object result
 * slot); whether `ok` must be a boolean (the unary client) or merely
 * `=== true` (the desktop probes) is each caller's own strictness.
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

/**
 * Narrow a parsed response body to a matching server-response envelope.
 * Never guesses: any shape that is not provably a matching server-response
 * with an object result slot is classified explicitly (see ServerResponseParse).
 * @param body - the parsed response JSON (null when the body was absent or
 *   unparseable — the callers treat that exactly like a non-envelope).
 * @param expectedRpcId - the rpcId this client-request minted; a mismatch is
 *   a protocol violation, never silently accepted.
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
  /** HTTP status when the endpoint answered; null when it did not (timeout /
   *  connection failure / premature close). */
  status: number | null
  /** Parsed JSON body of a 200 answer; null when absent or unparseable. */
  body: unknown
  /** True when the TOTAL deadline fired before any answer completed. */
  timeout: boolean
  /** True when the 200 body exceeded maxBodyBytes (bounded memory on a
   *  misbehaving endpoint — an oversized answer is not an RPC envelope). */
  oversized: boolean
}

/**
 * One-shot raw unary call over node:http (the desktop transport probes'
 * carrier — verifyDshEndpoint / probeRemoteMethod; the control-plane unary
 * client uses fetch and does not route through here).
 *
 * Semantics preserved from the previous inline implementations:
 * - TOTAL deadline, not a socket-idle timeout: an endpoint answering slowly
 *   (a byte every few seconds) must never hang the call.
 * - Non-200 answers resolve immediately with the status (body never
 *   accumulated); 200 answers are accumulated under maxBodyBytes.
 * - A premature close after the settle destroy never escapes as an uncaught
 *   error (main-process safety discipline: both the request and the response
 *   carry no-op error handlers after settle).
 * - The request is destroyed on settle so a late error is consumed by its
 *   own handler and the settled guard makes it a no-op.
 * @param options - {url} the POST target, {envelope} the client-request to
 *   send (JSON.stringify'd verbatim — key order preserved), {timeoutMs} the
 *   total deadline, {maxBodyBytes} the 200-body cap.
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
      // Destroy after settle: any late 'error' on the request is consumed by
      // its own handler below (settled guard makes it a no-op).
      req.destroy()
      resolve(outcome)
    }
    const req = httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, res => {
      // A premature close after our destroy must never escape as an
      // uncaught error (main-process safety discipline).
      res.on('error', () => {})
      if (res.statusCode !== 200) {
        // Non-200: the caller classifies from the status alone (dsh-signature
        // probe, 404-is-deterministic gateway semantics) — never accumulate
        // a non-200 body.
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
          // An unparseable body is not an RPC envelope; null collapses with
          // the absent-body case (every consumer treats it the same way).
          body = null
        }
        done({ status: 200, body, timeout: false, oversized: false })
      })
    })
    // TOTAL deadline, not the socket-idle timeout: an endpoint that answers
    // slowly must never hang the call.
    timer = setTimeout(() => done({ status: null, body: null, timeout: true, oversized: false }), timeoutMs)
    timer.unref?.()
    req.on('error', () => done({ status: null, body: null, timeout: false, oversized: false }))
    req.end(JSON.stringify(envelope))
  })
}
