import type {
  DesktopSshSurface,
  SshInstanceInput,
  SshInstanceSpec,
  TransportKind,
} from '../global.d.ts'

type SaveBridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_password'>
/** Full gateway save bridge: the registry plus BOTH write-only gateway
 *  credentials — the shared token (design 17 §7.2) and the login password
 *  (§7.1), both on the authoritative DesktopSshSurface. */
type GatewaySaveBridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_gateway_token' | 'set_gateway_password'>
/** Legacy token-only bridge for `saveHostWithGatewayToken` (existing
 *  callers/tests predate the password setter; they never submit one). */
type GatewayTokenSaveBridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_gateway_token'>
/** Kind-switch cleanup bridge: the ssh password setter plus BOTH gateway
 *  setters (a gateway target owns the token and the password). */
type SecretClearBridge = Pick<DesktopSshSurface, 'set_password' | 'set_gateway_token' | 'set_gateway_password'>

/**
 * Target-kind values the secret-cleanup accepts: the registry's authoritative
 * v2 kind ('dsh' | 'gateway', design 17 §2.1) plus the legacy wire name
 * ('ssh') older callers/tests still carry. The cleanup keys on the gateway
 * kind only (gateway targets own both the token and the password; every other
 * target owns the ssh password), so both spellings of "not gateway" clear the
 * password.
 */
export type SecretCleanupKind = TransportKind | 'dsh'

export type HostSaveResult =
  | { ok: true; instances: SshInstanceSpec[] }
  | { ok: false; instances: SshInstanceSpec[]; error: string; metadataCommitted: boolean }

/** Server-config password gate mirror (design 17 §5.1/§7.1): the gateway
 *  login password must be 12–1024 visible ASCII characters when present. The
 *  form mirrors the main-process gate so a password the desktop would refuse
 *  never reaches it as a vague write failure. */
export const MIN_GATEWAY_PASSWORD_CHARS = 12
export const MAX_GATEWAY_PASSWORD_CHARS = 1024
const GATEWAY_CREDENTIAL_ASCII = /^[\x20-\x7e]+$/

/** Mirror of the main-process gatewayPasswordValidationError gate (design 17
 *  §5.1): '' = the optional field is left empty (no validation — "留空 = 保留
 *  已存"); a present password must be 12–1024 visible ASCII. Returns a machine
 *  code ('ascii' | 'length') for the form to localize. */
