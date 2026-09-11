/**
 * Gateway managed-dsh runtime gates and result helpers (design 21 §5.1/§5.3,
 * §6.3 decision 12, §6.8 r1): pure, node-testable classification shared by the
 * connection-card restart/start flows (ConnectionsSection) and the plugin
 * dialog's restart-to-apply action (PluginDialog).
 *
 * Three projections live here, all of them mirroring a core gate the UI cannot
 * import (the gateway route table and the control plane are Node-side):
 *
 * 1. The RESTART gate — /chamber/runtime/restart accepts `ready`/`degraded`
 *    only (runtime-routes.ts); every other probed state is a guaranteed 409, so
 *    the button is disabled instead of offered.
 * 2. The PROBE projection — one probe answer per source; an unavailable answer
 *    (non-200, missing field, transport error) DELETES the entry rather than
 *    leaving a stale value behind.
 * 3. The 409 refusal — {error, code} bodies from the runtime routes are
 *    localized; serverRefusalText projects body.error verbatim for everything
 *    else (English copy there is a registered deviation, design 21 §5.2).
 * 4. The READ-side fence (2026-12 wiring) — the §6.2 read/write fence's 409 on
 *    a gateway READ is a retryable busy state, classified by the SAME 409
 *    classifier (classifyGatewayReadFence) and rendered with a dedicated
 *    dictionary key (gatewayReadFenceText), never as a read failure.
 *
 * The restart action itself is 202 + readiness polling: POST
 * /api/i/gateway-<id>/chamber/runtime/restart accepts with 202 only; a
 * 409/400 refusal carries {error, code}. The readiness poll (pollGatewayReady
 * in the sidebar shared face, gateway-runtime-poll.ts) resolves on success and
 * throws English error strings on failure (restart failed / terminal connection
 * states / 401/403/404 fast fail) or on timeout ('restart accepted but the
 * gateway did not reach ready in time'). classifyRestartError only
 * distinguishes the timeout so the caller can show the localized
 * accepted-but-recovering copy.
 *
 * Self-contained on purpose: no imports outside this file.
 */

/** The poll's English timeout marker (shared gateway-runtime-poll.ts). */
const READY_TIMEOUT_MARKER = 'did not reach ready in time'

/** Runtime connection states the /chamber/runtime/restart route accepts
 *  (runtime-routes.ts: `connectionState !== 'ready' && !== 'degraded'` → 409).
 *  The recovery surface for every other state is POST /chamber/runtime/start
 *  (decision 12). */
const RESTARTABLE_RUNTIME_STATES = new Set(['ready', 'degraded'])

/** How a managed-dsh restart attempt ended (card/panel note projections). */
export type RestartOutcomeKind = 'ok' | 'failed' | 'accepted-timeout'

/**
 * Classify a restart poll/action failure: the accepted-timeout case (the
 * gateway accepted the restart but did not reach ready in the poll window)
 * vs every other failure. The returned detail is the thrown message trimmed
 * (the poll's '<action> failed: <reason>' / '<action> accepted but …' English
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

/**
 * Whether the runtime probe's answer makes a restart a guaranteed 409: the
 * probe HAS answered (a string state) and the core route would refuse it.
 * An absent answer (undefined/null — never probed, or a failed probe that
 * cleared the entry) never blocks: a missing probe must not hide a healthy
 * source. Transitional states (starting/connecting/…) are refused by the same
 * route gate, so they block too — the click would 409 either way.
 */
export function runtimeBlocksRestart(state: string | null | undefined): boolean {
  return typeof state === 'string' && state !== '' && !RESTARTABLE_RUNTIME_STATES.has(state)
}

/**
 * Apply one runtime-probe answer to the per-source projection.
 * @param prev - the current source-id → connectionState map.
 * @param specId - the card's registry id.
 * @param state - the probed connectionState, or null when the probe is
 *   unavailable (non-200 / missing field / transport error).
 * @returns the same object when nothing changed (no needless re-render); the
 *   entry is written for a known state and DELETED for an unavailable probe —
 *   keeping the old value would let a stale `stopped` keep the「启动实例」
 *   action alive and turn every click into another 409.
 */
