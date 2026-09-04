/**
 * Gateway managed-dsh restart result helpers (design 21 §5.1/§5.3): pure,
 * node-testable classification shared by the connection-card restart flow
 * (ConnectionsSection) and the plugin dialog's restart-to-apply action
 * (PluginDialog).
 *
 * The restart action is 202 + readiness polling: POST
 * /api/i/gateway-<id>/chamber/runtime/restart accepts with 202 only; a
 * 409/400 refusal carries {error, code} — serverRefusalText projects body.error
 * verbatim. The readiness poll (pollGatewayReady in the sidebar shared face,
 * gateway-runtime-poll.ts) resolves on success and throws English error strings
 * on failure (restart failed / terminal connection states / 401/403/404 fast
 * fail) or on timeout ('restart accepted but the gateway did not reach ready in
 * time'). Those English strings are unlocalized on purpose (registered in
 * design 21 §5.2); classifyRestartError only distinguishes the timeout so the
 * caller can show the localized accepted-but-recovering copy.
 *
 * Self-contained on purpose: no imports outside this file.
 */

/** The poll's English timeout marker (shared gateway-runtime-poll.ts). */
const READY_TIMEOUT_MARKER = 'did not reach ready in time'

/** How a managed-dsh restart attempt ended (card/panel note projections). */
export type RestartOutcomeKind = 'ok' | 'failed' | 'accepted-timeout'

/**
 * Classify a restart poll/action failure: the accepted-timeout case (the
 * gateway accepted the restart but did not reach ready in the poll window)
 * vs every other failure. The returned detail is the thrown message trimmed
 * (the poll's 'restart failed: <reason>' / 'restart accepted but …' English
 * strings pass through as-is; unlocalized copy is registered acceptable).
 */
export function classifyRestartError(error: unknown): { kind: 'failed' | 'accepted-timeout'; detail: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes(READY_TIMEOUT_MARKER)) {
    return { kind: 'accepted-timeout', detail: '' }
  }
  return { kind: 'failed', detail: message.trim() }
}

/**
 * Project a restart refusal body: body.error verbatim when the server carried
 * one ({error, code} shape — 409/400), else a status-anchored fallback text.
 */
export function serverRefusalText(body: unknown, fallbackStatus: number): string {
  const error = (body as { error?: unknown } | null | undefined)?.error
  if (typeof error === 'string' && error !== '') return error
  return `restart refused (${fallbackStatus})`
}
