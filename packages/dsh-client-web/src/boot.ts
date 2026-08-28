/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 *
 * > chamber patch (dsh-chamber connection manager, design 05 §3.6 / design 09):
 * > the N-ctx sharing seam in {@link AppWebEntry.run} — one page hosts multiple
 * > shells (one per dsh instance); every boot after the first reuses the
 * > page-level module system from `window.__DSH_MODULES__` (see
 * > {@link ensureWebModuleSystem}). The per-instance host-graph extra rows
 * > (`extraRows`) merge into the boot rows, and the whole boot chain runs the
 * > chamber version-tolerance decision rules (`boot-tolerance.ts`).
 *
 * AppWebEntry.run(), module face first, then plugin face: adopt (or install)
 * the shared module system over `window.__DSH_BOOT__` (wire boundary — the
 * modules bundle owns parsing/projection, see `@deepseek-ai/dsh-client-modules`)
 * → render the loading page → prefetch every `immediately` row in parallel
 * with mounting the vendored cordis Loader (`internal` contract injection
 * BEFORE any entry exists — the bare-import fallback in tree.import must never
 * run in a browser) → await the prefetch tier, THEN create one loader entry
 * per plugin-view row plus the chamber extra rows → loader.await() + a full
 * fiber sweep (all ACTIVE, else fail listing who/what/which service; chamber:
 * extra rows degrade instead of failing — `classifySweepEntry`) → mount the
 * real UI through the uiRenderer service.
 *
 * Entry creation waits for the whole immediately tier: materialization runs
 * synchronous cross-package require edges (e.g. locale → runtime/client) that
 * fiber inject waiting cannot protect — a bundle's factory must be
 * registered before any dependent entry materializes. Per-row prefetch
 * failures still resolve silently (the create-side import reloads and
 * owns the loud failure), so the barrier never turns one bad bundle into a
 * boot-wide fail-fast.
 *
 * Composition lives in the host graph; the shell makes zero composition
 * decisions. The renderer is a client-plugin row in the official graph; the
 * chamber shell kernel ADOPTS it instead (page-own covered id — chamber
 * entry never imports it): its client half is shell-static, registered on the
 * shared module table next to the modules bootstrap, and its loader entry is
 * created by the kernel (sweep-checked) so the boot mounts through the
 * `uiRenderer` service it provides. The shell itself never installs the slot
 * renderer (rc.8 moved that into the renderer row).
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as ModulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  BootManifest, BootModuleRow, ClientBundleRegistration, ClientModuleCreateOptions,
  ClientModuleLoaderTarget, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
// Value-imported by the kernel (bootstrap identity — the same exception as the
// modules package): the ui-renderer client half is shell-static, adopted as a
// module-table factory and mounted as a kernel loader entry. The import also
// pulls its Context augmentation (`ctx.uiRenderer`) into this program.
import * as UiRenderer from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BootPage } from './boot-page.ts'
import { MODULES_ID, UI_RENDERER_ID, composeBootRows } from './boot-rows.ts'
import { classifySweepEntry } from './boot-tolerance.ts'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS } from './loader-status.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/** Stable boot diagnostics for arbitrary thrown values. The configureContext
 * seam and plugin/runtime graph are external execution boundaries; their
 * catch handler must not itself reject when reflection or String coercion on
 * a hostile Error-like value throws. */
function describeBootError(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      const message = typeof reason.message === 'string' ? reason.message : ''
      if (message !== '') return message
      const name = typeof reason.name === 'string' ? reason.name : ''
      if (name !== '') return name
    }
  } catch {
    // Fall through to the separately guarded primitive conversion.
  }
  try {
    const text = String(reason)
    return text === '' ? 'unknown error' : text
  } catch {
    return 'unknown error'
  }
}

/**
 * AppWebEntry construction options: the module-transport seams plus the
 * chamber patch's per-instance extra boot rows. Backward compatible with the
 * bare `BootSeams` callers used to pass (extraRows is optional).
 */
