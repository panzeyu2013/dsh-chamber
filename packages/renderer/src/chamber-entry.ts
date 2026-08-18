/**
 * chamber composite entry — the single `__DSH_BOOT__` plugin row (design 05
 * §2/§3.6; `scripts/gen-boot-manifest.mjs` writes it into dist/manifest.json).
 *
 * The control plane serves this bundle as the only boot-graph plugin: one
 * cordis entry whose apply registers the whole dsh client assembly — the
 * wire root (connection, with the chamber base-path parameterization), the
 * typert registry + generated Remote gateway, the mounted Remote namespaces,
 * the runtime object layer (sessions/workspaces/slots), locale, and every
 * ui-* plugin — so each per-instance boot gets a complete dsh shell
 * (independent cordis ctx, full ui-* tree) with zero dsh graph composition
 * machinery. Registration order is irrelevant: cordis fibers wait on their
 * inject sets. The bundle self-registers through the module-table handoff
 * (`window.__ModuleLoader__.load`), factory-form, matching the wire contract
 * of dsh-client-modules' parseBootManifest / ClientModuleSystem.
 *
 * > v1 deviation from contract 05 §1 (declared): the chamber sidebar plugin
 * > IS a boot-graph plugin in this composite (the self-built ui-sidebar
 * > replacement, 05 §2); the bridge host (health/connection polling + the
 * > session aggregation loop that publishes chamberBridge, App.tsx) remains
 * > an entry-level React implementation in the shell entry (main.tsx) — the
 * > wire crosser is the shared chamberBridge + the per-boot instance knob
 * > (see chamber-knob.ts).
 *
 * ## First-screen / deferred split (LCP perf pass, P4)
 *
 * The boot settle (`loader.await()` + `assertEntriesActive()`, boot.tsx) only
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
 * service at its apply root (verified against the inject lists): the deferred
 * set (commands, input-trigger, jobs, goal, skill, tool, trajectory,
 * workflow-run, deliverables, subagent, message-feedback, plan,
 * user-questions, agent-preset, permission-presets) all inject first-screen
 * services (connection/sessions/slots/locale/remote/…); the only
 * sync→deferred edge is ui-model-selection's `commandUi` inject, which it
 * declares inside a nested `ctx.inject` (a /model command contribution) — the
 * composer model seat renders without it. `input-trigger`'s service
 * (`inputTriggers`) is injected only by deferred families (commands, skill,
 * subagent), and ui-conversation's imports from it are type-only.
 *
 * Maintenance: when adding a ui-* family, decide first-screen (synchronous
 * static import — hero, composer, settings shell, navigation) vs deferred
 * (feature UI only reachable after the first paint). Keep `chamber-covered.ts`
 * in lockstep either way.
 */

import type { Context } from '@deepseek-ai/cordis'

import { getChamberInstanceId } from './chamber-knob.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-boot instance id (05 §4): provided by this entry, read by the sidebar plugin. */
    chamberInstanceId?: string
  }
}

