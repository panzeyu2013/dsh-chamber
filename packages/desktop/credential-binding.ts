/**
 * Durable credential-domain bindings: the credential file commits independently
 * of the connection registry, so binding every write-only value to its exact
 * endpoint domain makes a crash between the two fsyncs fail closed — after
 * restart a value written for a proposed target is invisible while the registry
 * still names the old one.
 */
import { createHash } from 'node:crypto'
import type { TransportInstanceSpec } from './transport-provider.ts'
import { gatewayCredentialTargetIdentity } from './credential-identity.ts'

function fingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** Gateway identity is target-owned: transport, HTTP scheme, SPKI and SSH-only
 * fields are excluded. */
export function gatewayCredentialBinding(spec: TransportInstanceSpec): string | null {
  const target = gatewayCredentialTargetIdentity(spec)
  return target === null ? null : fingerprint(['gateway-credential-v1', target.kind, target.host, target.remotePort])
}

/** SSH password identity belongs only to the SSH endpoint; target kind, remote
 * dsh port, service metadata and gateway protocol are irrelevant. */
function sshCredentialBindingForEndpoint(
  host: string,
  user: string | null,
  sshPort: number | null,
): string {
  return fingerprint(['ssh-password-v1', host, user, sshPort])
}

export function sshCredentialBinding(spec: TransportInstanceSpec): string | null {
  if (spec.transport !== 'ssh') return null
  return sshCredentialBindingForEndpoint(spec.host, spec.user, spec.sshPort)
}

export function isCredentialBinding(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
