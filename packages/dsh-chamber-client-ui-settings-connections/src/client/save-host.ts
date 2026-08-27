import type { DesktopSshSurface, SshInstanceInput, SshInstanceSpec, TransportKind } from '../global.d.ts'

type SaveBridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_password'>
type GatewaySaveBridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_gateway_token'>
type SecretClearBridge = Pick<DesktopSshSurface, 'set_password' | 'set_gateway_token'>

export type HostSaveResult =
  | { ok: true; instances: SshInstanceSpec[] }
  | { ok: false; instances: SshInstanceSpec[]; error: string; metadataCommitted: boolean }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameInstances(left: SshInstanceSpec[], right: SshInstanceSpec[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Save non-secret host metadata and its optional secret as one user-visible
 * operation. ORDER DEPENDS ON REGISTRY EXISTENCE (2026 final review fix):
 * - EXISTING host: password FIRST, registry SECOND — a password failure
 *   leaves the registry untouched and the form can retry directly.
 * - NEW host: the main process REFUSES `set_password` for unregistered ids
 *   (desktop_ssh_set_password → 'invalid or unknown instance id'), so the
 *   registry MUST land first; a subsequent password failure is compensated
 *   by restoring the previous registry (design 05 §8 rollback), and
 *   `metadataCommitted` reports whether that rollback itself failed (the
 *   form then turns the committed row into an edit target so a retry can
 *   never be rejected by the duplicate check).
 */
export async function saveHostWithPassword(
  bridge: SaveBridge,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  password: string,
): Promise<HostSaveResult> {
  return saveHostWithSecretSetter(bridge, before, next, instanceId, password, value => bridge.set_password(instanceId, value))
}

/** Gateway equivalent of saveHostWithPassword. The token is write-only and
 * never included in either the registry input or the returned result. */
export async function saveHostWithGatewayToken(
  bridge: GatewaySaveBridge,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  token: string,
): Promise<HostSaveResult> {
  return saveHostWithSecretSetter(bridge, before, next, instanceId, token, value => bridge.set_gateway_token(instanceId, value))
}

/** Clear the credential owned by the PREVIOUS transport kind after the new
 * metadata+credential transaction has committed. The caller deliberately
 * invokes this last: clearing first would make a failed new-secret write
 * impossible to compensate by rolling the old registry metadata back. */
export function clearSupersededTransportSecret(
  bridge: SecretClearBridge,
  instanceId: string,
  previousKind: TransportKind,
  nextKind: TransportKind,
): Promise<{ ok: true } | { error: string }> {
  if (previousKind === nextKind) return Promise.resolve({ ok: true })
  return previousKind === 'gateway'
    ? bridge.set_gateway_token(instanceId, null)
    : bridge.set_password(instanceId, null)
}

/**
 * Shared metadata+secret transaction for both ssh passwords and gateway
 * tokens. The ordering rules from the 2026 final review apply to EITHER
 * secret kind (the main-process gate refuses secret writes for ids that are
 * not yet in the registry):
 * - EXISTING host: secret FIRST, registry SECOND — a refusal leaves the
 *   registry untouched and the form can retry directly.
 * - NEW host: the registry MUST land first; a subsequent secret failure is
 *   compensated by restoring the previous registry (design 05 §8 rollback),
 *   with `metadataCommitted` reporting whether that rollback itself failed
 *   (the form then turns the committed row into an edit target so a retry
 *   can never be rejected by the duplicate check). The secret error text
 *   survives even when the rollback itself fails (2026 round-3 review — the
 *   rollback failure must never masquerade as the secret error).
 */
async function saveHostWithSecretSetter(
  bridge: Pick<DesktopSshSurface, 'instances_get' | 'instances_set'>,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  secret: string,
  setSecret: (value: string) => Promise<{ ok: true } | { error: string }>,
): Promise<HostSaveResult> {
  const exists = before.some(spec => spec.id === instanceId)
  if (exists && secret !== '') {
    // Edit: secret first — a refusal leaves the registry untouched.
    try {
      const result = await setSecret(secret)
      if ('error' in result) return { ok: false, instances: before, error: result.error, metadataCommitted: false }
    } catch (error) {
      return { ok: false, instances: before, error: message(error), metadataCommitted: false }
    }
  }
  let saved: SshInstanceSpec[]
  try {
    saved = await bridge.instances_set(next)
  } catch (error) {
    return { ok: false, instances: before, error: message(error), metadataCommitted: false }
  }
  if (secret === '') return { ok: true, instances: saved }
  if (exists) return { ok: true, instances: saved }

  // New host: the registry landed (secret writes require a registered id);
  // commit the secret, rolling the registry back on failure so a retry
  // never hits the duplicate check with a half-committed row.
  try {
    const result = await setSecret(secret)
    if ('error' in result) return await rollbackNewHost(result.error, saved)
    return { ok: true, instances: saved }
  } catch (error) {
    return await rollbackNewHost(message(error), saved)
  }

  /** New-host secret failure compensation (design 05 §8). */
  async function rollbackNewHost(secretError: string, saved: SshInstanceSpec[]): Promise<HostSaveResult> {
    try {
      const rolledBack = await bridge.instances_set(before)
      return { ok: false, instances: rolledBack, error: secretError, metadataCommitted: false }
    } catch (rollbackError) {
      let authoritative = saved
      try {
        authoritative = await bridge.instances_get()
      } catch {
        // Keep the known post-save snapshot if even the authoritative read is
        // unavailable; the error remains loud and the form stays open.
      }
      return {
        ok: false,
        instances: authoritative,
        error: `${secretError}; host metadata rollback failed: ${message(rollbackError)}`,
        metadataCommitted: !sameInstances(authoritative, before),
      }
    }
  }
}
