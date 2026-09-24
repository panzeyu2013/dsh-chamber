import type { TransportInstanceInput, TransportInstanceSpec } from './transport-provider.ts'
import type { SaveInstancesProvenance } from './transport-manager.ts'
import { gatewayCredentialTargetChanged, liveTransportIdentityChanged, sshCredentialEndpointChanged } from './credential-identity.ts'
import { describeError } from './describe-error.ts'

/** Write-only mutations accepted by the main-owned connection transaction: missing/empty
 *  fields mean "leave untouched"; explicit clearing stays on the per-dimension IPC actions. */
export interface ConnectionCredentialMutations {
  sshPassword?: string
  gatewayToken?: string
  gatewayPassword?: string
}

export interface SaveConnectionRequest {
  /** null = add; a concrete id = edit that immutable registry id. */
  previousId: string | null
  input: TransportInstanceInput
  credentials: ConnectionCredentialMutations
}

export interface ConnectionCredentialChanges {
  sshPassword: boolean
  gatewayToken: boolean
  gatewayPassword: boolean
}

export type SaveConnectionTransactionResult =
  | {
      ok: true
      instances: TransportInstanceSpec[]
      changes: ConnectionCredentialChanges
      previous: TransportInstanceSpec | null
      next: TransportInstanceSpec
    }
  | {
      ok: false
      instances: TransportInstanceSpec[]
      error: string
      metadataCommitted: boolean
    }

/** Injectable main-process owners. Every credential getter/setter stays in this boundary;
 *  neither old nor new values are ever returned to the renderer. */
export interface SaveConnectionTransactionDeps {
  listInstances(): TransportInstanceSpec[]
  normalize(input: TransportInstanceInput): TransportInstanceSpec | null
  /** `provenance` keeps the rollback write distinguishable from a real user
   *  save: a compensation write must not clear the registry degraded gate and,
   *  while that gate is closed, is an in-memory-only restore — transport-manager
   *  skips its disk write so the unknown live file is not resurrected (F19). */
  saveInstances(instances: TransportInstanceInput[], provenance?: SaveInstancesProvenance): TransportInstanceSpec[]
  getSshPassword(id: string): string | null
  getGatewayToken(id: string): string | null
  getGatewayPassword(id: string): string | null
  setSshPassword(id: string, password: string | null, spec: TransportInstanceSpec | null): void
  /** Token+password MUST be one write-through gateway-store commit. */
  setGatewaySecrets(id: string, token: string | null, password: string | null, spec: TransportInstanceSpec | null): void
  /** Invalidate every direct and ready-tunnel origin of the old/new gateway shape. Must
   *  throw on failure so no metadata/secret commit follows. */
  invalidateGatewaySessions(previous: TransportInstanceSpec | null, next: TransportInstanceSpec | null): void
  isActive(id: string): boolean
  disconnect(id: string): void
  connect(id: string): void
}

export interface DeleteConnectionsTransactionDeps {
  listInstances(): TransportInstanceSpec[]
  saveInstances(instances: TransportInstanceInput[], provenance?: SaveInstancesProvenance): TransportInstanceSpec[]
  getSshPassword(id: string): string | null
  getGatewayToken(id: string): string | null
  getGatewayPassword(id: string): string | null
  setSshPassword(id: string, password: string | null, spec: TransportInstanceSpec | null): void
  setGatewaySecrets(id: string, token: string | null, password: string | null, spec: TransportInstanceSpec | null): void
  invalidateGatewaySessions(spec: TransportInstanceSpec): void
  isActive(id: string): boolean
  disconnect(id: string): void
  connect(id: string): void
}

export type DeleteConnectionsTransactionResult =
  | { ok: true; instances: TransportInstanceSpec[]; removed: TransportInstanceSpec[] }
  | { ok: false; instances: TransportInstanceSpec[]; error: string; metadataCommitted: boolean }

