/**
 * chamber patch — rc.8 `commands.execute` wire compatibility bridge
 * (design 09 §3.3 版本容忍修订 2026-08).
 *
 * dsh 0.1.0-rc.8 added a REQUIRED `images` argument to the host
 * `commands.execute` Typert Remote (upstream 8d9fee19f9 "route composer image
 * attachments through slash commands", review round 4ed283a2ba), inserted
 * between `line` and `signal`. An rc.7-shaped client (this shell's composite
 * bundle) omits the argument, so against rc.8+ hosts every composer slash
 * command — the Access permission chip's `/permission` switch included — fails
 * at the gateway (strict descriptors reject the missing field) or inside the
 * host (`images.length` on undefined), and the UI silently does nothing
 * (PermissionSelect swallows the command error).
 *
 * This module bridges the skew CLIENT-side, keyed on the AUTHORITATIVE host
 * version from `host.describe` (never a heuristic): rc.8+ hosts get the
 * `images: []` argument injected into the typert args envelope; rc.7-era
 * hosts are left byte-identical (an extra field there is rejected by the
 * gateway's exact-argument check, so the shim must never fire for them).
 *
 * TEMPORARY BRIDGE — remove this module and its wiring when the chamber shell
 * aligns to the rc.8 baseline (harness.commit → 141eb6fef8, design 09 §4
 * 待办): the rc.8 client then always sends `images: []` itself and the
 * rewrite is dead code.
 */

/** The generic-RPC endpoint of the host command executor. */
export const COMMANDS_EXECUTE_ENDPOINT = 'commands/execute'

/**
 * Whether an rc.8-shaped `commands.execute` call must carry the `images`
 * argument: true for every host version that semver-sorts at or after
 * `0.1.0-rc.8` (the release that introduced the argument). Unknown or
 * malformed version strings conservatively answer false — never risk an
 * extra field against an unknown host.
 */
export function needsCommandsImagesArg(version: string | undefined): boolean {
  if (version === undefined) return false
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const rc = match[4] === undefined ? undefined : Number(match[4])
  if (major > 0 || (major === 0 && (minor > 1 || (minor === 1 && patch > 0)))) return true
  if (major !== 0 || minor !== 1 || patch !== 0) return false
  // On the 0.1.0 line: the stable release and every rc number >= 8 sort
  // after rc.8 (semver pre-release ordering), so they carry the argument too.
  return rc === undefined || rc >= 8
}

/**
 * Ensure a `commands/execute` typert payload carries `images: []`
 * (non-mutating — builds fresh envelopes so a frozen caller object can never
 * be tripped).
 * @param payload - the `{ args }` envelope the api-gateway client passes to
 *   the generic RPC channel (`connection.rpc.call('/api', endpoint, { args })`).
 * @returns the payload, with `images: []` added to `args` when absent;
 *   anything that is not a plain `{ args }` envelope passes through untouched.
 */
export function withCommandsImagesArg(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  const envelope = payload as { args?: unknown }
  const args = envelope.args
  if (typeof args !== 'object' || args === null) return payload
  const record = args as Record<string, unknown>
  if (Object.hasOwn(record, 'images')) return payload
  return { ...envelope, args: { ...record, images: [] } }
}

/**
 * The full compat decision for one `commands/execute` call: apply the rewrite
 * exactly when the authoritative host version needs it.
 * @param payload - the typert `{ args }` envelope.
 * @param version - the host version string from `host.describe` (undefined
 *   while not connected / reconnecting).
 * @returns the payload to send.
 */
export function applyCommandsExecuteCompat(payload: unknown, version: string | undefined): unknown {
  return needsCommandsImagesArg(version) ? withCommandsImagesArg(payload) : payload
}
