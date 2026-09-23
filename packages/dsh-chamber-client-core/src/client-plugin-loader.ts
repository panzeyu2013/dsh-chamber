/**
 * Page-level client-plugin bundle loader (design 09 §3.2 union table).
 *
 * WHY THIS MODULE EXISTS (single source): the chamber page executes a source's
 * `dsh.client` bundles in the per-instance shell boot
 * (`packages/renderer/src/host-graph.ts`, which preloads every non-covered
 * graph row before the boot kernel materializes entries); the settings panel
 * renders the source's own boot-ctx ledger and loads nothing. That path needs
 * the SAME page-level bookkeeping: one script execution per combo URL, one
 * factory claim per plugin id (first-load-wins), timeout tombstones that keep
 * observing a script that outlived its request budget, and honest rev-conflict
 * facts.
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
   * verbatim. The boot kernel treats this as pass-through data.
   */
  inject?: readonly string[]
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

/**
 * Drop the rows the chamber composite already covers (design 09 §3.3):
 * loading a covered row again would double-register the same plugin on one
 * cordis ctx — this filter is load-bearing, not an optimization.
 * @param rows - the source's raw graph rows.
 * @param covered - covered ids (renderer `CHAMBER_COVERED_IDS`).
 * @returns the kept rows, input order preserved.
 */
export function dedupeCoveredRows<T extends ClientPluginRow>(
  rows: readonly T[],
  covered: readonly string[],
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
  /** Optional diagnostic sink (boot passes the page-level store). */
  reportDiagnostic?(sourceId: string, diagnostic: PluginGraphDiagnostic): void
}

/** Failure policy for a calling context. */
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
 * verdict per row. Semantics:
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

/** The source that first claimed a plugin id on this page (first-load-wins owner), when known. */
export function clientPluginRowOwner(id: string): string | undefined {
  return preloadedIds.get(id)?.ownerSourceId
}

/** Test/diagnostic seam: forget every page-level load fact. */
export function resetClientPluginLoaderState(): void {
  preloadedCombos.clear()
  preloadedIds.clear()
}