// ── First-screen families: statically imported, evaluated with the entry
// ── chunk, registered synchronously inside apply (see module header).
import * as ConnectionPlugin from '@deepseek-ai/dsh-client-connection/client'
import * as TypertRegistry from '@deepseek-ai/dsh-typert-registry/client'
import * as ApiGateway from '@deepseek-ai/dsh-api-gateway/client'
import * as ApiRemotes from '@deepseek-ai/dsh-api-remotes/client'
import * as Runtime from '@deepseek-ai/dsh-client-runtime/client'
import * as Locale from '@deepseek-ai/dsh-client-locale/client'
import * as UiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
// chamber (design 06): the chamber-owned ui-layout fork replaces the official
// layout — the official bundle must never load on the same ctx (a second
// 'root' registration at priority 0 throws the one-declarer rule; the id
// stays covered in chamber-covered.ts). The fork shares + persists the
// sidebar width across every shell boot.
import * as UiLayout from '@dsh-chamber/dsh-client-ui-layout/client'
import * as UiSidebar from '@dsh-chamber/dsh-client-ui-sidebar/client'
import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as UiSettingsGeneral from '@deepseek-ai/dsh-client-ui-settings-general/client'
import * as UiSettingsModels from '@deepseek-ai/dsh-client-ui-settings-models/client'
import * as UiSettingsPlugins from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import * as UiSettingsPluginInventory from '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client'
import * as UiConversation from '@deepseek-ai/dsh-client-ui-conversation/client'
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
    commands,
    inputTrigger,
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
  ] = await Promise.all([
    import('@deepseek-ai/dsh-client-ui-commands/client'),
    import('@deepseek-ai/dsh-client-ui-input-trigger/client'),
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
  ])
  ctx.plugin(commands)
  ctx.plugin(inputTrigger)
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
}

/**
 * The boot-graph entry ids this composite covers (design 09, module C) — the
 * dedupe set the per-instance host-graph merge filters against (shell.ts →
 * host-graph.ts). Re-exported from the leaf module `chamber-covered.ts` (the
 * constant is DEFINED there): shell.ts must import it without pulling this
 * bundle's top-level module-table handoff into the main chunk — same pattern
 * as chamber-knob.ts (see its header comment). Maintenance: keep the two
 * lists in lockstep (see chamber-covered.ts header).
 */
export { CHAMBER_COVERED_IDS } from './chamber-covered.ts'

/** The boot-graph row id this bundle registers under (must match dist/manifest.json). */
export const CHAMBER_APP_ID = '@dsh-chamber/app'

/** No inject: the composite provides every service the dsh shell needs. */
export const inject: string[] = []

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
  // chamber patch (05 §4): the per-boot instance id, set by shell.ts through
  // the chamber knob for the duration of the boot — the sidebar plugin reads
  // it to highlight the current source. Declared via ctx.provide: cordis
  // rejects assigning undeclared context properties at runtime.
  ctx.provide('chamberInstanceId', getChamberInstanceId())
  ctx.plugin(ConnectionPlugin)
  ctx.plugin(TypertRegistry)
  ctx.plugin(ApiGateway)
  ctx.plugin(ApiRemotes)
  ctx.plugin(Runtime)
  ctx.plugin(Locale)
  ctx.plugin(UiTheme)
  ctx.plugin(UiLayout)
  ctx.plugin(UiSidebar)
  ctx.plugin(UiSettings)
  ctx.plugin(UiSettingsGeneral)
  ctx.plugin(UiSettingsModels)
  ctx.plugin(UiSettingsPlugins)
  ctx.plugin(UiSettingsPluginInventory)
  ctx.plugin(UiConversation)
  ctx.plugin(UiWorkspace)
  ctx.plugin(UiModelSelection)
  // Directory-picker surface: the `browse` face for every instance (see the
  // import comment above) — the host pins the browse capability per spawn, so
  // the client surface and the host capability never disagree.
  const chamberInstanceId = getChamberInstanceId()
  if (chamberInstanceId !== undefined && !chamberInstanceId.startsWith('ssh-') && chamberInstanceId !== 'local') {
    throw new Error(`chamber-entry: unexpected chamberInstanceId ${JSON.stringify(chamberInstanceId)}`)
  }
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

/** Factory-form self-registration: body runs once, at materialization. */
const factory: ClientPluginHandoff['factory'] = () => ({ inject, apply })

const win = globalThis as typeof globalThis & {
  __ModuleLoader__?: { load(handoff: ClientPluginHandoff): void }
}
if (win.__ModuleLoader__ === undefined) {
  throw new Error('chamber-entry: window.__ModuleLoader__ is not installed (bundle loaded before the boot kernel)')
}
win.__ModuleLoader__.load({ id: CHAMBER_APP_ID, factory })
