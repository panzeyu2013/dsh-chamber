/**
 * Web shell boot kernel — the face consumed by the apps/web entry. Everything
 * here is machinery that cannot itself be a loader entry, and none of it
 * value-imports a plugin package (shell self-sufficiency rule: the
 * loading page must work while — especially when — plugins fail). The one
 * sanctioned exception is the modules package (bootstrap
 * identity): the module system cannot arrive through itself, so its class
 * and its client-half wrapper are shell-bundled and the kernel adopts its
 * plugin entry once cordis is up.
 *
 * > chamber patch (dsh-chamber connection manager, design 05 §3.6): the
 * > N-ctx sharing seam in {@link AppWebEntry.run} — one page hosts multiple
 * > shells (one per dsh instance); every boot after the first reuses the
 * > page-level module system from `window.__DSH_MODULES__` (see run()).
 *
 * AppWebEntry.run(), module face first, then plugin face: parse
 * `window.__DSH_BOOT__` into the two-view BootManifest (wire boundary)
 * → build the module system over the module-view rows → render the loading
 * page → prefetch every `immediately` row in parallel with mounting the
 * vendored cordis Loader (`internal` contract injection BEFORE any entry exists —
 * the bare-import fallback in tree.import must never run in a browser) →
 * await the prefetch tier, THEN adopt the modules entry and create one
 * loader entry per plugin-view row plus the shell-own app-shell assembly
 * entry → loader.await() + a full fiber sweep (all ACTIVE, else fail
 * listing who/what/which service) → flip the settled signal so AppRoot
 * switches to the real UI in one pass.
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
 * decisions (the app-shell assembly is itself a graph entry, the only
 * shell-own module registered with the module system).
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createRoot, type Root } from 'react-dom/client'
import * as ModulesClient from '@deepseek-ai/dsh-client-modules/client'
import {
  ClientModuleSystem, parseBootManifest,
  type BootManifest, type BootModuleRow, type ClientModuleSystemOptions, type DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import * as AppShell from './app-shell.ts'
import { APP_SHELL_ID } from './app-shell.ts'
import { AppRoot } from './AppRoot.tsx'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS, createLoaderStatusStore, createSignal } from './loader-status.ts'
import './base.css'

/** Module transport hook the shell passes through (jsdom tests replace the <script> path). */
export type BootSeams = Pick<ClientModuleSystemOptions, 'loadBundle'>

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
}

/**
 * The modules package's own graph row id. The kernel adopts that entry
 * itself (its wrapper is statically registered — shell-bundled code, never
 * fetched), so the plugin-row loop must skip it: the vendored Group.create
 * does not deduplicate by name, and a second fiber would provide 'modules'
 * twice.
 */
const MODULES_ID = '@deepseek-ai/dsh-client-modules'

/**
 * The web shell kernel: mounts the loading page into a DOM element and runs
 * the two-stage boot over the host graph. Fields hold only what must exist
 * before cordis does — the parsed manifest, the module system, and the
 * loading-page UI handles; everything else lives in plugins.
 */
export class AppWebEntry {
  private readonly el: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly extraRows: BootModuleRow[] | undefined
  private readonly status = createLoaderStatusStore()
  private readonly settled = createSignal(false)
  private readonly error = createSignal<string | undefined>(undefined)
  // Assigned by run() before any private method or settled-gated closure reads them.
  // Optional (not definite-assigned): dispose() nulls it, and reads must handle
  // the pre-run / post-dispose state.
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest
  private root: Root | undefined

  /**
   * Hold the mount point; all work happens in {@link run}.
   * @param el - mount point (the app's #root).
   * @param options - Optional construction options: module transport overrides
   *   for test environments plus the chamber patch's per-instance extra boot
   *   rows (bundles already pre-loaded by the chamber shell — see
   *   {@link AppWebEntryOptions.extraRows}).
   */
  constructor(el: HTMLElement, options?: AppWebEntryOptions) {
    this.el = el
    this.seams = options
    this.extraRows = options?.extraRows
  }

