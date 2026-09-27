/**
 * Live client-plugin graph sync: one chamber-owned EventSource per instance shell
 * (`<basePath>/plugins/events`, the upstream HMR host route) feeding an id-set
 * reconciler for the LIVE ctx of that instance — add/remove rows without a window
 * reload.
 *
 * WHY THIS SHAPE: the official HMR client half opens a DOCUMENT-relative
 * EventSource, which in the chamber page would hit the control-plane origin
 * (the composite entry covers it and its bundles are runtime-loaded, so no build
 * patch can re-base it). The host route itself is a per-instance service, so the
 * chamber subscribes at the instance prefix instead and keeps the official client
 * row unloaded (chamber-covered.ts).
 *
 * SCOPE (v1): row ADD/REMOVE by id. A rev change for a mounted id is a fact, not
 * a re-mount: the page-level module table is first-load-wins per id, so the panel
 * reports `restart-required` (or `instance-version-conflict` across sources) and
 * waits for a window reload. Rebuilt frames need no handling: upstream's
 * `rebuilt()` recomposes and fires the graph listeners, so a fresh graph frame
 * always follows.
 *
 * OPPORTUNISTIC BY CONTRACT: a missing/failing channel is NOT a degrade — every
 * path below no-ops, and boot stays the FALLBACK authority for the row set whenever the
 * channel is unavailable (an answered channel's graph frames take over add/remove, §3.7).
 * Arm/disarm is owned by shell.ts: disarm happens synchronously at the next
 * same-id boot entry and inside disposeHolder, and the in-flight pass joins the
 * id-local teardown barrier (the page-level loader kernel and module table are
 * SHARED across sources, so a superseded pass must never interleave with a
 * successor's eager preload). Every await re-checks `isCurrent` — except the two
 * deliberate cases documented in design 09 §3.7: the page-level chunk-owner delete
 * on removal is never fenced, and the recheck retry acts after its last remove await.
 *
 * UNLOAD BOUNDARY (deliberate): removal drops the loader entry and the chunk-owner
 * row and awaits fiber inertia; it KEEPS the module-table factory, the loadCache
 * record and the injected `style[data-plugin]` tags, because a same-rev re-add
 * never re-executes the script — deleting one ledger without the others produces
 * either a duplicate-factory throw or permanently missing styles.
 */

