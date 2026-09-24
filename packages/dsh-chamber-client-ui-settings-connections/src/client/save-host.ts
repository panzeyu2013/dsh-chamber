import type {
  DesktopSshSurface,
  SshInstanceInput,
  SshInstanceSpec,
} from '../global.d.ts'
import { credentialCapabilitiesFor } from './connection-form.ts'

type ConnectionSaveBridge = Pick<DesktopSshSurface, 'save_connection'>

export type HostSaveResult =
  | { ok: true; instances: SshInstanceSpec[] }
  | { ok: false; instances: SshInstanceSpec[]; error: string; metadataCommitted: boolean }

/** Server-config password gate mirror: the gateway login password must be 12–1024 JavaScript
 *  characters when present. The form mirrors the main-process gate so a refused password never
 *  reaches it as a vague write failure. */
export const MIN_GATEWAY_PASSWORD_CHARS = 12
export const MAX_GATEWAY_PASSWORD_CHARS = 1024

/** Mirror of the main-process gatewayPasswordValidationError gate: '' = the optional field is left
 *  empty ("留空 = 保留已存"); a present password must be 12–1024 characters (Unicode allowed, it
 *  rides a JSON body). */
export function gatewayPasswordValidationError(password: string): 'length' | null {
  if (password === '') return null
  if (password.length < MIN_GATEWAY_PASSWORD_CHARS || password.length > MAX_GATEWAY_PASSWORD_CHARS) return 'length'
  return null
}
/**
 * Plugin-side mirror of the desktop transport-identity predicate (packages/desktop/
 * credential-identity.ts, locked by a cross-package test): true when an EDIT changes the transport
 * TARGET — kind or any host/user/port field — while the id stays the same. Label-only edits are not
 * target changes; `insecureHttp` is deliberately excluded (an http↔https switch on the same target
 * keeps the credential). The renderer cannot import the desktop module, so the check is duplicated
 * here with input normalization mirroring the main process (an omitted kind defaults to dsh, an
 * omitted transport derives from kind). The settings form's save_connection path deliberately does
 * NOT reuse it for credential ownership: gateway auth compares host+remotePort, SSH password
 * host+user+sshPort.
 */
export function transportTargetChangedSpec(a: SshInstanceSpec, b: SshInstanceInput): boolean {
  const aKind = a.kind === 'gateway' ? 'gateway' : 'dsh'
  const kind = (b.kind ?? 'dsh') === 'gateway' ? 'gateway' : 'dsh'
  return aKind !== kind
    || a.host !== b.host
    || a.user !== (b.user ?? null)
    || a.sshPort !== (b.sshPort ?? null)
    || a.remotePort !== b.remotePort
    || a.serviceName !== (b.serviceName ?? null)
    || a.remoteDshHome !== (b.remoteDshHome ?? null)
}

export interface CredentialReentry {
  sshPassword: boolean
  gatewayToken: boolean
  gatewayPassword: boolean
}

/** Which EXISTING credential values must be re-entered before an edit can commit. Ownership is
 *  domain-specific: gateway token/password bind to gateway host+remotePort; SSH password binds to
 *  host+user+sshPort while SSH remains the mechanism. Token and password are independent. */
export function credentialReentryFor(previous: SshInstanceSpec, next: SshInstanceInput): CredentialReentry {
  const kind = next.kind ?? 'dsh'
  const transport = next.transport ?? (kind === 'gateway' ? 'http' : 'ssh')
  const capabilities = credentialCapabilitiesFor(kind, transport)
  const sshEndpointChanged = previous.transport === 'ssh' && transport === 'ssh'
    && (previous.host !== next.host
      || previous.user !== (next.user ?? null)
      || previous.sshPort !== (next.sshPort ?? null))
  const gatewayTargetChanged = previous.kind === 'gateway' && kind === 'gateway'
    && (previous.host !== next.host || previous.remotePort !== next.remotePort)
  return {
    sshPassword: capabilities.sshPassword && previous.sshPasswordSet === true
      && sshEndpointChanged,
    gatewayToken: capabilities.gatewayAuth && previous.kind === 'gateway'
      && previous.tokenSet === true && gatewayTargetChanged,
    gatewayPassword: capabilities.gatewayAuth && previous.kind === 'gateway'
      && previous.passwordSet === true && gatewayTargetChanged,
  }
}

/** Gateway credentials submitted from the form. Each field is an independent write-only mutation; '' leaves the stored value untouched. */
export interface GatewayCredentialsInput {
  /** Write-only shared token (design 17 §7.2). */
  token: string
  /** Write-only login password (design 17 §7.1). */
  password: string
}

/** All independent credential dimensions accepted by the form. A gateway+ssh row may submit all three in one main-owned transaction. */
export interface ConnectionCredentialsInput extends GatewayCredentialsInput {
  sshPassword: string
}

/** Filter the credential dimensions applicable to the NEXT normalized row and cross IPC once. Empty values mean "leave untouched". */
export async function saveHostWithConnectionCredentials(
  bridge: ConnectionSaveBridge,
  previousId: string | null,
  input: SshInstanceInput,
  credentials: ConnectionCredentialsInput,
): Promise<HostSaveResult> {
  const kind = input.kind ?? 'dsh'
  const transport = input.transport ?? (kind === 'gateway' ? 'http' : 'ssh')
  const capabilities = credentialCapabilitiesFor(kind, transport)
  // One IPC call is the transaction boundary. Old values never enter this process: main snapshots
  // them, writes gateway+SSH stores and registry, and compensates every dimension on failure.
  return bridge.save_connection(previousId, input, {
    ...(capabilities.sshPassword && credentials.sshPassword !== ''
      ? { sshPassword: credentials.sshPassword }
      : {}),
    ...(capabilities.gatewayAuth && credentials.token !== ''
      ? { gatewayToken: credentials.token }
      : {}),
    ...(capabilities.gatewayAuth && credentials.password !== ''
      ? { gatewayPassword: credentials.password }
      : {}),
  })
}
