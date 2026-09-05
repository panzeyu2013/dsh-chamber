/**
 * Gateway HTTP scaffolding single sources (audit N1, 2026-09 P3): the
 * byte-identical JSON response writer, the bounded body-reader kernel and the
 * header-value lookups that dispatch.ts / routes.ts / runtime-routes.ts /
 * middleware.ts / auth.ts previously each declared locally. Behavior at every
 * use site is preserved exactly — where callers genuinely differ (header-key
 * casing, ambiguous multi-value handling, per-reader caps/parse/error text),
 * the variants are exported separately and documented with their use sites.
 * Nothing here unifies semantics that differ: dispatch's first-value lookup,
 * middleware's case-insensitive scan and auth's fail-closed single-value
 * lookup are three distinct behaviors (the latter two are locked by the
 * gateway suite), and the body kernel deliberately returns raw bytes because
 * the materialize reader hands its buffer to a binary tgz scan.
 */

import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'

export type HeaderBag = Record<string, string | string[] | undefined>

/** Build a coded error (`.code` is the gateway wire contract). */
export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/**
 * The one JSON response writer (audit N1): `writeHead` with the identical
 * content-type/cache-control pair, then `end(JSON.stringify(body))`. Formerly
 * declared in dispatch.ts, routes.ts and runtime-routes.ts with byte-identical
 * bodies (runtime-routes additionally returned `true`). Returns `true` so
 * route handlers can keep the `return jsonResponse(...)` tail pattern
 * (runtime-routes.ts claims requests with a boolean); statement calls in
 * dispatch.ts / routes.ts simply ignore the value.
 */
export function jsonResponse(res: ApiResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
  return true
}

/** Result of one `readBoundedBody` read. `body` hands the raw collected bytes
 * to the caller: the three text readers decode utf8 at their end-of-body
 * parse, the materialize route needs the raw buffer for the binary tgz scan.
 * Exactly one outcome resolves; every later stream event is a no-op. */
export type BoundedBodyOutcome =
  | { kind: 'body'; buffer: Buffer }
  | { kind: 'oversize' }
  | { kind: 'aborted' }
  | { kind: 'closed' }
  | { kind: 'stream-error'; error: unknown }

/**
 * Bounded request-body collector kernel (audit N1) — the shared inner loop of
 * the four former per-route readers (dispatch readBody 16 KiB, runtime-routes
 * readJsonBody 64 KiB, routes readUploadJsonBody 8 MiB, routes
 * readMaterializeBody ≤ 32 MiB). It ONLY collects raw bytes up to `maxBytes`;
 * every former reader keeps its own cap constant, end-of-body parse/format
 * behavior, error text/code mapping, return shape and (caller-side)
 * 413-then-destroy ordering in a thin wrapper around this kernel.
 *
 * Union-safe event handling (each site's loop was a subset of this): a chunk
 * that trips the cap settles `oversize` without ever inspecting that chunk
 * further; `end` settles `body`; a stream `error` settles `stream-error`
 * with the raw error (dispatch/runtime-routes forwarded it unchanged);
 * `aborted` settles `aborted`; `close` before parser completion settles
 * `closed` (dispatch's historical complete-flag guard — a completed message
 * always settles through `end` first). Listeners are detached and retained
 * bytes dropped on the first settle so a slow/oversized upload cannot pin
 * memory or double-settle. This kernel never destroys the request: the
 * routes write their 413 BEFORE destroying the socket (response-first review
 * fix) and keep that ordering at their call sites.
 */
export function readBoundedBody(req: ApiRequest, maxBytes: number): Promise<BoundedBodyOutcome> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const cleanup = (): void => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
      req.removeListener('close', onClose)
    }
    const settle = (outcome: BoundedBodyOutcome): void => {
      if (settled) return
      settled = true
      chunks.length = 0
      cleanup()
      resolve(outcome)
    }
    const onData = (chunk: Buffer): void => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settle({ kind: 'oversize' })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled) return
      settle({ kind: 'body', buffer: Buffer.concat(chunks) })
    }
    const onError = (error: unknown): void => settle({ kind: 'stream-error', error })
    const onAborted = (): void => settle({ kind: 'aborted' })
    const onClose = (): void => {
      if (settled) return
      if ((req as ApiRequest & { complete?: boolean }).complete !== true) settle({ kind: 'closed' })
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
    req.on('close', onClose)
  })
}

/**
 * First-value header lookup with an EXACT key match: string → the value,
 * array → its first element, anything else → undefined. Formerly
 * dispatch.ts's local `headerValue`; also covers routes.ts's inline
 * host / x-plugin-name / x-plugin-version unpacking (identical shape).
 */
export function headerValue(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name]
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
}

/**
 * Case-insensitive header lookup (keys are compared lowercased; string →
 * value, array → its first element). Formerly middleware.ts's local
 * `headerValue` — the request policy may be evaluated against structural
 * requests whose header keys are not guaranteed lowercased by Node
 * (IncomingHttpHeaders lowercases real traffic; exact lookup would diverge
 * on hand-built doubles, so this variant keeps its own key handling).
 * Dispatch/auth look up already-lowercased or hand-built exact keys with
 * `headerValue` / `headerValueSingle`.
 */
export function headerValueAnyCase(headers: HeaderBag, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
  }
  return undefined
}

/**
 * Fail-closed single-value header lookup: an ARRAY value is ambiguous and
 * yields `undefined`, never the first element. Formerly auth.ts's local
 * `headerValue` — used for credential fields (authorization / cookie) where
 * picking a first value from duplicated lines must fail closed (the real
 * raw-header duplicate rejection lives in middleware.ts's request policy;
 * this guard also keeps direct AuthProvider callers fail-closed, locked by
 * auth.test.ts).
 */
export function headerValueSingle(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name]
  return typeof v === 'string' ? v : undefined
}
