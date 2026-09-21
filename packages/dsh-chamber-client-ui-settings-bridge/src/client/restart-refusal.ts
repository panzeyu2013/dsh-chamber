/**
 * Gateway restart 409 refusal projection for the runtime section (design 21
 * §5.1/§5.2, 2026-12 audit P1-2).
 *
 * The connections package owns the same classifier for the card and the plugin
 * dialog (managed-restart.ts classifyRuntimeRefusal / runtimeRefusalText).
 * The bridge cannot share that code across the plugin boundary, so this is the
 * bridge-local copy of the SAME semantics, and
 * settings-connections/test/runtime-gate/restart-refusal-parity.test.ts drives
 * both modules over one body matrix and asserts identical verdicts — the
 * lockstep the two copies must keep.
 *
 * Dependency-free on purpose: the parity test imports this file in plain node.
 */

/** The two 409 families the runtime routes answer (same as the connections side). */
export type BridgeRestartRefusalKind = 'not-running' | 'busy'

/** The bridge dictionary keys for those families. */
export type BridgeRestartRefusalKey = 'dshRuntimeRestartRefusedNotRunning' | 'dshRuntimeRestartRefusedBusy'

/**
 * Classify a runtime-action refusal: every 409 yields a projection, any other
 * status yields null. The route's wording is the only discriminator it ships.
 * @param body - the parsed response body.
 * @param status - the HTTP status.
 * @returns the family + code, or null for a non-409.
 */
export function classifyBridgeRestartRefusal(
  body: unknown,
  status: number,
): { kind: BridgeRestartRefusalKind; code: string | null } | null {
  if (status !== 409) return null
  const raw = body as { error?: unknown; code?: unknown } | null | undefined
  const code = typeof raw?.code === 'string' && raw.code !== '' ? raw.code : null
  const error = typeof raw?.error === 'string' ? raw.error : ''
  return { kind: /is not running\b/iu.test(error) ? 'not-running' : 'busy', code }
}

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
  if (refusal === null) {
    const error = (body as { error?: unknown } | null | undefined)?.error
    if (typeof error === 'string' && error !== '') return error
    return `restart refused (${status})`
  }
  const key: BridgeRestartRefusalKey = refusal.kind === 'not-running'
    ? 'dshRuntimeRestartRefusedNotRunning'
    : 'dshRuntimeRestartRefusedBusy'
  return t(key).replace('{code}', refusal.code ?? String(status))
}
