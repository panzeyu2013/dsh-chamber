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
 * agent-preset, permission-presets, the rc.8 alignment trio attachment,
 * brand-official, reference, and the C4 settings cluster (2026-09: the
 * official settings sections + the chamber settings shell/connections —
 * ui-settings itself stays first-screen, see its import comment) all inject
 * first-screen services
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
 * A DEFERRED family lands in the same batch as one `DEFERRED_ROWS` row (its
 * boot-graph id + chunk loader) and one id in `DEFERRED_EXTRA_ROW_IDS`
 * (required-extra-rows.ts) — that id is what host-graph.ts matches a
 * third-party row's `external` requests against, so a missing id turns a
 * guaranteed require miss back into silence.
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
import {
  deferredRegistrationFailureMessage,
  DEFERRED_EXTRA_ROW_IDS,
  missingInjectedServices, registeredInjectMembers, requiredServiceProbeMessage,
  REQUIRED_SERVICE_PROBE_DEADLINE_MS, REQUIRED_SERVICE_PROBE_INTERVAL_MS,
  type RegisteredPluginInject,
} from './required-extra-rows.ts'
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
// C3 (2026-09 性能审计): ui-primitives joins the store as a platform word the
// composite answers with a covered factory — the seed no longer carries it
// (dsh-client-web seed.ts/platform.ts deviation notes), so the whole-package
// namespace import leaves the main-graph (App-mount-before) eval. Static
// import here, never ctx.plugin'd: it is not a cordis plugin. The shell's C3
// gate (shell.ts) guarantees THIS bundle evaluates before any extra-row
// bundle loads, so this factory answers their `require(...ui-primitives)`
// edges; run()'s own prefetch of this entry is then a module-cache hit.
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
// alpha.2 (S2/S5 裁决): ui-dockkit is upstream's 9th PLATFORM_MODULES word and
// is value-imported by ui-sidebar-right/-files/-documentpreview. The chamber
// seed does NOT carry it (chunk-budget: seeding pulls the docking kit into the
// main-graph eval, the same reason ui-primitives left the seed), so this
// composite factory answers the require edges of the extra rows instead. It is
// a pure library — no `dsh.client`, no `./client` — so it can never arrive as
// a host-graph row and the "platform word must never be a row" invariant holds.
import * as UiDockkit from '@deepseek-ai/dsh-client-ui-dockkit'
import * as ApiSessionController from '@deepseek-ai/dsh-api-session-controller/client'
import * as ApiWorkspaceController from '@deepseek-ai/dsh-api-workspace-controller/client'
import * as Locale from '@deepseek-ai/dsh-client-locale/client'
import * as UiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
// chamber (design 06): the chamber-owned ui-layout fork replaces the official
// layout — the official bundle must never load on the same ctx (a second
// 'root' registration at priority 0 throws the one-declarer rule; the id
// stays covered in chamber-covered.ts). The fork shares + persists the
// sidebar width across every shell boot.
import * as UiLayout from '@dsh-chamber/dsh-chamber-client-ui-layout/client'
import * as UiSidebar from '@dsh-chamber/dsh-chamber-client-ui-sidebar/client'
import * as UiGit from '@dsh-chamber/dsh-chamber-client-ui-git/client'
import * as UiOpenIn from '@dsh-chamber/dsh-chamber-client-ui-open-in/client'
// The official ui-settings (settingsScope / settingsSchema provider, official
// SettingsRoot occupant) stays FIRST-SCREEN: locale and ui-theme — both
// first-screen — ROOT-inject `settingsScope` (vendor client inject lists;
// same invariant the deferred-split rules below check), so deferring it would
// strand their fibers and with them the whole shell. The settings SECTION
// families and the chamber settings shell are deferred instead (C4,
// 2026-09 性能审计 — see registerDeferred): nothing first-screen injects
// their services or occupants, and the settings surface is only reachable
// after the first screen.
import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as UiConversation from '@deepseek-ai/dsh-client-ui-conversation/client'
// dsh-v0.1.2-alpha.1 conversation families (decision D6: into the composite,
// FIRST-SCREEN): ui-session installs the sessions root source + scope adapter
// (ui-workspace / ui-layout / ui-conversation / ui-sidebar all graph-inject
// it), ui-chat owns the conversation.view + chat-node rendering (the message
// list IS first-screen content — deferring it would blank the conversation
// page until the deferred chunk arrives), ui-approval owns the composer
// approval surface. ui-cordis (the new debug face) is deliberately NOT
// registered — see chamber-covered.ts.
// 2026-09 三轮: the upload client is covered (see chamber-covered.ts) so the
// registered vendor patch can carry the per-entry base path; the host half
// (the /api/session/uploadFileBinary route) stays an instance host row.
import * as FileUpload from '@deepseek-ai/dsh-client-file-upload/client'
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
// 02 §3.1), which makes its directory-picker-auto resolve `browse` (the
// resolver's "SSH launch → in-app browse" arm) — so host.listDirectory /
// host.createDirectory are served locally; remote instances are deployed per
// 02 §3.9 with the same unit-level pin (headless servers resolve `browse`
// even without it). One surface everywhere: the hero's "Add workspace…" and
// the sidebar's add-workspace dialog share the same in-app directory browser
// (design 05 §4; the OS chooser is never surfaced to chamber users).
import * as UiDirectoryPickerBrowse from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client'

