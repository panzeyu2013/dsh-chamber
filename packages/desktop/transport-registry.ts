/**
 * Persisted transport registry: load/save/list of the instance set, the durable
 * document, corrupt-aside recovery and the load-health state. Split out of
 * transport-manager.ts (B2-1); every effect (log, atomic write, provider lookup,
 * connect/disconnect) arrives through the deps object, so the module owns no
 * transport lifecycle of its own.
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  MAX_TRANSPORT_INSTANCES, type TransportInstanceInput, type TransportInstanceSpec,
  type TransportProvider,
} from './transport-provider.ts'
import { liveTransportIdentityChanged } from './credential-identity.ts'
import { describeError } from './describe-error.ts'
import type { InstanceState } from './transport-instance-state.ts'

/** Coded error shape the registry throws (the ssh_instances_* codes are public contract). */
interface CodedError extends Error { code?: string }

export type SaveInstancesProvenance = 'authoritative' | 'compensation'

export interface TransportRegistryDeps {
  instances: Map<string, TransportInstanceSpec>
  states: Map<string, InstanceState>
  instancesFile: string
  state: { loadFailure: string | null; incomplete: boolean; droppedCount: number }
  log: (message: string) => void
  warn: (message: string) => void
  writeFileAtomic: (file: string, text: string) => void
  resolveProvider: (entry: { kind?: unknown; transport?: unknown }) => TransportProvider
  connect: (id: string) => void
  disconnect: (id: string) => void
  execIdentityChanged: (a: TransportInstanceSpec, b: TransportInstanceSpec) => boolean
  lastFailureProbeAt: Map<string, number>
}

