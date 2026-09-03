import type {
  SshInstanceInput,
  SshInstanceSpec,
  TransportKind,
  TransportMethod,
} from '../global.d.ts'
import { formatGatewayUrl, parseGatewayUrl } from './gateway-url.ts'

/** The field cluster rendered by a transport. Keeping this decision on the
 * transport schema is the design 17 §2.2 extension seam: adding a transport
 * extends this registry instead of adding another kind/transport cross-product
 * to the component. */
export type TransportFieldGroup = 'ssh' | 'url'

export interface TransportFormSchema {
  method: TransportMethod
  fieldGroup: TransportFieldGroup
  targetKinds: readonly TransportKind[]
  /** The value used by the SSH destination-port field when it has not been
   * customized. HTTP ports remain URL-derived, but keeping its conventional
   * fallback here lets a transport switch restore a sensible SSH default. */
  defaultRemotePort: Readonly<Record<TransportKind, number>>
}

/** Shipped transport schemas. The dsh×http combination is DISABLED
 *  (2026-09 user decision): direct-attaching a dsh web profile over http is
 *  hard-blocked on the 0.1.2 line — its host answers 401 without the
 *  spawn-time browser-auth launch token, which is unrecoverable remotely
 *  (STATUS「远端/直连 0.1.2 dsh 附加被硬阻断」; re-enable when upstream
 *  exposes token retrieval). ssh remains the only dsh transport; gateway
 *  keeps both transports. The main-process http provider refuses the
 *  combination at validateSpec (same flip point). Target semantics such as
 *  gateway authentication remain a separate decision below. */
export const TRANSPORT_FORM_SCHEMAS: Readonly<Record<TransportMethod, TransportFormSchema>> = {
  ssh: {
    method: 'ssh',
    fieldGroup: 'ssh',
    targetKinds: ['dsh', 'gateway'],
    defaultRemotePort: { dsh: 30800, gateway: 30801 },
  },
  http: {
    method: 'http',
    fieldGroup: 'url',
    targetKinds: ['gateway'],
    // Direct endpoints derive their actual port from the URL. These values
    // are only draft fallbacks used when moving between form schemas.
    defaultRemotePort: { dsh: 30800, gateway: 443 },
  },
}

export const TRANSPORT_FORM_OPTIONS: readonly TransportFormSchema[] = [
  TRANSPORT_FORM_SCHEMAS.ssh,
  TRANSPORT_FORM_SCHEMAS.http,
]

/** systemd unit-name input gate. A leading dash is never a unit name here:
 * it could otherwise be parsed as a systemctl option. Main repeats this gate
 * and inserts `--` before the unit, so renderer validation is UX rather than
 * the security boundary. */
export const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

export function transportFormSchema(method: TransportMethod): TransportFormSchema {
  return TRANSPORT_FORM_SCHEMAS[method]
}

export function transportSupportsTarget(method: TransportMethod, kind: TransportKind): boolean {
  return transportFormSchema(method).targetKinds.includes(kind)
}

/** Move a still-defaulted port across target/transport choices while
 * preserving every custom value. */
export function nextDefaultedRemotePort(
  current: string,
  previousKind: TransportKind,
  previousTransport: TransportMethod,
  nextKind: TransportKind,
  nextTransport: TransportMethod,
): string {
  const previousDefault = String(transportFormSchema(previousTransport).defaultRemotePort[previousKind])
  return current === previousDefault
    ? String(transportFormSchema(nextTransport).defaultRemotePort[nextKind])
    : current
}

/** Independent credential dimensions for one target/transport pair. Gateway
 * over SSH needs BOTH: SSH authenticates the tunnel and token/password
 * authenticates the gateway reached through it. */
export interface CredentialCapabilities {
  sshPassword: boolean
  gatewayAuth: boolean
}

export function credentialCapabilitiesFor(kind: TransportKind, transport: TransportMethod): CredentialCapabilities {
  return {
    sshPassword: transport === 'ssh',
    gatewayAuth: kind === 'gateway',
  }
}

/** Add/edit form draft. Secret values are transient and never become members
 * of SshInstanceInput. The SPKI pin is intentionally different: it is
 * non-secret registry metadata and therefore is round-tripped on edit. */
export interface HostDraft {
  kind: TransportKind
  transport: TransportMethod
  id: string
  label: string
  /** Direct HTTP(S) endpoint origin for either target kind. */
  gatewayUrl: string
  gatewayToken: string
  gatewayPassword: string
  /** Optional, non-secret S23 64-hex SPKI digest. */
  spkiPin: string
  host: string
  user: string
  sshPort: string
  remotePort: string
  serviceName: string
  remoteDshHome: string
  password: string
}

export const EMPTY_DRAFT: HostDraft = {
  kind: 'dsh',
  transport: 'ssh',
  id: '',
  label: '',
  gatewayUrl: '',
  gatewayToken: '',
  gatewayPassword: '',
  spkiPin: '',
  host: '',
  user: '',
  sshPort: '',
  remotePort: '30800',
  serviceName: '',
  remoteDshHome: '',
  password: '',
}

/** S23 eligibility is deliberately narrow: only a gateway target reached by
 * the direct HTTP provider with an explicitly valid HTTPS origin. */
