/**
 * Gateway restart 409 refusal projection for the runtime section (design 21
 * §5.1/§5.2).
 *
 * The classifier and the verbatim-error projection are single-sourced on the
 * client-core face (dsh-chamber-client-core/src/runtime-refusal.ts):
 * the settings-connections package re-exports
 * the same implementations. This module keeps only what is bridge-local — the
 * bridge dictionary keys and the localized sentence — and re-exports the shared
 * names under their original bridge names for its own callers.
 */

import { classifyRuntimeRefusal, serverRefusalText, type RuntimeRefusalKind } from '@dsh-chamber/dsh-chamber-client-core'

/** The two 409 families the runtime routes answer (the shared union). */
export type BridgeRestartRefusalKind = RuntimeRefusalKind

/**
 * Classify a runtime-action refusal: every 409 yields a projection, any other
 * status yields null. Delegates to the shared classifier — the bridge keeps the
 * name (and this doc) for its own callers; the verdicts live in one place.
 * @param body - the parsed response body.
 * @param status - the HTTP status.
 * @returns the family + code, or null for a non-409.
 */
export function classifyBridgeRestartRefusal(
  body: unknown,
  status: number,
): { kind: BridgeRestartRefusalKind; code: string | null } | null {
  return classifyRuntimeRefusal(body, status)
}

/** The bridge dictionary keys for those families. */
export type BridgeRestartRefusalKey = 'dshRuntimeRestartRefusedNotRunning' | 'dshRuntimeRestartRefusedBusy'

/**
 * Localized text for a restart refusal: a 409 renders the family key with
 * `{code}` interpolated (the numeric status stands in when the body carried
 * none); every other status keeps the verbatim `body.error` (or the
 * status-anchored fallback), byte-identical to the connections projection.
 * @param body - the parsed response body.
 * @param status - the HTTP status.
 * @param t - the bridge dictionary lookup.
 * @returns the text to render.
 */
export function bridgeRestartRefusalText(
  body: unknown,
  status: number,
  t: (key: BridgeRestartRefusalKey) => string,
): string {
  const refusal = classifyBridgeRestartRefusal(body, status)
  if (refusal === null) return serverRefusalText(body, status)
  const key: BridgeRestartRefusalKey = refusal.kind === 'not-running'
    ? 'dshRuntimeRestartRefusedNotRunning'
    : 'dshRuntimeRestartRefusedBusy'
  return t(key).replace('{code}', refusal.code ?? String(status))
}
