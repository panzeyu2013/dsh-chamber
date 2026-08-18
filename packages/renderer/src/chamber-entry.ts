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
 */

import type { Context } from '@deepseek-ai/cordis'

import { getChamberInstanceId } from './chamber-knob.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-boot instance id (05 §4): provided by this entry, read by the sidebar plugin. */
    chamberInstanceId?: string
  }
}

import * as ConnectionPlugin from '@deepseek-ai/dsh-client-connection/client'
import * as TypertRegistry from '@deepseek-ai/dsh-typert-registry/client'
import * as ApiGateway from '@deepseek-ai/dsh-api-gateway/client'
import * as ApiRemotes from '@deepseek-ai/dsh-api-remotes/client'
import * as Runtime from '@deepseek-ai/dsh-client-runtime/client'
import * as Locale from '@deepseek-ai/dsh-client-locale/client'
import * as UiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
import * as UiLayout from '@deepseek-ai/dsh-client-ui-layout/client'
import * as UiSidebar from '@dsh-chamber/dsh-client-ui-sidebar/client'
import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as UiSettingsGeneral from '@deepseek-ai/dsh-client-ui-settings-general/client'
import * as UiSettingsModels from '@deepseek-ai/dsh-client-ui-settings-models/client'
import * as UiSettingsPlugins from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import * as UiSettingsPluginInventory from '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client'
import * as UiConversation from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as UiCommands from '@deepseek-ai/dsh-client-ui-commands/client'
import * as UiInputTrigger from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import * as UiJobs from '@deepseek-ai/dsh-client-ui-jobs/client'
import * as UiGoal from '@deepseek-ai/dsh-client-ui-goal/client'
import * as UiWorkspace from '@deepseek-ai/dsh-client-ui-workspace/client'
import * as UiModelSelection from '@deepseek-ai/dsh-client-ui-model-selection/client'
import * as UiMessageFeedback from '@deepseek-ai/dsh-client-ui-message-feedback/client'
import * as UiPlan from '@deepseek-ai/dsh-client-ui-plan/client'
import * as UiSkill from '@deepseek-ai/dsh-client-ui-skill/client'
import * as UiSubagent from '@deepseek-ai/dsh-client-ui-subagent/client'
import * as UiTool from '@deepseek-ai/dsh-client-ui-tool/client'
import * as UiTrajectory from '@deepseek-ai/dsh-client-ui-trajectory/client'
import * as UiUserQuestions from '@deepseek-ai/dsh-client-ui-user-questions/client'
import * as UiWorkflowRun from '@deepseek-ai/dsh-client-ui-workflow-run/client'
import * as UiAgentPreset from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import * as UiDeliverables from '@deepseek-ai/dsh-client-ui-deliverables/client'
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
import * as UiPermissionPresets from '@deepseek-ai/dsh-client-ui-permission-presets/client'
import * as UiSettingsConnections from '@dsh-chamber/dsh-client-ui-settings-connections/client'
import * as UiSettingsBridge from '@dsh-chamber/dsh-client-ui-settings-bridge/client'

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
  ctx.plugin(UiCommands)
  ctx.plugin(UiInputTrigger)
  ctx.plugin(UiJobs)
  ctx.plugin(UiGoal)
  ctx.plugin(UiWorkspace)
  ctx.plugin(UiModelSelection)
  ctx.plugin(UiMessageFeedback)
  ctx.plugin(UiPlan)
  ctx.plugin(UiSkill)
  ctx.plugin(UiSubagent)
  ctx.plugin(UiTool)
  ctx.plugin(UiTrajectory)
  ctx.plugin(UiUserQuestions)
  ctx.plugin(UiWorkflowRun)
  ctx.plugin(UiAgentPreset)
  ctx.plugin(UiDeliverables)
  // Directory-picker surface: the `browse` face for every instance (see the
  // import comment above) — the host pins the browse capability per spawn, so
  // the client surface and the host capability never disagree.
  const chamberInstanceId = getChamberInstanceId()
  if (chamberInstanceId !== undefined && !chamberInstanceId.startsWith('ssh-') && chamberInstanceId !== 'local') {
    throw new Error(`chamber-entry: unexpected chamberInstanceId ${JSON.stringify(chamberInstanceId)}`)
  }
  ctx.plugin(UiDirectoryPickerBrowse)
  ctx.plugin(UiPermissionPresets)
  ctx.plugin(UiSettingsConnections)
  ctx.plugin(UiSettingsBridge)
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
