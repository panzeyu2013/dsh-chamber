/**
 * Durable credential-domain bindings.
 *
 * A credential file is committed independently from the connection registry.
 * Binding every write-only value to the exact endpoint domain makes a crash
 * between those two fsyncs fail closed: after restart, a value written for a
 * proposed target is invisible while the registry still names the old one.
 */
import { createHash } from 'node:crypto'
import type { TransportInstanceSpec } from './transport-provider.ts'

function fingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** Gateway token/password identity is target-owned, independent of transport,
 * HTTP scheme, SPKI, and SSH-only fields (design 17 §9.1). */
export function gatewayCredentialBinding(spec: TransportInstanceSpec): string | null {
  if (spec.kind !== 'gateway') return null
  return fingerprint(['gateway-credential-v1', spec.kind, spec.host, spec.remotePort])
}

/** SSH password identity belongs only to the SSH endpoint. Target kind,
 * remote dsh port, service metadata and gateway protocol are irrelevant. */
export function sshCredentialBinding(spec: TransportInstanceSpec): string | null {
  if (spec.transport !== 'ssh') return null
  return fingerprint(['ssh-password-v1', spec.host, spec.user, spec.sshPort])
}

export function isCredentialBinding(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
