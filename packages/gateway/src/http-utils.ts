/**
 * Gateway HTTP scaffolding: the JSON response writer, the bounded body-reader
 * kernel and the header-value lookups shared by dispatch / routes /
 * runtime-routes / middleware / auth. Variants that genuinely differ
 * (header-key casing, ambiguous multi-value handling, per-reader caps) stay
 * separate exports — nothing here unifies semantics that differ. The body
 * kernel deliberately returns raw bytes: the materialize reader hands its
 * buffer to a binary tgz scan.
 */

import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'

export type HeaderBag = Record<string, string | string[] | undefined>

/** Build a coded error (`.code` is the gateway wire contract). */
export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/**
 * The one JSON response writer: identical content-type/cache-control pair, then
 * `end(JSON.stringify(body))`; returns `true` for the `return jsonResponse(...)`
 * tail pattern.
 */
export function jsonResponse(res: ApiResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
  return true
}

/** Result of one `readBoundedBody` read. `body` hands the raw collected bytes to
 * the caller (text readers decode utf8 at parse; materialize needs them for the
 * tgz scan). Exactly one outcome resolves; later stream events are no-ops. */
export type BoundedBodyOutcome =
  | { kind: 'body'; buffer: Buffer }
  | { kind: 'oversize' }
  | { kind: 'aborted' }
  | { kind: 'closed' }
  | { kind: 'stream-error'; error: unknown }

/**
 * Bounded request-body collector kernel — the shared inner loop behind the
 * per-route readers (dispatch 16 KiB, runtime-routes 64 KiB, routes 8 MiB,
 * materialize ≤ 32 MiB). It ONLY collects raw bytes up to `maxBytes`; every
 * reader keeps its own cap, parse/format, error mapping and return shape.
 *
 * A chunk that trips the cap settles `oversize`; `end` settles `body`; stream
 * `error`/`aborted`/early `close` settle their outcomes. Listeners detach and retained
 * bytes drop on the first settle (no memory pinning, no double settle); the kernel
 * never destroys the request — routes write 413 BEFORE destroying it.
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

/** First-value header lookup with an EXACT key match: string → value, array → its
 * first element, anything else → undefined (routes.ts unpacks host /
 * x-plugin-name / x-plugin-version the same way). */
export function headerValue(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name]
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
}

/** Case-insensitive header lookup (keys lowercased; string → value, array → its
 * first element). Structural requests may carry non-lowercased keys. */
export function headerValueAnyCase(headers: HeaderBag, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
  }
  return undefined
}

/**
 * Fail-closed single-value header lookup: an ARRAY value is ambiguous and yields
 * `undefined`, never the first element — used for credential fields where a
 * duplicated line must fail closed.
 */
export function headerValueSingle(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name]
  return typeof v === 'string' ? v : undefined
}
