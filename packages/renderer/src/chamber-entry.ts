/**
 * chamber composite entry — the single `__DSH_BOOT__` plugin row (design 05
 * §2/§3.6; `scripts/gen-boot-manifest.mjs` writes it into dist/manifest.json).
 *
 * The control plane serves this bundle as the only boot-graph plugin: one
 * cordis entry whose apply registers the whole dsh client assembly — the
 * wire root (connection, with the chamber base-path parameterization, and
 * the api-gateway fork, which carries the same per-entry base path), the
 * typert registry + generated Remote gateway, the mounted Remote namespaces,
 * the object layer (dsh-v0.1.2-alpha.1: sessions via the api session
 * controller, workspaces via the api workspace controller, slots via the
 * kernel-adopted ui-renderer row), locale, and every ui-* plugin — so each
 * per-instance boot gets a complete dsh shell (independent cordis ctx, full
 * ui-* tree) with zero dsh graph composition machinery. Registration order
 * is irrelevant: cordis fibers wait on their inject sets. The bundle
 * self-registers through the module-table handoff
 * (`window.__ModuleLoader__.load`), factory-form, matching the wire contract
 * of dsh-client-modules' parseBootManifest / ClientModuleSystem.
 *
 * > v1 deviation from contract 05 §1 (declared): the chamber sidebar plugin
 * > IS a boot-graph plugin in this composite (the self-built ui-sidebar
 * > replacement, 05 §2); the bridge host (health/connection polling + the
 * > session aggregation loop that publishes chamberBridge, App.tsx) remains
 * > an entry-level React implementation in the shell entry (main.tsx) — the
 * > wire crosser is the shared chamberBridge; instance identity and proxy
 * > base path are immutable per-entry Context facts installed by shell.ts.
 *
 * ## First-screen / deferred split (LCP perf pass, P4)
 *
 * The boot settle (`loader.await()` + `assertEntriesActive()`, boot.ts) only
 * requires every loader ENTRY fiber ACTIVE — for this composite that is the
 * entry's own root fiber, which is ACTIVE as soon as `apply` returns (a sync
 * function, not a thenable). Child ui-* fibers registered through
 * `ctx.plugin()` are NOT part of the sweep, so they may be registered AFTER
 * the settle — the boot does not wait for them (fiber activation is driven by
 * inject-waiting + reflect notifications, and the settled UI re-renders
 * reactively as late-registered slots/services appear).
 *
 * To shrink the JS that must evaluate before the settled UI paints, the
 * NON-first-screen ui-* families are split into separate vite chunks via
 * dynamic `import()` and registered fire-and-forget at the end of `apply`
 * (never awaited): the fetch starts right away, overlapping the settle and
 * first paint, while the entry — and therefore the whole boot — settles with
 * only the first-screen families evaluated. The deferred families register
 * their slots/services moments later; the already-painted UI picks them up
 * through the slot store's reactivity (progressive enhancement, not a
 * blocking dependency).
 *
 * The split is safe ONLY because no first-screen family requires a deferred
 * service at its apply root (verified against the vendor inject lists): the
 * deferred set (jobs, goal, skill, tool, trajectory, workflow-run,
 * deliverables, subagent, message-feedback, plan, user-questions,
 * agent-preset, permission-presets, and the rc.8 alignment trio attachment,
 * brand-official, reference) all inject first-screen services
 * (connection/sessions/slots/locale/remote/…). Two families that WOULD have
 * violated the invariant are kept FIRST-SCREEN by construction (2026-08
 * review fix — the vendor `inject` list is the authority, and it carries the
 * edge at the ROOT, not in a nested inject as the original comment claimed):
 * - `dsh-client-ui-model-selection` root-injects `commandUi` (vendor
 *   src/client/index.ts:100), provided only by `dsh-client-ui-commands` — the
 *   whole model-selection apply, INCLUDING the composer model seat (nested
 *   `ctx.inject(['slots','modelDirectories'])`), is gated on it. Commands is
 *   therefore first-screen; if its chunk ever failed, the model seat would
 *   disappear with only a console.error (no UI signal) — unacceptable for a
 *   first-screen seat.
 * - `dsh-client-ui-commands` root-injects `inputTriggers`, provided only by
 *   `dsh-client-ui-input-trigger` — input-trigger moves with it.
 * (skill/subagent also inject `inputTriggers`, but they are themselves
 * deferred, so that edge is deferred→deferred and harmless.)
 *
 * dsh-v0.1.2-alpha.1 first-screen additions (decision D6): the api session /
 * workspace controllers, ui-session, ui-chat and ui-approval are FIRST-SCREEN
 * by the same rule — ui-conversation / ui-workspace / ui-sidebar / ui-layout
 * (first-screen) graph-inject the controllers and ui-session (dsh.client
 * inject lists), and ui-chat owns the conversation message rendering (the
 * conversation view is first-screen content, not feature UI). Their own
 * injects are all first-screen or kernel-adopted (sessions ← api-session
 * controller, workspaces ← api-workspace controller, uiSession ← ui-session,
 * uiConversation ← ui-conversation, slots ← the kernel-adopted ui-renderer
 * row, remote / remote.* ← the api-gateway client + api-remotes' generated
 * namespace mounts), so the split invariant still holds. The api-remotes
 * apply is ASYNC (it mounts every generated Remote contribution through
 * `ctx.remote.$mount`) — registered first-screen, never awaited by the entry
 * root, the controllers' fibers wait on the mounted `remote.*` namespaces.
 *
 * Maintenance: when adding a ui-* family, decide first-screen (synchronous
 * static import — hero, composer, settings shell, navigation, conversation
 * rendering) vs deferred (feature UI only reachable after the first paint);
 * BEFORE deferring a family, grep the vendor `inject` lists for any
 * first-screen family that root-injects one of its services — such a family
 * must stay first-screen. Keep `chamber-covered.ts` in lockstep either way.
 *
 * ## Module-table factories for the covered set (design 09 union table)
 *
 * The composite is also the module-table PROVIDER for every covered package:
 * the shared module table (client-modules system.ts) resolves a fetched
 * bundle's synchronous `require` edges through seed → statics → loadCache →
 * registered factories — and the official graph answers each edge with the
 * target package's own row-factory. The chamber merge DROPS the covered rows
 * (the composite replaces their bundles), so their factories must be
 * registered here or a covered require edge misses: the new client purity
 * gate (upstream tsdown.client.ts) externalizes the platform modules
 * (`PLATFORM_MODULES` — `@deepseek-ai/dsh-client-store` among them), so every
 * client bundle that value-imports the store engine emits
 * `require("@deepseek-ai/dsh-client-store")` — the store word is
 * composite-covered (and the default web profile's `dsh-session-log-export`
 * row, an extra row the composite does not cover, is exactly such a bundle;
 * the chamber shell seed may already answer the word, the registered factory
 * below is the composite-side fallback for the same require edge).
 * The covered-factory registration below (one per statically-imported
 * first-screen family, at bundle execution — before any loader entry
 * materializes) completes the union table. The map↔list lockstep is enforced
 * in apply() (assertCoveredFactoryLockstep — fails THIS entry loudly on drift)
 * plus the CI test. See the COVERED_FACTORIES block.
 */