export function gatewayPasswordValidationError(password: string): 'ascii' | 'length' | null {
  if (password === '') return null
  if (!GATEWAY_CREDENTIAL_ASCII.test(password)) return 'ascii'
  if (password.length < MIN_GATEWAY_PASSWORD_CHARS || password.length > MAX_GATEWAY_PASSWORD_CHARS) return 'length'
  return null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameInstances(left: SshInstanceSpec[], right: SshInstanceSpec[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Plugin-side mirror of the desktop `transportTargetChanged`
 * (packages/desktop/transport-provider.ts, locked by transport-target.test.ts):
 * true when an EDIT changes the transport TARGET — kind, transport or any
 * host/user/port field — while the id stays the same. Label-only edits are
 * not target changes; `insecureHttp` is deliberately excluded (design 17
 * §9.1, D3: an http↔https switch on the same target keeps the credential).
 *
 * The renderer cannot import the desktop module (Electron main process), so
 * the check is duplicated here, with normalization on BOTH sides mirroring
 * the main process (transport-manager.ts migrateInstanceEntry / provider
 * validateSpec: the legacy 'ssh' kind normalizes to 'dsh', an omitted kind
 * defaults to dsh, an omitted transport derives from kind, omitted optional
 * fields default to null). The main process uses the same rule to clear
 * provider-held credentials INSIDE instances_set (main.ts
 * desktop_ssh_instances_set — same-kind retarget scrubs both secret stores),
 * so this transaction and the form MUST agree with it or a credential would
 * silently survive (or silently vanish) on a target edit.
 */
export function transportTargetChangedSpec(a: SshInstanceSpec, b: SshInstanceInput): boolean {
  const aKind = a.kind === 'gateway' ? 'gateway' : 'dsh'
  const kind = (b.kind ?? 'dsh') === 'gateway' ? 'gateway' : 'dsh'
  const transport = b.transport ?? (kind === 'gateway' ? 'http' : 'ssh')
  return aKind !== kind
    || a.transport !== transport
    || a.host !== b.host
    || a.user !== (b.user ?? null)
    || a.sshPort !== (b.sshPort ?? null)
    || a.remotePort !== b.remotePort
    || a.serviceName !== (b.serviceName ?? null)
    || a.remoteDshHome !== (b.remoteDshHome ?? null)
}

/**
 * Save non-secret host metadata and its optional secret as one user-visible
 * operation. ORDER DEPENDS ON REGISTRY EXISTENCE AND TARGET CHANGE (2026
 * final review fix + P2):
 * - EXISTING host, target UNCHANGED: password FIRST, registry SECOND — a
 *   password failure leaves the registry untouched and the form can retry
 *   directly.
 * - NEW host OR SAME-KIND TARGET edit (host/user/ports changed): the main
 *   process REFUSES `set_password` for unregistered ids (new host) and clears
 *   the stale provider credential INSIDE instances_set (same-kind retarget,
 *   main.ts transportTargetChanged), so the registry MUST land first; a
 *   subsequent password failure is compensated by restoring the previous
 *   registry (design 05 §8 rollback), and `metadataCommitted` reports whether
 *   that rollback itself failed (the form then turns the committed row into
 *   an edit target so a retry can never be rejected by the duplicate check).
 */
export async function saveHostWithPassword(
  bridge: SaveBridge,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  password: string,
): Promise<HostSaveResult> {
  return saveHostWithSecretCommits(bridge, before, next, instanceId, password === '' ? [] : [{
    value: password,
    set: value => bridge.set_password(instanceId, value),
    clear: () => bridge.set_password(instanceId, null),
  }])
}

/** Gateway credentials submitted from the form. Each field commits
 *  INDEPENDENTLY; '' leaves the stored value untouched (design 17 §2.3 —
 *  auth is never a mode; both empty sends the request without auth and the
 *  gateway decides, §7.3). Exception: on a same-kind TARGET edit the main
 *  process has already cleared the stored credential inside instances_set,
 *  so the form requires re-entry (P2) and the commit is mandatory. */
export interface GatewayCredentialsInput {
  /** Write-only shared token (design 17 §7.2). */
  token: string
  /** Write-only login password (design 17 §7.1). */
  password: string
}

/**
 * Gateway equivalent of saveHostWithPassword for BOTH write-only gateway
 * credentials: token and password commit independently in one transaction
 * (token first, then password). Both are never included in either the
 * registry input or the returned result.
 */
export async function saveHostWithGatewayCredentials(
  bridge: GatewaySaveBridge,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  credentials: GatewayCredentialsInput,
): Promise<HostSaveResult> {
  const commits: SecretCommit[] = []
  if (credentials.token !== '') {
    commits.push({
      value: credentials.token,
      set: value => bridge.set_gateway_token(instanceId, value),
      clear: () => bridge.set_gateway_token(instanceId, null),
    })
  }
  if (credentials.password !== '') {
    commits.push({
      value: credentials.password,
      set: value => bridge.set_gateway_password(instanceId, value),
      clear: () => bridge.set_gateway_password(instanceId, null),
    })
  }
  return saveHostWithSecretCommits(bridge, before, next, instanceId, commits)
}

/** Token-only compatibility entry (existing callers/tests predate the
 *  password setter): delegates to the full credentials transaction with the
 *  password left untouched. The token is write-only and never included in
 *  either the registry input or the returned result. */
export async function saveHostWithGatewayToken(
  bridge: GatewayTokenSaveBridge,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  token: string,
): Promise<HostSaveResult> {
  return saveHostWithGatewayCredentials(bridge as GatewaySaveBridge, before, next, instanceId, { token, password: '' })
}

/**
 * Clear the credentials owned by the PREVIOUS transport kind after the new
 * metadata+credential transaction has committed. The caller deliberately
 * invokes this last: clearing first would make a failed new-secret write
 * impossible to compensate by rolling the old registry metadata back.
 * A gateway target owns BOTH write-only credentials (design 17 §7) — the
 * gateway→other branch scrubs the token AND the password, or a switch back
 * would resurrect the old secret.
 */
export async function clearSupersededTransportSecret(
  bridge: SecretClearBridge,
  instanceId: string,
  previousKind: SecretCleanupKind,
  nextKind: SecretCleanupKind,
): Promise<{ ok: true } | { error: string }> {
  if (previousKind === nextKind) return { ok: true }
  if (previousKind === 'gateway') {
    // Attempt BOTH clears even if one store fails: a token-store error must
    // not leave the password behind (or vice versa).
    const tokenResult = await bridge.set_gateway_token(instanceId, null)
    const passwordResult = await bridge.set_gateway_password(instanceId, null)
    if ('error' in tokenResult) return tokenResult
    if ('error' in passwordResult) return passwordResult
    return { ok: true }
  }
  return bridge.set_password(instanceId, null)
}

/** One write-only credential commit inside the shared transaction: the value
 *  to store plus the IPC setter and a best-effort clear used to compensate a
 *  PARTIAL new-host commit (an earlier credential landed before a later one
 *  failed). */
interface SecretCommit {
  value: string
  set: (value: string) => Promise<{ ok: true } | { error: string }>
  clear: () => Promise<{ ok: true } | { error: string }>
}

/**
 * Shared metadata+secrets transaction for the ssh password and the gateway
 * credentials (token and/or password). The ordering rules from the 2026 final
 * review (plus the P2 same-kind retarget fix) apply to EVERY secret kind:
 * - EXISTING host, target UNCHANGED: every non-empty secret FIRST, registry
 *   SECOND — a refusal leaves the registry untouched and the form can retry
 *   directly (an earlier secret may already be updated when a later one
 *   fails; the registry is still untouched and the error names the failing
 *   credential).
 * - NEW host: the registry MUST land first (the main-process gate refuses
 *   secret writes for ids that are not yet in the registry); then each secret
 *   commits in order, and any failure is compensated by restoring the
 *   previous registry (design 05 §8 rollback).
 * - EXISTING host, TARGET CHANGED (same kind — transportTargetChangedSpec):
 *   the main process clears the stale provider credential INSIDE
 *   instances_set (main.ts desktop_ssh_instances_set, same-kind retarget), so
 *   committing a secret BEFORE the registry would be wiped — the registry
 *   MUST land first, then the fresh secret commits after the main process
 *   cleared the old one; a failure is compensated exactly like a new host
 *   (registry rollback + metadataCommitted). A kind switch keeps the old
 *   provider secret in the store (main.ts skips the clear), and the form
 *   scrubs it explicitly AFTER this transaction succeeds
 *   (clearSupersededTransportSecret) — but the registry-first order is still
 *   safe: a failed new-kind secret rolls the metadata back to the old kind,
 *   whose credential was never cleared and stays usable.
 * A PARTIAL commit is scrubbed BEFORE the registry rolls back — clearing
 * afterwards would be refused (the id is already gone) and leave an orphaned
 * credential that a retried id would silently reuse. `metadataCommitted`
 * reports whether the rollback itself failed (the form then turns the
 * committed row into an edit target so a retry can never be rejected by the
 * duplicate check). The secret error text survives even when the rollback
 * itself fails (2026 round-3 review — the rollback failure must never
 * masquerade as the secret error).
 */
async function saveHostWithSecretCommits(
  bridge: Pick<DesktopSshSurface, 'instances_get' | 'instances_set'>,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  commits: SecretCommit[],
): Promise<HostSaveResult> {
  const previous = before.find(spec => spec.id === instanceId)
  const exists = previous !== undefined
  // Same-kind TARGET edits must NOT commit secrets before the registry: the
  // main process clears the old provider credential INSIDE instances_set
  // (transportTargetChanged, main.ts), so a secret committed first would be
  // silently wiped. Registry-first → the main clears the stale secret → the
  // fresh secret commits after — the ordering holds by construction. A
  // degenerate input whose id is absent from `next` (a removal) is treated
  // as a target change: registry-first is the only safe order there too.
  const nextSpec = next.find(entry => entry.id === instanceId)
  const targetChanged = exists && (nextSpec === undefined ? true : transportTargetChangedSpec(previous, nextSpec))
  const secretsFirst = exists && !targetChanged
  if (secretsFirst && commits.length > 0) {
    // Plain metadata edit: secrets first — a refusal leaves the registry
    // untouched and the old credential intact.
    for (const commit of commits) {
      try {
        const result = await commit.set(commit.value)
        if ('error' in result) return { ok: false, instances: before, error: result.error, metadataCommitted: false }
      } catch (error) {
        return { ok: false, instances: before, error: message(error), metadataCommitted: false }
      }
    }
  }
  let saved: SshInstanceSpec[]
  try {
    saved = await bridge.instances_set(next)
  } catch (error) {
    return { ok: false, instances: before, error: message(error), metadataCommitted: false }
  }
  if (commits.length === 0) return { ok: true, instances: saved }
  if (secretsFirst) return { ok: true, instances: saved }

  // New host or same-kind retarget: the registry landed (secret writes
  // require a registered id / the main process has cleared the stale
  // credential); commit each secret, rolling the registry back on failure so
  // a retry never hits the duplicate check with a half-committed row.
  const committed: SecretCommit[] = []
  for (const commit of commits) {
    try {
      const result = await commit.set(commit.value)
      if ('error' in result) return await rollbackRegistryCommit(result.error, saved, committed)
      committed.push(commit)
    } catch (error) {
      return await rollbackRegistryCommit(message(error), saved, committed)
    }
  }
  return { ok: true, instances: saved }

  /** New-host / same-kind-retarget secret failure compensation (design 05 §8). */
  async function rollbackRegistryCommit(secretError: string, saved: SshInstanceSpec[], committed: SecretCommit[]): Promise<HostSaveResult> {
    // A partial commit (an earlier credential landed) is scrubbed while the
    // id is STILL in the registry — the main-process gate refuses secret
    // writes for ids that are not in the registry, so clearing after the
    // rollback would be refused and the retried id would silently reuse it.
    const clearFailures: string[] = []
    for (const commit of [...committed].reverse()) {
      try {
        const result = await commit.clear()
        if ('error' in result) clearFailures.push(result.error)
      } catch (error) {
        clearFailures.push(message(error))
      }
    }
    const compensationNote = clearFailures.length > 0
      ? `; clearing partially-committed secrets failed: ${clearFailures.join('; ')}`
      : ''
    try {
      const rolledBack = await bridge.instances_set(before)
      return { ok: false, instances: rolledBack, error: `${secretError}${compensationNote}`, metadataCommitted: false }
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
        error: `${secretError}${compensationNote}; host metadata rollback failed: ${message(rollbackError)}`,
        metadataCommitted: !sameInstances(authoritative, before),
      }
    }
  }
}
