/**
 * The ONE gateway managed-dsh restart action: POST /chamber/runtime/restart → 202 → readiness poll.
 * The connection card calls this function and maps its outcome onto its own per-card note, so every
 * restart entry shares one refusal copy and one readiness poll.
 *
 * Not in managed-restart.ts: that module is deliberately pure and import-free (its classifiers
 * are plain-node tested). This action owns the transport and the readiness poll, hence it
 * imports fetch/poll — one implementation, one call site.
 */
import { REMOTE_RUNTIME_CONTROL_TIMEOUT_MS, pollGatewayReady, type GatewayPollDeps } from '@dsh-chamber/dsh-chamber-client-core'
import {
  HttpBudgetUnscheduledError, httpBudgetLaneFor, httpBudgetLeaseFor, remainingDispatchBudgetMs, runWithHttpBudget,
} from '@dsh-chamber/dsh-chamber-client-core/http-budget'
import { classifyRestartError, runtimeRefusalText, type RuntimeRefusalKey } from './managed-restart.ts'
import { errorMessage } from './error-text.ts'

/** POST ceiling. The route answers 202 immediately (it only awaits one cheap
 *  runtime status read), so a long ceiling would only park a budget slot on a
 *  wedged hop; the readiness poll owns its own 120s window. One literal with the
 *  core control helper: two independent 30s constants would drift silently. */
export const MANAGED_RESTART_POST_TIMEOUT_MS = REMOTE_RUNTIME_CONTROL_TIMEOUT_MS

/** Seams for the restart action (the poll seams plus the POST ceiling). */
export interface ManagedRestartDeps extends Omit<GatewayPollDeps, 'action'> {
  /** POST ceiling override for tests (default MANAGED_RESTART_POST_TIMEOUT_MS). */
  requestTimeoutMs?: number
}

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
 * @param deps - the readiness-poll seams (fetchImpl/sleepMs/timeoutMs/pollIntervalMs), forwarded verbatim.
 * @returns the outcome; never throws (every failure is a returned arm).
 */
export async function runManagedRestart(
  sourceId: string,
  t: (key: RuntimeRefusalKey) => string,
  deps: ManagedRestartDeps = {},
): Promise<ManagedRestartOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const postTimeoutMs = deps.requestTimeoutMs ?? MANAGED_RESTART_POST_TIMEOUT_MS
  let result: { status: number; body: unknown }
  let postTimedOut = false
  try {
    result = await runWithHttpBudget({
      sourceId,
      kind: 'unary',
      lane: httpBudgetLaneFor(sourceId),
      leaseMs: httpBudgetLeaseFor(postTimeoutMs),
      queueDeadlineAt: Date.now() + 10_000,
      label: 'managed-restart',
    }, async (slot) => {
      // The POST's own ceiling starts at DISPATCH (inside the slot): a queue wait
      // is bounded separately by queueDeadlineAt and must not spend this budget.
      const controller = new AbortController()
      // The ceiling covers the caller's window: what the page queue already spent is
      // not available to the carrier (same rule as remoteRuntimeControl).
      const timer = setTimeout(() => { postTimedOut = true; controller.abort() },
        remainingDispatchBudgetMs(postTimeoutMs, slot.queuedMs))
      try {
        const response = await fetchImpl(`/api/i/${sourceId}/chamber/runtime/restart`, {
          method: 'POST',
          signal: controller.signal,
        })
        // The refusal body is part of the in-flight connection: read it inside the
        // slot so a stalled body cannot outlive the budget (202 needs no body).
        const body: unknown = response.status === 202 ? null : await response.json().catch(() => null)
        return { status: response.status, body }
      } finally {
        clearTimeout(timer)
      }
    })
  } catch (error) {
    if (error instanceof HttpBudgetUnscheduledError) {
      // Page-local refusal: a localized deterministic arm, never a source failure.
      return { kind: 'refused', text: t('restartNotDispatched') }
    }
    if (postTimedOut) {
      // Unknown outcome by construction: the POST may or may not have been accepted.
      return { kind: 'failed', detail: `restart request timed out after ${String(postTimeoutMs)}ms; the runtime state is unknown — check the connection` }
    }
    return { kind: 'failed', detail: errorMessage(error) }
  }
  if (result.status !== 202) {
    // The route's {error, code} refusal is localized by the shared 409 classifier (not-running vs
    // busy); every other status keeps the status-anchored/verbatim projection runtimeRefusalText owns.
    return { kind: 'refused', text: runtimeRefusalText(result.body, result.status, MANAGED_RESTART_REFUSAL_KEYS, t) }
  }
  // The 202 only accepts the restart: the readiness poll decides whether the success note is honest
  // (pollGatewayReady owns its own 120s ceiling and classification). The poll failure is kept for the
  // panel's copy; accepted-timeout = the restart IS accepted and still recovering (ok tone).
  try {
    await pollGatewayReady(sourceId, { ...deps, action: 'restart' })
    return { kind: 'served' }
  } catch (error) {
    const cls = classifyRestartError(error)
    return cls.kind === 'accepted-timeout' ? { kind: 'accepted-timeout' } : { kind: 'failed', detail: cls.detail }
  }
}