import type { Context } from '@deepseek-ai/cordis'

import { CHAMBER_COVERED_FACTORY_IDS, CHAMBER_COVERED_IDS } from './chamber-covered.ts'
import { isChamberSourceId } from './transport-source.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-entry instance id (05 §4): shell-bound before plugin materialization. */
    chamberInstanceId?: string
    /** Per-entry control-plane proxy base path; never read from a page-global knob. */
    chamberBasePath?: string
    /** Immutable, non-secret registry incarnation bound before plugin materialization. */
    chamberSourceFingerprint?: string
    /** Immutable transport mechanism bound before plugin materialization. */
    chamberTransport?: 'local' | 'ssh' | 'http'
  }
}

// ── First-screen families: statically imported, evaluated with the entry
// ── chunk, registered synchronously inside apply (see module header).
import * as ConnectionPlugin from '@deepseek-ai/dsh-client-connection/client'
import * as TypertRegistry from '@deepseek-ai/dsh-typert-registry/client'
import * as ApiGateway from '@deepseek-ai/dsh-api-gateway/client'
import * as ApiRemotes from '@deepseek-ai/dsh-api-remotes/client'
// dsh-v0.1.2-alpha.1 provider group (dsh-client-runtime no longer exists):
// the platform store word (module-table seed — a plain module, NOT a cordis
// plugin: registered as a covered factory below, never ctx.plugin'd) plus the
// two api controllers (ctx.sessions / ctx.workspaces). All first-screen: the
// ui-conversation / ui-workspace / ui-sidebar first-screen families
// graph-inject the controllers (dsh.client.inject), so deferring them would
// defer the whole shell.
import * as Store from '@deepseek-ai/dsh-client-store'
import * as ApiSessionController from '@deepseek-ai/dsh-api-session-controller/client'
import * as ApiWorkspaceController from '@deepseek-ai/dsh-api-workspace-controller/client'
import * as Locale from '@deepseek-ai/dsh-client-locale/client'
import * as UiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
// chamber (design 06): the chamber-owned ui-layout fork replaces the official
// layout — the official bundle must never load on the same ctx (a second
// 'root' registration at priority 0 throws the one-declarer rule; the id
// stays covered in chamber-covered.ts). The fork shares + persists the
// sidebar width across every shell boot.
import * as UiLayout from '@dsh-chamber/dsh-client-ui-layout/client'
import * as UiSidebar from '@dsh-chamber/dsh-client-ui-sidebar/client'
import * as UiGit from '@dsh-chamber/dsh-client-ui-git/client'
import * as UiOpenIn from '@dsh-chamber/dsh-client-ui-open-in/client'
import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as UiSettingsGeneral from '@deepseek-ai/dsh-client-ui-settings-general/client'
import * as UiSettingsModels from '@deepseek-ai/dsh-client-ui-settings-models/client'
import * as UiSettingsPlugins from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import * as UiSettingsPluginInventory from '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client'
import * as UiConversation from '@deepseek-ai/dsh-client-ui-conversation/client'
// dsh-v0.1.2-alpha.1 conversation families (decision D6: into the composite,
// FIRST-SCREEN): ui-session installs the sessions root source + scope adapter
// (ui-workspace / ui-layout / ui-conversation / ui-sidebar all graph-inject
// it), ui-chat owns the conversation.view + chat-node rendering (the message
// list IS first-screen content — deferring it would blank the conversation
// page until the deferred chunk arrives), ui-approval owns the composer
// approval surface. ui-cordis (the new debug face) is deliberately NOT
// registered — see chamber-covered.ts.
import * as UiSession from '@deepseek-ai/dsh-client-ui-session/client'
import * as UiChat from '@deepseek-ai/dsh-client-ui-chat/client'
import * as UiApproval from '@deepseek-ai/dsh-client-ui-approval/client'
// commands + input-trigger are FIRST-SCREEN (2026-08 review fix, see module
// header): ui-model-selection's ROOT inject list carries `commandUi`
// (vendor src/client/index.ts:100), provided only by ui-commands — so the
// whole model-selection apply (incl. the composer model seat) is gated on
// it. Leaving commands deferred would push the model seat past the deferred
// chunk load (and lose it entirely if that chunk fails). commands' own root
// inject requires `inputTriggers`, provided only by input-trigger — the two
// move together.
import * as UiCommands from '@deepseek-ai/dsh-client-ui-commands/client'
import * as UiInputTrigger from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import * as UiWorkspace from '@deepseek-ai/dsh-client-ui-workspace/client'
import * as UiModelSelection from '@deepseek-ai/dsh-client-ui-model-selection/client'
// Directory picking: the official web-app roster mounts exactly ONE surface
// (dsh-host-directory-picker-auto resolves native|browse per deployment and
// mounts that pair; the web-app cordis.patch.yml never carries both). Both
// surfaces occupy the SAME `single` directoryFlow holes of ui-workspace, so a
// composite registering both on ONE ctx throws at boot. The choice is
// therefore made per boot, mirroring the host-side picker-auto resolution.
// Chamber pins the `browse` interaction for EVERY managed host: the local
// host is spawned with the SSH_CONNECTION launch marker (spawn-dsh.ts, design
// 02 §3.2.1), which makes its directory-picker-auto resolve `browse` (the
// resolver's "SSH launch → in-app browse" arm) — so host.listDirectory /
// host.createDirectory are served locally; remote instances are deployed per
// 02 §3.9 with the same unit-level pin (headless servers resolve `browse`
// even without it). One surface everywhere: the hero's "Add workspace…" and
// the sidebar's add-workspace dialog share the same in-app directory browser
// (design 05 §4; the OS chooser is never surfaced to chamber users).
import * as UiDirectoryPickerBrowse from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client'
import * as UiSettingsConnections from '@dsh-chamber/dsh-client-ui-settings-connections/client'
import * as UiSettingsBridge from '@dsh-chamber/dsh-client-ui-settings-bridge/client'

