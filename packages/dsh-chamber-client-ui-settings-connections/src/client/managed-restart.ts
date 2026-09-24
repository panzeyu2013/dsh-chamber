/**
 * Gateway managed-dsh runtime gates and result helpers (design 21 §5.1/§6.3/§6.8 r1): pure,
 * node-testable classification shared by the connection-card restart/start flows and the plugin
 * dialog's restart-to-apply action. Four projections, each mirroring a core gate the UI cannot
 * import (the gateway route table and control plane are Node-side):
 * 1. RESTART gate — /chamber/runtime/restart accepts `ready`/`degraded` only; every other probed
 *    state is a guaranteed 409, so the button is disabled instead of offered.
 * 2. PROBE projection — one answer per source; an unavailable answer (non-200, missing field,
 *    transport error) DELETES the entry rather than leaving a stale value behind.
 * 3. 409 refusal — {error, code} bodies from the runtime routes are localized; serverRefusalText
 *    projects body.error verbatim for everything else.
 * 4. READ-side fence — the read/write fence's 409 on a gateway READ is a retryable busy state
 *    (classifyGatewayReadFence + gatewayReadFenceText), never a read failure.
 * The restart action is 202 + readiness polling; classifyRestartError only distinguishes the
 * timeout so the caller can show the accepted-but-recovering copy. The refusal projection is
 * single-sourced on the client-core face; this module re-exports it and keeps the localized wording.
 */

import {
  classifyRuntimeRefusal,
  serverRefusalText,
  type RuntimeRefusalKind,
} from '@dsh-chamber/dsh-chamber-client-core'

// Re-exported under their original names: callers import them from this module, the implementations live in the shared face.
export { classifyRuntimeRefusal, serverRefusalText }
export type { RuntimeRefusalKind }

/** The poll's English timeout marker (shared gateway-runtime-poll.ts). */
const READY_TIMEOUT_MARKER = 'did not reach ready in time'

/** Runtime connection states the /chamber/runtime/restart route accepts (`ready`/`degraded`;
 *  everything else → 409, whose recovery surface is POST /chamber/runtime/start). */
const RESTARTABLE_RUNTIME_STATES = new Set(['ready', 'degraded'])

/**
 * Classify a restart poll/action failure: the accepted-timeout case (accepted but not ready
 * within the poll window) vs every other failure. The returned detail is the thrown message
 * trimmed; the poll's English strings pass through as-is.
 */
export function classifyRestartError(error: unknown): { kind: 'failed' | 'accepted-timeout'; detail: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes(READY_TIMEOUT_MARKER)) {
    return { kind: 'accepted-timeout', detail: '' }
  }
  return { kind: 'failed', detail: message.trim() }
}

/**
 * Whether the runtime probe's answer makes a restart a guaranteed 409: the probe HAS answered
 * (a string state) and the core route would refuse it. An absent answer (never probed, or a
 * failed probe that cleared the entry) never blocks — a missing probe must not hide a healthy
 * source. Transitional states are refused by the same route gate, so they block too.
 */
export function runtimeBlocksRestart(state: string | null | undefined): boolean {
  return typeof state === 'string' && state !== '' && !RESTARTABLE_RUNTIME_STATES.has(state)
}

/**
 * Apply one runtime-probe answer to the per-source projection.
 * @param prev - the current source-id → connectionState map.
 * @param state - the probed connectionState, or null when the probe is unavailable.
 * @returns the same object when nothing changed (no needless re-render); the entry is written for
 *   a known state and DELETED for an unavailable probe — keeping the old value would let a stale
 *   `stopped` keep「启动实例」alive and turn every click into another 409.
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

/** Locale keys the connections dictionary owns for those refusals. */
export type RuntimeRefusalKey = 'restartRefusedNotRunning' | 'restartRefusedBusy' | 'startManagedDshRefused'

/**
 * Localized text for a runtime-action refusal: a 409 renders `keys[kind]` with `{code}`
 * interpolated (the numeric status stands in when the body carried no code), every other status
 * keeps serverRefusalText.
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

/* ---- Gateway READ-side fence ----
 * The A0 read `GET /chamber/plugins/installed` shares the A1 write fence: while a plugin mutation
 * holds the managed-profile write lease the route answers 409 `runtime_busy` rather than publishing
 * a torn projection. That 409 is a RETRYABLE BUSY STATE, never a read failure and never folded into
 * an ok shape; both helpers reuse the SAME 409 classifier as the runtime actions, and the copy
 * follows runtimeRefusalText's shape. */

/** Locale keys the connections dictionary owns for a fenced gateway read. */
export type GatewayReadFenceKey = 'gatewayReadFencedBusy'

/**
 * Classify a gateway READ refusal: non-null exactly for the fenced 409 family, carrying the
 * server's own code (null when the refusal body carried none). Every other status yields null, so
 * the caller keeps its own read-error projection — a fenced read and an unreachable/corrupt
 * gateway must never render as the same thing.
 */
export function classifyGatewayReadFence(body: unknown, status: number): { code: string | null } | null {
  const refusal = classifyRuntimeRefusal(body, status)
  return refusal === null ? null : { code: refusal.code }
}

/**
 * Localized copy for a fenced read refusal: `t(key)` with `{code}` interpolated (the numeric
 * status stands in when the body carried no code) — the exact shape runtimeRefusalText renders.
 * @param code - the classified refusal code, or null when the body carried none.
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
