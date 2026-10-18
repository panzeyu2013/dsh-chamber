/**
 * Page-level client-plugin bundle loader.
 *
 * Single source: the page executes a source's `dsh.client` bundles in the
 * per-instance shell boot (`renderer/src/host-graph.ts` preloads every non-covered
 * graph row before the boot kernel materializes entries) AND, after settle, from the
 * live graph subscriber's adds (`renderer/src/live-graph.ts`, design 09 §3.7 — same
 * rows, same kernel, load failures collected per pass); the settings panel renders
 * the source's own boot-ctx ledger and loads nothing. Those paths need the SAME
 * page-level bookkeeping — one script execution per combo URL, one factory claim per
 * plugin id (first-load-wins), timeout tombstones that keep observing a script that
 * outlived its request budget, and honest rev-conflict facts — and this module owns
 * it.
 *
 * The page module table is shared across cordis contexts (`dsh-client-web` boot.ts
 * parks it on `window.__DSH_MODULES__`), so a factory loaded here is reusable by
 * every context on the page — a plugin's module instance may back more than one fiber
 * (plugin modules must be stateless at module scope; state belongs to
 * `ctx.effect`/services). Zero dsh package imports on purpose: the table is typed
 * structurally and the diagnostic shape is imported type-only.
 */
import type { PluginGraphDiagnostic } from './aggregate-store.ts'
import { errorMessage } from './error-text.ts'
import { assertSingletonModule } from './singleton.ts'
import { HttpBudgetUnscheduledError, acquireHttpBudget, httpBudgetLeaseFor } from './http-budget.ts'

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
   * verbatim; the boot kernel treats this as pass-through data.
   */
  inject?: readonly string[]
}

/**
 * A module element can still execute after its request-level timeout. The explicit
 * type keeps that exceptional lifecycle distinct from ordinary load failures.
 */
export class BundleLoadTimeoutError extends Error {
  /** Resolves the ORIGINAL element's eventual outcome (true = it loaded). */
  readonly bundleOutcome: Promise<boolean>

  /** @param bundleOutcome - the still-pending element outcome (message = failure text). */
  constructor(message: string, bundleOutcome: Promise<boolean>) {
    super(message)
    this.name = 'BundleLoadTimeoutError'
    this.bundleOutcome = bundleOutcome
  }
}

/**
 * Drop the rows the chamber composite already covers: loading a covered row again
 * would double-register the same plugin on one cordis ctx — this filter is
 * load-bearing, not an optimization.
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
  /** Bundle endpoint this claim loaded from (foreign consumers verify content by it). */
  url: string
  combo: PreloadedCombo
  /** Source that first claimed this id on this page (first-load-wins owner). */
  ownerSourceId: string
  /** The claiming instance's host release version (graph `release.version`), when the
   *  graph published one. Two hosts at the same release serve interchangeable
   *  `@deepseek-ai/*` artifacts, so a foreign row may materialize under this factory. */
  releaseVersion?: string
}

const preloadedCombos = new Map<string, PreloadedCombo>()
const preloadedIds = new Map<string, PreloadedIdRecord>()

/** One row's load verdict (policy-free: each caller maps it to boot/panel semantics). */
export type ClientRowOutcome<T extends ClientPluginRow = ClientPluginRow> =
  /** The row's bundle executed in this call (factory registered). */
  | { state: 'loaded'; row: T }
  /** The row's factory was already registered at the same rev (shared or earlier). */
  | { state: 'reused'; row: T }
  /** Another instance's factory answers this id and the implementations are
   *  interchangeable — same host release for a release-published id, or the caller
   *  verified byte-identical content. Nothing was loaded; the row materializes under
   *  the owner's factory. */
  | { state: 'shared'; row: T; ownerSourceId: string }
  /** The id is claimed at another rev: the kernel returns the conflict WITHOUT loading,
   *  and callers must not materialize the conflicting row. */
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
  /** The calling instance's host release version (graph `release.version`). A foreign row
   *  for a release-published id at ANOTHER rev shares the owner factory when this equals
   *  the owner's recorded release. */
  releaseVersion?: string
  /** Caller-verified byte-identical content, keyed by id: the value is the exact
   *  candidate REV the comparison covered. A foreign row shares the owner factory only
   *  at that rev — an approval never transfers to a different build of the id. */
  sharedRevisions?: ReadonlyMap<string, string>
}

/**
 * Whether an id's bundle is published WITH the host release: the whole
 * `@deepseek-ai/*` client surface ships inside the dsh release, so two hosts at the
 * same release serve interchangeable artifacts. Profile/third-party plugins are
 * host-local builds — same release says nothing about their bytes — and never
 * qualify here (the caller may verify their content instead).
 */