// ── Deferred families (see module header): dynamic-import chunks, fetched
// ── and registered after the boot settles. Each `import()` resolves to the
// ── same module-namespace shape the static imports above use, so the
// ── registrations below typecheck identically to the synchronous ones.

/**
 * Register the non-first-screen ui-* families once their chunks arrive.
 * Fire-and-forget from apply: never awaited, so the entry (and the boot's
 * settle/sweep) does not wait for any of this. Failures (chunk load error,
 * or a registration racing the shell's teardown) are logged loud — the
 * settled UI simply misses that family, it never takes the boot down.
 */
async function registerDeferred(ctx: Context): Promise<void> {
  const [
    jobs,
    goal,
    skill,
    tool,
    trajectory,
    workflowRun,
    deliverables,
    subagent,
    messageFeedback,
    plan,
    userQuestions,
    agentPreset,
    permissionPresets,
    attachment,
    brandOfficial,
    reference,
  ] = await Promise.all([
    import('@deepseek-ai/dsh-client-ui-jobs/client'),
    import('@deepseek-ai/dsh-client-ui-goal/client'),
    import('@deepseek-ai/dsh-client-ui-skill/client'),
    import('@deepseek-ai/dsh-client-ui-tool/client'),
    import('@deepseek-ai/dsh-client-ui-trajectory/client'),
    import('@deepseek-ai/dsh-client-ui-workflow-run/client'),
    import('@deepseek-ai/dsh-client-ui-deliverables/client'),
    import('@deepseek-ai/dsh-client-ui-subagent/client'),
    import('@deepseek-ai/dsh-client-ui-message-feedback/client'),
    import('@deepseek-ai/dsh-client-ui-plan/client'),
    import('@deepseek-ai/dsh-client-ui-user-questions/client'),
    import('@deepseek-ai/dsh-client-ui-agent-preset/client'),
    import('@deepseek-ai/dsh-client-ui-permission-presets/client'),
    // rc.8 deferred families (design 09 §4 baseline alignment): attachment
    // fills the composer + message-image slots, reference registers the
    // unified `@` source — both inject first-screen services only (slots /
    // inputTriggers + locale + remote + the fileReferences &
    // sessionReferenceResolver namespaces, all first-screen providers), so
    // the deferred split stays safe; brand-official fills the official brand
    // slots but is gated on the 'official' build profile (chamber's build
    // defines it away — see vite.config.mjs), so it loads as a no-op.
    import('@deepseek-ai/dsh-client-ui-attachment/client'),
    import('@deepseek-ai/dsh-client-ui-brand-official/client'),
    import('@deepseek-ai/dsh-client-ui-reference/client'),
  ])
  ctx.plugin(jobs)
  ctx.plugin(goal)
  ctx.plugin(skill)
  ctx.plugin(tool)
  ctx.plugin(trajectory)
  ctx.plugin(workflowRun)
  ctx.plugin(deliverables)
  ctx.plugin(subagent)
  ctx.plugin(messageFeedback)
  ctx.plugin(plan)
  ctx.plugin(userQuestions)
  ctx.plugin(agentPreset)
  ctx.plugin(permissionPresets)
  ctx.plugin(attachment)
  ctx.plugin(brandOfficial)
  ctx.plugin(reference)
}

