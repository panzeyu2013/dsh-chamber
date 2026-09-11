/**
 * Page-level client-plugin bundle loader + per-source graph cache (design 09
 * §3.2 union table; settings-surface extension 2026-12).
 *
 * WHY THIS MODULE EXISTS (single source): the chamber page executes a source's
 * `dsh.client` bundles in the per-instance shell boot
 * (`packages/renderer/src/host-graph.ts`, which preloads every non-covered
 * graph row before the boot kernel materializes entries) — the settings panel
 * used to be the second consumer through its per-source child context, which
 * the 2026-12 完整桥接修订 deleted (the panel renders the source's own boot-ctx
 * ledger and loads nothing). That path still needs the
 * SAME page-level bookkeeping: one script execution per combo URL, one factory
 * claim per plugin id (first-load-wins), timeout tombstones that keep observing
 * a script that outlived its request budget, and honest rev-conflict facts.
 * Duplicating that logic would drift; this module owns it and the boot path
 * delegates here.
 *
 * The page module table itself is shared across cordis contexts
 * (`dsh-client-web` boot.ts `ensureWebModuleSystem` parks it on
 * `window.__DSH_MODULES__`), so a factory loaded here is reusable by every
 * context on the page — that is the union-table model, and it is why a
 * plugin's module instance may back more than one fiber (documented contract:
 * plugin modules must be stateless at module scope; all state belongs to
 * `ctx.effect`/services).
 *
 * Zero dsh package imports on purpose (this face is consumed by the plain-node
 * renderer tests, the browser renderer, and the settings bridge): the module
 * table is typed structurally, the diagnostic shape is imported type-only.
 */
import type { PluginGraphDiagnostic } from './aggregate-store.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('client-plugin-loader')

/** The minimal row shape the loader needs (structurally satisfied by the renderer's graph rows). */
export interface ClientPluginRow {
  /** Entry name == package name (module-table key). */
  id: string
  /** Bundle endpoint, already prefixed with the source's proxy base path. */
  url: string
  /** Opaque bundle revision (cache-busting consistency anchor, not a content hash). */
  rev: string
  /**
   * Package-level dependency edges (the graph row's `inject`), carried through
   * verbatim. The settings panel's OPTIONAL dependency-closure expansion (its
   * only documented consumer) was retired with the 2026-12 完整桥接修订, so the
   * boot kernel treats this as pass-through data today.
   */
  inject?: readonly string[]
}

/**
 * The page module table face the loader materializes through
 * (`ClientModuleSystem.import` — async, resolves registered factories and
 * memoized records; a loaded-but-unregistered id throws loud).
 */
export interface ClientModuleTable {
  import(specifier: string): Promise<unknown>
}

/**
 * A module element can still execute after its request-level timeout. The
 * explicit type keeps that one exceptional lifecycle distinct from ordinary
 * load failures without inspecting arbitrary thrown objects.
 */
export class BundleLoadTimeoutError extends Error {
  /** Resolves the ORIGINAL element's eventual outcome (true = it loaded). */
  readonly bundleOutcome: Promise<boolean>

  /**
   * @param message - failure text.
   * @param bundleOutcome - the still-pending element outcome.
   */
  constructor(message: string, bundleOutcome: Promise<boolean>) {
    super(message)
    this.name = 'BundleLoadTimeoutError'
    this.bundleOutcome = bundleOutcome
  }
}

/** What the page shell installs once at boot (see {@link installClientPluginLoader}). */
export interface ClientPluginLoaderInstall {
  /** The shell-owned module-script transport (DOM element + timeout/tombstone). */
  loadBundle(url: string): Promise<void>
  /** The page module table (`window.__DSH_MODULES__`); absent in non-browser hosts. */
  modules?: ClientModuleTable
  /** The boot-graph ids the chamber composite covers (renderer `CHAMBER_COVERED_IDS`). */
  coveredIds?: readonly string[]
}

let installed: ClientPluginLoaderInstall | null = null

/**
 * Install (or replace) the page-level loader seams. Idempotent in effect: the
 * page shell calls it once per boot with the same instances; a later call
 * refreshes the captured references (HMR / re-boot) without dropping the
 * page-level load bookkeeping below.
 * @param install - the shell-owned seams.
 */