export function applyRuntimeProbe(
  prev: Record<string, string | undefined>,
  specId: string,
  state: string | null,
): Record<string, string | undefined> {
  if (state === null) {
    if (!(specId in prev)) return prev
    const next = { ...prev }
    delete next[specId]
    return next
  }
  if (prev[specId] === state) return prev
  return { ...prev, [specId]: state }
}

/** The two 409 families the runtime routes answer a UI action with
 *  (gateway/src/runtime-refusals.ts): 'not-running' — the managed dsh itself is
 *  down, so the actionable recovery is /chamber/runtime/start; 'busy' — a
 *  mutation/start/restart is in flight, a profile write holds the lease, or the
 *  runtime needs its recovery route first. Both carry code `runtime_busy` (or
 *  `runtime_recovery_required`), so the code alone cannot tell them apart. */
export type RuntimeRefusalKind = 'not-running' | 'busy'

/** Locale keys the connections dictionary owns for those refusals. */
export type RuntimeRefusalKey = 'restartRefusedNotRunning' | 'restartRefusedBusy' | 'startManagedDshRefused'

/**
 * Classify a runtime-action refusal. Every 409 yields a projection (a 409 body
 * is never shown verbatim, not even a body-less one); any other status yields
 * null so the caller keeps the status-anchored/verbatim projection.
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
 * Localized text for a runtime-action refusal: a 409 renders `keys[kind]` with
 * `{code}` interpolated (the numeric status stands in when the body carried no
 * code), every other status keeps serverRefusalText.
 * @param keys - the caller's locale keys for the two 409 families.
 */
export function runtimeRefusalText(
  body: unknown,
  status: number,
  keys: { notRunning: RuntimeRefusalKey; busy: RuntimeRefusalKey },
  t: (key: RuntimeRefusalKey) => string,
): string {
  const refusal = classifyRuntimeRefusal(body, status)
  if (refusal === null) return serverRefusalText(body, status)
  const key = refusal.kind === 'not-running' ? keys.notRunning : keys.busy
  return t(key).replace('{code}', refusal.code ?? String(status))
}

/* ---- Gateway READ-side fence (design 21 §6.2 读/写面共享栅栏, 2026-12 接线) ----
 * The gateway's A0 read `GET /chamber/plugins/installed` shares the A1 write
 * fence: while a plugin mutation holds the managed-profile write lease the
 * route answers 409 `runtime_busy` (the /chamber/runtime lease family) rather
 * than publishing a torn projection. That 409 is a RETRYABLE BUSY STATE, not a
 * read failure: it must never reach the caller's generic read-error projection
 * (unreachable gateway / 500 / 503, which stay distinguishable) and it must
 * never be folded into an ok shape. Both helpers reuse the SAME 409 classifier
 * as the runtime actions above instead of adding a second taxonomy, and the
 * copy follows runtimeRefusalText's shape (dictionary key + `{code}`). */

/** Locale keys the connections dictionary owns for a fenced gateway read. */
export type GatewayReadFenceKey = 'gatewayReadFencedBusy'

/**
 * Classify a gateway READ refusal: non-null exactly for the fenced 409 family,
 * carrying the server's own code (null when the refusal body carried none —
 * classifyRuntimeRefusal is total for a 409). Every other status yields null,
 * so the caller keeps its own read-error projection: a fenced read and an
 * unreachable/corrupt gateway must never render as the same thing.
 */
export function classifyGatewayReadFence(body: unknown, status: number): { code: string | null } | null {
  const refusal = classifyRuntimeRefusal(body, status)
  return refusal === null ? null : { code: refusal.code }
}

/**
 * Localized copy for a fenced read refusal: `t(key)` with `{code}`
 * interpolated (the numeric status stands in when the body carried no code) —
 * the exact shape runtimeRefusalText renders for runtime actions.
 * @param code - the classified refusal code (classifyGatewayReadFence), or
 *   null when the refusal body carried none.
 * @param status - the refusal's HTTP status (the `{code}` fallback).
 * @param key - the caller's fence locale key.
 */
export function gatewayReadFenceText(
  code: string | null,
  status: number,
  key: GatewayReadFenceKey,
  t: (key: GatewayReadFenceKey) => string,
): string {
  return t(key).replace('{code}', code ?? String(status))
}
