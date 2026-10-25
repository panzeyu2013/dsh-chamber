/**
 * Bounded ERROR-body probe for the per-instance unary client: the 404
 * domain-missing discrimination AND the 503 not-ready phase (details.state).
 * Extracted from instance-api.ts so the god-file budget can pay for the
 * dispatch-budget integration (net-negative move, behaviour unchanged):
 * the domain-missing decision only needs the tiny \`instance_not_found\` code JSON.
 */

/** 404-body read cap: the domain-missing discrimination only needs the tiny
 *  \`instance_not_found\` code JSON. */
const NOT_FOUND_BODY_CAP_BYTES = 4 * 1024

/**
 * Read at most NOT_FOUND_BODY_CAP_BYTES of an ERROR body and parse the fields
 * the unary client classifies on: `code` (proven-not-forwarded / domain
 * missing), `details.phase` (the proxy's after-body marker) and
 * `details.state` (the local connection phase on an instance-unavailable 503).
 * Oversized or unparseable bodies resolve null — the caller keeps its
 * conservative outcome.
 */
export async function readNotFoundBody(response: Response): Promise<{
  code?: string
  error?: string
  details?: { phase?: unknown; state?: unknown }
} | null> {
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
    // `details.phase` is the proxy's after-body marker; `details.state` is the
    // local connection phase on an instance-unavailable 503. The caller needs
    // both to classify a lost answer and to localize the not-ready phase, so the
    // bounded read carries exactly those two fields.
    const details = (parsed as { details?: unknown }).details
    const phase = details !== null && typeof details === 'object'
      ? (details as { phase?: unknown }).phase
      : undefined
    const state = details !== null && typeof details === 'object'
      ? (details as { state?: unknown }).state
      : undefined
    const message = (parsed as { error?: unknown }).error
    const carriedDetails = {
      ...(typeof phase === 'string' ? { phase } : {}),
      ...(typeof state === 'string' ? { state } : {}),
    }
    return {
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof message === 'string' && message !== '' ? { error: message } : {}),
      ...(Object.keys(carriedDetails).length > 0 ? { details: carriedDetails } : {}),
    }
  } catch {
    return null
  }
}