export function installClientPluginLoader(install: ClientPluginLoaderInstall): void {
  installed = install
}

/** The installed seams, or null before the page shell booted (non-browser hosts). */
export function clientPluginLoader(): ClientPluginLoaderInstall | null {
  return installed
}

/** The covered ids the composite registers (empty until the shell installs them). */
export function coveredClientPluginIds(): readonly string[] {
  return installed?.coveredIds ?? []
}

/**
 * Drop the rows the chamber composite already covers (design 09 §3.3):
 * loading a covered row again would double-register the same plugin on one
 * cordis ctx — this filter is load-bearing, not an optimization.
 * @param rows - the source's raw graph rows.
 * @param covered - covered ids (defaults to the installed set).
 * @returns the kept rows, input order preserved.
 */
export function dedupeCoveredRows<T extends ClientPluginRow>(
  rows: readonly T[],
  covered: readonly string[] = coveredClientPluginIds(),
): T[] {
  const coveredIds = new Set(covered)
  return rows.filter(row => !coveredIds.has(row.id))
}

/** One combo script's shared execution + the ids it will register. */
interface PreloadedCombo {
  /** The ids whose factories this combo script registers (failure rollback set). */
  ids: Set<string>
  load: Promise<void>
}

/** The combo record whose script registered one id's factory. */
interface PreloadedIdRecord {
  rev: string
  combo: PreloadedCombo
  /** Source that first claimed this id on this page (first-load-wins owner). */
  ownerSourceId: string
}

const preloadedCombos = new Map<string, PreloadedCombo>()
const preloadedIds = new Map<string, PreloadedIdRecord>()

/** One row's load verdict (policy-free: each caller maps it to boot/panel semantics). */
export type ClientRowOutcome<T extends ClientPluginRow = ClientPluginRow> =
  /** The row's bundle executed in this call (factory registered). */
  | { state: 'loaded'; row: T }
  /** The row's factory was already registered at the same rev (shared or earlier). */
  | { state: 'reused'; row: T }
  /** The id is claimed at another rev: reuse the loaded factory, report the conflict. */
  | { state: 'rev-conflict'; row: T; conflict: 'restart' | 'version'; ownerSourceId: string }
  /** The bundle failed: ordinary (records rolled back) or a timeout tombstone. */
  | { state: 'failed'; row: T; error: unknown; timeout: boolean }

/** Per-call seams (the owner of a shared combo binds its own transport). */
export interface ClientRowLoadDeps {
  loadBundle(url: string): Promise<void>
  /** Optional diagnostic sink (boot passes the page-level store; the settings panel its own). */
  reportDiagnostic?(sourceId: string, diagnostic: PluginGraphDiagnostic): void
}