/**
 * The boot-graph entry ids this composite covers (design 09, module C) — the
 * dedupe set the per-instance host-graph merge filters against (shell.ts →
 * host-graph.ts). Re-exported from the leaf module `chamber-covered.ts` (the
 * constant is DEFINED there): shell.ts must import it without pulling this
 * bundle's top-level module-table handoff into the main chunk. Maintenance:
 * keep the two lists in lockstep (see chamber-covered.ts header).
 */
export { CHAMBER_COVERED_IDS } from './chamber-covered.ts'

/** The boot-graph row id this bundle registers under (must match dist/manifest.json). */
export const CHAMBER_APP_ID = '@dsh-chamber/app'

/** No inject: the composite provides every service the dsh shell needs. */
export const inject: string[] = []

/**
 * Union-table lockstep guard (design 09 §3.2): COVERED_FACTORIES must match
 * CHAMBER_COVERED_FACTORY_IDS exactly, and every id must be covered — a
 * non-covered id would execute its official bundle as an extra row and
 * double-register against the composite's own factory.
 *
 * Runs inside apply() — the composite's OWN entry — so a drift fails THIS
 * entry loudly and is attributed correctly (assertEntriesActive reports
 * "@dsh-chamber/app: failed"; the specific message lands in the console via
 * cordis's apply-error log). A top-level check would be muffled: a composite
 * top-level throw is swallowed by prefetchImmediateTier's catch and the drift
 * would surface as a misleading extra-bundle "import failed" instead. Runs on
 * every boot (apply runs per ctx); O(n) over ~20 ids, negligible.
 *
 * The CI lockstep test (host-graph.test.ts) covers the declared↔covered
 * direction; this covers the map↔declared direction (chamber-entry cannot be
 * imported by the node test runner — its namespaces resolve to source).
 */