import { describeThrown, type PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'
import {
  clientPluginRowOwner, dedupeCoveredRows, loadClientPluginRows, type ClientRowOutcome,
} from '@dsh-chamber/dsh-chamber-client-core/client-plugin-loader'
import { CHAMBER_COVERED_IDS } from './chamber-covered.ts'
import {
  parseGraphRows, restartRequiredMessage, toExtraRows, versionConflictMessage,
  type ExtraModuleRow, type HostGraphRow,
} from './host-graph.ts'
import type { PluginGraphBaseEntry } from '@dsh-chamber/dsh-chamber-client-core/plugin-graph-classify'

/** 页面级急停开关（devtools/测试用；用户面急停 = safe mode）: `false` 关闭 live sync。 */
const LIVE_SYNC_GLOBAL = '__DSH_CHAMBER_LIVE_PLUGIN_SYNC__'

/**
 * Read the page-level kill switch AT ARM TIME (no cache): safe mode is the user-facing
 * kill switch; this global is the devtools/test hatch. Only an explicit boolean `false`
 * disables — a missing key or any other value keeps live sync on.
 * @param scope - default globalThis; tests inject an equivalent object.
 */
export function readLiveSyncEnabled(scope: unknown = globalThis): boolean {
  if (typeof scope !== 'object' || scope === null) return true
  return (scope as Record<string, unknown>)[LIVE_SYNC_GLOBAL] !== false
}

/** Loose mirror of one vendored cordis loader entry (never a direct import). */
export interface LiveLoaderEntryFace {
  id?: string
  options?: { name?: string }
  fiber?: { state?: number; await?(): Promise<unknown>; inertia?: Promise<unknown> }
}

/** The loader slice the reconciler drives (cordis entry ids are RANDOM: removal
 *  must use the id returned by create/resolved from the live entry, never the
 *  plugin name). */
export interface LiveLoaderFace {
  entries(): readonly LiveLoaderEntryFace[]
  create(options: { name: string }): Promise<string>
  remove(id: string): void
  resolve(id: string): LiveLoaderEntryFace
}

/** The browser EventSource slice (injected so plain-node tests never open one). */
export interface LiveEventSourceFace {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void
  close(): void
}

/** One row this holder currently owns, with the entry id create returned. */
export interface MountedLiveRow {
  row: ExtraModuleRow
  entryId?: string
  /** Created but not yet ACTIVE (waiting on services/dependencies). */
  pending?: boolean
}

/** The pure id-set diff one graph frame produces. */
export interface LiveRowDiff {
  remove: { id: string; mounted: MountedLiveRow }[]
  add: ExtraModuleRow[]
  revChanged: { mounted: MountedLiveRow; incoming: ExtraModuleRow }[]
  recheck: { id: string; mounted: MountedLiveRow }[]
}

/**
 * Diff the incoming kept rows against the mounted set. Pure; duplicate incoming
 * ids keep their first occurrence (the kernel would dedupe the combo anyway).
 */
export function diffLiveRows(
  mounted: ReadonlyMap<string, MountedLiveRow>,
  incoming: readonly ExtraModuleRow[],
): LiveRowDiff {
  const byId = new Map<string, ExtraModuleRow>()
  for (const row of incoming) if (!byId.has(row.id)) byId.set(row.id, row)
  const remove = [...mounted]
    .filter(([id]) => !byId.has(id))
    .map(([id, entry]) => ({ id, mounted: entry }))
  const add: ExtraModuleRow[] = []
  const revChanged: LiveRowDiff['revChanged'] = []
  const recheck: LiveRowDiff['recheck'] = []
  for (const [id, row] of byId) {
    const entry = mounted.get(id)
    if (entry === undefined) {
      add.push(row)
      continue
    }
    if (entry.row.rev !== row.rev) {
      revChanged.push({ mounted: entry, incoming: row })
      continue
    }
    if (entry.pending === true) recheck.push({ id, mounted: entry })
  }
  return { remove, add, revChanged, recheck }
}

/** One parsed SSE frame; `null` = malformed (the caller counts it and moves on). */
export type PluginEventFrame =
  | { kind: 'graph'; rows: HostGraphRow[] }
  | { kind: 'rebuilt'; id: string; rev: string }
  /** A well-formed frame of a type this chamber does not consume (upstream may add more). */
  | { kind: 'ignored' }

/**
 * Parse one `/plugins/events` data payload. Graph frames run the SAME row
 * projection as the boot fetch (`parseGraphRows`); any wire violation returns
 * null instead of throwing — a live frame must never fail the page.
 */
export function parsePluginEventFrame(data: string): PluginEventFrame | null {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const frame = value as Record<string, unknown>
  if (frame.type === 'rebuilt') {
    return typeof frame.id === 'string' && typeof frame.rev === 'string'
      ? { kind: 'rebuilt', id: frame.id, rev: frame.rev }
      : null
  }
  // Any non-graph type is a forward-compatible no-op (upstream's own client treats it as
  // unknown too); only a structurally invalid GRAPH frame counts as malformed.
  if (frame.type !== 'graph') return { kind: 'ignored' }
  const graph = frame.graph
  if (typeof graph !== 'object' || graph === null) return null
  const entries = (graph as Record<string, unknown>).entries
  if (!Array.isArray(entries)) return null
  // The shared base gate (mirror of the classifier's own): string id/url/rev.
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) return null
    const row = raw as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.rev !== 'string') return null
  }
  try {
    return { kind: 'graph', rows: parseGraphRows(entries as PluginGraphBaseEntry[]) }
  } catch {
    return null
  }
}