/** Failure policy: the boot fails loud, the settings panel degrades per plugin. */
export interface ClientRowLoadOptions {
  /** Ordinary (non-timeout) failures: `defer` collects them; `throw` rejects (boot recovery pass). */
  ordinary: 'defer' | 'throw'
  /** Timeout failures: `throw` rejects immediately (boot); `collect` returns them as outcomes. */
  timeout: 'throw' | 'collect'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Load the given rows' bundles into the page module table, returning one
 * verdict per row. Semantics preserved verbatim from the boot path:
 *
 * - the id's FIRST loader owns the execution; a later consumer of the same id
 *   at the same rev awaits that same execution (never a second script);
 * - a later consumer at a DIFFERENT rev reuses the loaded factory and reports
 *   `restart` (same source) or `version` (another source) — the page keeps the
 *   first factory;
 * - an ordinary failure clears the combo + its id records so a later load (or
 *   the caller's recovery pass) may retry;
 * - a DOM-script timeout leaves a tombstone observing the original element:
 *   a late load converts it to success, a late error clears it.
 *
 * @param sourceId - the source the rows belong to (first-load-wins owner).
 * @param rows - the rows to load (duplicates and shared combo URLs allowed).
 * @param deps - the transport + optional diagnostic sink.
 * @param options - failure policy for the calling context.
 * @returns one outcome per row, in completion order.
 */
export async function loadClientPluginRows<T extends ClientPluginRow>(
  sourceId: string,
  rows: readonly T[],
  deps: ClientRowLoadDeps,
  options: ClientRowLoadOptions,
): Promise<ClientRowOutcome<T>[]> {
  const outcomes: ClientRowOutcome<T>[] = []
  await Promise.all(rows.map(async (row): Promise<void> => {
    const owned = preloadedIds.get(row.id)
    if (owned !== undefined) {
      if (owned.rev !== row.rev) {
        outcomes.push({
          state: 'rev-conflict',
          row,
          conflict: owned.ownerSourceId !== sourceId ? 'version' : 'restart',
          ownerSourceId: owned.ownerSourceId,
        })
        return
      }
      // Await the ORIGINAL load (read live off the combo record): a
      // still-pending or tombstoned load must fail THIS caller loud too, and a
      // late-success conversion of the shared load is observed by later calls.
      try {
        await owned.combo.load
      } catch (error) {
        deps.reportDiagnostic?.(sourceId, {
          state: 'bundle-load-failed',
          pluginId: row.id,
          message: messageOf(error),
          updatedAt: Date.now(),
        })
        if (error instanceof BundleLoadTimeoutError && options.timeout === 'collect') {
          outcomes.push({ state: 'failed', row, error, timeout: true })
          return
        }
        throw error
      }
      outcomes.push({ state: 'reused', row })
      return
    }
    let combo = preloadedCombos.get(row.url)
    if (combo === undefined) {
      // Promise.resolve().then also normalizes a synchronously throwing
      // transport into the same shared rejected promise.
      combo = {
        ids: new Set(),
        load: Promise.resolve().then(() => deps.loadBundle(row.url)),
      }
      preloadedCombos.set(row.url, combo)
    }
    // Publish the ownership BEFORE the load (a concurrent row for the same id
    // must await the shared execution, never start its own) and fold this id
    // into the combo's rollback set. The url-level map is what dedupes a
    // multi-id combo: rows sharing one url await ONE load.
    combo.ids.add(row.id)
    preloadedIds.set(row.id, { rev: row.rev, combo, ownerSourceId: sourceId })
    try {
      await combo.load
      outcomes.push({ state: 'loaded', row })
    } catch (error) {
      // Preload failure must not be marked permanently (the module system does
      // not re-fetch extra bundles on its own): the combo record is the owner,
      // so a retry installs a NEW record for the same url and a later catch in
      // another waiter of the old promise must not clear the new one.
      const bundleOutcome = error instanceof BundleLoadTimeoutError ? error.bundleOutcome : null
      const clearCombo = (): void => {
        if (preloadedCombos.get(row.url) !== combo) return
        preloadedCombos.delete(row.url)
        for (const id of combo.ids) {
          if (preloadedIds.get(id)?.combo === combo) preloadedIds.delete(id)
        }
      }
      if (bundleOutcome === null) {
        clearCombo()
        if (options.ordinary === 'defer') {
          outcomes.push({ state: 'failed', row, error, timeout: false })
          return
        }
        throw error
      }
      // DOM-script timeout: removing the element does not reliably cancel its
      // fetch, so leave the tagged tombstone attached and observe the eventual
      // outcome (late load → success, late error → a later retry is safe).
      void bundleOutcome.then(
        succeeded => {
          if (preloadedCombos.get(row.url) !== combo) return
          if (succeeded) combo.load = Promise.resolve()
          else clearCombo()
        },
        () => { clearCombo() },
      )
      deps.reportDiagnostic?.(sourceId, {
        state: 'bundle-load-failed',
        pluginId: row.id,
        message: messageOf(error),
        updatedAt: Date.now(),
      })
      if (options.timeout === 'collect') {
        outcomes.push({ state: 'failed', row, error, timeout: true })
        return
      }
      throw error
    }
  }))
  return outcomes
}

/** Whether a plugin id's factory is already on the page module table (loaded at least once). */
export function clientPluginRowLoaded(id: string): boolean {
  return preloadedIds.has(id)
}

/** The source that first claimed a plugin id on this page (first-load-wins owner), when known. */
export function clientPluginRowOwner(id: string): string | undefined {
  return preloadedIds.get(id)?.ownerSourceId
}

/** Row signatures for cache/reconcile decisions. */
export interface ClientRowSignatures {
  /** Sorted id set (plugin install/uninstall changes this). */
  idSet: string
  /** Sorted `id@rev` set (a rebuilt plugin changes this; an instance restart changes every rev). */
  revSet: string
}

/**
 * Identity of a row set for cache/reconcile decisions. The id set is the
 * REBUILD key (a different plugin set needs a different boot graph); the
 * rev set is informational (first-load-wins already decided which factory the
 * page runs, so rev drift is reported, never rebuilt).
 * @param rows - the source's kept rows.
 * @returns both signatures.
 */
export function clientRowSignatures(rows: readonly ClientPluginRow[]): ClientRowSignatures {
  const ids = [...new Set(rows.map(row => row.id))].sort()
  const revs = [...new Set(rows.map(row => `${row.id}@${row.rev}`))].sort()
  return { idSet: ids.join('|'), revSet: revs.join('|') }
}

/** One cached source graph (raw rows, before covered filtering / base-path prefixing). */
export interface CachedSourceGraph {
  /** Registry incarnation the rows were fetched for ('' when unknown). */
  sourceFingerprint: string
  rows: readonly ClientPluginRow[]
}

const sourceGraphs = new Map<string, CachedSourceGraph>()

/**
 * Publish a source's freshly fetched graph rows (the boot path does this so the
 * settings panel reuses the same read instead of paying another round trip).
 * @param sourceId - the source id.
 * @param graph - the raw rows + the incarnation they belong to.
 */
export function publishSourceClientGraph(sourceId: string, graph: CachedSourceGraph): void {
  sourceGraphs.set(sourceId, graph)
}

/**
 * The cached graph for a source, only when it belongs to the CURRENT
 * incarnation (a deleted/re-added source must never serve the old plugin set).
 * @param sourceId - the source id.
 * @param sourceFingerprint - the authoritative roster proof, when known.
 * @returns the cached rows, or undefined when absent/foreign.
 */
export function cachedSourceClientGraph(
  sourceId: string,
  sourceFingerprint: string,
): CachedSourceGraph | undefined {
  const cached = sourceGraphs.get(sourceId)
  if (cached === undefined) return undefined
  if (cached.sourceFingerprint !== sourceFingerprint) return undefined
  return cached
}

/**
 * Retire a source's cached graph (roster removal / incarnation replacement).
 * @param sourceId - the source id.
 */
export function retireSourceClientGraph(sourceId: string): void {
  sourceGraphs.delete(sourceId)
}

/**
 * Which sources have mounted a plugin id on this page (cross-source sharing
 * fact). The module table is page-level, so one module instance backs every
 * mounted fiber — a plugin with module-scope state would share it across
 * sources; the settings panel surfaces this rather than pretending isolation.
 */
const mountedBy = new Map<string, Set<string>>()

/**
 * Record that `sourceId` mounted `pluginId`.
 * @param pluginId - the plugin id.
 * @param sourceId - the mounting source.
 * @returns the OTHER sources that already mounted it (empty = first mount).
 */
export function notePluginMounted(pluginId: string, sourceId: string): string[] {
  const owners = mountedBy.get(pluginId) ?? new Set<string>()
  const others = [...owners].filter(id => id !== sourceId)
  owners.add(sourceId)
  mountedBy.set(pluginId, owners)
  return others
}

/**
 * Record that `sourceId` no longer mounts `pluginId` (child-ctx dispose).
 * @param pluginId - the plugin id.
 * @param sourceId - the disposing source.
 */
export function notePluginUnmounted(pluginId: string, sourceId: string): void {
  const owners = mountedBy.get(pluginId)
  if (owners === undefined) return
  owners.delete(sourceId)
  if (owners.size === 0) mountedBy.delete(pluginId)
}

/** Test/diagnostic seam: forget every page-level load/cache fact. */
export function resetClientPluginLoaderState(): void {
  preloadedCombos.clear()
  preloadedIds.clear()
  sourceGraphs.clear()
  mountedBy.clear()
}
