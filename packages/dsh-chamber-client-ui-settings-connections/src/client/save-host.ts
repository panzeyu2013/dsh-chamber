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
 * operation. The stores are intentionally separate, so a password failure is
 * compensated by restoring the previous registry. If compensation itself
 * rejects, re-read the authoritative registry before reporting whether the
 * metadata actually committed; this avoids duplicate retries for a new host.
 */
export async function saveHostWithPassword(
  bridge: SaveBridge,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  password: string,
): Promise<HostSaveResult> {
  return saveHostWithSecretSetter(bridge, before, next, password, value => bridge.set_password(instanceId, value))
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
  return saveHostWithSecretSetter(bridge, before, next, token, value => bridge.set_gateway_token(instanceId, value))
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

async function saveHostWithSecretSetter(
  bridge: Pick<DesktopSshSurface, 'instances_get' | 'instances_set'>,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  secret: string,
  setSecret: (value: string) => Promise<{ ok: true } | { error: string }>,
): Promise<HostSaveResult> {
  const saved = await bridge.instances_set(next)
  if (secret === '') return { ok: true, instances: saved }

  let secretError: string | null = null
  try {
    const result = await setSecret(secret)
    if ('error' in result) secretError = result.error
  } catch (error) {
    secretError = message(error)
  }
  if (secretError === null) return { ok: true, instances: saved }

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
