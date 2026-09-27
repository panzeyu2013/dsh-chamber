/**
 * The ONE gateway managed-dsh restart action: POST /chamber/runtime/restart → 202 → readiness poll.
 * The connection card calls this function and maps its outcome onto its own per-card note, so every
 * restart entry shares one refusal copy and one readiness poll.
 *
 * Not in managed-restart.ts: that module is deliberately pure and import-free (its classifiers
 * are plain-node tested). This action owns the transport and the readiness poll, hence it
 * imports fetch/poll — one implementation, one call site.
 */
import { pollGatewayReady } from '@dsh-chamber/dsh-chamber-client-core'
import { classifyRestartError, runtimeRefusalText, type RuntimeRefusalKey } from './managed-restart.ts'
import { errorMessage } from './error-text.ts'

/** How one managed-dsh restart attempt ended (the caller owns the note/UI). */
export type ManagedRestartOutcome =
  /** The managed dsh is serving again (the readiness poll settled). */
  | { kind: 'served' }
  /** The restart was accepted; readiness did not settle inside the poll window. */
  | { kind: 'accepted-timeout' }
  /** The route refused the action (409/400) — localized copy, ready to render. */
  | { kind: 'refused'; text: string }
  /** Transport/poll failure with its own English detail. */
  | { kind: 'failed'; detail: string }

/** The 409 families every restart entry renders with the same dictionary keys. */
export const MANAGED_RESTART_REFUSAL_KEYS: { notRunning: RuntimeRefusalKey; busy: RuntimeRefusalKey } = {
  notRunning: 'restartRefusedNotRunning',
  busy: 'restartRefusedBusy',
}

/**
 * Run one managed-dsh restart against a gateway source.
 * @param deps.fetchImpl - test seam; defaults to the page fetch.
 * @returns the outcome; never throws (every failure is a returned arm).
 */
export async function runManagedRestart(
  sourceId: string,
  t: (key: RuntimeRefusalKey) => string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ManagedRestartOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`/api/i/${sourceId}/chamber/runtime/restart`, { method: 'POST' })
  } catch (error) {
    return { kind: 'failed', detail: errorMessage(error) }
  }
  if (response.status !== 202) {
    // The route's {error, code} refusal is localized by the shared 409 classifier (not-running vs
    // busy); every other status keeps the status-anchored/verbatim projection runtimeRefusalText owns.
    let body: unknown = null
    try { body = await response.json() } catch { body = null }
    return { kind: 'refused', text: runtimeRefusalText(body, response.status, MANAGED_RESTART_REFUSAL_KEYS, t) }
  }
  // The 202 only accepts the restart: the readiness poll decides whether the success note is honest
  // (pollGatewayReady owns its own 120s ceiling and classification). The poll failure is kept for the
  // panel's copy; accepted-timeout = the restart IS accepted and still recovering (ok tone).
  try {
    await pollGatewayReady(sourceId, undefined, { action: 'restart' })
    return { kind: 'served' }
  } catch (error) {
    const cls = classifyRestartError(error)
    return cls.kind === 'accepted-timeout' ? { kind: 'accepted-timeout' } : { kind: 'failed', detail: cls.detail }
  }
}
