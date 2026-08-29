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

/** Server-config password gate mirror (design 17 §5.1/§7.1): the gateway
 *  login password must be 12–1024 JavaScript characters when present. The
 *  form mirrors the main-process gate so a password the desktop would refuse
 *  never reaches it as a vague write failure. */
export const MIN_GATEWAY_PASSWORD_CHARS = 12
export const MAX_GATEWAY_PASSWORD_CHARS = 1024

/** Mirror of the main-process gatewayPasswordValidationError gate (design 17
 *  §5.1): '' = the optional field is left empty (no validation — "留空 = 保留
 *  已存"); a present password must be 12–1024 characters and may contain
 *  Unicode because it rides a JSON request body. */
export function gatewayPasswordValidationError(password: string): 'length' | null {
  if (password === '') return null
  if (password.length < MIN_GATEWAY_PASSWORD_CHARS || password.length > MAX_GATEWAY_PASSWORD_CHARS) return 'length'
  return null
}
/**
 * Plugin-side mirror of the desktop `transportTargetChanged`
 * (packages/desktop/transport-provider.ts, locked by transport-target.test.ts):
 * true when an EDIT changes the transport TARGET — kind or any
 * host/user/port field — while the id stays the same. Label-only edits are
 * not target changes; `insecureHttp` is deliberately excluded (design 17
 * §9.1, D3: an http↔https switch on the same target keeps the credential).
 *
 * The renderer cannot import the desktop module (Electron main process), so
 * the check is duplicated here, with input normalization mirroring the main
 * process (transport-manager.ts migrateInstanceEntry / provider validateSpec:
 * an omitted kind defaults to dsh, an omitted transport derives from kind, omitted optional
 * fields default to null). This remains the renderer-side mirror for provider/
 * registry semantic tests; legacy instances_set is exact-no-op-only and has
 * no retarget path. The settings form's save_connection path deliberately does
 * NOT reuse it for credential ownership: gateway auth compares
 * host+remotePort, while SSH password compares host+user+sshPort.
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

/** Which EXISTING credential values must be re-entered before an edit can
 * commit. Credential ownership is domain-specific: gateway token/password
 * bind only to gateway host+remotePort; SSH password binds only to
 * host+user+sshPort while SSH remains the mechanism. Token and gateway
 * password are independent, so each existence projection gets its own
 * requirement. Boolean projections keep key/agent and --no-auth users
 * unblocked. */
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

/** Gateway credentials submitted from the form. Each field is an independent
 * write-only mutation; '' leaves the stored value untouched. */
export interface GatewayCredentialsInput {
  /** Write-only shared token (design 17 §7.2). */
  token: string
  /** Write-only login password (design 17 §7.1). */
  password: string
}

/** All independent credential dimensions accepted by the connection form.
 * A gateway+ssh row may submit all three values in one main-owned transaction. */
export interface ConnectionCredentialsInput extends GatewayCredentialsInput {
  sshPassword: string
}

/** Filter the credential dimensions applicable to the NEXT normalized row
 * and cross IPC once. Empty values mean "leave untouched". */
export async function saveHostWithConnectionCredentials(
  bridge: ConnectionSaveBridge,
  previousId: string | null,
  input: SshInstanceInput,
  credentials: ConnectionCredentialsInput,
): Promise<HostSaveResult> {
  const kind = input.kind ?? 'dsh'
  const transport = input.transport ?? (kind === 'gateway' ? 'http' : 'ssh')
  const capabilities = credentialCapabilitiesFor(kind, transport)
  // One IPC call is the transaction boundary. Old values never enter this
  // process: the main snapshots them, writes gateway+SSH stores and registry,
  // and compensates every dimension on failure.
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