function assertCoveredFactoryLockstep(): void {
  const mapIds = COVERED_FACTORIES.map(([id]) => id)
  const unique = new Set(mapIds)
  if (unique.size !== mapIds.length) {
    throw new Error('chamber-entry: COVERED_FACTORIES contains a duplicate id')
  }
  const declared = new Set(CHAMBER_COVERED_FACTORY_IDS)
  if (unique.size !== declared.size) {
    throw new Error(
      `chamber-entry: COVERED_FACTORIES (${unique.size} ids) must match CHAMBER_COVERED_FACTORY_IDS `
      + `(${declared.size} ids) exactly — add/remove the same ids in both (see chamber-covered.ts)`,
    )
  }
  for (const id of unique) {
    if (!declared.has(id)) {
      throw new Error(
        `chamber-entry: covered factory "${id}" is not in CHAMBER_COVERED_FACTORY_IDS — add it there (or remove it here)`,
      )
    }
    if (!CHAMBER_COVERED_IDS.includes(id)) {
      throw new Error(
        `chamber-entry: covered factory "${id}" is not in CHAMBER_COVERED_IDS — add it there (or remove it here); `
        + 'a non-covered id would double-register against the host-graph row',
      )
    }
  }
}

/**
 * Assemble the complete dsh client plugin tree on the per-instance ctx.
 * Sub-plugin fibers wait on their inject sets, so registration order carries
 * no activation semantics; the core assembly is listed first for readability.
 *
 * The first-screen families are registered synchronously; the deferred
 * families are kicked off (not awaited) so the entry settles — and the boot
 * paints — without their eval (see module header).
 */
