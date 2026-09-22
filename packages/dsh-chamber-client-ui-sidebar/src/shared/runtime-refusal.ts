/**
 * Gateway runtime-action refusal projection — the repository's single
 * classifier and verbatim-error projection (2026-12 single-sourcing pass).
 *
 * Two client plugins render this projection from their own dictionaries:
 * settings-connections (connection card + plugin dialog: managed-restart.ts)
 * and settings-bridge (runtime section: restart-refusal.ts). Each used to keep
 * a byte-identical copy plus a hand-written lockstep test
 * (settings-connections/test/runtime-gate/restart-refusal-parity.test.ts).
 * Both pieces are pure functions over (status, body) with no dictionary,
 * transport or privilege dependency, so the pure core lives on the sidebar
 * shared face — the same §5.2 split the gateway-runtime core already uses — and
 * each plugin keeps only its own key mapping and wording.
 *
 * Dependency-free on purpose: both packages' plain-node tests import it.
 */

/** The two 409 families the runtime routes answer a UI action with
 *  (gateway/src/runtime-refusals.ts): 'not-running' — the managed dsh itself is
 *  down, so the actionable recovery is /chamber/runtime/start; 'busy' — a
 *  mutation/start/restart is in flight, a profile write holds the lease, or the
 *  runtime needs its recovery route first. Both carry code 'runtime_busy' (or
 *  'runtime_recovery_required'), so the code alone cannot tell them apart. */
export type RuntimeRefusalKind = 'not-running' | 'busy'

/**
 * Classify a runtime-action refusal. Every 409 yields a projection (a 409 body
 * is never shown verbatim, not even a body-less one); any other status yields
 * null so the caller keeps the status-anchored/verbatim projection.
 * @param body - the parsed response body.
 * @param status - the HTTP status.
 * @returns the family + code, or null for a non-409.
 */
export function classifyRuntimeRefusal(body: unknown, status: number): { kind: RuntimeRefusalKind; code: string | null } | null {
  if (status !== 409) return null
  const raw = body as { error?: unknown; code?: unknown } | null | undefined
  const code = typeof raw?.code === 'string' && raw.code !== '' ? raw.code : null
  const error = typeof raw?.error === 'string' ? raw.error : ''
  // The route's own wording is the only discriminator it ships: "managed dsh
  // is not running (<state>); start the managed dsh …" (restart/apply-now) vs
  // "a restart is already in flight" / "another runtime mutation …" /
  // "runtime recovery … is required". Anything unmatched is a busy family
  // refusal — the safe default, since its advice ("retry later") is harmless.
  return { kind: /is not running\b/iu.test(error) ? 'not-running' : 'busy', code }
}

/**
 * Project a refusal body: body.error verbatim when the server carried one
 * ({error, code} shape — 409/400), else a status-anchored fallback. Byte-equal
 * on both plugin sides before this module existed.
 * @param body - the parsed response body.
 * @param fallbackStatus - the status to anchor the fallback on.
 * @returns the text to render.
 */
export function serverRefusalText(body: unknown, fallbackStatus: number): string {
  const error = (body as { error?: unknown } | null | undefined)?.error
  if (typeof error === 'string' && error !== '') return error
  return `restart refused (${fallbackStatus})`
}