export function spkiPinEligible(draft: Pick<HostDraft, 'kind' | 'transport' | 'gatewayUrl'>): boolean {
  if (draft.kind !== 'gateway' || draft.transport !== 'http') return false
  const parsed = parseGatewayUrl(draft.gatewayUrl)
  return parsed.ok && parsed.scheme === 'https'
}

export function spkiPinValidationError(pin: string): 'format' | null {
  const value = pin.trim()
  if (value === '') return null
  return /^[0-9a-fA-F]{64}$/.test(value) ? null : 'format'
}

/** Normalize a registry row into a form draft. Secret fields always start
 * empty, while a valid S23 pin is prefilled so a label-only edit cannot
 * silently remove certificate verification. HTTP backfill is transport-
 * based, not kind-based, which is required for dsh+http. */
export function draftFromSpec(spec: SshInstanceSpec): HostDraft {
  const endpointUrl = spec.transport === 'http'
    ? formatGatewayUrl(spec.host, spec.remotePort, spec.insecureHttp)
    : ''
  const pinEligible = spec.kind === 'gateway' && spec.transport === 'http' && !spec.insecureHttp
  return {
    kind: spec.kind,
    transport: spec.transport,
    id: spec.id,
    label: spec.label,
    gatewayUrl: endpointUrl,
    gatewayToken: '',
    gatewayPassword: '',
    spkiPin: pinEligible ? (spec.spkiPin ?? '') : '',
    host: spec.host,
    user: spec.user ?? '',
    sshPort: spec.sshPort === null ? '' : String(spec.sshPort),
    remotePort: String(spec.remotePort),
    serviceName: spec.serviceName ?? '',
    remoteDshHome: spec.remoteDshHome ?? '',
    password: '',
  }
}

/** Derive non-secret registry input. Every combination follows its transport
 * schema. SPKI is emitted only for gateway+http+https and is normalized to
 * lowercase; stale hidden values can therefore never leak into dsh, SSH, or
 * plaintext HTTP saves. */
export function draftToInput(draft: HostDraft): SshInstanceInput {
  const input: SshInstanceInput = {
    kind: draft.kind,
    transport: draft.transport,
    id: draft.id.trim(),
    label: draft.label.trim(),
    host: '',
    remotePort: 0,
  }
  const schema = transportFormSchema(draft.transport)
  if (schema.fieldGroup === 'url') {
    const parsed = parseGatewayUrl(draft.gatewayUrl)
    if (parsed.ok) {
      input.host = parsed.host
      input.remotePort = parsed.port
      input.insecureHttp = parsed.scheme === 'http'
      const pin = draft.spkiPin.trim()
      if (draft.kind === 'gateway' && parsed.scheme === 'https' && pin !== '') {
        input.spkiPin = pin.toLowerCase()
      }
    }
  } else {
    input.host = draft.host.trim()
    input.remotePort = Number(draft.remotePort)
    if (draft.user.trim() !== '') input.user = draft.user.trim()
    if (draft.sshPort.trim() !== '') input.sshPort = Number(draft.sshPort)
    if (draft.serviceName.trim() !== '') input.serviceName = draft.serviceName.trim()
    if (draft.remoteDshHome.trim() !== '') input.remoteDshHome = draft.remoteDshHome.trim()
  }
  return input
}

/** Target changes preserve the independently selected transport WHEN the new
 *  target supports it. The dsh×http combination is disabled (2026-09), so a
 *  kind switch INTO dsh moves an http draft onto ssh (the only dsh transport)
 *  with the ssh port default. Transient credentials are cleared so switching
 *  away and back cannot accidentally submit a value typed for another target. */
export function changeDraftKind(draft: HostDraft, kind: TransportKind): HostDraft {
  if (kind === draft.kind) return draft
  const transport = transportSupportsTarget(draft.transport, kind) ? draft.transport : 'ssh'
  return {
    ...draft,
    kind,
    transport,
    remotePort: nextDefaultedRemotePort(draft.remotePort, draft.kind, draft.transport, kind, transport),
    gatewayToken: '',
    gatewayPassword: '',
    password: '',
    spkiPin: '',
  }
}

/** Transport changes preserve the target kind and move only the field schema.
 * Target-owned gateway credentials remain valid across ssh/http; the SPKI pin
 * and dsh SSH password are cleared when their TLS/SSH surfaces disappear. */
export function changeDraftTransport(draft: HostDraft, transport: TransportMethod): HostDraft {
  if (transport === draft.transport) return draft
  return {
    ...draft,
    transport,
    remotePort: nextDefaultedRemotePort(draft.remotePort, draft.kind, draft.transport, draft.kind, transport),
    password: transport === 'ssh' ? draft.password : '',
    spkiPin: '',
  }
}

/** URL editing clears a pin as soon as the endpoint is no longer valid HTTPS,
 * preventing a hidden value from surviving an explicit move to plaintext. */
export function changeDraftEndpointUrl(draft: HostDraft, gatewayUrl: string): HostDraft {
  const next = { ...draft, gatewayUrl }
  return spkiPinEligible(next) ? next : { ...next, spkiPin: '' }
}