/** The diagnostic slot adapter (chamberBridge in production; tests inject a map). */
export interface LiveDiagnosticSink {
  read(): PluginGraphDiagnostic | undefined
  write(record: PluginGraphDiagnostic): void
}

export interface LiveGraphSyncDeps {
  /** Diagnostic-store key (`local` | `<kind>-<id>`). */
  sourceId: string
  /** Instance proxy prefix (`/api/i/<id>`). */
  basePath: string
  /** The boot rows this shell kept (mount + rev baseline). */
  initialRows: readonly ExtraModuleRow[]
  loader: LiveLoaderFace
  registerChunkOwners(rows: readonly ExtraModuleRow[]): void
  removeChunkOwners(ids: readonly string[]): void
  loadBundle(url: string): Promise<void>
  diagnostics: LiveDiagnosticSink
  /** Holder identity + generation fence: re-checked after EVERY await. */
  isCurrent(): boolean
  fiberIsActive(fiber: LiveLoaderEntryFace['fiber']): boolean
  /** True when a fiber can never activate any more (FAILED/DISPOSED/UNLOADING): live
   *  treats it like a fiberless entry (drop now + retry on the next frame) instead of
   *  reporting the row "mounted but not active" forever. boot-tolerance.ts owns the
   *  terminal-state semantics: a tolerated apply failure is marked degraded/failed and
   *  is NOT retried by the boot path. */
  fiberIsTerminal(fiber: LiveLoaderEntryFace['fiber']): boolean
  /** EventSource factory; absent = the channel is unavailable on this host. */
  createEventSource?(url: string): LiveEventSourceFace
  now?(): number
  /** Bounded activation wait; defaults to {@link LIVE_ACTIVATION_TIMEOUT_MS}. */
  activationTimeoutMs?: number
  warn?(message: string, detail?: unknown): void
}

/** The handle shell.ts owns: disarm once, await the joined-in-flight pass. */
export interface LiveGraphSync {
  disarm(): Promise<void>
}

/** Activation wait for a newly created entry (create resolves before inject settles). */
const LIVE_ACTIVATION_TIMEOUT_MS = 5_000

/** Bound on the fiber.inertia drain during removal (a wedged disposer must not wedge the id). */
const LIVE_INERTIA_TIMEOUT_MS = 2_000

type LiveFact =
  | { kind: 'version-conflict'; id: string; owner: string }
  | { kind: 'restart-required'; id: string; message: string }
  | { kind: 'load-failed'; id: string; message: string }
  | { kind: 'pending'; id: string; message: string }

/** One text for the mounted-but-inactive fact (derived, emitted and re-emitted). */
function pendingMessage(id: string): string {
  return `客户端插件 ${id} 已挂载但未在窗口内激活（等待服务/依赖）`
}

/** Fact identity: the same projected fact, regardless of when it was written. */
function sameFact(a: PluginGraphDiagnostic, b: PluginGraphDiagnostic): boolean {
  return a.state === b.state && a.message === b.message && a.pluginId === b.pluginId
}

/** Exact record identity: fact identity + the write stamp (provenance CAS). */
function sameRecord(a: PluginGraphDiagnostic, b: PluginGraphDiagnostic): boolean {
  return sameFact(a, b) && a.updatedAt === b.updatedAt
}

/**
 * Start the reconciler for one holder. Returns synchronously; the EventSource is
 * the only side effect until the first frame arrives.
 */