export function apply(ctx: Context): void {
  // Union-table lockstep guard FIRST (see assertCoveredFactoryLockstep): a
  // COVERED_FACTORIES drift must fail this entry before any plugin registers.
  assertCoveredFactoryLockstep()
  // chamber patch (05 §4): shell.ts installs immutable per-entry identity and
  // base-path facts through AppWebEntry.configureContext before any plugin can
  // materialize. Do not fall back to page-global knobs: a timed-out boot may
  // settle while a later instance is also booting.
  const chamberInstanceId = ctx.chamberInstanceId
  const chamberBasePath = ctx.chamberBasePath
  const chamberSourceFingerprint = ctx.chamberSourceFingerprint
  const chamberTransport = ctx.chamberTransport
  if (typeof chamberInstanceId !== 'string' || chamberInstanceId.trim() === '') {
    throw new Error('chamber-entry: missing per-entry chamberInstanceId')
  }
  if (!isChamberSourceId(chamberInstanceId)) {
    throw new Error(`chamber-entry: unexpected chamberInstanceId ${JSON.stringify(chamberInstanceId)}`)
  }
  if (typeof chamberBasePath !== 'string' || chamberBasePath !== `/api/i/${chamberInstanceId}`) {
    throw new Error(`chamber-entry: invalid per-entry chamberBasePath ${JSON.stringify(chamberBasePath)}`)
  }
  const validSourceFingerprint = chamberInstanceId === 'local'
    ? chamberSourceFingerprint === 'local'
    : typeof chamberSourceFingerprint === 'string' && /^[a-f0-9]{64}$/.test(chamberSourceFingerprint)
  if (!validSourceFingerprint) {
    throw new Error('chamber-entry: invalid per-entry chamberSourceFingerprint')
  }
  if ((chamberInstanceId === 'local' && chamberTransport !== 'local')
    || (chamberInstanceId !== 'local' && chamberTransport !== 'ssh' && chamberTransport !== 'http')) {
    throw new Error('chamber-entry: invalid per-entry chamberTransport')
  }
  ctx.plugin(ConnectionPlugin, { basePath: chamberBasePath })
  ctx.plugin(TypertRegistry)
  // dsh-v0.1.2-alpha.1: the chamber api-gateway fork (packages/dsh-api-gateway)
  // carries the same per-entry base-path parameterization as the connection
  // fork — its remote stream / RPC carriers prefix the instance proxy path,
  // so the config is bound here, never read from a page-global knob.
  ctx.plugin(ApiGateway, { basePath: chamberBasePath })
  ctx.plugin(ApiRemotes)
  // Provider group (dsh-client-runtime dissolved): the store is a platform
  // word (covered factory only, no plugin); the api controllers provide
  // ctx.sessions / ctx.workspaces; ui-session / ui-chat / ui-approval are the
  // conversation families (see the import comments). ApiRemotes' async apply
  // mounts the generated Remote namespaces (`remote.session` etc.) that the
  // controllers' inject lists require — cordis fibers wait on the inject
  // sets, so registration order carries no activation semantics.
  ctx.plugin(ApiSessionController)
  ctx.plugin(ApiWorkspaceController)
  ctx.plugin(Locale)
  ctx.plugin(UiTheme)
  ctx.plugin(UiLayout)
  ctx.plugin(UiSidebar)
  ctx.plugin(UiGit)
  ctx.plugin(UiOpenIn)
  ctx.plugin(UiSettings)
  ctx.plugin(UiSettingsGeneral)
  ctx.plugin(UiSettingsModels)
  ctx.plugin(UiSettingsPlugins)
  ctx.plugin(UiSettingsPluginInventory)
  ctx.plugin(UiConversation)
  // First-screen (2026-08 review fix): ui-model-selection's root inject
  // requires `commandUi` (commands) and commands requires `inputTriggers`
  // (input-trigger) — see the import comments above.
  ctx.plugin(UiCommands)
  ctx.plugin(UiInputTrigger)
  ctx.plugin(UiWorkspace)
  ctx.plugin(UiModelSelection)
  // dsh-v0.1.2-alpha.1 conversation families (first-screen; see the import
  // comments above).
  ctx.plugin(UiSession)
  ctx.plugin(UiChat)
  ctx.plugin(UiApproval)
  // Directory-picker surface: the `browse` face for every instance (see the
  // import comment above) — the host pins the browse capability per spawn, so
  // the client surface and the host capability never disagree.
  ctx.plugin(UiDirectoryPickerBrowse)
  ctx.plugin(UiSettingsConnections)
  ctx.plugin(UiSettingsBridge)
  // Deferred families: fetch their chunks in the background and register them
  // once loaded — never awaited (the entry must settle with only the
  // first-screen families evaluated; see module header).
  void registerDeferred(ctx).catch((error) => {
    console.error('[chamber-entry] deferred plugin registration failed:', error)
  })
}