export function isReleasePublishedPluginId(id: string): boolean {
  return id.startsWith('@deepseek-ai/')
}

/**
 * Whether a foreign-owned claim may answer this row without loading: both sides
 * report the same host release and the id is release-published. Fail-closed when
 * either release is unknown (an old host cannot prove interchangeability).
 */
export function canReuseForeignFactory(
  id: string,
  ownerRelease: string | undefined,
  candidateRelease: string | undefined,
): boolean {
  return isReleasePublishedPluginId(id)
    && ownerRelease !== undefined && ownerRelease !== ''
    && candidateRelease !== undefined && candidateRelease !== ''
    && ownerRelease === candidateRelease
}

/**
 * Load the given rows' bundles into the page module table, returning one verdict per
 * row:
 * - the id's FIRST loader owns the execution; a later consumer of the same id at the
 *   same rev awaits that same execution (never a second script);
 * - a later consumer at a DIFFERENT rev returns a conflict without loading and reports
 *   `restart` (same source) or `version` (another source) — the page keeps the
 *   first factory; callers must not materialize the conflicting row;
 * - EXCEPT when the implementations are interchangeable: a foreign row shares the
 *   owner factory when both sides report the same host release (release-published
 *   `@deepseek-ai/*` ids) or the caller verified byte-identical content at that
 *   exact rev (`sharedRevisions`); the outcome is `shared` and nothing is loaded;
 * - an ordinary failure clears the combo + its id records so a later load (or the
 *   caller's recovery pass) may retry;
 * - a DOM-script timeout leaves a tombstone observing the original element: a late
 *   load converts it to success, a late error clears it.
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
        const foreign = owned.ownerSourceId !== sourceId
        if (foreign && (canReuseForeignFactory(row.id, owned.releaseVersion, options.releaseVersion)
          || options.sharedRevisions?.get(row.id) === row.rev)) {
          // The owner's factory IS the same implementation (same release for a
          // release-published id, or caller-verified identical content at this exact
          // rev). Nothing is loaded here, but the owner's execution must EXIST before
          // the row materializes: await it and surface its failure exactly like the
          // same-rev reuse path (never a silent missing factory).
          try {
            await owned.combo.load
          } catch (error) {
            deps.reportDiagnostic?.(sourceId, {
              state: 'bundle-load-failed',
              pluginId: row.id,
              message: errorMessage(error),
              updatedAt: Date.now(),
            })
            if (error instanceof BundleLoadTimeoutError && options.timeout === 'collect') {
              outcomes.push({ state: 'failed', row, error, timeout: true })
              return
            }
            throw error
          }
          outcomes.push({ state: 'shared', row, ownerSourceId: owned.ownerSourceId })
          return
        }
        outcomes.push({
          state: 'rev-conflict',
          row,
          conflict: foreign ? 'version' : 'restart',
          ownerSourceId: owned.ownerSourceId,
        })
        return
      }
      // Await the ORIGINAL load (read live off the combo record): a still-pending or
      // tombstoned load must fail THIS caller loud too, and a late-success conversion
      // is observed by later calls.
      try {
        await owned.combo.load
      } catch (error) {
        deps.reportDiagnostic?.(sourceId, {
          state: 'bundle-load-failed',
          pluginId: row.id,
          message: errorMessage(error),
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
      // Promise.resolve().then also normalizes a synchronously throwing transport into
      // the same shared rejected promise.
      // Bundle concurrency cap (design 26 §D7; the ceil(N/bundleMax) boot-wave cost
      // is a STATUS calibration item): the shared
      // budget admits at most `bundleMax` concurrent script loads, so one slow
      // instance's boot wave cannot occupy the whole same-origin pool and starve
      // local unary reads. The slot lives until the script really settles: on a
      // DOM-script timeout removal does not cancel the fetch, so the slot is
      // released by the tombstone's `bundleOutcome` instead of by the rejection.
      combo = {
        ids: new Set(),
        load: Promise.resolve().then(async () => {
          const acquired = await acquireHttpBudget({
            sourceId,
            kind: 'bundle',
            lane: 'background',
            leaseMs: httpBudgetLeaseFor(60_000),
            label: 'bundle:' + row.url,
          })
          if (acquired.kind === 'unscheduled') {
            throw new HttpBudgetUnscheduledError(acquired.reason, acquired.queuedMs)
          }
          try {
            const loaded = await deps.loadBundle(row.url)
            acquired.slot.release()
            return loaded
          } catch (error) {
            if (error instanceof BundleLoadTimeoutError) {
              void Promise.resolve(error.bundleOutcome).then(
                () => acquired.slot.release(),
                () => acquired.slot.release(),
              )
            } else {
              acquired.slot.release()
            }
            throw error
          }
        }),
      }
      preloadedCombos.set(row.url, combo)
    }
    // Publish ownership BEFORE the load (a concurrent row for the same id must await
    // the shared execution) and fold this id into the combo's rollback set; the
    // url-level map dedupes a multi-id combo (rows sharing one url await ONE load).
    combo.ids.add(row.id)
    preloadedIds.set(row.id, {
      rev: row.rev,
      url: row.url,
      combo,
      ownerSourceId: sourceId,
      ...(options.releaseVersion === undefined ? {} : { releaseVersion: options.releaseVersion }),
    })
    try {
      await combo.load
      outcomes.push({ state: 'loaded', row })
    } catch (error) {
      // A preload failure must not be marked permanently (the module system does not
      // re-fetch extra bundles): the combo record is the owner, so a retry installs a NEW
      // record for the same url and a later catch must not clear the new one.
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
      // DOM-script timeout: removing the element does not reliably cancel its fetch, so
      // leave the tagged tombstone attached and observe the eventual outcome.
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
        message: errorMessage(error),
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

/**
 * Read-only pre-scan of the page-level table: the rows this caller would be
 * REFUSED at their current revision, in input order. `conflict` mirrors the
 * kernel verdict (another source owns the id ⇒ `version`, this source ⇒
 * `restart`); a duplicate id inside one call is judged once because the kernel
 * resolves a later occurrence against the record the first one publishes.
 * The boot path uses this to fail BEFORE any bundle executes or any new id is
 * claimed, so a boot that will be blocked leaves no executed factory and no
 * owner record behind. The kernel verdicts remain the authority: a claim that
 * appears after this scan is still answered by {@link loadClientPluginRows}.
 * @param sourceId - the caller's source (instance) id.
 * @param rows - candidate rows.
 * @param releaseVersion - the caller's host release (graph `release.version`), when known.
 * @returns the conflicting rows (empty when nothing conflicts).
 */