  /**
   * Run the boot chain to settlement. Boot-chain failures resolve (not
   * reject): the loading page stays up and renders the failure report (the
   * fail-loud surface the kernel owns). Rejects only when the boot manifest
   * is missing or malformed — there is nothing to boot against.
   * @returns resolves once the UI settled or the failure report rendered.
   *
   * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
   *
   * N-ctx sharing seam: one page hosts multiple shells (one per dsh instance),
   * and the module table + bundle registry are page-level singletons — the
   * module system constructor refuses a second `__ModuleLoader__` install, so
   * every boot after the first reuses the instance parked on
   * `window.__DSH_MODULES__` (a pre-existing kernel handoff slot). The reuse
   * branch skips the duplicate static registrations (they throw on repeats).
   * The shared table is safe across ctxs: materialized exports are stateless
   * plugin definitions applied per-ctx by each entry's own cordis loader.
   */
  async run(): Promise<void> {
    this.manifest = parseBootManifest((globalThis as DshWindow).__DSH_BOOT__)

    const win = globalThis as DshWindow
    const shared = win.__DSH_MODULES__
    if (shared !== undefined) {
      // chamber patch: reuse the page-level module system (sequential boots —
      // the manifest is identical across instances).
      this.modules = shared
    } else {
      this.modules = new ClientModuleSystem({
        modules: this.manifest.modules, staticModules: getStaticModules(), ...this.seams,
      })
      // The app-shell assembly is the only shell-own module: every other graph
      // row is a plugin bundle arriving through fetch.
      this.modules.registerStatic(APP_SHELL_ID, AppShell)
      // Adoption handoff, supply side: register the modules
      // package's own client half under its bare package name (= graph row id
      // = entry name — a suffixed key would miss the statics branch and
      // trigger a real fetch), and put the instance on the kernel slot the
      // wrapper's apply reads to provide ctx.modules.
      this.modules.registerStatic(MODULES_ID, ModulesClient)
      win.__DSH_MODULES__ = this.modules
    }

    this.root = createRoot(this.el)
    this.root.render(
      <AppRoot
        settled={this.settled}
        status={this.status}
        error={this.error}
        renderApp={() => {
          const shell = this.ctx?.get('appShell')
          // Unreachable after a clean settle (the app-shell entry is in every graph).
          if (shell === undefined) throw new Error('web boot: appShell service missing after settled')
          return shell.renderApp()
        }}
      />,
    )

    // The immediately tier prefetches in parallel with Loader mounting;
    // runPluginBoot awaits it before creating entries (see module comment:
    // cross-package synchronous require edges need every immediately-tier
    // factory registered before any materialization).
    const prefetching = this.prefetchImmediateTier()
    this.ctx = new Context()
    try {
      await this.runPluginBoot(prefetching)
      this.settled.set(true)
    } catch (reason) {
      // Stay on the loading page; surface the sweep report (fail loud).
      console.error(reason)
      this.error.set(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Unmount the shell (loading page or settled UI) and stop its runtime ctx. */
  dispose(): void {
    this.root?.unmount()
    this.root = undefined
    const ctx = this.ctx
    // Drop the handle so a second dispose is a no-op and late runtimeCtx
    // reads observe a dead context.
    this.ctx = undefined
    if (ctx === undefined) return
    void teardownCordisCtx(ctx).catch((error) => {
      console.error('[web-shell] ctx teardown failed:', error)
    })
  }

  /**
   * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
   *
   * Public read handle on the settled runtime context: the chamber shell
   * dispatches per-instance session opens through `ctx.sessions` (the
   * dsh-client-runtime ISessions face) after boot settlement. Private `ctx`
   * has no other consumer; a getter keeps the seam explicit. The handle is
   * `undefined` once dispose() ran (the ctx is torn down) — callers must
   * guard with `?.` (shell.ts dispatchOpen does).
   */
  get runtimeCtx(): Context | undefined {
    return this.ctx
  }

  /** Prefetch the immediately tier (factory registration only; failures defer to the import path). */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch(() => {
        // Import reloads and reports this loudly per entry; swallowing
        // here keeps one failing prefetch from masking the others.
      })))
  }

