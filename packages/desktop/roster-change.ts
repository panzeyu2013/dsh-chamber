/**
 * Committed roster change set — the host's ONE conclusion for a persisted registry
 * replacement (design D §3.2.1/§3.4). Pure, clockless, zero IO: the caller already
 * holds the authoritative before/after snapshots and applies the consequences.
 *
 * A dimension is a CONSEQUENCE, not a second identity table: one edit may hit several
 * dimensions (a host edit = sourceRetire + transportRebuild + execRevoke + forwardRevoke
 * + seedRevoke) and each consumer reads only its own domain. The field sets themselves
 * stay single-sourced in credential-identity.ts (live transport / logical source);
 * execIdentityChanged lives HERE so the exec channel fence in transport-manager.ts and the
 * change set share one list; operationalFingerprint is the ONE seed-ownership fingerprint
 * (host-assembly imports it for its remote-target closure; the change set uses it for seed dims).
 */
import {
  liveTransportIdentityChanged,
  logicalSourceIdentityChanged,
} from './credential-identity.ts'
import type { TransportInstanceSpec, TransportKind, TransportMethod } from './transport-provider.ts'

/** Everything one committed roster replacement may require of one source. */
export type RosterChangeDimension =
  /** Only presentation (label) changed: install the row, no teardown, no rotation. */
  | 'displayOnly'
  /** Stop the old transport generation and start one under the new spec while live. */
  | 'transportRebuild'
  /** Revoke in-flight/queued remote exec work and provider-owned exec projections. */
  | 'execRevoke'
  /** The LOGICAL source ended: proof rotation, notification-incarnation and shell retirement. */
  | 'sourceRetire'
  /** The shell's boot capability word (chamberTransport) changed: remount the shell, keep the source. */
  | 'bootCapability'
  /** The old ssh forward leg died: release its forward children and alias namespace. */
  | 'forwardRevoke'
  /** Revoke chamber host package seed ownership for the changed target. */
  | 'seedRevoke'
  /** Same-id target is still a dsh×ssh source: explicitly reseed once it is ready. */
  | 'seedReseed'

/** Exec-channel identity: fields that bind provider exec work to one connection
 *  generation. label, HTTP scheme and SPKI never change an SSH exec target; service and
 *  dsh home do. saveInstances disconnects/bumps exec epochs on exactly this set. */
export function execIdentityChanged(
  previous: TransportInstanceSpec,
  next: TransportInstanceSpec,
): boolean {
  return previous.kind !== next.kind
    || previous.transport !== next.transport
    || previous.host !== next.host
    || previous.user !== next.user
    || previous.sshPort !== next.sshPort
    || previous.remotePort !== next.remotePort
    || previous.serviceName !== next.serviceName
    || previous.remoteDshHome !== next.remoteDshHome
}

/** Chamber host package seed fingerprint: EXACTLY the serialization host-assembly.ts
 *  injects today (nested transport-identity array + service/home), so the change set's
 *  seed dimensions cannot drift from the fingerprint the assembly gives
 *  publishRegistryTransition. The assembly batch moves it onto this export. */
export function operationalFingerprint(instance: TransportInstanceSpec): string {
  return JSON.stringify([
    JSON.stringify([
      instance.kind,
      instance.transport,
      instance.host,
      instance.user,
      instance.sshPort,
      instance.remotePort,
    ]),
    instance.serviceName,
    instance.remoteDshHome,
  ])
}

/** Does the change kill the old ssh forward leg? The forward lease is keyed by the
 *  kind-prefixed sourceId and its identity digest covers the ssh endpoint AND the
 *  forwarded target port (remote-forward-service.ts forwardSourceIdentity), so:
 *  mechanism leaves ssh, the ssh endpoint / forwarded port changes, the sourceId changes
 *  (kind edit), or the row is removed. service/home edits, HTTP scheme and SPKI are NOT
 *  forward facts (v2 review C8) — they rebuild the transport but never revoke a lease. */
