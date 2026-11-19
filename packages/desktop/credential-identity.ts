/**
 * Credential / live-transport identity predicates — the SINGLE source for "which spec
 * fields make two connections the same target". Each predicate has production consumers
 * (live-transport comparison in connection-save/transport-manager, SSH credential endpoint,
 * gateway credential-target + credential-binding fingerprint). A new spec field has ONE
 * place to be classified, in or out, per identity.
 *
 * Ownership: the LIVE transport identity decides proxy re-registration + restart; an SSH
 * password belongs to the SSH endpoint (host/user/sshPort); a gateway token/password belongs
 * to the gateway deployment (host + remotePort) — scheme, SPKI pin and SSH-only fields never
 * retarget it. The LOGICAL SOURCE identity decides durable-source retirement (proof rotation,
 * notification incarnation, renderer lifecycle): gateway = kind+host+remotePort (the SSH login
 * is a mechanism, not the deployment), dsh = kind+host+user+sshPort+remotePort.
 */
import type { TransportInstanceSpec } from './transport-provider.ts'

export type LiveTransportIdentityField =
  | 'kind' | 'transport' | 'host' | 'user' | 'sshPort' | 'remotePort'
  | 'serviceName' | 'remoteDshHome' | 'insecureHttp' | 'spkiPin'

export type SshCredentialEndpointField = 'host' | 'user' | 'sshPort'

export type GatewayCredentialTargetField = 'kind' | 'host' | 'remotePort'

export type LogicalSourceIdentityField = 'kind' | 'host' | 'user' | 'sshPort' | 'remotePort'

/** Structural input face shared by the registry spec and the notification proof projection
 *  (whose kind is a plain string) so both can derive the ONE identity without a cast. */
export interface LogicalSourceIdentitySpec {
  readonly kind: string
  readonly host: string
  readonly user: string | null
  readonly sshPort: number | null
  readonly remotePort: number
}

/** The durable LOGICAL source identity as one canonical string. A gateway deployment is
 *  identified by kind + host + remotePort — the same triple as
 *  gatewayCredentialTargetIdentity: the SSH user/daemon port only carry the mechanism used
 *  to reach it, so changing them never retargets the source (design 19 §3.3 / D1 ruling).
 *  A dsh (or future ssh-only) source keeps the full endpoint tuple: there user/sshPort ARE
 *  the target identity. Proof digests and renderer retirement derive from this value only. */
export function logicalSourceIdentity(spec: LogicalSourceIdentitySpec): string {
  return JSON.stringify([
    spec.kind,
    spec.host,
    spec.kind === 'gateway' ? null : spec.user,
    spec.kind === 'gateway' ? null : spec.sshPort,
    spec.remotePort,
  ])
}

/** True when a same-id edit re-targets the logical source (removal is the caller's case):
 *  the single retirement predicate for the renderer retiredIds and the notification proof. */
export function logicalSourceIdentityChanged(
  previous: LogicalSourceIdentitySpec,
  next: LogicalSourceIdentitySpec,
): boolean {
  return logicalSourceIdentity(previous) !== logicalSourceIdentity(next)
}

/** True when the change requires tearing the live transport down/restarting it so the proxy
 *  URL never disagrees with the mechanism. Presentation-only fields (label) are absent by
 *  construction. */
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

/** SSH password identity: the authentication endpoint triple; forwarded port, service and
 *  home edits keep the stored password. */
export function sshCredentialEndpointChanged(
  previous: Pick<TransportInstanceSpec, SshCredentialEndpointField>,
  next: Pick<TransportInstanceSpec, SshCredentialEndpointField>,
): boolean {
  return previous.host !== next.host || previous.user !== next.user || previous.sshPort !== next.sshPort
}

/** Gateway auth belongs to the deployment, not to the mechanism used to reach it: HTTP scheme,
 *  SPKI and SSH-only metadata never retarget it. Implemented over the identity helper, so
 *  "predicate true" is EXACTLY "gatewayCredentialBinding differs" — including a kind change
 *  (gateway → non-gateway), which the fingerprint already treats as a retarget. */
export function gatewayCredentialTargetChanged(
  previous: Pick<TransportInstanceSpec, GatewayCredentialTargetField>,
  next: Pick<TransportInstanceSpec, GatewayCredentialTargetField>,
): boolean {
  const left = gatewayCredentialTargetIdentity(previous)
  const right = gatewayCredentialTargetIdentity(next)
  if (left === null || right === null) return left !== right
  return left.host !== right.host || left.remotePort !== right.remotePort
}

/** The gateway credential identity as one value, or null for a non-gateway spec. The binding
 *  fingerprint and the change predicate both derive from this, so they can never disagree
 *  about which fields matter. */
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