/** The module-table handoff shape (wire contract, dsh-client-modules). */
interface ClientPluginHandoff {
  id: string
  factory: (require: (spec: string) => unknown) => Record<string, unknown>
}

/**
 * Wrap a bundled first-screen namespace as a module-table factory: every
 * materialization returns the SAME object the composite mounts on the ctx —
 * the require edge and the ctx services share one instance (union table,
 * design 09 §3.2). The factory signature's `require` is unused: the namespace
 * is fully bundled, nothing is resolved lazily.
 */
const coveredFactory = (exports: unknown): ClientPluginHandoff['factory'] => () => exports as Record<string, unknown>

/**
 * Module-table factories for the composite-covered packages (module header,
 * "Module-table factories for the covered set"): one per statically-imported
 * first-screen family — exactly the namespaces present the moment this bundle
 * executes. Registered at bundle execution (see the loop below), so every
 * synchronous require an extra host-graph bundle can emit resolves before any
 * loader entry materializes.
 *
 * Deliberately NOT included:
 * - the deferred families (jobs, goal, …, attachment, brand-official,
 *   reference): their chunks load after the boot settles; the official graph
 *   only guarantees the immediately tier for synchronous requires, and the
 *   client-bundle purity gate (upstream tsdown.client.ts) forbids value
 *   imports of ui-* packages anyway;
 * - page-own covered ids (`@deepseek-ai/dsh-client-modules`, the official
 *   `dsh-client-ui-sidebar` / `dsh-client-ui-layout` registrations the chamber
 *   replaces, and rc.8's `dsh-client-ui-renderer` — the shell kernel adopts
 *   that row, chamber-entry never imports it): the composite has no namespace
 *   for them and they are not legitimate require targets.
 *
 * Maintenance: every id here MUST stay in `CHAMBER_COVERED_IDS` (a non-covered
 * id would double-register against the host-graph row's own bundle); keep the
 * map in lockstep with the first-screen import list, `CHAMBER_COVERED_FACTORY_IDS`
 * and `chamber-covered.ts` — drift is enforced by apply-time
 * `assertCoveredFactoryLockstep` plus the CI lockstep test (host-graph.test.ts).
 *
 * Known boundaries (documented, accepted):
 * - the composite bundle is NOT re-execution-safe: the sanctioned dev HMR
 *   reload of `@dsh-chamber/app` (invalidate → prefetch re-executes the
 *   bundle) would re-run this registration loop and hit the duplicate-factory
 *   sink on the covered ids. Dev-only (the web profile has no hmr client
 *   channel); the reload fails loud and degrades per the hmr failure policy.
 * - the "before any loader entry materializes" guarantee assumes the composite
 *   prefetch succeeds; if it fails (swallowed), the composite is re-fetched
 *   during entry creation concurrently with extra entries — an extra requiring
 *   a covered id can then miss the table and fail loud (self-heals on retry).
 */