function forwardLegInvalid(previous: TransportInstanceSpec, current: TransportInstanceSpec | undefined): boolean {
  if (previous.transport !== 'ssh') return false
  if (current === undefined) return true
  return current.transport !== 'ssh'
    || current.kind !== previous.kind
    || current.host !== previous.host
    || current.user !== previous.user
    || current.sshPort !== previous.sshPort
    || current.remotePort !== previous.remotePort
}

/** One after-row conclusion (removedRows keep the BEFORE row's kind/transport/sourceId). */
export interface RosterChangeRow {
  /** Raw registry id — the IPC push unit. */
  readonly id: string
  readonly kind: TransportKind
  /** kind + '-' + id — the renderer/forward/guest unit. */
  readonly sourceId: string
  /** The AFTER row's transport (the BEFORE row's on removedRows). */
  readonly nextTransport: TransportMethod
  readonly removed: boolean
  readonly dimensions: ReadonlySet<RosterChangeDimension>
}

/** The host-side diff of one committed registry replacement. Arrays are deduped and
 *  order-stable (BEFORE row order for everything derived from the previous roster;
 *  AFTER row order for bootCapabilityIds). */
export interface RosterChangeSet {
  /** One row per AFTER instance. */
  readonly rows: readonly RosterChangeRow[]
  /** BEFORE rows that no longer exist in AFTER. */
  readonly removedRows: readonly RosterChangeRow[]
  /** Physical deletions, deduped in BEFORE order. */
  readonly removedIds: readonly string[]
  /** Renderer retirement set: removedIds then logical-source retargets (BEFORE order). */
  readonly retiredIds: readonly string[]
  /** Rows whose boot capability word changed (AFTER order; a retired source is excluded). */
  readonly bootCapabilityIds: readonly string[]
  readonly transportRebuildIds: readonly string[]
  readonly execRevokeIds: readonly string[]
  readonly forwardRevokeIds: readonly string[]
  /** The OLD sourceIds whose forward namespaces/children must be released (kind-prefixed). */
  readonly forwardRevokeSourceIds: readonly string[]
  readonly seedRevokeIds: readonly string[]
  readonly seedReseedIds: readonly string[]
}

const EMPTY_DIMENSIONS: ReadonlySet<RosterChangeDimension> = new Set()

function computeDimensions(
  previous: TransportInstanceSpec,
  current: TransportInstanceSpec,
): Set<RosterChangeDimension> {
  const dimensions = new Set<RosterChangeDimension>()
  const sourceRetire = logicalSourceIdentityChanged(previous, current)
  if (sourceRetire) dimensions.add('sourceRetire')
  if (execIdentityChanged(previous, current)) dimensions.add('execRevoke')
  if (liveTransportIdentityChanged(previous, current)) dimensions.add('transportRebuild')
  // Retirement already tears the shell down; a remount would fight that teardown (I1:
  // retire wins). Only a surviving source can be remounted for its new transport word.
  if (previous.transport !== current.transport && !sourceRetire) dimensions.add('bootCapability')
  if (forwardLegInvalid(previous, current)) dimensions.add('forwardRevoke')
  if (operationalFingerprint(previous) !== operationalFingerprint(current)) {
    dimensions.add('seedRevoke')
    // A service/home edit of a completed dsh×ssh target reseeds under the same owner.
    if (current.kind === 'dsh' && current.transport === 'ssh') dimensions.add('seedReseed')
  }
  // Presentation is a dimension only when nothing else changed; any other consequence
  // already installs the new label with the row.
  if (dimensions.size === 0 && previous.label !== current.label) dimensions.add('displayOnly')
  return dimensions
}

/**
 * Diff one committed registry replacement. Duplicate ids are rejected by saveInstances
 * before this runs; a duplicate here is tolerated (first occurrence wins for the maps,
 * every BEFORE row still contributes at most one entry to each id list).
 */
