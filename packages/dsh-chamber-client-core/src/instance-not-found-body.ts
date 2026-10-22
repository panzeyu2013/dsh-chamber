/**
 * Bounded 404-body probe for the per-instance unary client's domain-missing
 * discrimination. Extracted from instance-api.ts so the god-file budget can pay
 * for the dispatch-budget integration (net-negative move, behaviour unchanged):
 * the domain-missing decision only needs the tiny \`instance_not_found\` code JSON.
 */

/** 404-body read cap: the domain-missing discrimination only needs the tiny
 *  \`instance_not_found\` code JSON. */
const NOT_FOUND_BODY_CAP_BYTES = 4 * 1024

/**
 * Read at most NOT_FOUND_BODY_CAP_BYTES of an ERROR body and parse the two
 * fields the unary client classifies on: `code` (proven-not-forwarded / domain
 * missing) and `details.phase` (the proxy's after-body marker). Oversized or
 * unparseable bodies resolve null — the caller keeps its conservative outcome.
 */
export async function readNotFoundBody(response: Response): Promise<{ code?: string; error?: string; details?: { phase?: unknown } } | null> {
  try {
    const body = response.body
    if (body === null) return null
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > NOT_FOUND_BODY_CAP_BYTES) {
        // Give up past the cap: cancel the rest of the stream and keep the
        // conservative null outcome.
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const code = (parsed as { code?: unknown }).code
    // `details.phase` is the proxy's after-body marker; the caller must see it to
    // classify a lost answer, so the bounded read carries the one field it needs.
    const details = (parsed as { details?: unknown }).details
    const phase = details !== null && typeof details === 'object'
      ? (details as { phase?: unknown }).phase
      : undefined
    const message = (parsed as { error?: unknown }).error
    return {
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof message === 'string' && message !== '' ? { error: message } : {}),
      ...(typeof phase === 'string' ? { details: { phase } } : {}),
    }
  } catch {
    return null
  }
}