export interface AppWebEntryOptions extends BootSeams {
  /**
   * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
   *
   * Extra client-plugin rows from THIS instance's host boot graph
   * (per-instance: local and remote hosts compose different plugin sets —
   * design 09). The chamber shell pre-loads these bundles before constructing
   * the entry, so their factories are already registered on the shared module
   * table via `window.__ModuleLoader__.load`; this seam only merges their ids
   * into the boot rows, it never fetches them (the modules view / graphRows
   * has no row for them), and it does not prefetch them (the chamber side
   * pre-loads the whole extra set uniformly).
   */
  extraRows?: BootModuleRow[]
  /**
   * ## chamber patch (dsh-chamber connection manager, design 05 §4)
   *
   * Per-entry context initializer. N-ctx boots may overlap after the shell's
   * bounded queue timeout, so instance identity and connection base paths must
   * never ride page-global mutable knobs. The shell supplies a closure bound to
   * THIS entry; run() invokes it synchronously immediately after constructing
   * the Context and before any loader/plugin work can suspend.
   */
  configureContext?: (ctx: Context) => void
}

/**
 * The web shell kernel: draws the loading page into a DOM element and runs
 * the two-stage boot over the host graph. Fields hold only what must exist
 * before cordis does — the parsed manifest, the module system, and the
 * loading-page UI handles; everything else lives in plugins.
 */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly extraRows: BootModuleRow[] | undefined
  private readonly configureContext: ((ctx: Context) => void) | undefined
  private readonly page: BootPage
  // Assigned by run() before any private method reads them; dispose() nulls
  // ctx, and reads must handle the pre-run / post-dispose state.
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest
  private bootFailure: string | undefined

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param options - Optional construction options: module transport overrides
   *   for test environments plus the chamber patch's per-instance extra boot
   *   rows (bundles already pre-loaded by the chamber shell — see
   *   {@link AppWebEntryOptions.extraRows}).
   */
  constructor(container: HTMLElement, options?: AppWebEntryOptions) {
    this.container = container
    this.seams = options
    this.extraRows = options?.extraRows
    this.configureContext = options?.configureContext
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every client entry, then hand the mount point to the
   * UI renderer. Plugin failures remain visible on the boot page.
   * @returns Resolves after application mount or failure rendering.
   */
  async run(): Promise<void> {
    try {
      // chamber patch (design 05 §4): install-or-reuse the page-level module
      // system. The chamber shell installs it BEFORE preloading any host-graph
      // bundle (ensureWebModuleSystem — first-boot race fix), so run() must
      // adopt the parked instance instead of re-installing; the reuse branch
      // also skips the duplicate bootstrap registration.
      this.modules = ensureWebModuleSystem(this.seams)
      this.manifest = this.modules.manifest

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      // Per-entry facts are installed before the first await/plugin
      // materialization. A previous boot that settles after the shell queue's
      // timeout therefore keeps its own immutable closure values even while a
      // later instance is booting concurrently.
      this.configureContext?.(ctx)
      await this.runPluginBoot(ctx, prefetching)
      await this.mountApp(ctx)
    } catch (reason) {
      // Stay on the loading page; surface the sweep report (fail loud).
      console.error(reason)
      this.bootFailure = describeBootError(reason)
      this.page.fail(this.bootFailure)
    }
  }

  /**
   * Dispose the client plugin tree and whichever page owns the mount point.
   * Resolves once the teardown settled (never rejects — teardown errors are
   * logged). Shell lifecycle paths await/fold this Promise into the source's
   * per-id teardown barrier; unload-only callers may invoke it fire-and-forget.
   */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    // Drop the handle so a second dispose is a no-op and late runtimeCtx
    // reads observe a dead context.
    this.ctx = undefined
    if (ctx !== undefined) {
      try {
        // Root-fiber dispose cascades through every loader entry fiber and
        // the mount inject fiber (each child fiber's disposer is collected on
        // its parent's effect list), releasing what React unmount alone never
        // would: the connection stream loop, reconnect timers, session /
        // conversation stores, and the chamber sidebar / runtime-facts
        // producers.
        await ctx.fiber.dispose()
      } catch (error) {
        console.error('[web-shell] ctx teardown failed:', error)
      }
    }
    this.page.dispose()
  }

  /**
   * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
   *
   * Public read handle on the settled runtime context: the chamber shell
   * dispatches per-instance session opens through `ctx.sessions` (the
   * dsh-client-runtime ISessions face) after boot settlement. The handle is
   * `undefined` once dispose() ran (the ctx is torn down) — callers must
   * guard with `?.` (shell.ts dispatchOpen does).
   */
  get runtimeCtx(): Context | undefined {
    return this.ctx
  }

  /**
   * ## chamber patch (dsh-chamber connection manager, design 05 §4)
   *
   * The boot failure report (undefined while loading or after a clean settle).
   * run() resolves on boot-chain failures by design — the loading page stays
   * up and renders the in-shell report (the fail-loud surface the kernel
   * owns) — but the chamber shell must SEE the failure to present its own
   * per-instance fallback (retry + server switching) instead of the dead-end
   * in-shell report trapping the active view. Public read handle, same
   * pattern as runtimeCtx; valid once run() settled (the report is set before
   * run() resolves).
   */
  get bootError(): string | undefined {
    return this.bootFailure
  }

  /** Prefetch stage-one bundles; their import path owns any eventual failure. */
  private async prefetchImmediateTier(): Promise<void> {
    // A transport that carries `loadBundle` supplies the bundle bytes itself
    // (not over HTTP), so skip the immediately-tier prefetch.
    const transport = (globalThis as { __DSH_TRANSPORT__?: { loadBundle?: unknown } }).__DSH_TRANSPORT__
    if (transport?.loadBundle !== undefined) return
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and
        // reports this bundle failure. Extra rows are NOT prefetched here:
        // the chamber side pre-loads the whole extra set uniformly.
      })))
  }

  /** Mount the Loader, create all graph entries, await quiescence, and audit activation. */
  private async runPluginBoot(ctx: Context, prefetching: Promise<void>): Promise<void> {
    await ctx.plugin(Loader)
    const loader = ctx.loader
    // Inject the module system BEFORE any entry exists: tree.import falls back
    // to a bare dynamic import when internal is undefined, which in a browser
    // is a guaranteed loud failure — correct as a tripwire, never as a path.
    loader.internal = this.modules as never

    // Status projection: the boot page displays fiber truth. Every
    // internal/status transition under an entry re-projects that entry's row
    // from its ROOT fiber (child plugin fibers share the same entry).
    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.page.setState(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    // The kernel adopts the modules entry itself (its record is pre-materialized
    // as the module-system bootstrap — see ensureWebModuleSystem) and the
    // ui-renderer entry (its factory is shell-static, registered on the shared
    // module table in ensureWebModuleSystem — chamber patch, rc.8 baseline
    // alignment), then the manifest rows, then — chamber patch (design 05 §3.6 /
    // design 09) — the per-instance extra client-plugin rows from the host boot
    // graph. The extra bundles were already executed by the chamber shell, so
    // their factories are registered on the shared module table — loader.create
    // resolves them through internal.import's factories branch without a graph
    // row (the modules view / graphRows has no entry for them;
    // duplicate-registration protection is __ModuleLoader__.load's own check).
    // No prefetch here: the chamber side pre-loads the whole extra set
    // uniformly, and the kernel-adopted entries are never fetched at all.
    const rows = composeBootRows(
      this.manifest.plugins.map(row => row.id),
      this.extraRows?.map(row => row.id) ?? [],
    )
    this.page.setTotal(rows.length)
    // Barrier before any entry exists: entry creation materializes bundles,
    // and materialization runs synchronous cross-package require edges that
    // need every immediately-tier factory already registered (module
    // comment). Resolves even when individual prefetches failed.
    await prefetching

    // Entry creation order carries no semantics (fiber inject waiting owns
    // activation order); creating concurrently lets non-prefetched bundle
    // loads parallelize.
    //
    // chamber patch (2026-08, version-tolerance): EXTRA rows (the per-instance
    // host-graph rows this shell does not cover) degrade instead of failing
    // the boot. The composite bundles ONE dsh client version; a backend of a
    // NEWER/older dsh can ship rows the shell cannot run — a row whose id is
    // also a shell seed word (the module system resolves seed before factory,
    // so the entry materializes the static namespace — "invalid plugin"), a
    // row registering into slots this shell's ui-* does not declare, or a row
    // re-installing a service the shell already provides. Those are version
    // skew, not corruption: the row's features are simply absent from this
    // shell. The instance must keep booting. Fail-loud stays for the MANIFEST
    // rows and the kernel-adopted modules entry (corruption there is fatal by
    // design); extra-row failures are logged loud and marked 'failed' on the
    // boot page.
    const toleratedIds = new Set(this.extraRows?.map(row => row.id) ?? [])
    await Promise.all(rows.map(async (name) => {
      this.page.setState(name, 'loading')
      try {
        const id = await loader.create({ name })
        // A failed import leaves the entry fiberless (Entry._init logs and
        // returns); project it as failed — no fiber means no status event.
        if (loader.resolve(id).fiber === undefined) {
          this.page.setState(name, 'failed')
        }
      } catch (error) {
        if (!toleratedIds.has(name)) throw error
        console.error(`[web-shell] extra row "${name}" could not materialize; its features are unavailable on this shell version`, error)
        this.page.setState(name, 'failed')
      }
    }))

    await loader.await()
    this.assertEntriesActive(toleratedIds)
  }

  /**
   * Reject entries that failed import/apply or still wait on missing services.
   *
   * ## chamber patch (2026-08, version-tolerance)
   *
   * `toleratedIds` (the per-instance EXTRA rows) are swept but never fail the
   * boot: a version-skewed foreign row simply marks 'failed' on the boot page
   * (and its apply error was already logged by the loader). Only the manifest
   * rows and the kernel-adopted entries (modules + ui-renderer) are fatal. The
   * per-entry decision rules live in boot-tolerance.ts (pure + unit-tested);
   * this loop only drives the verdicts into the page / failure list.
   */
  private assertEntriesActive(toleratedIds: ReadonlySet<string> = new Set()): void {
    const ctx = this.ctx!
    const failures: string[] = []
    for (const entry of ctx.loader.entries()) {
      const name = entry.options.name
      const fiber = entry.fiber
      const fiberLabel = fiber === undefined ? undefined : STATE_LABELS[fiber.state]
      const verdict = classifySweepEntry(
        name,
        fiberLabel,
        toleratedIds,
        // The missing-service list is only meaningful for a PENDING fiber
        // (fiber defined); computing it for any other state is dead work.
        fiberLabel === 'pending' && fiber !== undefined
          ? Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
          : [],
      )
      if (verdict.kind === 'ok') continue
      if (verdict.kind === 'degraded') {
        this.page.setState(name, 'failed')
        continue
      }
      failures.push(verdict.reason)
    }
    if (failures.length > 0) {
      throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }

  /**
   * Mount through a dependency fiber so replacing uiRenderer remounts the
   * application.
   *
   * ## chamber patch (2026-08, rc.8 baseline alignment)
   *
   * The `uiRenderer` service arrives from the kernel-adopted ui-renderer
   * entry (sweep-checked like the modules entry — a renderer that fails to
   * activate fails the boot loudly in assertEntriesActive BEFORE this runs).
   * The bounded wait below is a backstop for the residual pathological case
   * (an entry that reports ACTIVE but whose provide was rolled back): cordis
   * inject waiting has no timeout, so without it the boot page would spin
   * until the chamber shell's boot timeout — a silent hang, not a loud
   * failure. 15s is far beyond any legitimate activation delay (the renderer
   * is shell-static local code, its inject set is composite-covered runtime).
   */
  private async mountApp(ctx: Context): Promise<void> {
    const mounted = ctx.inject(['uiRenderer'], (scope) => {
      scope.effect(() => scope.uiRenderer.mount(this.container), 'web boot: application mount')
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('web boot: uiRenderer service never arrived (the renderer did not activate); the app mount timed out'))
      }, MOUNT_TIMEOUT_MS)
    })
    try {
      await Promise.race([mounted, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/** How long the app mount may wait for the uiRenderer service (see mountApp). */
const MOUNT_TIMEOUT_MS = 15_000

/**
 * The page-level module table + registration sink (design 05 §4 / first-boot
 * race fix, 2026-08).
 *
 * The module system cannot arrive through itself: the HTML-installed
 * `window.__ModuleLoader__` facade (queue-mode pending registration sink +
 * `create()`) materializes the modules bootstrap and delegates construction
 * to the modules bundle. The chamber control-plane index.html does NOT
 * install that facade (there are no parser-preloaded ordinary bundles), so
 * this helper installs the same queue-mode facade — the chamber mirror of the
 * official host injection — and hands it the SHELL-STATIC modules client half
 * as the bootstrap registration (the modules package is shell-bundled in
 * chamber, never fetched).
 *
 * The chamber shell (shell.ts bootInstanceShell) calls this BEFORE preloading
 * any host-graph bundle: an extra bundle's script EVALUATES at load (the
 * script load event fires after evaluation) and its top level registers the
 * factory through the sink — so the sink must exist first. The old order
 * (preload → run() install) let a first-ever boot's extra scripts evaluate
 * before the sink existed; the official bundles' unguarded top-level handoff
 * (`window.__ModuleLoader__.load(...)`) threw, the factory was never
 * registered, and the boot failed with a confusing "cannot resolve".
 *
 * Idempotent: the first call installs the facade, creates the module system
 * (switching the facade to live-registration mode) and parks it on
 * `window.__DSH_MODULES__`; every later call — including every
 * `AppWebEntry.run()` — returns the parked instance (the module system
 * constructor refuses a second create). The shared table is safe across ctxs:
 * materialized exports are stateless plugin definitions applied per-ctx by
 * each entry's own cordis loader.
 */
export function ensureWebModuleSystem(seams?: BootSeams): ClientModuleSystem {
  const win = globalThis as ChamberWindow
  const shared = win.__DSH_MODULES__
  if (shared !== undefined) return shared

  // Install the stable registration facade if the host HTML has not already
  // (the chamber control plane does not), mirroring the official queue-mode
  // facade exactly.
  const target = win.__ModuleLoader__ ?? installModuleLoaderFacade(win)
  // Hand the shell-static client halves to the facade as bootstrap
  // registrations (chamber never fetches these bundles): the modules package
  // (drained by the facade create — the bootstrap identity) and the
  // kernel-adopted ui-renderer (replayed by the module-system constructor
  // into live registration once create switches the facade). If a real
  // preloaded registration exists (a future host preload), keep it — it is
  // the same package's ordinary bundle and the facade materializes it.
  if (!target.pendingQueue.some(registration => registration.id === MODULES_ID)) {
    target.load({ id: MODULES_ID, factory: () => ModulesClient })
  }
  if (!target.pendingQueue.some(registration => registration.id === UI_RENDERER_ID)) {
    target.load({ id: UI_RENDERER_ID, factory: () => UiRenderer })
  }

  // Aligned with upstream rc.2: a worker-preview transport may carry its own
  // `loadBundle`; chamber has no such scenario, so this only keeps the
  // structure consistent. The transport hook wins over the constructor seams
  // only when the transport actually defines it.
  const transport = (globalThis as {
    __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
  }).__DSH_TRANSPORT__
  const modules = target.create({
    boot: win.__DSH_BOOT__,
    staticModules: getStaticModules(),
    ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
    ...seams,
  })
  win.__DSH_MODULES__ = modules
  return modules
}

/** The chamber N-ctx extension of the modules wire window: the shared module system slot. */
interface ChamberWindow extends DshWindow {
  /** Page-level shared module system (design 05 §4): installed once, reused by every shell boot. */
  __DSH_MODULES__?: ClientModuleSystem
}

/**
 * Install the queue-mode `window.__ModuleLoader__` facade — the chamber mirror
 * of the official host HTML injection (dsh-client-modules node half
 * `bootInjections`): a pending registration queue that `create()` drains
 * by materializing the modules bootstrap and delegating construction to
 * `createClientModuleSystem`. `create()` is called exactly once by
 * {@link ensureWebModuleSystem}; the resulting {@link ClientModuleSystem}
 * constructor switches the facade to live-registration mode.
 * @param win - the window object to install on.
 * @returns the installed facade.
 */
function installModuleLoaderFacade(win: ChamberWindow): ClientModuleLoaderTarget {
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: (options) => {
      if (target.mode !== 'queue') {
        throw new Error('client-modules: window.__ModuleLoader__.create called after module-system boot')
      }
      const index = pendingQueue.findIndex(registration => registration.id === MODULES_ID)
      const registration = pendingQueue[index]
      if (registration === undefined) {
        throw new Error(
          'client-modules: no bootstrap registration for @deepseek-ai/dsh-client-modules '
          + '(ensureWebModuleSystem must register the shell-static client half)',
        )
      }
      pendingQueue.splice(index, 1)
      // Materialize the bootstrap registration — the shell-static namespace or
      // a real preloaded bundle — then delegate construction (the same flow
      // the official HTML facade runs).
      const exports = registration.factory((specifier) => {
        throw new Error(`client-modules: ${MODULES_ID}/client.js requested external "${specifier}" before the module system existed`)
      })
      if (typeof exports !== 'object' || exports === null
        || typeof (exports as Record<string, unknown>).createClientModuleSystem !== 'function'
        || typeof (exports as Record<string, unknown>).apply !== 'function') {
        throw new Error('client-modules: @deepseek-ai/dsh-client-modules/client.js did not export the bootstrap module face')
      }
      return (exports as typeof ModulesClient).createClientModuleSystem(
        target,
        { id: registration.id, exports },
        options,
      )
    },
  }
  win.__ModuleLoader__ = target
  return target
}