// ── Deferred families (see module header): dynamic-import chunks, fetched in
// ── parallel right away and registered after they arrive. One roster row pairs
// ── the boot-graph ID with its chunk loader: the id is what the covered-set
// ── lockstep and the failure diagnostic need, and a destructured import list
// ── cannot name the chunk that failed.

/**
 * The deferred cluster's roster: `[boot-graph id, chunk loader]`, in
 * registration order. The id set MUST equal `DEFERRED_EXTRA_ROW_IDS`
 * (required-extra-rows.ts) — asserted by `assertDeferredRosterLockstep` in
 * apply() — and every id is composite-covered (chamber-covered.ts), so this
 * entry is the only thing that may load the bundle.
 */
const DEFERRED_ROWS: ReadonlyArray<readonly [id: string, load: () => Promise<unknown>]> = [
  // rc.8/alpha.2 feature families: nothing first-screen injects their services.
  ['@deepseek-ai/dsh-client-ui-jobs', () => import('@deepseek-ai/dsh-client-ui-jobs/client')],
  ['@deepseek-ai/dsh-client-ui-goal', () => import('@deepseek-ai/dsh-client-ui-goal/client')],
  ['@deepseek-ai/dsh-client-ui-skill', () => import('@deepseek-ai/dsh-client-ui-skill/client')],
  // ui-tool DECLARES the `tool.call.toolview` slot (vendor
  // ui-tool/src/client/apply.ts:38) that extra host-graph rows inject into
  // (ui-cordis, vendor ui-cordis/src/client/index.ts:119-143): its chunk failing
  // is the silent slot gap the failure diagnostic below names.
  ['@deepseek-ai/dsh-client-ui-tool', () => import('@deepseek-ai/dsh-client-ui-tool/client')],
  ['@deepseek-ai/dsh-client-ui-trajectory', () => import('@deepseek-ai/dsh-client-ui-trajectory/client')],
  ['@deepseek-ai/dsh-client-ui-workflow-run', () => import('@deepseek-ai/dsh-client-ui-workflow-run/client')],
  ['@deepseek-ai/dsh-client-ui-deliverables', () => import('@deepseek-ai/dsh-client-ui-deliverables/client')],
  ['@deepseek-ai/dsh-client-ui-subagent', () => import('@deepseek-ai/dsh-client-ui-subagent/client')],
  // 2026-09 四轮: the session-log export client is covered so its registered
  // vendor patch can carry the per-entry base path on `/api/session.export`
  // (the host half keeps the route + /export command).
  ['@deepseek-ai/dsh-session-log-export', () => import('@deepseek-ai/dsh-session-log-export/client')],
  ['@deepseek-ai/dsh-client-ui-message-feedback', () => import('@deepseek-ai/dsh-client-ui-message-feedback/client')],
  ['@deepseek-ai/dsh-client-ui-plan', () => import('@deepseek-ai/dsh-client-ui-plan/client')],
  ['@deepseek-ai/dsh-client-ui-user-questions', () => import('@deepseek-ai/dsh-client-ui-user-questions/client')],
  ['@deepseek-ai/dsh-client-ui-agent-preset', () => import('@deepseek-ai/dsh-client-ui-agent-preset/client')],
  ['@deepseek-ai/dsh-client-ui-permission-presets', () => import('@deepseek-ai/dsh-client-ui-permission-presets/client')],
  // rc.8 deferred families (design 09 §4 baseline alignment): attachment
  // fills the composer + message-image slots, reference registers the
  // unified `@` source — both inject first-screen services only (slots /
  // inputTriggers + locale + remote + the fileReferences &
  // sessionReferenceResolver namespaces, all first-screen providers), so
  // the deferred split stays safe; brand-official fills the official brand
  // slots but is gated on the 'official' build profile (chamber's build
  // defines it away — see vite.config.mjs), so it loads as a no-op.
  ['@deepseek-ai/dsh-client-ui-attachment', () => import('@deepseek-ai/dsh-client-ui-attachment/client')],
  ['@deepseek-ai/dsh-client-ui-brand-official', () => import('@deepseek-ai/dsh-client-ui-brand-official/client')],
  ['@deepseek-ai/dsh-client-ui-reference', () => import('@deepseek-ai/dsh-client-ui-reference/client')],
  // C4 settings cluster (2026-09 性能审计): official ui-settings stays
  // FIRST-SCREEN (locale/theme root-inject its settingsScope), but its SECTION
  // families and the chamber settings shell/connections are only reachable once
  // the user opens settings — deferred like the rc.8 families. Inject audit:
  // every member injects first-screen services only
  // (slots/locale/remote.*/settingsScope/settingsSchema — all first-screen
  // providers); no first-screen family root-injects anything this cluster
  // provides (bridge injects only slots+locale and provides the shadowing
  // sidebar.settings occupant — the official SettingsRoot occupant is
  // registered by ui-settings-general, which moves here with it). Visible
  // transients: the settings ENTRY is absent for ~one chunk roundtrip —
  // one-time only (first instance, first cold boot; later boots resolve
  // from the module cache, possibly before settle); there is no
  // intermediate "official root without sections" frame (all six register
  // in one synchronous continuation after the single load sweep). The
  // per-source settings panel renders THIS boot ctx's own settings.section
  // ledger (2026-12 完整桥接修订), so this boot-ctx timing IS the panel's
  // gate: until the cluster lands, the selected source shows the honest
  // "starting this instance's frontend" intermediate state — the panel does
  // NOT load any content of its own (no child ctx, no bundle). Failure
  // semantics (2026-12 review F2): the cluster is no longer
  // all-or-nothing — each row loads in isolation, so one failed chunk costs
  // exactly its own family (a failed bridge no longer takes the whole
  // cluster, including the chamber-global connections surface, down with
  // it), and the failed id SET is reported by name (never console-only)
  // while the boot keeps settling (diagnostic, not a boot gate; recovery =
  // shell re-boot).
  ['@deepseek-ai/dsh-client-ui-settings-general', () => import('@deepseek-ai/dsh-client-ui-settings-general/client')],
  ['@deepseek-ai/dsh-client-ui-settings-models', () => import('@deepseek-ai/dsh-client-ui-settings-models/client')],
  ['@deepseek-ai/dsh-client-ui-settings-plugins', () => import('@deepseek-ai/dsh-client-ui-settings-plugins/client')],
  ['@deepseek-ai/dsh-client-ui-settings-plugin-inventory', () => import('@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client')],
  ['@dsh-chamber/dsh-chamber-client-ui-settings-connections', () => import('@dsh-chamber/dsh-chamber-client-ui-settings-connections/client')],
  ['@dsh-chamber/dsh-chamber-client-ui-settings-bridge', () => import('@dsh-chamber/dsh-chamber-client-ui-settings-bridge/client')],
]