export function createTransportRegistry(deps: TransportRegistryDeps) {
  const {
    instances, states, instancesFile, state, log, warn, writeFileAtomic, resolveProvider,
    connect, disconnect, execIdentityChanged, lastFailureProbeAt,
  } = deps
  /** Load the persisted instance set; a missing file is an empty set. */
  function loadInstances(): TransportInstanceSpec[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(instancesFile, 'utf8'))
    } catch (error: unknown) {
      if ((error as CodedError | undefined)?.code === 'ENOENT') {
        // A missing live file is a healthy empty set only while no preserved
        // .corrupt sibling exists: after a corrupt preservation the previous
        // registry contents are unknown, never a healthy empty set.
        const preservedCorrupt = existsSync(`${instancesFile}.corrupt`)
        state.loadFailure = preservedCorrupt
          ? 'ssh-instances file is missing while its preserved .corrupt copy exists; registry contents unknown'
          : null
        if (!preservedCorrupt) {
          // Drop-free successful load: the roster-incomplete bit clears too.
          state.incomplete = false
          state.droppedCount = 0
        }
        return listInstances()
      }
      // Corrupt instance file: loud failure, never a fake-empty set; the caller
      // (desktop main) preserves the file before starting empty.
      const wrapped: CodedError = new Error(`ssh-instances file is corrupt: ${describeError(error)}`)
      wrapped.code = 'ssh_instances_corrupt'
      state.loadFailure = wrapped.message
      throw wrapped
    }
    if (!Array.isArray(parsed)) {
      const wrapped: CodedError = new Error('ssh-instances file does not contain an array')
      wrapped.code = 'ssh_instances_corrupt'
      state.loadFailure = wrapped.message
      throw wrapped
    }
    if (parsed.length > MAX_TRANSPORT_INSTANCES) {
      const wrapped: CodedError = new Error(`ssh-instances file exceeds the ${MAX_TRANSPORT_INSTANCES}-instance limit`)
      wrapped.code = 'ssh_instances_too_many'
      state.loadFailure = wrapped.message
      throw wrapped
    }
    const dropped: unknown[] = []
    const seenIds = new Set<string>()
    let duplicates = 0
    for (const entry of parsed) {
      // A null/non-object entry must never throw inside provider resolution: drop
      // it loudly with the other invalid entries (the per-entry defense).
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        dropped.push(entry)
        continue
      }
      // Provider selection is transport-keyed; the entry must already carry
      // the current kind+transport pair (pre-v2 rows are dropped loudly).
      const providerFor = resolveProvider(entry as { kind?: unknown; transport?: unknown })
      const normalized = providerFor.validateSpec(entry)
      if (normalized === null) {
        dropped.push(entry)
        continue
      }
      if (seenIds.has(normalized.id)) {
        // Duplicate persisted ids: first wins (last-wins would silently flip the registry).
        duplicates += 1
        continue
      }
      seenIds.add(normalized.id)
      instances.set(normalized.id, normalized)
    }
    if (dropped.length > 0) warn(`transport-manager: dropped ${dropped.length} invalid instance(s) from ${instancesFile}`)
    if (duplicates > 0) warn(`transport-manager: dropped ${duplicates} duplicate id(s) from ${instancesFile} (first wins)`)
    // V5-A: the parse succeeded, but rows were dropped — the disk file HAS
    // content this process cannot represent (a provider-rejected entry, or a
    // duplicate id), so the in-memory roster is a PARTIAL view. The health
    // probe reports rosterIncomplete so the renderer refuses to retire durable
    // unread keys from it (the typical trigger is a new-writer/old-reader
    // field drift). A drop-free load or an authoritative save clears it.
    state.droppedCount = dropped.length + duplicates
    state.incomplete = state.droppedCount > 0
    state.loadFailure = null
    return listInstances()
  }

  /**
   * Persist a new instance set (atomic write) and align the registry: instances
   * that disappeared are disconnected and removed. Save is an all-or-nothing
   * proposal — one invalid/provider-mismatched entry or duplicate id rejects the
   * whole replacement before persistence or live transport mutation (load-time
   * recovery stays lenient). Instances whose target kind, transport method or
   * parameters changed revoke the old tunnel and exec generations before
   * publication, and teardown always runs while the OLD spec is still
   * authoritative so provider-owned resources observe the old kind.
   * `provenance` defaults to `'authoritative'`; a `'compensation'` rollback keeps
   * both registry health bits and skips the disk write while either is closed
   * (F19/V5-A; see SaveInstancesProvenance). An AUTHORITATIVE write rebuilds the
   * file and clears both bits.
   */
  function saveInstances(
    next: TransportInstanceInput[],
    provenance: SaveInstancesProvenance = 'authoritative',
  ): TransportInstanceSpec[] {
    if (!Array.isArray(next)) {
      const error: CodedError = new Error('instances must be an array')
      error.code = 'ssh_instances_invalid'
      throw error
    }
    if (next.length > MAX_TRANSPORT_INSTANCES) {
      const error: CodedError = new Error(`instances exceed the ${MAX_TRANSPORT_INSTANCES}-instance limit`)
      error.code = 'ssh_instances_too_many'
      throw error
    }
    const kept: TransportInstanceSpec[] = []
    const restartIds: string[] = []
    const stopBeforeReplaceIds: string[] = []
    const projectionResetIds: string[] = []
    const seenIds = new Set<string>()
    for (const [index, entry] of next.entries()) {
      // Save is all-or-nothing: a malformed entry rejects the whole roster before
      // any persistence, credential commit, or runtime mutation.
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        const error: CodedError = new Error(`instance at index ${index} is invalid`)
        error.code = 'ssh_instances_invalid'
        throw error
      }
      const providerFor = resolveProvider(entry as { kind?: unknown; transport?: unknown })
      const normalized = providerFor.validateSpec(entry)
      if (normalized === null) {
        const error: CodedError = new Error(`instance at index ${index} is invalid for its transport provider`)
        error.code = 'ssh_instances_invalid'
        throw error
      }
      if (seenIds.has(normalized.id)) {
        const error: CodedError = new Error(`duplicate instance id at index ${index}`)
        error.code = 'ssh_instances_duplicate'
        throw error
      }
      seenIds.add(normalized.id)
      const previous = instances.get(normalized.id)
      const state = previous === undefined ? undefined : states.get(normalized.id)
      if (previous !== undefined && execIdentityChanged(previous, normalized)) {
        projectionResetIds.push(normalized.id)
      }
      // transport/insecureHttp/SPKI are part of the live-transport identity:
      // switching mechanism, scheme or pin while live must restart the transport so
      // projection/proxy URL never disagrees; none of these is a credential, so the
      // token/password survive the edit. Field set single-sourced in
      // credential-identity.ts.
      const transportFieldsChanged = previous !== undefined && liveTransportIdentityChanged(previous, normalized)
      if (transportFieldsChanged && state !== undefined) {
        // Always revoke the old generation, including the between-child gap of a
        // multi-stage exec; only an actually live transport is restarted.
        stopBeforeReplaceIds.push(normalized.id)
        if (state.phase !== 'idle') restartIds.push(normalized.id)
      }
      kept.push(normalized)
    }
    // Persist BEFORE mutating the in-memory registry: a failed write throws while
    // the registry and every live transport stay untouched, so runtime and UI never
    // diverge; connection-save.ts coordinates the secondary stores and rollback.
    // F19/V5-A: a COMPENSATION rollback never writes while the degraded or
    // incomplete gate is closed — an authoritative-looking empty/partial snapshot
    // would make the next launch settle (and prune durable keys from) a roster it
    // cannot trust. Memory still accepts `next` so connection-save.ts can verify
    // the rollback against the pre-transaction snapshot.
    if (provenance === 'compensation' && state.loadFailure !== null) {
      warn(`transport-manager: registry load is degraded; skipping the compensation write of ${kept.length} instance(s) (live file left untouched, degraded gate stays closed)`)
    } else if (provenance === 'compensation' && state.incomplete) {
      warn(`transport-manager: registry roster is incomplete; skipping the compensation write of ${kept.length} instance(s) (live file left untouched, incomplete gate stays closed)`)
    } else {
      writeFileAtomic(instancesFile, `${JSON.stringify(kept, undefined, 2)}\n`)
    }
    // An AUTHORITATIVE write is new registry truth: the file was rebuilt, so both
    // load-health bits clear here (a compensation keeps them closed).
    if (provenance === 'authoritative') {
      state.loadFailure = null
      state.incomplete = false
      state.droppedCount = 0
    }
    const nextIds = new Set(kept.map(entry => entry.id))
    for (const id of [...instances.keys()]) {
      if (!nextIds.has(id)) {
        const removedSpec = instances.get(id)
        log(`transport-manager: instance ${id} removed from the set; disconnecting its transport`)
        disconnect(id)
        // The instance is GONE: drop its runtime state so a later same-id reuse
        // starts clean. An in-flight exec of the removed instance can never write
        // into the NEW state (stale via the execEpoch bump; this is authoritative).
        states.delete(id)
        lastFailureProbeAt.delete(id)
        // Request final cleanup of every provider-owned generation on REMOVAL:
        // purge never invalidates a still-running child's askpass environment.
        if (removedSpec !== undefined) resolveProvider(removedSpec).purgeAuth?.(removedSpec)
      }
    }
    // Stop changed transports BEFORE replacing `instances`: disconnect() resolves
    // the provider from the current entry and would otherwise unregister the wrong target.
    for (const id of stopBeforeReplaceIds) {
      log(`transport-manager: instance ${id} transport kind/parameters changed; stopping old transport`)
      disconnect(id)
      // A same-id operational replacement is a fresh runtime generation: drop the
      // retired state's ring/projections so they never present as replacement facts.
      states.delete(id)
      lastFailureProbeAt.delete(id)
    }
    instances.clear()
    for (const entry of kept) instances.set(entry.id, entry)
    // Provider-specific fields cannot cross a kind boundary (an SSH systemd result never appears on a gateway status).
    for (const id of projectionResetIds) {
      const state = states.get(id)
      if (state !== undefined) state.serviceActive = null
    }
    // Parameters changed while live: start a fresh transport under the new spec
    // (disconnect is idempotent; connect reads the now-updated registry).
    for (const id of restartIds) {
      log(`transport-manager: instance ${id} transport kind/parameters changed; starting replacement transport`)
      connect(id)
    }
    return listInstances()
  }

  /** The current instance set (non-secret metadata). */
  function listInstances(): TransportInstanceSpec[] {
    return [...instances.values()].map(spec => ({ ...spec }))
  }

  /** Start (or restart) the transport for one instance: idempotent while
   *  connecting/ready; a manual connect resets retry and clears the pending reconnect. */

  return { loadInstances, saveInstances, listInstances }
}
