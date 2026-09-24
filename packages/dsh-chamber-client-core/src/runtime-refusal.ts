/**
 * Gateway runtime-action refusal projection: the single classifier plus
 * verbatim-error projection, shared by the two client plugins that render it
 * (settings-connections, settings-bridge); each keeps only its own key mapping
 * and wording. Pure over (status, body), with no dictionary, transport or
 * privilege dependency.
 */

/** The two 409 families a UI runtime action can hit: 'not-running' — the managed
 *  dsh is down, recovery is /chamber/runtime/start; 'busy' — a mutation or
 *  start/restart is in flight, a profile write holds the lease, or recovery is
 *  required first. Both carry code 'runtime_busy'/'runtime_recovery_required',
 *  so the code alone cannot tell them apart. */
export type RuntimeRefusalKind = 'not-running' | 'busy'

/** Classify a runtime-action refusal: every 409 yields a projection (a 409 body
 *  is never shown verbatim, not even a body-less one); any other status yields
 *  null, keeping the caller's status-anchored/verbatim projection. */
export function classifyRuntimeRefusal(body: unknown, status: number): { kind: RuntimeRefusalKind; code: string | null } | null {
  if (status !== 409) return null
  const raw = body as { error?: unknown; code?: unknown } | null | undefined
  const code = typeof raw?.code === 'string' && raw.code !== '' ? raw.code : null
  const error = typeof raw?.error === 'string' ? raw.error : ''
  // Route wording is the only discriminator ("is not running" vs "already in
  // flight"/"another runtime mutation"/"recovery required"); unmatched -> 'busy'.
  return { kind: /is not running\b/iu.test(error) ? 'not-running' : 'busy', code }
}

/** Project a refusal body: body.error verbatim when present, else `restart refused (<status>)`. */
export function serverRefusalText(body: unknown, fallbackStatus: number): string {
  const error = (body as { error?: unknown } | null | undefined)?.error
  if (typeof error === 'string' && error !== '') return error
  return `restart refused (${fallbackStatus})`
}