/**
 * Register the non-first-screen ui-* families once their chunks arrive.
 * Fire-and-forget from apply: never awaited, so the entry (and the boot's
 * settle/sweep) does not wait for any of this. Failures (chunk load error, or a
 * registration racing the shell's teardown) are logged loud AND reported by id
 * through the shared named diagnostic — the settled UI simply misses that
 * family, it never takes the boot down.
 *
 * 2026-12 review F2 (silent slot gap): the cluster is loaded PER ROW. A single
 * `Promise.all` over every chunk used to mean one rejection cancelled the whole
 * continuation — every family after the failure never registered, and the id
 * that failed was not even named (only `console.error`). The slot-declaring
 * families make that a silent hole: `ui-tool` declares `tool.call.toolview`,
 * which the extra host-graph row `ui-cordis` injects into, so a failed chunk
 * meant the row never activated with no non-console trace. Today each row keeps
 * its own verdict, the surviving families still register (in roster order, one
 * synchronous continuation), and the failed id SET travels through
 * `deferredRegistrationFailureMessage` — logged and handed to the shell's
 * post-settle degrade seam (`chamberReportBootDegraded`, the same seam the
 * required-service probe uses), which is what the App renders and self-heals.
 * @param ctx - the per-entry client root context.
 * @param degradedSeam - the shell's post-settle degrade reporter (see
 *   {@link createDegradedSeam}).
 * @param registered - the composite's live probe roster (see the `register`
 *   helper): every row that mounts here ADDS its namespace's exported inject
 *   face, so the deferred members are probed too (2026-09-11 review-fix,
 *   finding 1) instead of pending invisibly.
 * @param probeRearm - the probe's re-arm hand-off; called once after the
 *   cluster registered, so the already-armed probe pass picks the new members
 *   up even when it had stopped on a clean verdict.
 */