  /** Plugin face: mount the Loader, inject the `internal` contract, adopt modules, create the graph entries, settle, sweep. */
  private async runPluginBoot(prefetching: Promise<void>): Promise<void> {
    const ctx = this.ctx!
    await ctx.plugin(Loader)
    const loader = ctx.loader
    // Inject the module system BEFORE any entry exists: tree.import falls back
    // to a bare dynamic import when internal is undefined, which in a browser
    // is a guaranteed loud failure — correct as a tripwire, never as a path.
    loader.internal = this.modules as never

    // Status projection: AppRoot displays fiber truth. Every internal/status
    // transition under an entry re-projects that entry's row from its ROOT
    // fiber (child plugin fibers share the same entry).
    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.status.set(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    // Barrier before any entry exists: entry creation materializes bundles,
    // and materialization runs synchronous cross-package require edges that
    // need every immediately-tier factory already registered (module
    // comment). Resolves even when individual prefetches failed.
    await prefetching

    // Adoption handoff, plugin side: the modules entry is created first —
    // its wrapper apply reads the kernel slot and provides ctx.modules (the
    // provide lives on the plugin face; see MODULES_ID for why the row loop
    // must then skip it).
    const rows = [
      MODULES_ID,
      ...this.manifest.plugins.map(row => row.id).filter(id => id !== MODULES_ID),
      // chamber patch (design 05 §3.6 / design 09): the per-instance extra
      // client-plugin rows from the host boot graph. Their bundles were
      // already executed by the chamber shell, so the factories are registered
      // on the shared module table — loader.create resolves them through
      // internal.import's factories branch without a graph row (the modules
      // view / graphRows has no entry for them; duplicate-registration
      // protection is __ModuleLoader__.load's own check). No prefetch here:
      // the chamber side pre-loads the whole extra set uniformly.
      ...(this.extraRows?.map(row => row.id) ?? []),
      APP_SHELL_ID,
    ]
    // Entry creation order carries no semantics (fiber inject waiting owns
    // activation order); creating concurrently lets non-prefetched bundle
    // loads parallelize. The app-shell assembly entry is appended by the
    // kernel: it is shell-own code (host graph rows are all plugin bundles),
    // and mounting the assembly is not a composition decision — it rides the
    // same entry lifecycle so the sweep and status cover it uniformly.
    await Promise.all(rows.map(async (name) => {
      this.status.set(name, 'loading')
      const id = await loader.create({ name })
      // A failed import leaves the entry fiberless (Entry._init logs and
      // returns); project it as failed — no fiber means no status event.
      if (loader.resolve(id).fiber === undefined) {
        this.status.set(name, 'failed')
      }
    }))

    await loader.await()
    this.assertEntriesActive()
  }

  /**
   * Sweep every loader entry after the tree quiesced: an entry without a
   * fiber failed its import; a fiber not ACTIVE is FAILED (apply threw) or
   * PENDING (a required service never arrived — cordis inject waiting has no
   * timeout, so this sweep is the fail-loud compensation).
   */
  private assertEntriesActive(): void {
    const ctx = this.ctx!
    const failures: string[] = []
    for (const entry of ctx.loader.entries()) {
      const name = entry.options.name
      if (entry.fiber === undefined) {
        failures.push(`${name}: import failed (see console for the import error)`)
        continue
      }
      const state = STATE_LABELS[entry.fiber.state]
      if (state === 'active') continue
      if (state === 'pending') {
        const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
        failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: ${state}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }
}

/**
 * ## chamber patch (dsh-chamber connection manager, design 05 §4)
 *
 * Stop every loader entry fiber of one shell's ctx, cascading all plugin
 * effect teardowns (cordis fiber._unload runs the fiber's collected
 * disposers, and child plugin fibers register their disposers on the parent
 * fiber — so the whole plugin subtree under each entry unloads recursively).
 * This releases what root unmount alone never would: the connection stream
 * loop (two WebSockets + the infinite reconnect/backoff loop — its stop
 * handle is a ctx.effect teardown in dsh-client-runtime), the session /
 * conversation stores, and the chamber sidebar / runtime-facts producers
 * (which unsubscribe and clear the bridge's module-level report entry). A
 * shell reaped without this would keep its WS streams, reconnect timers,
 * store data and bridge subscriptions alive forever.
 *
 * Fire-and-forget: nothing depends on the teardown settling; a re-added
 * instance boots a fresh ctx. Failure of one entry's dispose is logged and
 * the rest still tear down.
 */
async function teardownCordisCtx(ctx: Context): Promise<void> {
  const loader = ctx.loader
  if (loader === undefined) return
  for (const entry of loader.entries()) {
    if (entry.fiber === undefined) continue
    try {
      await entry.fiber.dispose()
    } catch (error) {
      console.error('[web-shell] entry dispose threw:', error)
    }
  }
}