export function startLiveGraphSync(deps: LiveGraphSyncDeps): LiveGraphSync {
  const now = deps.now ?? (() => Date.now())
  const warn = deps.warn ?? ((message: string, detail?: unknown) => { console.warn(message, detail) })
  const activationTimeoutMs = deps.activationTimeoutMs ?? LIVE_ACTIVATION_TIMEOUT_MS
  const mounted = new Map<string, MountedLiveRow>()
  /** The exact record this reconciler last wrote (provenance CAS). */
  let lastWrite: PluginGraphDiagnostic | undefined
  /** Ids this reconciler has positively mounted (provenance clause (3): their
   *  stale boot facts may be cleared — the set is a managed set, not per-pass). */
  const handled = new Set<string>()
  let disposed = false
  let malformedLogged = false
  let errorLogged = false
  /** Newest GRAPH frame not yet consumed; a no-op frame must never evict it. */
  let pendingFrame: Extract<PluginEventFrame, { kind: 'graph' }> | null = null
  let running = false
  let current: Promise<void> = Promise.resolve()

  /** Snapshot the mounted set from the settled loader (boot rows only). */
  const entriesByName = new Map<string, LiveLoaderEntryFace>()
  try {
    for (const entry of deps.loader.entries()) {
      const name = entry?.options?.name
      if (typeof name === 'string') entriesByName.set(name, entry)
    }
  } catch (error) {
    warn('[live-graph] loader entry scan failed; live sync starts with an empty baseline', error)
  }
  for (const row of deps.initialRows) {
    const entry = entriesByName.get(row.id)
    if (entry === undefined) continue
    const fiber = entry.fiber
    if (fiber === undefined || deps.fiberIsTerminal(fiber)) {
      // The boot pass materialized this entry but it can never activate: no fiber at all
      // (import failed), or a TERMINAL fiber (FAILED/DISPOSED/UNLOADING — a tolerated
      // apply failure is boot-tolerance's degraded/failed verdict, never a retry). Drop it
      // now: the loader keys entries by id, so retrying the row later would create a SECOND
      // entry with the same name (orphan). The next frame's add retries it instead, and the
      // retry's real create/apply error is what gets reported. Not fenced on purpose — this
      // runs synchronously on the current holder before any pass, and a terminal entry is
      // already dead.
      const deadId = entry.id
      if (deadId !== undefined) {
        try { deps.loader.remove(deadId) } catch { /* best effort */ }
      }
      continue
    }
    mounted.set(row.id, { row, entryId: entry.id, pending: !deps.fiberIsActive(fiber) })
  }

  const resolveEntry = (entryId: string): LiveLoaderEntryFace | undefined => {
    try {
      return deps.loader.resolve(entryId)
    } catch {
      return undefined
    }
  }

  const publish = (facts: readonly LiveFact[]): void => {
    const pick = (kind: LiveFact['kind']): LiveFact | undefined => facts.find(fact => fact.kind === kind)
    const fact = pick('version-conflict') ?? pick('restart-required') ?? pick('load-failed') ?? pick('pending')
    const currentRecord = deps.diagnostics.read()
    if (fact === undefined) {
      // No fact: heal OUR OWN previous fact only (a boot fact stays untouched
      // unless this pass positively handled that plugin id).
      if (currentRecord !== undefined
        && ((lastWrite !== undefined && sameRecord(currentRecord, lastWrite))
          || (currentRecord.pluginId !== undefined && handled.has(currentRecord.pluginId)))) {
        const ok: PluginGraphDiagnostic = { state: 'ok', updatedAt: now() }
        // A repeated no-fact frame must not rewrite the same ok record (the wall clock
        // makes updatedAt differ every pass).
        if (lastWrite === undefined || !sameFact(lastWrite, ok)) {
          deps.diagnostics.write(ok)
          lastWrite = ok
        }
      }
      return
    }
    const record: PluginGraphDiagnostic = fact.kind === 'version-conflict'
      ? {
        state: 'instance-version-conflict',
        pluginId: fact.id,
        message: versionConflictMessage(fact.id, fact.owner),
        updatedAt: now(),
      }
      : fact.kind === 'restart-required'
        ? { state: 'restart-required', pluginId: fact.id, message: fact.message, updatedAt: now() }
        : { state: 'bundle-load-failed', pluginId: fact.id, message: fact.message, updatedAt: now() }
    // Skip only when the slot STILL holds what we wrote: if another writer (or a
    // retire path) cleared or replaced it, the fact must be re-published.
    if (lastWrite !== undefined && sameFact(lastWrite, record)
      && currentRecord !== undefined && sameFact(currentRecord, record)) return
    // Write discipline: never clobber a fact another plugin id owns.
    if (currentRecord !== undefined
      && currentRecord.pluginId !== record.pluginId
      && !(lastWrite !== undefined && sameRecord(currentRecord, lastWrite))) return
    deps.diagnostics.write(record)
    lastWrite = record
  }

  /** The page-level chunk-owner table is id-keyed and SHARED across sources: a second
   *  source mounting an already-claimed id reuses the owner's factory, so its add
   *  rollback/remove must never delete a descriptor it does not own (the owner's still-
   *  mounted row needs it). `undefined` = nobody claimed the id yet, so this source's own
   *  registration is the only one. */
  const ownsChunkDescriptor = (id: string): boolean => {
    const owner = clientPluginRowOwner(id)
    return owner === undefined || owner === deps.sourceId
  }

  const removeMounted = async (item: { id: string; mounted: MountedLiveRow }): Promise<void> => {
    mounted.delete(item.id)
    const entryId = item.mounted.entryId
    if (entryId !== undefined) {
      const entry = resolveEntry(entryId)
      try {
        deps.loader.remove(entryId)
      } catch (error) {
        warn(`[live-graph] loader.remove(${entryId}) for ${item.id} failed`, error)
      }
      // Upstream reconcile drains fiber.inertia in a loop (a disposal phase can install a
      // new promise); bounded here so a never-cleared field cannot wedge the pass.
      const fiber = entry?.fiber
      let guard = 0
      while (fiber?.inertia !== undefined && guard++ < 8) {
        const drain = fiber.inertia
        try {
          // Bounded: the disarm promise joins the successor's teardown barrier, so a
          // wedged disposer must not queue the next same-id boot forever.
          await Promise.race([
            drain,
            new Promise<void>(resolve => setTimeout(resolve, LIVE_INERTIA_TIMEOUT_MS)),
          ])
        } catch (error) {
          warn(`[live-graph] fiber inertia for ${item.id} rejected`, error)
          break
        }
        // Upstream drains the CHAIN (a disposal phase can install a new promise); keep
        // awaiting while a new one appears, still bounded by the guard above.
        if (fiber.inertia === drain) break
      }
    }
    // Deliberately NOT fenced: the chunk-owner index is a PAGE-LEVEL table, so a
    // disarmed holder must still drop its row or the removed plugin's chunks stay
    // resolvable for every later consumer on the page — but only the id's factory
    // owner may drop it (a shared id's descriptor serves the owner's mounted row).
    if (ownsChunkDescriptor(item.id)) {
      try {
        deps.removeChunkOwners([item.id])
      } catch (error) {
        warn(`[live-graph] chunk-owner removal for ${item.id} failed`, error)
      }
    }
  }

  /** Undo one add's page-level side effects (entry + chunk-owner row), best effort. */
  const rollbackAdd = (id: string, entryId: string): void => {
    try { deps.loader.remove(entryId) } catch (error) { warn(`[live-graph] stale entry rollback for ${id} failed`, error) }
    if (!ownsChunkDescriptor(id)) return
    try { deps.removeChunkOwners([id]) } catch { /* best effort */ }
  }

  const addRow = async (row: ExtraModuleRow, facts: LiveFact[]): Promise<void> => {
    let outcomes: ClientRowOutcome<ExtraModuleRow>[]
    try {
      outcomes = await loadClientPluginRows(deps.sourceId, [row], { loadBundle: deps.loadBundle }, {
        ordinary: 'defer',
        timeout: 'collect',
      })
    } catch (error) {
      facts.push({ kind: 'load-failed', id: row.id, message: describeThrown(error) })
      return
    }
    const outcome = outcomes[0]
    if (outcome === undefined) return
    if (outcome.state === 'rev-conflict') {
      if (outcome.conflict === 'version') {
        facts.push({ kind: 'version-conflict', id: row.id, owner: outcome.ownerSourceId ?? '—' })
      } else {
        facts.push({
          kind: 'restart-required', id: row.id,
          message: restartRequiredMessage(row.id),
        })
      }
      return
    }
    if (outcome.state === 'failed') {
      // Deliberately NO unsatisfiable-external enrichment here: the boot predicate is a
      // STATIC potential-missing projection over the declared `external` set (and only the
      // boot path reports it). A live frame's authoritative answer is this create/apply
      // outcome — deferred families never register a factory at any later time, so there is
      // no timing window either way.
      facts.push({ kind: 'load-failed', id: row.id, message: describeThrown(outcome.error) })
      return
    }
    if (!deps.isCurrent()) return
    try {
      deps.registerChunkOwners([row])
    } catch (error) {
      // A partial registration must not outlive the failed row (page-level table).
      if (ownsChunkDescriptor(row.id)) { try { deps.removeChunkOwners([row.id]) } catch { /* best effort */ } }
      facts.push({ kind: 'load-failed', id: row.id, message: describeThrown(error) })
      return
    }
    let entryId: string
    try {
      entryId = await deps.loader.create({ name: row.id })
    } catch (error) {
      if (ownsChunkDescriptor(row.id)) { try { deps.removeChunkOwners([row.id]) } catch { /* best effort */ } }
      facts.push({ kind: 'load-failed', id: row.id, message: describeThrown(error) })
      return
    }
    if (!deps.isCurrent()) {
      rollbackAdd(row.id, entryId)
      return
    }
    const mountedRow: MountedLiveRow = { row, entryId }
    mounted.set(row.id, mountedRow)
    const fiber = resolveEntry(entryId)?.fiber
    if (fiber === undefined) {
      // A created entry without a fiber can never activate; drop it so a later frame
      // retries cleanly instead of reusing a broken row (or accumulating duplicates).
      rollbackAdd(row.id, entryId)
      mounted.delete(row.id)
      facts.push({ kind: 'load-failed', id: row.id, message: '插件 entry 创建后没有 fiber' })
      return
    }
    if (deps.fiberIsActive(fiber) || fiber.await === undefined) {
      handled.add(row.id)
      return
    }
    const activated = await Promise.race([
      fiber.await().then(() => true, () => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), activationTimeoutMs)),
    ])
    if (!deps.isCurrent()) {
      // The fence flipped while activation was pending: this entry belongs to a dead
      // holder, so undo it (and its page-level chunk-owner row) instead of leaving it
      // behind for a retry pass to duplicate.
      rollbackAdd(row.id, entryId)
      mounted.delete(row.id)
      return
    }
    if (activated && deps.fiberIsActive(resolveEntry(entryId)?.fiber)) {
      handled.add(row.id)
      return
    }
    mountedRow.pending = true
    facts.push({ kind: 'pending', id: row.id, message: pendingMessage(row.id) })
  }

  const handleGraph = async (rows: readonly HostGraphRow[]): Promise<void> => {
    if (!deps.isCurrent()) return
    const incoming = toExtraRows(dedupeCoveredRows(rows, CHAMBER_COVERED_IDS), deps.basePath)
    const diff = diffLiveRows(mounted, incoming)
    const facts: LiveFact[] = []
    for (const item of diff.remove) {
      if (!deps.isCurrent()) return
      await removeMounted(item)
    }
    for (const item of diff.revChanged) {
      handled.add(item.mounted.row.id)
      const owner = clientPluginRowOwner(item.incoming.id)
      if (owner !== undefined && owner !== deps.sourceId) {
        // Another instance claimed this id first: its bundle is already in the shared
        // kernel, so NO restart of this source can switch it — that is a version
        // conflict, not a restart-to-apply.
        facts.push({ kind: 'version-conflict', id: item.incoming.id, owner })
      } else {
        facts.push({
          kind: 'restart-required', id: item.incoming.id,
          message: `页面已加载 ${item.incoming.id} 的 ${item.mounted.row.rev} 版本，宿主已重建为 ${item.incoming.rev}；重启应用后才能切换`,
        })
      }
    }
    for (const item of diff.recheck) {
      const fiber = item.mounted.entryId === undefined ? undefined : resolveEntry(item.mounted.entryId)?.fiber
      if (fiber === undefined || deps.fiberIsTerminal(fiber)) {
        // Drop the dead entry (missing OR terminal fiber) before the retry, or the add
        // would create a duplicate; the retry's create error is the honest fact.
        if (item.mounted.entryId !== undefined) rollbackAdd(item.id, item.mounted.entryId)
        mounted.delete(item.id)
        diff.add.push(item.mounted.row)
        continue
      }
      if (deps.fiberIsActive(fiber)) {
        item.mounted.pending = false
        handled.add(item.id)
      } else {
        // Still inactive: RE-EMIT the fact, otherwise the next fact-less pass would
        // "heal" our own record to ok while the plugin is still unmounted.
        facts.push({ kind: 'pending', id: item.id, message: pendingMessage(item.id) })
      }
    }
    for (const row of diff.add) {
      if (!deps.isCurrent()) return
      await addRow(row, facts)
    }
    if (!deps.isCurrent()) return
    publish(facts)
  }

  /** Parse one payload and queue it: only a GRAPH frame occupies the slot (newest wins). */
  const acceptFrame = (data: string): void => {
    const frame = parsePluginEventFrame(data)
    if (frame === null) {
      if (!malformedLogged) {
        malformedLogged = true
        warn('[live-graph] ignored a malformed /plugins/events frame; further malformed frames stay silent')
      }
      return
    }
    // rebuilt/ignored frames need no action: upstream's rebuilt() recomposes the graph
    // and fires the graph listeners, so a graph frame carrying the new rev follows.
    if (frame.kind !== 'graph') return
    pendingFrame = frame
    pump()
  }

  const handleFrame = async (frame: Extract<PluginEventFrame, { kind: 'graph' }>): Promise<void> => {
    await handleGraph(frame.rows)
  }

  const pump = (): void => {
    if (disposed || running || pendingFrame === null) return
    running = true
    current = (async () => {
      while (!disposed && pendingFrame !== null) {
        const frame = pendingFrame
        pendingFrame = null
        try {
          await handleFrame(frame)
        } catch (error) {
          warn('[live-graph] live pass failed', error)
        }
      }
      running = false
    })()
  }

  let source: LiveEventSourceFace | undefined
  try {
    source = deps.createEventSource?.(`${deps.basePath}/plugins/events`)
  } catch (error) {
    warn('[live-graph] EventSource construction failed; live sync is off for this holder', error)
  }
  if (source !== undefined) {
    source.addEventListener('message', (event) => {
      if (disposed) return
      acceptFrame(typeof event?.data === 'string' ? event.data : '')
    })
    source.addEventListener('error', () => {
      // EventSource reconnects on its own; never close on error. One log per holder.
      if (errorLogged || disposed) return
      errorLogged = true
      warn(`[live-graph] /plugins/events connection for ${deps.sourceId} dropped; the browser will retry`)
    })
  }

  return {
    disarm(): Promise<void> {
      if (disposed) return current
      disposed = true
      pendingFrame = null
      try {
        source?.close()
      } catch (error) {
        warn('[live-graph] EventSource close failed', error)
      }
      return current
    },
  }
}