function sameInstances(left: TransportInstanceSpec[], right: TransportInstanceSpec[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * Main-owned registry + credential transaction.
 *
 * All old write-only values are snapshotted in main before the first write.
 * The old live transport is stopped before a new credential can be visible,
 * gateway token+password land in one store commit, SSH lands second, and the
 * registry lands last. Any failure restores metadata and every secret from
 * those main-only snapshots; a compensation failure is loud and the old
 * transport is not reconnected under an uncertain state. The registry
 * proposal is written as `authoritative` and the rollback rewrite as
 * `compensation`, so a rollback can never clear the registry-load degraded
 * gate (F16/A4) and, while that gate is closed, never writes the live file
 * (F19: an in-memory-only restore).
 */
export function saveConnectionTransaction(
  deps: SaveConnectionTransactionDeps,
  request: SaveConnectionRequest,
): SaveConnectionTransactionResult {
  const before = deps.listInstances()
  const normalized = deps.normalize(request.input)
  if (normalized === null) {
    return { ok: false, instances: before, error: 'invalid connection metadata', metadataCommitted: false }
  }

  const previous = request.previousId === null
    ? null
    : before.find(instance => instance.id === request.previousId) ?? null
  if (request.previousId === null) {
    if (before.some(instance => instance.id === normalized.id)) {
      return { ok: false, instances: before, error: 'connection id already exists', metadataCommitted: false }
    }
  } else if (previous === null || normalized.id !== request.previousId) {
    return { ok: false, instances: before, error: 'invalid or unknown connection id', metadataCommitted: false }
  }

  const proposed: TransportInstanceSpec[] = previous === null
    ? [...before, normalized]
    : before.map(instance => instance.id === previous.id ? normalized : instance)

  const id = normalized.id
  const oldSshPassword = deps.getSshPassword(id)
  const oldGatewayToken = deps.getGatewayToken(id)
  const oldGatewayPassword = deps.getGatewayPassword(id)
  const sshMutation = nonEmpty(request.credentials.sshPassword)
  const gatewayTokenMutation = nonEmpty(request.credentials.gatewayToken)
  const gatewayPasswordMutation = nonEmpty(request.credentials.gatewayPassword)

  if (sshMutation !== undefined && normalized.transport !== 'ssh') {
    return { ok: false, instances: before, error: 'SSH password is not applicable to an HTTP transport', metadataCommitted: false }
  }
  if ((gatewayTokenMutation !== undefined || gatewayPasswordMutation !== undefined) && normalized.kind !== 'gateway') {
    return { ok: false, instances: before, error: 'gateway credentials are not applicable to a dsh target', metadataCommitted: false }
  }

  // Credential identity and live transport identity are deliberately separate: transport/http(s)/
  // SPKI-only edits restart the live mechanism but do not retarget gateway auth. SSH is a
  // transport credential, retained only across dsh↔gateway when the SSH endpoint itself is stable.
  const sshRetarget = previous !== null
    && previous.transport === 'ssh'
    && normalized.transport === 'ssh'
    && sshCredentialEndpointChanged(previous, normalized)
  const gatewayRetarget = previous !== null
    && previous.kind === 'gateway'
    && normalized.kind === 'gateway'
    && gatewayCredentialTargetChanged(previous, normalized)

  const mustReenterSsh = oldSshPassword !== null
    && normalized.transport === 'ssh'
    && sshRetarget
  const mustReenterGatewayToken = oldGatewayToken !== null
    && previous?.kind === 'gateway'
    && normalized.kind === 'gateway'
    && gatewayRetarget
  const mustReenterGatewayPassword = oldGatewayPassword !== null
    && previous?.kind === 'gateway'
    && normalized.kind === 'gateway'
    && gatewayRetarget
  if (mustReenterSsh && sshMutation === undefined) {
    return { ok: false, instances: before, error: 'the stored SSH password must be re-entered for the new target', metadataCommitted: false }
  }
  if (mustReenterGatewayToken && gatewayTokenMutation === undefined) {
    return { ok: false, instances: before, error: 'the stored gateway token must be re-entered for the new target', metadataCommitted: false }
  }
  if (mustReenterGatewayPassword && gatewayPasswordMutation === undefined) {
    return { ok: false, instances: before, error: 'the stored gateway password must be re-entered for the new target', metadataCommitted: false }
  }

  let nextSshPassword: string | null = null
  if (normalized.transport === 'ssh') {
    const stableExistingSsh = previous !== null
      && previous.transport === 'ssh'
      && !sshRetarget
    nextSshPassword = sshMutation ?? (stableExistingSsh ? oldSshPassword : null)
  }

  let nextGatewayToken: string | null = null
  let nextGatewayPassword: string | null = null
  if (normalized.kind === 'gateway') {
    const stableExistingGateway = previous?.kind === 'gateway' && !gatewayRetarget
    nextGatewayToken = gatewayTokenMutation ?? (stableExistingGateway ? oldGatewayToken : null)
    nextGatewayPassword = gatewayPasswordMutation ?? (stableExistingGateway ? oldGatewayPassword : null)
  }

  const changes: ConnectionCredentialChanges = {
    sshPassword: oldSshPassword !== nextSshPassword || (sshRetarget && nextSshPassword !== null),
    gatewayToken: oldGatewayToken !== nextGatewayToken || (gatewayRetarget && nextGatewayToken !== null),
    gatewayPassword: oldGatewayPassword !== nextGatewayPassword || (gatewayRetarget && nextGatewayPassword !== null),
  }
  // ADD is also a lifecycle-generation boundary: getters intentionally hide a crash-half
  // credential whose binding has no current registry row, so an unconditional rewrite/clear
  // keeps that raw value from going live again when the same id + endpoint is recreated blank.
  const forceGatewayCommit = previous === null
    || (previous.kind === 'gateway') !== (normalized.kind === 'gateway')
    || gatewayRetarget
  const forceSshCommit = previous === null
    || (previous.transport === 'ssh') !== (normalized.transport === 'ssh')
    || sshRetarget
  const gatewayWriteNeeded = forceGatewayCommit || changes.gatewayToken || changes.gatewayPassword
  const sshWriteNeeded = forceSshCommit || changes.sshPassword
  const gatewayChanged = changes.gatewayToken || changes.gatewayPassword
  const credentialsChanged = gatewayWriteNeeded || sshWriteNeeded
  const metadataNeedsRestart = previous !== null && liveTransportIdentityChanged(previous, normalized)
  const wasActive = previous !== null && deps.isActive(id)
  let disconnected = false
  let gatewayAttempted = false
  let sshAttempted = false
  let metadataAttempted = false

  try {
    // Teardown is unconditional for an existing generation: provider execs may be live while the
    // transport projection is still idle. `wasActive` controls only whether the transport itself
    // is reconnected afterward.
    if (previous !== null && (metadataNeedsRestart || credentialsChanged)) {
      deps.disconnect(id)
      disconnected = true
    }
    if ((previous?.kind === 'gateway'
      && (metadataNeedsRestart || gatewayChanged || normalized.kind !== 'gateway'))
      || (normalized.kind === 'gateway' && previous?.kind !== 'gateway')) {
      deps.invalidateGatewaySessions(previous, normalized.kind === 'gateway' ? normalized : null)
    }
    if (gatewayWriteNeeded) {
      // Mark the write before invoking the store: a backend may persist and then throw (e.g.
      // syncing its directory), and compensation must restore the snapshot in that case too.
      gatewayAttempted = true
      deps.setGatewaySecrets(id, nextGatewayToken, nextGatewayPassword, normalized.kind === 'gateway' ? normalized : null)
    }
    if (sshWriteNeeded) {
      sshAttempted = true
      deps.setSshPassword(id, nextSshPassword, normalized.transport === 'ssh' ? normalized : null)
    }
    metadataAttempted = true
    // The proposal is the user's real registry replacement: authoritative.
    const saved = deps.saveInstances(proposed, 'authoritative')
    if (!sameInstances(saved, proposed)) {
      throw new Error('connection registry refused or normalized the proposed replacement')
    }
    if (wasActive && disconnected) deps.connect(id)
    return { ok: true, instances: saved, changes, previous, next: normalized }
  } catch (error) {
    const failures: string[] = []
    // A replacement may only have started if an injected/nonstandard manager violated the
    // pre-disconnect assumption; always stop it before restoring metadata/secrets.
    if (metadataAttempted) {
      try { deps.disconnect(id) } catch (restoreError) { failures.push(`disconnecting replacement failed: ${describeError(restoreError)}`) }
    }

    let metadataRestored = true
    if (metadataAttempted) {
      try {
        // Rollback restores the pre-transaction snapshot; it is NOT a new
        // registry truth and must leave the degraded gate untouched (while
        // degraded, the manager skips the disk write so the unknown live file
        // is not resurrected; F19).
        const restored = deps.saveInstances(before, 'compensation')
        metadataRestored = sameInstances(restored, before)
        if (!metadataRestored) failures.push('restoring connection metadata returned a different registry')
      } catch (restoreError) {
        metadataRestored = false
        failures.push(`restoring connection metadata failed: ${describeError(restoreError)}`)
      }
    }

    if (metadataRestored) {
      // Attempt both stores even if one restoration fails. Old values remain main-only
      // throughout and are never included in this result.
      if (gatewayAttempted) {
        try { deps.setGatewaySecrets(id, oldGatewayToken, oldGatewayPassword, previous?.kind === 'gateway' ? previous : null) } catch (restoreError) {
          failures.push(`restoring gateway credentials failed: ${describeError(restoreError)}`)
        }
      }
      if (sshAttempted) {
        try { deps.setSshPassword(id, oldSshPassword, previous?.transport === 'ssh' ? previous : null) } catch (restoreError) {
          failures.push(`restoring SSH password failed: ${describeError(restoreError)}`)
        }
      }
    } else {
      // Never place credentials for the OLD target onto metadata that could still name the NEW
      // target. Best-effort scrub keeps the failure safe.
      try { deps.setGatewaySecrets(id, null, null, null) } catch (restoreError) {
        failures.push(`scrubbing gateway credentials after metadata rollback failure failed: ${describeError(restoreError)}`)
      }
      try { deps.setSshPassword(id, null, null) } catch (restoreError) {
        failures.push(`scrubbing SSH password after metadata rollback failure failed: ${describeError(restoreError)}`)
      }
    }

    if (wasActive && disconnected && metadataRestored && failures.length === 0) {
      try { deps.connect(id) } catch (restoreError) {
        failures.push(`reconnecting restored connection failed: ${describeError(restoreError)}`)
      }
    }
    const authoritative = deps.listInstances()
    const note = failures.length === 0 ? '' : `; compensation failed: ${failures.join('; ')}`
    return {
      ok: false,
      instances: authoritative,
      error: `${describeError(error)}${note}`,
      metadataCommitted: !sameInstances(authoritative, before),
    }
  }
}

/**
 * Shared deletion transaction core. Production reaches it through the exact
 * id-addressed `desktop_ssh_delete_connection`; a retained-set wrapper remains
 * only for pure compatibility tests and is not exposed to the renderer.
 * Secrets and gateway sessions are
 * invalidated before the metadata deletion: a hard crash can therefore lose
 * availability, but can never leave old credentials/session state reusable by
 * a recreated id. In-process failures restore the main-only snapshots.
 */
function runDeleteConnectionsTransaction(
  deps: DeleteConnectionsTransactionDeps,
  before: TransportInstanceSpec[],
  retained: TransportInstanceSpec[],
): DeleteConnectionsTransactionResult {
  const retainedIds = new Set(retained.map(instance => instance.id))
  const removed = before.filter(instance => !retainedIds.has(instance.id))
  if (removed.length === 0) return { ok: true, instances: before, removed: [] }
  const snapshots = removed.map(spec => ({
    spec,
    sshPassword: deps.getSshPassword(spec.id),
    gatewayToken: deps.getGatewayToken(spec.id),
    gatewayPassword: deps.getGatewayPassword(spec.id),
    active: deps.isActive(spec.id),
  }))
  const disconnected: typeof snapshots = []
  let secretsAttempted = false
  let metadataAttempted = false
  try {
    for (const snapshot of snapshots) {
      // Deletion always tears down the old generation: an exec-only child can exist while the
      // transport phase is idle. Only a previously non-idle transport is eligible for
      // compensation reconnect.
      deps.disconnect(snapshot.spec.id)
      if (snapshot.active) disconnected.push(snapshot)
    }
    for (const snapshot of snapshots) {
      if (snapshot.spec.kind === 'gateway') deps.invalidateGatewaySessions(snapshot.spec)
    }
    secretsAttempted = true
    for (const snapshot of snapshots) {
      // Each durable clear includes its binding; clearing before the registry commit makes both
      // crash windows fail closed.
      deps.setGatewaySecrets(snapshot.spec.id, null, null, null)
      deps.setSshPassword(snapshot.spec.id, null, null)
    }
    metadataAttempted = true
    const saved = deps.saveInstances(retained, 'authoritative')
    if (!sameInstances(saved, retained)) throw new Error('connection registry refused the delete-only replacement')
    return { ok: true, instances: saved, removed }
  } catch (error) {
    const failures: string[] = []
    let metadataRestored = true
    if (metadataAttempted) {
      try {
        // Rollback restores the pre-transaction snapshot; it is NOT a new
        // registry truth and must leave the degraded gate untouched (while
        // degraded, the manager skips the disk write so the unknown live file
        // is not resurrected; F19).
        const restored = deps.saveInstances(before, 'compensation')
        metadataRestored = sameInstances(restored, before)
        if (!metadataRestored) failures.push('restoring connection metadata returned a different registry')
      } catch (restoreError) {
        metadataRestored = false
        failures.push(`restoring connection metadata failed: ${describeError(restoreError)}`)
      }
    }
    if (metadataRestored && secretsAttempted) {
      for (const snapshot of snapshots) {
        try {
          deps.setGatewaySecrets(snapshot.spec.id, snapshot.gatewayToken, snapshot.gatewayPassword,
            snapshot.spec.kind === 'gateway' ? snapshot.spec : null)
        } catch (restoreError) {
          failures.push(`restoring gateway credentials for ${snapshot.spec.id} failed: ${describeError(restoreError)}`)
        }
        try {
          deps.setSshPassword(snapshot.spec.id, snapshot.sshPassword,
            snapshot.spec.transport === 'ssh' ? snapshot.spec : null)
        } catch (restoreError) {
          failures.push(`restoring SSH password for ${snapshot.spec.id} failed: ${describeError(restoreError)}`)
        }
      }
    } else if (!metadataRestored) {
      for (const snapshot of snapshots) {
        try { deps.setGatewaySecrets(snapshot.spec.id, null, null, null) } catch (restoreError) {
          failures.push(`scrubbing gateway credentials for ${snapshot.spec.id} failed: ${describeError(restoreError)}`)
        }
        try { deps.setSshPassword(snapshot.spec.id, null, null) } catch (restoreError) {
          failures.push(`scrubbing SSH password for ${snapshot.spec.id} failed: ${describeError(restoreError)}`)
        }
      }
    }
    if (metadataRestored && failures.length === 0) {
      for (const snapshot of disconnected) {
        try { deps.connect(snapshot.spec.id) } catch (restoreError) {
          failures.push(`reconnecting ${snapshot.spec.id} failed: ${describeError(restoreError)}`)
        }
      }
    }
    const authoritative = deps.listInstances()
    const note = failures.length === 0 ? '' : `; compensation failed: ${failures.join('; ')}`
    return {
      ok: false,
      instances: authoritative,
      error: `${describeError(error)}${note}`,
      metadataCommitted: !sameInstances(authoritative, before),
    }
  }
}

/** Exact, linearized-by-main-event-loop delete: a stale renderer supplies only the id it intends
 *  to remove, the CURRENT authoritative roster is read once here, and an already-removed id is
 *  an idempotent no-op that can never delete a concurrently added connection. */
export function deleteConnectionTransaction(
  deps: DeleteConnectionsTransactionDeps,
  id: string,
): DeleteConnectionsTransactionResult {
  const before = deps.listInstances()
  if (!before.some(instance => instance.id === id)) {
    return { ok: true, instances: before, removed: [] }
  }
  return runDeleteConnectionsTransaction(deps, before, before.filter(instance => instance.id !== id))
}
