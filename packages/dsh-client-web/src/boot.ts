/**
 * Web boot kernel: owns only the module system, Cordis loader, and a framework-free
 * boot page; the dynamic UI renderer receives the mount point after every entry activates.
 *
 * Chamber N-ctx sharing seam: one page hosts multiple shells (one per dsh instance);
 * boots after the first reuse the page-level module system from `window.__DSH_MODULES__`,
 * extra rows merge into the boot rows, and the chain runs the version-tolerance rules.
 * run() is module face first: adopt/install the shared module system → draw the loading
 * page → prefetch the `immediately` tier while mounting the Loader (`internal` injected
 * BEFORE any entry exists) → await the tier and create the entries → sweep for ACTIVE
 * (extras degrade) → mount through `uiRenderer`.
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as ModulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  BootManifest, BootModuleRow, ClientBundleRegistration, ClientModuleCreateOptions,
  ClientModuleLoaderTarget, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
// Value-imported by the kernel (bootstrap identity): the ui-renderer client half is
// shell-static, adopted as a module-table factory and mounted as a kernel entry;
// the import also pulls its Context augmentation (`ctx.uiRenderer`) in.
import * as UiRenderer from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BootPage } from './boot-page.ts'
import { MODULES_ID, UI_RENDERER_ID, composeBootRows } from './boot-rows.ts'
import { registerExtraChunkOwners } from './extra-chunk-owners.ts'
import { classifySweepEntry } from './boot-tolerance.ts'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS } from './loader-status.ts'
import { installWindowDragRecall } from './window-drag/recall.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/** Boot perf-mark guard, inlined because this package cannot depend on the renderer
 *  (the renderer owns the mark-name registry). Observational only: missing API or
 *  throw is silent. */
function perfMark(name: string): void {
  try {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.mark(name)
    }
  } catch {
    // User Timing 失败不影响 boot 路径。
  }
}

/** Stable boot diagnostics for arbitrary thrown values: the catch handler must not
 *  itself throw when reflection/String coercion on a hostile value throws. */
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

/** Construction options: module-transport seams plus the per-instance extra boot rows. */
export interface AppWebEntryOptions extends BootSeams {
  /**
   * Extra client-plugin rows from THIS instance's host boot graph. The shell
   * pre-loads these bundles, so their factories are already on the shared module
   * table; this seam only merges their ids into the boot rows — it never fetches
   * or prefetches them.
   */
  extraRows?: BootModuleRow[]
  /**
   * Per-entry context initializer. N-ctx boots may overlap, so instance identity
   * and connection base paths must never ride page-global mutable knobs: the shell
   * supplies a closure bound to THIS entry, invoked synchronously right after the
   * Context is constructed and before any loader/plugin work can suspend.
   */
  configureContext?: (ctx: Context) => void
}