export function computeRosterChangeSet(
  before: readonly TransportInstanceSpec[],
  after: readonly TransportInstanceSpec[],
): RosterChangeSet {
  const beforeById = new Map<string, TransportInstanceSpec>()
  const seenBefore = new Set<string>()
  for (const previous of before) {
    if (!beforeById.has(previous.id)) beforeById.set(previous.id, previous)
    seenBefore.add(previous.id)
  }
  const afterById = new Map<string, TransportInstanceSpec>()
  for (const current of after) if (!afterById.has(current.id)) afterById.set(current.id, current)

  const removedIds: string[] = []
  const editSourceRetireIds: string[] = []
  const transportRebuildIds: string[] = []
  const execRevokeIds: string[] = []
  const forwardRevokeIds: string[] = []
  const forwardRevokeSourceIds: string[] = []
  const seedRevokeIds: string[] = []
  const seedReseedIds: string[] = []
  const removedRows: RosterChangeRow[] = []
  const changeById = new Map<string, Set<RosterChangeDimension>>()
  const seenForwardSourceId = new Set<string>()
  const reportForward = (previous: TransportInstanceSpec): void => {
    forwardRevokeIds.push(previous.id)
    const sourceId = previous.kind + '-' + previous.id
    if (!seenForwardSourceId.has(sourceId)) {
      seenForwardSourceId.add(sourceId)
      forwardRevokeSourceIds.push(sourceId)
    }
  }

  // BEFORE order: removals, per-row dimensions and every previous-roster-derived list.
  for (const previous of before) {
    if (!seenBefore.delete(previous.id)) continue
    const current = afterById.get(previous.id)
    if (current === undefined) {
      removedIds.push(previous.id)
      // Removal revokes the seed owner too (host-registry-transition's previous loop did
      // this for every disappeared row); only a surviving dsh×ssh target can reseed.
      seedRevokeIds.push(previous.id)
      const dimensions = new Set<RosterChangeDimension>(['sourceRetire', 'execRevoke'])
      if (forwardLegInvalid(previous, undefined)) {
        dimensions.add('forwardRevoke')
        reportForward(previous)
      }
      removedRows.push({
        id: previous.id,
        kind: previous.kind,
        sourceId: previous.kind + '-' + previous.id,
        nextTransport: previous.transport,
        removed: true,
        dimensions,
      })
      continue
    }
    const dimensions = computeDimensions(previous, current)
    changeById.set(previous.id, dimensions)
    if (dimensions.has('sourceRetire')) editSourceRetireIds.push(previous.id)
    if (dimensions.has('transportRebuild')) transportRebuildIds.push(previous.id)
    if (dimensions.has('execRevoke')) execRevokeIds.push(previous.id)
    if (dimensions.has('forwardRevoke')) reportForward(previous)
    if (dimensions.has('seedRevoke')) {
      seedRevokeIds.push(previous.id)
      if (dimensions.has('seedReseed')) seedReseedIds.push(previous.id)
    }
  }

  // AFTER order: rows + boot capability (the renderer's remount planning unit).
  const rows: RosterChangeRow[] = []
  const bootCapabilityIds: string[] = []
  for (const current of after) {
    const dimensions = changeById.get(current.id) ?? EMPTY_DIMENSIONS
    rows.push({
      id: current.id,
      kind: current.kind,
      sourceId: current.kind + '-' + current.id,
      nextTransport: current.transport,
      removed: false,
      dimensions,
    })
    if (dimensions.has('bootCapability')) bootCapabilityIds.push(current.id)
  }

  // retiredIds: the physical deletions first, then same-id logical retargets, stable in
  // BEFORE order and free of duplicates (renderer/native consumers treat it as a set,
  // the pinned order keeps assertions and logs deterministic).
  const retiredIds = [...removedIds]
  const retiredSeen = new Set(removedIds)
  for (const id of editSourceRetireIds) {
    if (retiredSeen.has(id)) continue
    retiredSeen.add(id)
    retiredIds.push(id)
  }

  return {
    rows,
    removedRows,
    removedIds,
    retiredIds,
    bootCapabilityIds,
    transportRebuildIds,
    execRevokeIds,
    forwardRevokeIds,
    forwardRevokeSourceIds,
    seedRevokeIds,
    seedReseedIds,
  }
}