async function registerDeferred(
  ctx: Context,
  degradedSeam: (message: string) => void,
  registered: RegisteredPluginInject[],
  probeRearm: ProbeRearmSlot,
): Promise<void> {
  // Chunks are fetched in PARALLEL (one cluster, one round of requests — the
  // LCP reason the split exists) but each row keeps its own verdict.
  const settled = await Promise.all(DEFERRED_ROWS.map(async ([id, load]) => {
    try {
      return { id, ok: true as const, plugin: await load(), error: undefined }
    } catch (error) {
      return { id, ok: false as const, plugin: undefined, error }
    }
  }))
  const failed: string[] = []
  let mounted = 0
  for (const outcome of settled) {
    if (!outcome.ok) {
      failed.push(outcome.id)
      continue
    }
    // Mount with the ROW ID as the fiber name (2026-09-11): cordis gives an
    // UNNAMED fiber the name of its nearest NAMED ancestor (`Fiber.name` walks
    // up, else `'root'`), so mounting these rows bare made every fiber in the
    // cluster report as `@dsh-chamber/app` — in cordis error text, in the
    // crash-attribution index, and (until the nav provenance tag was retired)
    // in the settings panel, which read the same stamp. The upstream web boot
    // names every graph row by its id (`loader.create({ name: row.id })`), and
    // the old child-ctx bridge did the same for its base set; this keeps the
    // composite on that convention so a fiber's name is the package it belongs
    // to. (`DEFERRED_ROWS` types each chunk as `Promise<unknown>` — the id
    // roster is the contract, not the module shapes — so the cordis
    // object-plugin shape is asserted here.)
    const loaded = outcome.plugin as { apply: (ctx: Context, config?: never) => void; inject?: string[] }
    ctx.plugin({ ...loaded, name: outcome.id })
    // 2026-09-11 review-fix (finding 1): the row's OWN exported inject face
    // enters the probe roster now that its namespace is materialized — the
    // declaration the fiber above is waiting on, recorded exactly the way the
    // first-screen `register` helper records one. Two disciplines the mount above
    // must not inherit from that helper:
    //  - the normalization is EAGER (the same call `register` uses), so a face
    //    the normalizer rejects fails HERE rather than inside the probe's timer a
    //    moment later (an uncaught throw in that callback would escape the
    //    diagnostic entirely);
    //  - it is guarded PER ROW: this cluster's whole point (2026-12 review F2) is
    //    that one bad row costs exactly its own family, so an unreadable face
    //    loses that row's probe coverage (loudly) and never the mounting of the
    //    rows after it.
    // A FAILED row adds nothing at all — its members are reported by id through
    // the failure diagnostic below instead.
    try {
      registered.push({ id: outcome.id, inject: registeredInjectMembers(outcome.id, loaded.inject) })
    } catch (error) {
      console.error(
        `[chamber-entry] deferred plugin ${outcome.id} exports an unreadable inject face; its services stay unprobed:`,
        error,
      )
    }
    mounted += 1
  }
  // One re-armed probe pass (review-fix finding 1): the probe stops on a clean
  // verdict, so a roster that grew after that verdict needs an explicit nudge.
  // Only when a row actually mounted — with an unchanged roster the re-arm would
  // buy nothing and only re-run the same poll. The slot is empty in hosts where
  // the probe never installed (plain-node tests), hence the optional call.
  if (mounted > 0) probeRearm.reArm?.()
  if (failed.length === 0) return
  const message = deferredRegistrationFailureMessage(failed, ctx.chamberInstanceId)
  console.error(
    message,
    settled.filter(outcome => !outcome.ok).map(outcome => outcome.error),
  )
  // The shell only accepts a degrade fact once the boot SETTLED (shell.ts
  // reportSettledDegrade); a deferred failure is detected after apply returned,
  // so the report rides a macrotask — the settle (microtask chain) has always
  // won by then, and a report that a torn-down instance never sees is a no-op
  // in the shell's entries lookup rather than a leak.
  setTimeout(() => degradedSeam(message), 0)
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
 * every boot (apply runs per ctx); O(n) over the ~24 covered-factory ids,
 * negligible.
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
 * Deferred-roster lockstep guard (2026-12 review F2): `DEFERRED_ROWS` (this
 * file) and `DEFERRED_EXTRA_ROW_IDS` (required-extra-rows.ts, the list
 * host-graph.ts matches a third-party row's `external` requests against) must
 * name exactly the same ids. Without the guard a family deferred here but
 * absent there would make the `external` diagnostic blind to it — the silent
 * require miss the roster exists to surface.
 *
 * Runs inside apply() for the same attribution reason as
 * {@link assertCoveredFactoryLockstep} (chamber-entry.ts cannot be imported by
 * the node test runner, so this is the only drift guard for the roster).
 */
function assertDeferredRosterLockstep(): void {
  const rosterIds = DEFERRED_ROWS.map(([id]) => id)
  const unique = new Set(rosterIds)
  if (unique.size !== rosterIds.length) {
    throw new Error('chamber-entry: DEFERRED_ROWS contains a duplicate id')
  }
  const declared = new Set(DEFERRED_EXTRA_ROW_IDS)
  if (unique.size !== declared.size) {
    throw new Error(
      `chamber-entry: DEFERRED_ROWS (${unique.size} ids) must match DEFERRED_EXTRA_ROW_IDS `
      + `(${declared.size} ids) exactly — add/remove the same ids in both (see required-extra-rows.ts)`,
    )
  }
  for (const id of unique) {
    if (!declared.has(id)) {
      throw new Error(
        `chamber-entry: deferred id "${id}" is not in DEFERRED_EXTRA_ROW_IDS — add it there `
        + '(or remove it here); host-graph.ts cannot see an external require of it without that entry',
      )
    }
    if (!CHAMBER_COVERED_IDS.includes(id)) {
      throw new Error(
        `chamber-entry: deferred id "${id}" is not in CHAMBER_COVERED_IDS — add it there (or remove it here); `
        + 'an uncovered id would load its host-graph row a second time',
      )
    }
  }
}

/**
 * The shell's post-settle degrade seam, resolved once per entry: the App
 * re-boots the instance on the next ready transition when it receives a fact
 * (2026-09-10 sidebarRight heal; 2026-12 the deferred-cluster report reuses the
 * same channel). Absent in plain-node tests / other hosts, and a throwing seam
 * must never break the caller, so the reporter wraps it.
 * @param ctx - the per-entry client root context.
 * @returns the reporter: logs nothing itself, never throws.
 */
function createDegradedSeam(ctx: Context): (message: string) => void {
  // Shell-provided seam (shell.ts createChamberContextSetup): reports a
  // post-settle degrade to the App. Absent in plain-node tests / other hosts.
  const reportBootDegraded = (ctx as { chamberReportBootDegraded?: (message: string) => void })
    .chamberReportBootDegraded
  return (message: string): void => {
    try { reportBootDegraded?.(message) } catch (error) {
      console.error('[chamber-entry] failed to report a post-settle degrade fact:', error)
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
  // Lockstep guards FIRST (see assertCoveredFactoryLockstep /
  // assertDeferredRosterLockstep): a drift must fail this entry before any
  // plugin registers.
  assertCoveredFactoryLockstep()
  assertDeferredRosterLockstep()
  // chamber patch (05 §4): shell.ts installs immutable per-entry identity and
  // base-path facts through AppWebEntry.configureContext before any plugin can
  // materialize. Do not fall back to page-global knobs: a timed-out boot may
  // settle while a later instance is also booting. Alongside those per-entry
  // facts the shell also installs the PAGE-level machine catalog
  // (`chamberMachineCatalog`, design 20 §4.2) — the same reader object in every
  // entry, because the machine's installed apps are not a per-source fact.
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
  // Both chamber base-path forks read the per-entry `chamberBasePath` from
  // THIS context at apply time (connection: apply(ctx) → RPC carrier + handle;
  // api-gateway: apply(ctx) → Remote stream mux route), so the prefix is bound
  // per entry through configureContext, never through plugin config or a
  // page-global knob (2026-09 Batch 2: the config-passing form was retired).
  //
  // A1 (2026-09-11 upstream-alignment): every first-screen registration also
  // RECORDS what its namespace injects, and the required-service probe below
  // probes exactly that union — the same declaration upstream reads off
  // `Object.keys(entry.fiber.inject)` in its post-settle sweep (vendor
  // packages/client/web/src/boot.ts:138-158). Registration and roster are one
  // call on purpose: a family added here is probed automatically, one removed
  // here stops being probed, and the recorded id is the mount identity (the
  // package / boot-graph id the fiber is named by), never a second service
  // list.
  //
  // 2026-09-11 review-fix (finding 1): the deferred cluster joins the SAME
  // roster as each of its chunks mounts (registerDeferred below), and one probe
  // pass is re-armed when it does. Before this round those members were probed
  // by NOTHING: the derived union carries only the first-screen declarations,
  // and 11 members live exclusively in deferred faces — `remote.goals`,
  // `remote.skills`, `remote.messageFeedback`, `remote.sessionFeedback`,
  // `remote.agentPresets`, `remote.credentials`, `remote.llm`,
  // `remote.pluginInventory`, `remote.fileReferences`,
  // `remote.sessionReferenceResolver` (mounted by the first-screen
  // api-gateway/api-remotes pair) and `settingsSchema` (provided by the
  // first-screen ui-settings) — so a deferred family whose composite-provided
  // provider never activated pended with no diagnostic at all, the exact
  // silent-gap class this probe exists to close. The deferred-split invariant
  // (module header) is what makes that probing safe: every deferred member's
  // provider is a FIRST-SCREEN COMPOSITE plugin, never another deferred family,
  // so a re-armed pass can never mistake a not-yet-evaluated sibling chunk for a
  // missing service.
  const registered: RegisteredPluginInject[] = []
  /** The probe's re-arm hand-off (see {@link assertRequiredExtraRowServices});
   *  filled in when the probe's effect installs, before the deferred cluster can
   *  possibly finish loading its chunks. */
  const probeRearm: ProbeRearmSlot = {}
  const register = (id: string, plugin: object): void => {
    // The mounted fiber's OWN normalized inject map is upstream's source of
    // truth (`Object.keys(entry.fiber.inject)`, the sweep's fact). It is read
    // here as a WITNESS only — never as the roster: the roster is derived from
    // the namespace's exported `inject` face (the declaration this composite
    // registered).
    // 2026-09-11 review-fix (finding 3): the witness is NARROWER than the first
    // version of this comment claimed, and the claim is corrected rather than
    // repeated. Cordis resolves the fiber's map from the SAME expression this
    // helper derives from (`Inject.resolve(plugin.inject)`, vendor cordis
    // registry.ts:330), so the two can only diverge for ONE declaration form:
    // an inject object carrying cordis's `symbols.checkProto` marker
    // (registry.ts:63-87), where the members sit on the object's PROTOTYPE and
    // `Object.keys(plugin.inject)` cannot see them. That case is what the throw
    // below catches. A namespace that simply STOPS EXPORTING `inject` yields an
    // empty roster entry AND an empty witness (`plugin.inject` is undefined on
    // both sides) — no throw, roster silently smaller. That class is covered by
    // the CI table test instead (test/required-extra-rows.test.ts reads every
    // registered id's client entry and pins its audited face), which is the only
    // place a drift is visible: this runtime check cannot know what a namespace
    // "should" export without the hand-written roster the round retired.
    // (`ctx.plugin` returns the fiber; a shape that carries no inject map — or a
    // cordis that returned the context instead — yields no witness and no
    // false alarm.)
    const fiber = ctx.plugin(plugin) as unknown as { inject?: unknown } | undefined
    const witness = fiber?.inject
    const witnessKeys = witness !== null && typeof witness === 'object' && !Array.isArray(witness)
      ? Object.keys(witness as Record<string, unknown>)
      : []
    const declared = registeredInjectMembers(id, (plugin as { inject?: unknown }).inject)
    if (declared.length === 0 && witnessKeys.length > 0) {
      throw new Error(
        `chamber-entry: plugin ${id} mounts an inject set ${JSON.stringify(witnessKeys)} that its namespace does not export — `
        + 'the derived required-service roster would silently lose them (see required-extra-rows.ts)',
      )
    }
    registered.push({ id, inject: declared })
  }
  register('@deepseek-ai/dsh-client-connection', ConnectionPlugin)
  register('@deepseek-ai/dsh-typert-registry', TypertRegistry)
  register('@deepseek-ai/dsh-api-gateway', ApiGateway)
  register('@deepseek-ai/dsh-api-remotes', ApiRemotes)
  // Provider group (dsh-client-runtime dissolved): the store is a platform
  // word (covered factory only, no plugin); the api controllers provide
  // ctx.sessions / ctx.workspaces; ui-session / ui-chat / ui-approval are the
  // conversation families (see the import comments). ApiRemotes' async apply
  // mounts the generated Remote namespaces (`remote.session` etc.) that the
  // controllers' inject lists require — cordis fibers wait on the inject
  // sets, so registration order carries no activation semantics.
  register('@deepseek-ai/dsh-api-session-controller', ApiSessionController)
  register('@deepseek-ai/dsh-api-workspace-controller', ApiWorkspaceController)
  // Background file uploads (covers the host-graph row): ui-conversation and
  // api-session-controller root-inject `fileUpload`, and the composite-bundled
  // copy is the only one the vendor patch can fix (see chamber-covered.ts).
  register('@deepseek-ai/dsh-client-file-upload', FileUpload)
  register('@deepseek-ai/dsh-client-locale', Locale)
  register('@deepseek-ai/dsh-client-ui-theme', UiTheme)
  register('@dsh-chamber/dsh-chamber-client-ui-layout', UiLayout)
  register('@dsh-chamber/dsh-chamber-client-ui-sidebar', UiSidebar)
  register('@dsh-chamber/dsh-chamber-client-ui-git', UiGit)
  register('@dsh-chamber/dsh-chamber-client-ui-open-in', UiOpenIn)
  register('@deepseek-ai/dsh-client-ui-settings', UiSettings)
  register('@deepseek-ai/dsh-client-ui-conversation', UiConversation)
  // First-screen (2026-08 review fix): ui-model-selection's root inject
  // requires `commandUi` (commands) and commands requires `inputTriggers`
  // (input-trigger) — see the import comments above.
  register('@deepseek-ai/dsh-client-ui-commands', UiCommands)
  register('@deepseek-ai/dsh-client-ui-input-trigger', UiInputTrigger)
  register('@deepseek-ai/dsh-client-ui-workspace', UiWorkspace)
  register('@deepseek-ai/dsh-client-ui-model-selection', UiModelSelection)
  // dsh-v0.1.2-alpha.1 conversation families (first-screen; see the import
  // comments above).
  register('@deepseek-ai/dsh-client-ui-session', UiSession)
  register('@deepseek-ai/dsh-client-ui-chat', UiChat)
  register('@deepseek-ai/dsh-client-ui-approval', UiApproval)
  // Directory-picker surface: the `browse` face for every instance (see the
  // import comment above) — the host pins the browse capability per spawn, so
  // the client surface and the host capability never disagree.
  register('@deepseek-ai/dsh-client-ui-directory-picker-browse', UiDirectoryPickerBrowse)
  // Deferred families: fetch their chunks in the background and register them
  // once loaded — never awaited (the entry must settle with only the
  // first-screen families evaluated; see module header). The seam is shared
  // with the required-service probe below, so both post-settle verdicts land on
  // the one channel the App self-heals from.
  const degradedSeam = createDegradedSeam(ctx)
  void registerDeferred(ctx, degradedSeam, registered, probeRearm).catch((error) => {
    console.error('[chamber-entry] deferred plugin registration failed:', error)
  })

  assertRequiredExtraRowServices(ctx, degradedSeam, registered, probeRearm)
}

/**
 * The probe's re-arm hand-off (2026-09-11 review-fix, finding 1): `apply` owns
 * the slot, the probe effect fills it, and `registerDeferred` calls it once the
 * deferred cluster has extended the roster. Empty until the effect installs and
 * empty again after teardown, so an optional call is the whole contract.
 */
interface ProbeRearmSlot {
  /** Run one more probe pass now; absent before install / after teardown. */
  reArm?: () => void
}

/**
 * The post-settle required-service probe (alpha.2; roster DERIVED since the A1
 * 2026-09-11 upstream-alignment).
 *
 * The concrete miss this exists for: the non-covered `ui-sidebar-right` row
 * provides `ctx.sidebarRight`, which the composite's FIRST-SCREEN `ui-chat`
 * declares in its cordis inject set (vendor ui-chat/src/client/apply.ts:47-50).
 * The composite registers ui-chat directly, so its fiber is not part of the
 * boot kernel's loader sweep: if that row never applies, the fiber stays
 * PENDING and the conversation surface disappears while the boot still reports
 * success. Probe the services after the extra rows have had time to materialize
 * and report loudly instead of failing silently.
 *
 * The probed set is NOT a list here either: it is the union of the `inject`
 * faces of the plugins `register()` above mounted (upstream's own fact, read
 * per fiber in its post-settle sweep — vendor
 * packages/client/web/src/boot.ts:138-158), and the pure union/missing/message
 * rules live in required-extra-rows.ts, the single authority, next to the
 * deferred-cluster diagnostic that shares this seam. Since the 2026-09-11
 * review-fix (finding 1) the deferred cluster extends the very same roster when
 * its chunks mount and re-arms one pass here, so a deferred family whose
 * composite-provided service never activated is named too.
 *
 * This is a diagnostic, not a boot gate: a gateway-hosted instance may
 * legitimately run without the rows (the mobile deployment loads no sidebar
 * surface), so the boot must not fail — the operator-facing log is the signal.
 * The timer is owned by the ctx effect, so a torn-down instance stops probing.
 * @param ctx - the per-entry client root context.
 * @param degradedSeam - the shell's post-settle degrade reporter (see
 *   {@link createDegradedSeam}).
 * @param registered - the first-screen plugins this apply mounted, in
 *   registration order, EXTENDED in place by every deferred row that mounts
 *   later (roster source; see the `register` helper and `registerDeferred`).
 * @param probeRearm - the re-arm hand-off the deferred cluster calls once it has
 *   extended the roster (2026-09-11 review-fix, finding 1).
 */
function assertRequiredExtraRowServices(
  ctx: Context,
  degradedSeam: (message: string) => void,
  registered: readonly RegisteredPluginInject[],
  probeRearm: ProbeRearmSlot,
): void {
  const started = Date.now()
  const isProvided = (name: string): boolean =>
    (ctx as { get: (key: string) => unknown }).get(name) !== undefined
  const instanceId = (ctx as { chamberInstanceId?: string }).chamberInstanceId
  ctx.effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    /** The last verdict's service set: a re-armed pass must not re-report it
     *  verbatim (one report per fact is what the App's self-heal consumes). */
    let reportedSignature: string | undefined
    const probe = (): void => {
      const missing = missingInjectedServices(registered, isProvided)
      if (missing.length === 0) return
      if (Date.now() - started < REQUIRED_SERVICE_PROBE_DEADLINE_MS) {
        timer = setTimeout(probe, REQUIRED_SERVICE_PROBE_INTERVAL_MS)
        return
      }
      const signature = missing.map(entry => entry.service).join('\u0000')
      if (signature === reportedSignature) return
      reportedSignature = signature
      const message = requiredServiceProbeMessage(missing, instanceId)
      console.error(message)
      // 2026-09-10: a mount whose conversation view never registers has to be
      // recoverable without a manual reload. The probe's verdict is the only
      // place that KNOWS the graph arrived yet the row did not apply, so report
      // it through the shell seam: the App re-boots the instance on the next
      // ready transition (a fresh boot re-fetches the graph and re-applies the
      // rows — the same effect a full page reload had).
      degradedSeam(message)
    }
    // Re-arm (2026-09-11 review-fix, finding 1): one extra pass over the roster
    // the deferred cluster just extended. `started` is deliberately NOT reset —
    // the deadline is an invariant of the BOOT ("every probed service must have
    // materialized within 5s of apply"), and the deferred members' providers are
    // first-screen composite plugins that mounted long before the cluster's
    // chunks arrived, so re-armed members get exactly the same window as the
    // first-screen ones (a verdict for the pre-cluster members is therefore
    // never delayed either). A pass that finds the same set the last verdict
    // already named reports nothing (`reportedSignature`), while a NEW member
    // that is missing gets its own report — the App's self-heal is marked once
    // per ready epoch, so that is one more fact, never one more re-boot.
    probeRearm.reArm = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(probe, 0)
    }
    timer = setTimeout(probe, 0)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      if (probeRearm.reArm !== undefined) probeRearm.reArm = undefined
    }
  }, 'chamber-entry: required extra-row services probe')
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
 *   reference, and the C4 settings cluster — the official settings sections,
 *   the chamber settings shell + connections): their chunks load after the
 *   boot settles; the official graph
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
  // C3 (2026-09 性能审计): the primitives platform word — the seed no longer
  // answers it (see the import comment); the shell's C3 gate orders this
  // bundle's evaluation before any extra-row load, so require edges land
  // here. Same shape as the store word: factory only, never ctx.plugin'd.
  ['@deepseek-ai/dsh-client-ui-primitives', coveredFactory(UiPrimitives)],
  // alpha.2: the docking-kit word (see the import comment) — factory only,
  // never ctx.plugin'd.
  ['@deepseek-ai/dsh-client-ui-dockkit', coveredFactory(UiDockkit)],
  ['@deepseek-ai/dsh-api-session-controller', coveredFactory(ApiSessionController)],
  ['@deepseek-ai/dsh-api-workspace-controller', coveredFactory(ApiWorkspaceController)],
  ['@deepseek-ai/dsh-client-locale', coveredFactory(Locale)],
  ['@deepseek-ai/dsh-client-ui-theme', coveredFactory(UiTheme)],
  ['@dsh-chamber/dsh-chamber-client-ui-layout', coveredFactory(UiLayout)],
  ['@dsh-chamber/dsh-chamber-client-ui-sidebar', coveredFactory(UiSidebar)],
  ['@dsh-chamber/dsh-chamber-client-ui-git', coveredFactory(UiGit)],
  ['@dsh-chamber/dsh-chamber-client-ui-open-in', coveredFactory(UiOpenIn)],
  ['@deepseek-ai/dsh-client-ui-settings', coveredFactory(UiSettings)],
  ['@deepseek-ai/dsh-client-ui-conversation', coveredFactory(UiConversation)],
  ['@deepseek-ai/dsh-client-ui-commands', coveredFactory(UiCommands)],
  ['@deepseek-ai/dsh-client-ui-input-trigger', coveredFactory(UiInputTrigger)],
  ['@deepseek-ai/dsh-client-ui-workspace', coveredFactory(UiWorkspace)],
  ['@deepseek-ai/dsh-client-ui-model-selection', coveredFactory(UiModelSelection)],
  ['@deepseek-ai/dsh-client-ui-session', coveredFactory(UiSession)],
  ['@deepseek-ai/dsh-client-ui-chat', coveredFactory(UiChat)],
  ['@deepseek-ai/dsh-client-ui-approval', coveredFactory(UiApproval)],
  ['@deepseek-ai/dsh-client-file-upload', coveredFactory(FileUpload)],
  ['@deepseek-ai/dsh-client-ui-directory-picker-browse', coveredFactory(UiDirectoryPickerBrowse)],
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