const COVERED_FACTORIES: ReadonlyArray<readonly [id: string, factory: ClientPluginHandoff['factory']]> = [
  ['@deepseek-ai/dsh-client-connection', coveredFactory(ConnectionPlugin)],
  ['@deepseek-ai/dsh-typert-registry', coveredFactory(TypertRegistry)],
  ['@deepseek-ai/dsh-api-gateway', coveredFactory(ApiGateway)],
  ['@deepseek-ai/dsh-api-remotes', coveredFactory(ApiRemotes)],
  // dsh-v0.1.2-alpha.1 provider group: the store is the platform word every
  // client bundle that value-imports the store engine requires (the new
  // tsdown.client.ts PLATFORM_MODULES externalizes `@deepseek-ai/dsh-client-store`
  // — the chamber shell seed provides it too, and this registered factory is
  // the composite-side fallback for the same require edge; seed wins, factory
  // is inert-but-harmless). The controllers + conversation families are
  // first-screen plugins, factories mirror their namespaces like the rest.
  ['@deepseek-ai/dsh-client-store', coveredFactory(Store)],
  ['@deepseek-ai/dsh-api-session-controller', coveredFactory(ApiSessionController)],
  ['@deepseek-ai/dsh-api-workspace-controller', coveredFactory(ApiWorkspaceController)],
  ['@deepseek-ai/dsh-client-locale', coveredFactory(Locale)],
  ['@deepseek-ai/dsh-client-ui-theme', coveredFactory(UiTheme)],
  ['@dsh-chamber/dsh-client-ui-layout', coveredFactory(UiLayout)],
  ['@dsh-chamber/dsh-client-ui-sidebar', coveredFactory(UiSidebar)],
  ['@dsh-chamber/dsh-client-ui-git', coveredFactory(UiGit)],
  ['@dsh-chamber/dsh-client-ui-open-in', coveredFactory(UiOpenIn)],
  ['@deepseek-ai/dsh-client-ui-settings', coveredFactory(UiSettings)],
  ['@deepseek-ai/dsh-client-ui-settings-general', coveredFactory(UiSettingsGeneral)],
  ['@deepseek-ai/dsh-client-ui-settings-models', coveredFactory(UiSettingsModels)],
  ['@deepseek-ai/dsh-client-ui-settings-plugins', coveredFactory(UiSettingsPlugins)],
  ['@deepseek-ai/dsh-client-ui-settings-plugin-inventory', coveredFactory(UiSettingsPluginInventory)],
  ['@deepseek-ai/dsh-client-ui-conversation', coveredFactory(UiConversation)],
  ['@deepseek-ai/dsh-client-ui-commands', coveredFactory(UiCommands)],
  ['@deepseek-ai/dsh-client-ui-input-trigger', coveredFactory(UiInputTrigger)],
  ['@deepseek-ai/dsh-client-ui-workspace', coveredFactory(UiWorkspace)],
  ['@deepseek-ai/dsh-client-ui-model-selection', coveredFactory(UiModelSelection)],
  ['@deepseek-ai/dsh-client-ui-session', coveredFactory(UiSession)],
  ['@deepseek-ai/dsh-client-ui-chat', coveredFactory(UiChat)],
  ['@deepseek-ai/dsh-client-ui-approval', coveredFactory(UiApproval)],
  ['@deepseek-ai/dsh-client-ui-directory-picker-browse', coveredFactory(UiDirectoryPickerBrowse)],
  ['@dsh-chamber/dsh-client-ui-settings-connections', coveredFactory(UiSettingsConnections)],
  ['@dsh-chamber/dsh-client-ui-settings-bridge', coveredFactory(UiSettingsBridge)],
]

/** Factory-form self-registration: body runs once, at materialization. */
const factory: ClientPluginHandoff['factory'] = () => ({ inject, apply })

const win = globalThis as typeof globalThis & {
  __ModuleLoader__?: { load(handoff: ClientPluginHandoff): void }
}
if (win.__ModuleLoader__ === undefined) {
  throw new Error('chamber-entry: window.__ModuleLoader__ is not installed (bundle loaded before the boot kernel)')
}
win.__ModuleLoader__.load({ id: CHAMBER_APP_ID, factory })

// Union-table completion: register the covered packages' factories (module
// header). Registration is self-consistent even if the map drifted (each id
// pairs with its own namespace, and no id can collide — covered ids are never
// preloaded as extra rows); the map↔list lockstep is enforced in apply()
// (assertCoveredFactoryLockstep) so a drift fails THIS entry loudly instead
// of surfacing as a misleading extra-bundle "import failed".
for (const [id, covered] of COVERED_FACTORIES) {
  win.__ModuleLoader__.load({ id, factory: covered })
}