/**
 * The web shell kernel: draws the loading page into a DOM element and runs the
 * two-stage boot over the host graph. Fields hold only what must exist before cordis
 * does (manifest, module system, page handles); everything else lives in plugins.
 */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly extraRows: BootModuleRow[] | undefined
  private readonly configureContext: ((ctx: Context) => void) | undefined
  private readonly page: BootPage
  // Assigned by run(); dispose() nulls ctx, so reads handle pre-run/post-dispose state.
  private ctx: Context | undefined
  // The shell owns the one document watcher that keeps Electron's window drag rects
  // in step with the rows that own them (electron#32341); the first mount must
  // measure the surface the renderer draws, so run() installs it before mountApp().
  // N-ctx overlap is safe: each boot stops its own watcher in dispose(), and the
  // watcher ignores its own RECALL_MARK mutation, so concurrent boots only repeat
  // an idempotent pulse.
  private stopDragRecall: (() => void) | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest
  private bootFailure: string | undefined

  /** Draw the boot page; {@link run} starts the loader. `options` carries test
   *  transport overrides plus the pre-loaded per-instance extra rows. */
  constructor(container: HTMLElement, options?: AppWebEntryOptions) {
    this.container = container
    this.seams = options
    this.extraRows = options?.extraRows
    this.configureContext = options?.configureContext
    this.page = new BootPage(container)
  }

  /** Load and activate every client entry, then hand the mount point to the UI
   *  renderer; failures remain visible on the boot page. */
  async run(): Promise<void> {
    try {
      // Install-or-reuse the page-level module system: the shell installs it BEFORE
      // preloading any bundle, so run() adopts the parked instance (which also skips
      // the duplicate bootstrap registration).
      this.modules = ensureWebModuleSystem(this.seams)
      registerExtraChunkOwners(this.modules, this.extraRows)
      this.manifest = this.modules.manifest
      perfMark('dsh:boot:run-start')

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      // Per-entry facts are installed before the first await/materialization, so an
      // earlier boot that settles late keeps its own immutable closure values.
      this.configureContext?.(ctx)
      await this.runPluginBoot(ctx, prefetching)
      // Install before the first mount, so the surface the renderer draws is the
      // one the first frame measures (the rc.2 shell seam, design-aligned with the
      // window-drag contract in src/window-drag/).
      this.stopDragRecall = installWindowDragRecall({ document: this.container.ownerDocument })
      await this.mountApp(ctx)
      perfMark('dsh:boot:settled')
    } catch (reason) {
      // Stay on the loading page; surface the sweep report (fail loud).
      perfMark('dsh:boot:failed')
      console.error(reason)
      this.bootFailure = describeBootError(reason)
      this.page.fail(this.bootFailure)
    }
  }

  /** Dispose the client plugin tree and the page owning the mount point. Never
   *  rejects (teardown errors are logged); shell lifecycle paths may await it. */
  async dispose(): Promise<void> {
    this.stopDragRecall?.()
    this.stopDragRecall = undefined
    const ctx = this.ctx
    // Drop the handle so a second dispose is a no-op and late runtimeCtx reads see a dead ctx.
    this.ctx = undefined
    if (ctx !== undefined) {
      try {
        // Root-fiber dispose cascades through every loader entry fiber and the mount
        // inject fiber, releasing what React unmount alone never would (connection
        // loop, timers, stores, producers).
        await ctx.fiber.dispose()
      } catch (error) {
        console.error('[web-shell] ctx teardown failed:', error)
      }
    }
    this.page.dispose()
  }

  /** Public read handle on the settled runtime context (the shell dispatches
   *  per-instance session opens through `ctx.sessions`). `undefined` once
   *  dispose() ran, so callers must guard with `?.`. */
  get runtimeCtx(): Context | undefined {
    return this.ctx
  }

  /** Boot failure report (undefined while loading or after a clean settle). run()
   *  resolves on failure by design, so the shell needs this read handle to present
   *  its per-instance fallback; valid once run() settled. */
  get bootError(): string | undefined {
    return this.bootFailure
  }

  /** Prefetch stage-one bundles; their import path owns any eventual failure. */
  private async prefetchImmediateTier(): Promise<void> {
    // A transport carrying `loadBundle` supplies the bytes itself, so skip prefetch.
    const transport = (globalThis as { __DSH_TRANSPORT__?: { loadBundle?: unknown } }).__DSH_TRANSPORT__
    if (transport?.loadBundle !== undefined) return
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports
        // the failure. Extra rows are not prefetched (the shell pre-loads them).
      })))
  }

  /** Mount the Loader, create all graph entries, await quiescence, and audit activation. */
  private async runPluginBoot(ctx: Context, prefetching: Promise<void>): Promise<void> {
    await ctx.plugin(Loader)
    const loader = ctx.loader
    // Inject the module system BEFORE any entry exists: tree.import falls back to a
    // bare dynamic import when internal is undefined, which in a browser is a loud failure.
    loader.internal = this.modules as never

    // Status projection from fiber truth: every internal/status transition
    // re-projects the entry's row from its ROOT fiber.
    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.page.setState(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    // Row order: the kernel-adopted modules and ui-renderer entries first (both
    // pre-materialized/shell-static), then the manifest rows, then the per-instance
    // extra rows. Extra bundles were already executed by the shell, so loader.create
    // resolves them through internal.import's factories branch without a graph row;
    // nothing here is prefetched.
    const rows = composeBootRows(
      this.manifest.plugins.map(row => row.id),
      this.extraRows?.map(row => row.id) ?? [],
    )
    this.page.setTotal(rows.length)
    // Barrier before any entry exists: materialization runs synchronous cross-package
    // require edges needing every immediately-tier factory registered. Resolves even
    // when individual prefetches failed.
    await prefetching
    perfMark('dsh:boot:prefetch')

    // Entry creation order carries no semantics; creating concurrently lets
    // non-prefetched loads parallelize. Version tolerance: EXTRA rows degrade instead
    // of failing the boot (a newer/older backend can ship rows this shell cannot run —
    // seed-word ids, unknown slots, already-provided services), because that is version
    // skew, not corruption; fail-loud stays for MANIFEST rows and kernel-adopted entries.
    const toleratedIds = new Set(this.extraRows?.map(row => row.id) ?? [])
    await Promise.all(rows.map(async (name) => {
      this.page.setState(name, 'loading')
      try {
        const id = await loader.create({ name })
        // A failed import leaves the entry fiberless, so project it as failed (no status event).
        if (loader.resolve(id).fiber === undefined) {
          this.page.setState(name, 'failed')
        }
      } catch (error) {
        if (!toleratedIds.has(name)) throw error
        console.error(`[web-shell] extra row "${name}" could not materialize; its features are unavailable on this shell version`, error)
        this.page.setState(name, 'failed')
      }
    }))

    perfMark('dsh:boot:rows-created')
    await loader.await()
    perfMark('dsh:boot:loader-awaited')
    this.assertEntriesActive(toleratedIds)
  }

  /**
   * Reject entries that failed import/apply or still wait on missing services.
   * `toleratedIds` (extra rows) are swept but never fail the boot — they only mark
   * 'failed'. The decision rules live in boot-tolerance.ts; this loop drives them.
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
        // The missing-service list is only meaningful for a PENDING fiber.
        fiberLabel === 'pending' && fiber !== undefined
          ? Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
          : [],
        // 无 fiber = import/apply 失败：模块系统记录了原因就用它，没有才回落「看 console」
        //（上游 boot-client.ts 的 assertEntriesActive 同口径，§22.4.2-1）。
        fiberLabel === undefined ? this.modules.importError(name)?.message : undefined,
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
   * Mount through a dependency fiber so replacing uiRenderer remounts the app. The
   * bounded wait is a backstop for the pathological case (ACTIVE entry whose provide
   * was rolled back): cordis inject waiting has no timeout, so without it the boot
   * page would spin until the shell's boot timeout. 15 s is far beyond any legitimate
   * activation delay for shell-static local code.
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
    perfMark('dsh:boot:mounted')
  }
}

/** How long the app mount may wait for the uiRenderer service (see mountApp). */
const MOUNT_TIMEOUT_MS = 15_000

/**
 * The page-level module table + registration sink (first-boot race guard): the module system
 * cannot arrive through itself, so this installs the queue-mode `window.__ModuleLoader__`
 * facade (the chamber mirror of the official host injection) and hands it the shell-static
 * modules client half as the bootstrap registration. The shell calls this BEFORE preloading
 * any bundle: an extra script EVALUATES at load and registers through the sink, so the sink
 * must exist first. Idempotent: the first call installs the facade, creates the module system
 * and parks it on `window.__DSH_MODULES__`; later calls — including every run() — return the
 * parked one (stateless plugin definitions applied per-ctx).
 */
export function ensureWebModuleSystem(seams?: BootSeams): ClientModuleSystem {
  const win = globalThis as ChamberWindow
  const shared = win.__DSH_MODULES__
  if (shared !== undefined) return shared

  // Install the registration facade if the host HTML has not (it does not).
  const target = win.__ModuleLoader__ ?? installModuleLoaderFacade(win)
  // Hand the shell-static client halves to the facade as bootstrap registrations
  // (chamber never fetches them): modules (the bootstrap identity) and the
  // kernel-adopted ui-renderer. An existing real registration is kept. Queue mode is
  // required — a LIVE-mode facade would make these reads an opaque TypeError.
  const pendingQueue = target.pendingQueue
  if (!Array.isArray(pendingQueue)) {
    throw new Error('dsh-chamber: the page module-loader facade has no registration queue — a live-mode facade was installed by the host, but the chamber composite requires queue mode')
  }
  if (!pendingQueue.some(registration => registration.id === MODULES_ID)) {
    target.load({ id: MODULES_ID, factory: () => ModulesClient })
  }
  if (!pendingQueue.some(registration => registration.id === UI_RENDERER_ID)) {
    target.load({ id: UI_RENDERER_ID, factory: () => UiRenderer })
  }

  // The transport hook wins over constructor seams only when the transport defines it.
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

/** The chamber extension of the modules wire window: the shared module-system slot. */
interface ChamberWindow extends DshWindow {
  /** Installed once, reused by every shell boot. */
  __DSH_MODULES__?: ClientModuleSystem
}

/** The require shape a factory receives (rc.2 adds the async chunk loader; the
 *  client face does not re-export the named type). */
type BundleRequire = Parameters<ClientBundleRegistration['factory']>[0]

/**
 * The require handed to the bootstrap registration before the module system exists.
 * Both shapes refuse — rc.2 `ClientBundleRequire` carries the async chunk loader
 * beside the call — because the shell-static modules client half must resolve
 * nothing external.
 */
function refusingBootstrapRequire(): BundleRequire {
  const message = (specifier: string, shape: string): string =>
    `client-modules: ${MODULES_ID}/client.js requested ${shape}external "${specifier}" before the module system existed`
  const refuse = (specifier: string): never => {
    throw new Error(message(specifier, ''))
  }
  return Object.assign(refuse, {
    async: async (specifier: string): Promise<never> => {
      throw new Error(message(specifier, 'async '))
    },
  })
}

/**
 * Install the queue-mode `window.__ModuleLoader__` facade: a pending registration
 * queue that `create()` drains by materializing the modules bootstrap and delegating
 * construction. Called exactly once by {@link ensureWebModuleSystem}.
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
      // Materialize the bootstrap registration, then delegate construction.
      const exports = registration.factory(refusingBootstrapRequire())
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
