/**
 * The ONE gateway managed-dsh restart action: POST /chamber/runtime/restart → 202 → PAGE-owned
 * readiness poll → reload. The connection card and the plugin dialog BOTH call this function and
 * map its outcome onto their own note/UI, so their refusal copy stays one source.
 *
 * Not in managed-restart.ts: that module is deliberately pure and import-free (its classifiers
 * are plain-node tested). This action owns the transport and the page-owned completion, hence it
 * imports fetch/poll/reload — exactly one implementation for both call sites.
 */
import {
  RESTART_RELOAD_BUDGET_MS,
  armWindowReloadWhenServed,
  pollGatewayReady,
} from '@dsh-chamber/dsh-chamber-client-core'
import { classifyRestartError, runtimeRefusalText, type RuntimeRefusalKey } from './managed-restart.ts'
import { errorMessage } from './error-text.ts'

/** How one managed-dsh restart attempt ended (the caller owns the note/UI). */
export type ManagedRestartOutcome =
  /** The managed dsh is serving again and the page reloaded onto it. */
  | { kind: 'reloaded' }
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
  // Readiness + reload are PAGE-owned: closing the card/dialog mid-restart cannot cancel the completion.
  let pollFailure: unknown = null
  const outcome = await armWindowReloadWhenServed(sourceId, async signal => {
    try {
      await pollGatewayReady(sourceId, signal, { action: 'restart' })
      return true
    } catch (error) {
      pollFailure = error
      return false
    }
  }, { budgetMs: RESTART_RELOAD_BUDGET_MS })
  if (outcome === 'reloaded') return { kind: 'reloaded' }
  // accepted-timeout = the restart IS accepted and still recovering (ok tone); everything else keeps the poll's English detail.
  const cls = classifyRestartError(pollFailure
    ?? new Error('restart completion aborted before the readiness poll settled'))
  return cls.kind === 'accepted-timeout' ? { kind: 'accepted-timeout' } : { kind: 'failed', detail: cls.detail }
}