export function scanClientPluginRowConflicts<T extends ClientPluginRow>(
  sourceId: string,
  rows: readonly T[],
  releaseVersion?: string,
): { row: T; conflict: 'restart' | 'version'; ownerSourceId: string }[] {
  const conflicts: { row: T; conflict: 'restart' | 'version'; ownerSourceId: string }[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const owned = preloadedIds.get(row.id)
    if (owned === undefined || owned.rev === row.rev) continue
    const foreign = owned.ownerSourceId !== sourceId
    if (foreign && canReuseForeignFactory(row.id, owned.releaseVersion, releaseVersion)) continue
    conflicts.push({
      row,
      conflict: foreign ? 'version' : 'restart',
      ownerSourceId: owned.ownerSourceId,
    })
  }
  return conflicts
}

/** The source that first claimed a plugin id on this page (first-load-wins owner), when known. */
export function clientPluginRowOwner(id: string): string | undefined {
  return preloadedIds.get(id)?.ownerSourceId
}

/** The claiming instance's host release version for an id, when its graph published one. */
export function clientPluginRowRelease(id: string): string | undefined {
  return preloadedIds.get(id)?.releaseVersion
}

/** One page-level claim's load facts: the bundle endpoint, its rev and the owner release.
 *  Foreign consumers use the URL/rev to verify content before sharing the factory. */
export interface ClientPluginRowClaim {
  rev: string
  url: string
  ownerSourceId: string
  releaseVersion?: string
}

/** Read one claim's facts (undefined = nobody claimed the id on this page). */
export function clientPluginRowClaim(id: string): ClientPluginRowClaim | undefined {
  const owned = preloadedIds.get(id)
  if (owned === undefined) return undefined
  return {
    rev: owned.rev,
    url: owned.url,
    ownerSourceId: owned.ownerSourceId,
    ...(owned.releaseVersion === undefined ? {} : { releaseVersion: owned.releaseVersion }),
  }
}

/** Per-instance host release versions, recorded from each answered boot graph. The live
 *  path classifies foreign rev changes with the SAME identity the boot used. */
const instanceReleases = new Map<string, string>()

/** Record (or clear) one instance's host release version from its boot graph. */
export function recordInstanceGraphRelease(instanceId: string, version: string | undefined): void {
  if (version === undefined || version === '') instanceReleases.delete(instanceId)
  else instanceReleases.set(instanceId, version)
}

/** The instance's last recorded host release version, when its graph published one. */
export function instanceGraphRelease(instanceId: string): string | undefined {
  return instanceReleases.get(instanceId)
}

/** Forget one instance's release fact (shell disposal / source retirement). */
export function forgetInstanceGraphRelease(instanceId: string): void {
  instanceReleases.delete(instanceId)
}

/** Test/diagnostic seam: forget every page-level load fact. */
export function resetClientPluginLoaderState(): void {
  preloadedCombos.clear()
  preloadedIds.clear()
  instanceReleases.clear()
}
