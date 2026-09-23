/**
 * Credential / live-transport identity predicates (design 17 §9.1/§9.3) —
 * the SINGLE source for "which spec fields make two connections the same
 * target". Each predicate has its production consumers: the live-transport
 * comparison (connection-save metadataNeedsRestart + transport-manager
 * saveInstances), the SSH credential endpoint (connection-save sshRetarget)
 * and the gateway credential-target pair (connection-save
 * gatewayCredentialTargetChanged + credential-binding's fingerprint). A new
 * spec field has ONE place to be classified, in or out, for each identity.
 *
 * Ownership rules (design 17 §9.1):
 * - the LIVE transport identity decides proxy re-registration + restart;
 * - an SSH password belongs to the SSH endpoint (host/user/sshPort);
 * - a gateway token/password belongs to the gateway deployment (host +
 *   remotePort); scheme, SPKI pin and SSH-only fields never retarget it.
 */
import type { TransportInstanceSpec } from './transport-provider.ts'

export type LiveTransportIdentityField =
  | 'kind' | 'transport' | 'host' | 'user' | 'sshPort' | 'remotePort'
  | 'serviceName' | 'remoteDshHome' | 'insecureHttp' | 'spkiPin'

export type SshCredentialEndpointField = 'host' | 'user' | 'sshPort'

export type GatewayCredentialTargetField = 'kind' | 'host' | 'remotePort'

/** True when the change requires tearing the live transport down/restarting
 *  it so the proxy URL never disagrees with the mechanism. Presentation-only
 *  fields (label) are absent by construction. */
export function liveTransportIdentityChanged(
  previous: Pick<TransportInstanceSpec, LiveTransportIdentityField>,
  next: Pick<TransportInstanceSpec, LiveTransportIdentityField>,
): boolean {
  return previous.kind !== next.kind
    || previous.transport !== next.transport
    || previous.host !== next.host
    || previous.user !== next.user
    || previous.sshPort !== next.sshPort
    || previous.remotePort !== next.remotePort
    || previous.serviceName !== next.serviceName
    || previous.remoteDshHome !== next.remoteDshHome
    || previous.insecureHttp !== next.insecureHttp
    || previous.spkiPin !== next.spkiPin
}

/** SSH password identity: the authentication endpoint triple. forwarded port,
 *  service and home edits keep the stored password. */
export function sshCredentialEndpointChanged(
  previous: Pick<TransportInstanceSpec, SshCredentialEndpointField>,
  next: Pick<TransportInstanceSpec, SshCredentialEndpointField>,
): boolean {
  return previous.host !== next.host || previous.user !== next.user || previous.sshPort !== next.sshPort
}

/** Gateway auth belongs to the gateway deployment, not to the mechanism used
 *  to reach it. HTTP scheme, SPKI, and SSH-only metadata never retarget it.
 *  Implemented over the identity helper, so "predicate true" is EXACTLY
 *  "gatewayCredentialBinding differs" — including a kind change (gateway →
 *  non-gateway), which the fingerprint already treats as a retarget. */
export function gatewayCredentialTargetChanged(
  previous: Pick<TransportInstanceSpec, GatewayCredentialTargetField>,
  next: Pick<TransportInstanceSpec, GatewayCredentialTargetField>,
): boolean {
  const left = gatewayCredentialTargetIdentity(previous)
  const right = gatewayCredentialTargetIdentity(next)
  if (left === null || right === null) return left !== right
  return left.host !== right.host || left.remotePort !== right.remotePort
}

/** The gateway credential identity as one value, or null for a non-gateway
 *  spec. The binding fingerprint and the change predicate derive from this,
 *  so they can never disagree about which fields matter. */
export interface GatewayCredentialTargetIdentity {
  kind: 'gateway'
  host: string
  remotePort: number
}

export function gatewayCredentialTargetIdentity(
  spec: Pick<TransportInstanceSpec, GatewayCredentialTargetField>,
): GatewayCredentialTargetIdentity | null {
  return spec.kind === 'gateway' ? { kind: 'gateway', host: spec.host, remotePort: spec.remotePort } : null
}
