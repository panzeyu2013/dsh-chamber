/**
 * chamber composite entry — the single `__DSH_BOOT__` plugin row. apply() assembles one
 * complete dsh client shell per instance (wire, typert/Remote, controllers, locale, every
 * ui-* family); registration order is irrelevant because cordis fibers wait on injects.
 * Self-registers factory-form via `window.__ModuleLoader__.load` (dsh-client-modules contract).
 * First-screen families register synchronously; the rest load as deferred chunks (never
 * awaited). The split is safe ONLY because no first-screen family root-injects a deferred
 * service (vendor inject lists are the authority); a new deferred family needs one
 * DEFERRED_ROWS row plus the same id in DEFERRED_EXTRA_ROW_IDS.
 * This module is also the module-table provider for every covered package: their rows are
 * dropped from the merged graph, so their factories register here at bundle execution
 * (map↔list lockstep asserted in apply; keep chamber-covered.ts in lockstep).
 */

import type { Context } from '@deepseek-ai/cordis'

import { CHAMBER_COVERED_FACTORY_IDS, CHAMBER_COVERED_IDS } from './chamber-covered.ts'
import { bootGapSignature, type ShellDegradedFact, type ShellDegradedReport } from './boot-gap.ts'
import {
  deferredRegistrationFailureMessage,
  DEFERRED_EXTRA_ROW_IDS,
  injectedServices,
  missingInjectedServices, missingServiceFact, monotonicNowMs, registeredInjectMembers,
  requiredServiceProbeMessage, RequiredServiceProbeWindows,
  REQUIRED_SERVICE_PROBE_INTERVAL_MS,
  type RegisteredPluginInject,
} from './required-extra-rows.ts'
import { withLocaleOwnership } from './locale-ownership.ts'
import { isChamberSourceId } from './transport-source.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-entry instance id; shell-bound before plugin materialization. */
    chamberInstanceId?: string
    /** Per-entry control-plane proxy base path; never read from a page-global knob. */
    chamberBasePath?: string
    /** Immutable, non-secret registry incarnation bound before materialization. */
    chamberSourceFingerprint?: string
    /** Immutable transport mechanism bound before plugin materialization. */
    chamberTransport?: 'local' | 'ssh' | 'http'
  }
}

// ── First-screen families: statically imported and registered synchronously inside apply.
import * as ConnectionPlugin from '@deepseek-ai/dsh-client-connection/client'
import * as TypertRegistry from '@deepseek-ai/dsh-typert-registry/client'
import * as ApiGateway from '@deepseek-ai/dsh-api-gateway/client'
import * as ApiRemotes from '@deepseek-ai/dsh-api-remotes/client'
// provider group: the platform store word (plain module, covered factory only — never
// ctx.plugin'd) plus the two api controllers (ctx.sessions / ctx.workspaces). All
// first-screen: the conversation/workspace/sidebar families graph-inject the controllers.
import * as Store from '@deepseek-ai/dsh-client-store'
// ui-primitives is another platform word answered by a covered factory (the seed does
// not carry it). Static import, never ctx.plugin'd; the shell's pre-load gate evaluates
// THIS bundle before any extra-row load, so their require edges land on this factory.
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
// ui-dockkit is a PLATFORM_MODULES word value-imported by several extra rows; the seed
// does not carry it (chunk budget, same as ui-primitives), so this factory answers their
// require edges. Pure library — no `dsh.client`, never a host-graph row.
import * as UiDockkit from '@deepseek-ai/dsh-client-ui-dockkit'
import * as ApiSessionController from '@deepseek-ai/dsh-api-session-controller/client'
import * as ApiWorkspaceController from '@deepseek-ai/dsh-api-workspace-controller/client'
import * as Locale from '@deepseek-ai/dsh-client-locale/client'
// First-screen since rc.2: the covered ui-layout/ui-workspace families inject
// `shortcuts`, and this package is its only provider. UNIQUE export shape: the
// client entry default-exports the service CLASS (no namespace-level `apply`),
// so the composite mounts the default binding the way the official loader's
// `exports.default ?? exports` normalization does, and the module-table factory
// returns that same class (the official row's `module.exports`). Left on the
// host graph it was a reverse dependency: a degraded graph channel stranded
// those fibers PENDING while boot reported success (design 09 §3.2).
import ShortcutsService from '@deepseek-ai/dsh-client-shortcuts/client'
import * as UiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
// chamber ui-layout fork replaces the official layout: loading both would register a
// second 'root' at priority 0 and throw the one-declarer rule. The fork shares and
// persists the sidebar width across boots.
import * as UiLayout from '@dsh-chamber/dsh-chamber-client-ui-layout/client'
import * as UiSidebar from '@dsh-chamber/dsh-chamber-client-ui-sidebar/client'
import * as UiGit from '@dsh-chamber/dsh-chamber-client-ui-git/client'
import * as UiOpenIn from '@dsh-chamber/dsh-chamber-client-ui-open-in/client'
// Official ui-settings (configForms / settingsSchema provider, SettingsRoot occupant)
// stays FIRST-SCREEN: locale and ui-theme root-inject `configForms`, so deferring it
// would strand their fibers and the whole shell. Its SECTION families and the chamber
// settings shell are deferred instead (nothing first-screen injects them).
import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as UiConversation from '@deepseek-ai/dsh-client-ui-conversation/client'
// Conversation families (FIRST-SCREEN): ui-session installs the sessions root source +
// scope adapter (graph-injected by workspace/layout/conversation/sidebar), ui-chat owns
// conversation.view + chat-node rendering (deferring would blank the conversation page),
// ui-approval owns the composer approval surface. ui-cordis is deliberately not
// registered (chamber-covered.ts). The upload client is covered so the vendor patch can
// carry the per-entry base path; its host half stays an instance host row.
import * as FileUpload from '@deepseek-ai/dsh-client-file-upload/client'
import * as UiSession from '@deepseek-ai/dsh-client-ui-session/client'
import * as UiChat from '@deepseek-ai/dsh-client-ui-chat/client'
import * as UiApproval from '@deepseek-ai/dsh-client-ui-approval/client'
// commands + input-trigger are FIRST-SCREEN: ui-model-selection's root inject carries
// `commandUi`, provided only by ui-commands, so the whole model-selection apply (incl.
// the composer model seat) is gated on it; commands itself root-injects `inputTriggers`,
// provided only by input-trigger. The two move together.
import * as UiCommands from '@deepseek-ai/dsh-client-ui-commands/client'
import * as UiInputTrigger from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import * as UiWorkspace from '@deepseek-ai/dsh-client-ui-workspace/client'
import * as UiModelSelection from '@deepseek-ai/dsh-client-ui-model-selection/client'
// Directory picking: native|browse occupy the same `single` directoryFlow holes of
// ui-workspace, so exactly ONE surface may register per ctx. Chamber pins `browse` for
// EVERY managed host (the host-side picker-auto resolves browse for SSH-launched local
// hosts and for headless remotes alike), so the hero and sidebar share the same in-app
// directory browser and the OS chooser is never surfaced.
import * as UiDirectoryPickerBrowse from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client'

// ── Deferred families: dynamic-import chunks, fetched in parallel and registered after
// ── arrival. Each roster row pairs the boot-graph ID with its chunk loader — a
// ── destructured import list could not name the chunk that failed.

/**
 * The deferred roster: `[boot-graph id, chunk loader]` in registration order. The id set
 * MUST equal `DEFERRED_EXTRA_ROW_IDS` (required-extra-rows.ts; asserted in apply) and
 * every id is composite-covered, so this entry is the only loader of these bundles.
 */
const DEFERRED_ROWS: ReadonlyArray<readonly [id: string, load: () => Promise<unknown>]> = [
  // Feature families: nothing first-screen injects their services.
  ['@deepseek-ai/dsh-client-ui-jobs', () => import('@deepseek-ai/dsh-client-ui-jobs/client')],
  ['@deepseek-ai/dsh-client-ui-goal', () => import('@deepseek-ai/dsh-client-ui-goal/client')],
  ['@deepseek-ai/dsh-client-ui-skill', () => import('@deepseek-ai/dsh-client-ui-skill/client')],
  // ui-tool declares the `tool.call.toolview` slot that extra host-graph rows inject
  // into: its chunk failing is the silent slot gap the failure diagnostic below names.
  ['@deepseek-ai/dsh-client-ui-tool', () => import('@deepseek-ai/dsh-client-ui-tool/client')],
  ['@deepseek-ai/dsh-client-ui-trajectory', () => import('@deepseek-ai/dsh-client-ui-trajectory/client')],
  ['@deepseek-ai/dsh-client-ui-workflow-run', () => import('@deepseek-ai/dsh-client-ui-workflow-run/client')],
  ['@deepseek-ai/dsh-client-ui-deliverables', () => import('@deepseek-ai/dsh-client-ui-deliverables/client')],
  ['@deepseek-ai/dsh-client-ui-subagent', () => import('@deepseek-ai/dsh-client-ui-subagent/client')],
  // Covered so its vendor patch can carry the per-entry base path; the host half keeps the route.
  ['@deepseek-ai/dsh-session-log-export', () => import('@deepseek-ai/dsh-session-log-export/client')],
  ['@deepseek-ai/dsh-client-ui-message-feedback', () => import('@deepseek-ai/dsh-client-ui-message-feedback/client')],
  ['@deepseek-ai/dsh-client-ui-plan', () => import('@deepseek-ai/dsh-client-ui-plan/client')],
  ['@deepseek-ai/dsh-client-ui-user-questions', () => import('@deepseek-ai/dsh-client-ui-user-questions/client')],
  ['@deepseek-ai/dsh-client-ui-agent-preset', () => import('@deepseek-ai/dsh-client-ui-agent-preset/client')],
  ['@deepseek-ai/dsh-client-ui-permission-presets', () => import('@deepseek-ai/dsh-client-ui-permission-presets/client')],
  // attachment / reference: both inject first-screen services only, so the deferred split
  // stays safe; brand-official is gated on the 'official' build profile (defined away in
  // chamber's build) and loads as a no-op.
  ['@deepseek-ai/dsh-client-ui-attachment', () => import('@deepseek-ai/dsh-client-ui-attachment/client')],
  ['@deepseek-ai/dsh-client-ui-brand-official', () => import('@deepseek-ai/dsh-client-ui-brand-official/client')],
  ['@deepseek-ai/dsh-client-ui-reference', () => import('@deepseek-ai/dsh-client-ui-reference/client')],
  // Settings cluster: official ui-settings stays first-screen, but its SECTION families
  // and the chamber settings shell/connections are only reachable after the first screen.
  // Every member injects first-screen services only; no first-screen family root-injects
  // anything they provide. The cluster is not all-or-nothing: each row loads in isolation,
  // so one failed chunk costs exactly its own family, and the failed id set is reported by
  // name while the boot keeps settling (diagnostic, not a boot gate; recovery = shell
  // re-boot). Until the cluster lands the selected source shows the panel's own
  // "starting this instance's frontend" state — the panel loads no content of its own.
  ['@deepseek-ai/dsh-client-ui-settings-general', () => import('@deepseek-ai/dsh-client-ui-settings-general/client')],
  ['@deepseek-ai/dsh-client-ui-settings-models', () => import('@deepseek-ai/dsh-client-ui-settings-models/client')],
  ['@deepseek-ai/dsh-client-ui-settings-plugins', () => import('@deepseek-ai/dsh-client-ui-settings-plugins/client')],
  ['@deepseek-ai/dsh-client-ui-settings-plugin-inventory', () => import('@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client')],
  ['@dsh-chamber/dsh-chamber-client-ui-settings-connections', () => import('@dsh-chamber/dsh-chamber-client-ui-settings-connections/client')],
  ['@dsh-chamber/dsh-chamber-client-ui-settings-bridge', () => import('@dsh-chamber/dsh-chamber-client-ui-settings-bridge/client')],
]

/**
 * Mount-time decorators, keyed by registered id: a vendor plugin whose body writes a
 * DOCUMENT-global fact gets a hook running immediately after its own apply() — same
 * fiber, same synchronous task. Covers both mount paths, so moving a decorated id
 * cannot silently drop its hook.
 * PRECONDITION: a decorated apply must be SYNCHRONOUS. Decorating inside the mount
 * helpers (not at call sites) keeps the call sites passing the imported namespace,
 * which the roster audit resolves through. The one entry, the official locale plugin,
 * writes the DOCUMENT-global <html lang> with no teardown and no active-source gate;
 * locale-ownership.ts re-points it at the ownership rule.
 */
const MOUNT_DECORATORS: Readonly<Record<string, (plugin: object) => object>> = {
  '@deepseek-ai/dsh-client-locale': withLocaleOwnership,
}
const decorateMount = (id: string, plugin: object): object => MOUNT_DECORATORS[id]?.(plugin) ?? plugin

/**
 * Register the non-first-screen ui-* families once their chunks arrive. Fire-and-forget
 * from apply (never awaited), so the entry and the boot settle without waiting.
 *
 * The cluster loads PER ROW: one Promise.all over every chunk would let a single
 * rejection cancel the whole continuation and lose the failing id. Each row keeps its
 * own verdict, surviving families still register, and the failed id set travels through
 * deferredRegistrationFailureMessage to the shell's post-settle degrade seam (the same
 * seam the required-service probe uses), which is what the App renders and self-heals.
 */
async function registerDeferred(
  ctx: Context,
  degradedSeam: (fact: ShellDegradedFact) => void,
  registered: RegisteredPluginInject[],
  probeRearm: ProbeRearmSlot,
): Promise<void> {
  // Chunks fetch in parallel (one round of requests), but each row keeps its own verdict.
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
    // Mount with the ROW ID as the fiber name: an unnamed fiber inherits its nearest
    // named ancestor, which would report the whole cluster as `@dsh-chamber/app` in cordis
    // error text and crash attribution. The chunk is typed `Promise<unknown>` (the id
    // roster is the contract), so the object-plugin shape is asserted here.
    const loaded = outcome.plugin as { apply: (ctx: Context, config?: never) => void; inject?: string[] }
    // Mount decorators apply here too: a decorated id must not lose its hook here.
    ctx.plugin(decorateMount(outcome.id, { ...loaded, name: outcome.id }))
    // The row's OWN exported inject face enters the probe roster, recorded exactly as the
    // first-screen `register` helper records one. Two disciplines differ here:
    //  - normalization is EAGER, so a rejected face fails HERE rather than inside the
    //    probe's timer (an uncaught throw there would escape the diagnostic);
    //  - it is guarded PER ROW: an unreadable face loses that row's probe coverage
    //    (loudly) and never the mounting of the rows after it.
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
  // One re-armed probe pass: the probe stops on a clean verdict, so a roster that grew
  // after that verdict needs an explicit nudge. Only when a row actually mounted; the
  // slot is empty where the probe never installed, hence the optional call.
  if (mounted > 0) probeRearm.reArm?.()
  if (failed.length === 0) return
  const message = deferredRegistrationFailureMessage(failed, ctx.chamberInstanceId)
  console.error(
    message,
    settled.filter(outcome => !outcome.ok).map(outcome => outcome.error),
  )
  // The shell accepts a degrade fact only once the boot SETTLED; a deferred failure is
  // detected after apply returned, so the report rides a macrotask (the settle has won by
  // then), and a report a torn-down instance never sees is a no-op rather than a leak.
  // Own kind: this shares the seam with the required-service probe but not its meaning —
  // that one names unprovided services, this one names row ids whose chunk never registered.
  setTimeout(() => degradedSeam({
    kind: 'deferred-registration-failed',
    message,
    failedIds: [...failed],
  }), 0)
}

/** The boot-graph row id this bundle registers under (must match dist/manifest.json). */
export const CHAMBER_APP_ID = '@dsh-chamber/app'

/** No inject: the composite provides every service the dsh shell needs. */
export const inject: string[] = []

/**
 * Union-table lockstep guard: COVERED_FACTORIES must match CHAMBER_COVERED_FACTORY_IDS
 * exactly and every id must be covered — a non-covered id would execute its official
 * bundle as an extra row and double-register against this composite's factory.
 *
 * Runs inside apply() so a drift fails THIS entry loudly; a top-level throw would be
 * swallowed by the prefetch tier and surface as a misleading extra-bundle import error.
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
 * Deferred-roster lockstep guard: `DEFERRED_ROWS` and `DEFERRED_EXTRA_ROW_IDS` (the list
 * host-graph.ts matches a third-party row's `external` requests against) must name exactly
 * the same ids — otherwise the `external` diagnostic goes blind to a deferred family.
 * Runs inside apply() so a drift fails this entry loudly.
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
 * The shell's post-settle degrade seam, resolved once per entry: on a fact the App
 * re-boots the instance at the next ready transition and renders it as copy. Absent in
 * other hosts; a throwing seam must never break the caller, so the reporter wraps it.
 *
 * The fact travels WHOLE (kind + structured fields) — the frame must never parse the
 * diagnostic message. This module never writes the fact itself: the seam is the only
 * writer, so the shell's boot-generation fence applies to every producer, including the
 * probe's RETRACTIONS ({@link ShellDegradedClear}) when its missing set empties.
 */
function createDegradedSeam(ctx: Context): (report: ShellDegradedReport) => void {
  // Shell-provided seam; absent in other hosts.
  const reportBootDegraded = (ctx as { chamberReportBootDegraded?: (report: ShellDegradedReport) => void })
    .chamberReportBootDegraded
  return (report: ShellDegradedReport): void => {
    try { reportBootDegraded?.(report) } catch (error) {
      console.error('[chamber-entry] failed to report a post-settle degrade fact:', error)
    }
  }
}

/**
 * Assemble the complete dsh client plugin tree on the per-instance ctx. Registration
 * order carries no activation semantics (fibers wait on inject sets). First-screen
 * families register synchronously; deferred families are kicked off, never awaited.
 */
export function apply(ctx: Context): void {
  // Lockstep guards first: a drift must fail this entry before any plugin registers.
  assertCoveredFactoryLockstep()
  assertDeferredRosterLockstep()
  // shell.ts installs immutable per-entry identity and base-path facts through
  // configureContext before any plugin can materialize; never fall back to page-global
  // knobs, because a timed-out boot may settle while a later instance is booting. The
  // shell also installs the PAGE-level machine catalog (same reader in every entry — the
  // machine's installed apps are not a per-source fact).
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
  // Both chamber base-path forks read `chamberBasePath` from THIS context at apply time;
  // it is bound per entry through configureContext, never through config or a page-global knob.
  // Each first-screen registration RECORDS its namespace's inject face, and the probe below
  // probes exactly that derived union (upstream reads the same declaration off `fiber.inject`);
  // the recorded id is the mount identity. The deferred cluster extends the same roster as
  // chunks mount and re-arms one pass.
  // Deferred-only members (no first-screen declaration) — 16, each provided by first-screen
  // composite plugins only, never by another deferred family: `jobs`, `modules`, `remote.goals`,
  // `remote.skills`, `remote.messageFeedback`, `remote.sessionFeedback`, `remote.agentPresets`,
  // `remote.credentials`, `remote.llm`, `remote.pluginInventory`, `remote.permissionPresets`,
  // `remote.fileReferences`, `remote.sessionReferenceResolver`, `resources`, `sidebarRightTabs`,
  // `settingsSchema`. Without the re-arm such a member would pend with no diagnostic, the
  // silent gap this probe closes.
  const registered: RegisteredPluginInject[] = []
  /** Probe re-arm hand-off; filled when the probe effect installs. */
  const probeRearm: ProbeRearmSlot = {}
  const register = (id: string, plugin: object): void => {
    // The mounted fiber's normalized inject map is a WITNESS only, never the roster: the
    // roster is derived from the namespace's exported `inject` face. Cordis resolves the
    // fiber map from the same expression, so they diverge only for an inject object using
    // cordis's `symbols.checkProto` marker (members on the prototype, invisible to
    // Object.keys) — the throw below catches that case. A namespace that simply stops
    // exporting `inject` yields an empty roster AND an empty witness (no throw), so that
    // drift is only visible to the audited table test. A missing inject map yields no
    // witness and no false alarm.
    const fiber = ctx.plugin(decorateMount(id, plugin)) as unknown as { inject?: unknown } | undefined
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
  // Provider group: the store is a platform word (covered factory, no plugin); the api
  // controllers provide ctx.sessions / ctx.workspaces; ui-session/ui-chat/ui-approval are
  // the conversation families. ApiRemotes' async apply mounts the generated Remote
  // namespaces the controllers require — fibers wait on inject sets, so order is free.
  register('@deepseek-ai/dsh-api-session-controller', ApiSessionController)
  register('@deepseek-ai/dsh-api-workspace-controller', ApiWorkspaceController)
  // Covers the host-graph row: conversation + api-session-controller root-inject `fileUpload`.
  register('@deepseek-ai/dsh-client-file-upload', FileUpload)
  register('@deepseek-ai/dsh-client-locale', Locale)
  // Provides ctx.shortcuts for the covered layout/workspace families; the
  // default class carries the static inject face the roster reads.
  register('@deepseek-ai/dsh-client-shortcuts', ShortcutsService)
  register('@deepseek-ai/dsh-client-ui-theme', UiTheme)
  register('@dsh-chamber/dsh-chamber-client-ui-layout', UiLayout)
  register('@dsh-chamber/dsh-chamber-client-ui-sidebar', UiSidebar)
  register('@dsh-chamber/dsh-chamber-client-ui-git', UiGit)
  register('@dsh-chamber/dsh-chamber-client-ui-open-in', UiOpenIn)
  register('@deepseek-ai/dsh-client-ui-settings', UiSettings)
  register('@deepseek-ai/dsh-client-ui-conversation', UiConversation)
  // First-screen: model-selection root-injects `commandUi`, commands root-injects `inputTriggers`.
  register('@deepseek-ai/dsh-client-ui-commands', UiCommands)
  register('@deepseek-ai/dsh-client-ui-input-trigger', UiInputTrigger)
  register('@deepseek-ai/dsh-client-ui-workspace', UiWorkspace)
  register('@deepseek-ai/dsh-client-ui-model-selection', UiModelSelection)
  // Conversation families — first-screen (see the import comments).
  register('@deepseek-ai/dsh-client-ui-session', UiSession)
  register('@deepseek-ai/dsh-client-ui-chat', UiChat)
  register('@deepseek-ai/dsh-client-ui-approval', UiApproval)
  // Directory-picker `browse` face for every instance; the host pins the same capability.
  register('@deepseek-ai/dsh-client-ui-directory-picker-browse', UiDirectoryPickerBrowse)
  // Deferred families: fetched in the background and registered once loaded, never
  // awaited. The seam is shared with the required-service probe below, so both
  // post-settle verdicts land on the one channel the App self-heals from.
  const degradedSeam = createDegradedSeam(ctx)
  void registerDeferred(ctx, degradedSeam, registered, probeRearm).catch((error) => {
    console.error('[chamber-entry] deferred plugin registration failed:', error)
  })

  assertRequiredExtraRowServices(ctx, degradedSeam, registered, probeRearm)
}

/**
 * The probe's re-arm hand-off: `apply` owns the slot, the probe effect fills it, and
 * `registerDeferred` calls it after extending the roster. Empty before install and after
 * teardown, so the optional call is the whole contract.
 */
interface ProbeRearmSlot {
  /** Run one more probe pass now; absent before install / after teardown. */
  reArm?: () => void
}

/**
 * The post-settle required-service probe (roster DERIVED from the mounted plugins'
 * `inject` faces — what upstream reads in its post-settle sweep; union/missing/message
 * rules live in required-extra-rows.ts). It catches a composite-registered first-screen
 * family whose service comes only from an extra row that never applied: the fiber stays
 * PENDING while boot reports success.
 * Diagnostic, not a boot gate (a deployment may legitimately run without those rows),
 * and the ctx-owned timer stops on teardown. The deadline is PER ROSTER MEMBER (its own
 * first sighting starts a 5 s window); a verdict is not final — the probe re-checks
 * until REQUIRED_SERVICE_PROBE_RECHECK_WINDOW_MS past the newest deadline and RETRACTS
 * when the missing set empties.
 */
function assertRequiredExtraRowServices(
  ctx: Context,
  degradedSeam: (report: ShellDegradedReport) => void,
  registered: readonly RegisteredPluginInject[],
  probeRearm: ProbeRearmSlot,
): void {
  // Deadline anchored to each member's OWN arrival, so re-armed members get full grace.
  const windows = new RequiredServiceProbeWindows()
  const isProvided = (name: string): boolean =>
    (ctx as { get: (key: string) => unknown }).get(name) !== undefined
  const instanceId = (ctx as { chamberInstanceId?: string }).chamberInstanceId
  ctx.effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    /** Last verdict's missing set: a re-armed pass must not re-report it verbatim. */
    let reportedServices: string | undefined
    /** Exact fact signature of the last verdict; the shell clears only kind+payload matches. */
    let reportedFactSignature: string | undefined
    const schedule = (delayMs: number): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(probe, delayMs)
    }
    const probe = (): void => {
      timer = undefined
      const roster = injectedServices(registered)
      // One monotonic clock for arrivals and deadlines; a wall-clock jump would misjudge.
      const now = monotonicNowMs()
      windows.note(roster, now)
      const missing = missingInjectedServices(registered, isProvided)
      if (missing.length === 0) {
        // Revocation: the provider materialized after the verdict — retract the fact, or
        // the banner claims a gap that no longer exists and the App burns its re-mount.
        if (reportedFactSignature !== undefined) {
          degradedSeam({
            cleared: true,
            kind: 'required-services-missing',
            signature: reportedFactSignature,
          })
          reportedFactSignature = undefined
          reportedServices = undefined
        }
        return
      }
      // No verdict while ANY probed member is still in grace, or a late add gets judged early.
      if (windows.withinGrace(roster, now).length > 0) {
        schedule(REQUIRED_SERVICE_PROBE_INTERVAL_MS)
        return
      }
      const signature = missing.map(entry => entry.service).join('\u0000')
      if (signature !== reportedServices) {
        reportedServices = signature
        const message = requiredServiceProbeMessage(missing, instanceId)
        console.error(message)
        // Report through the shell seam: only here do we KNOW the graph arrived yet the
        // row did not apply, so the App can re-boot the instance without a manual reload.
        // The fact is structured (service names + injectors) so the frame's copy names
        // what is missing instead of parsing the diagnostic; the signature feeds retraction.
        const fact: ShellDegradedFact = { kind: 'required-services-missing', message, ...missingServiceFact(missing) }
        degradedSeam(fact)
        reportedFactSignature = bootGapSignature(fact)
      }
      // Bounded re-check: keep polling past the newest deadline so a late provider clears.
      const recheckUntil = windows.recheckUntilMs()
      if (recheckUntil !== undefined && now < recheckUntil) schedule(REQUIRED_SERVICE_PROBE_INTERVAL_MS)
    }
    // Re-arm: one extra pass over the roster the deferred cluster extended. New members get
    // their own full grace; pre-cluster members keep elapsed windows, so no verdict is
    // delayed. An unchanged set reports nothing; a new missing member gets its own report.
    probeRearm.reArm = () => { schedule(0) }
    schedule(0)
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
 * Wrap a bundled first-screen namespace as a module-table factory: every materialization
 * returns the SAME object the composite mounts, so the require edge and the ctx services
 * share one instance. `require` is unused — the namespace is fully bundled.
 */
const coveredFactory = (exports: unknown): ClientPluginHandoff['factory'] => () => exports as Record<string, unknown>

/**
 * Module-table factories for the composite-covered packages: one per statically-imported
 * first-screen family, registered at bundle execution so every synchronous require an extra
 * host-graph bundle emits resolves before any loader entry materializes.
 * Deliberately NOT included: the deferred families (their chunks load after the boot
 * settles; the purity gate forbids value imports of ui-* packages anyway) and page-own
 * covered ids (`dsh-client-modules`, the official sidebar/layout rows the chamber
 * replaces, `dsh-client-ui-renderer` — adopted by the shell kernel).
 * Maintenance: every id MUST stay in `CHAMBER_COVERED_IDS` and in lockstep with the
 * first-screen import list, `CHAMBER_COVERED_FACTORY_IDS` and `chamber-covered.ts`.
 * Accepted boundary: the bundle is NOT re-execution-safe (a dev HMR reload re-runs this
 * loop, hits the duplicate-factory sink and fails loud); the pre-materialization guarantee
 * assumes the prefetch succeeded.
 */
const COVERED_FACTORIES: ReadonlyArray<readonly [id: string, factory: ClientPluginHandoff['factory']]> = [
  ['@deepseek-ai/dsh-client-connection', coveredFactory(ConnectionPlugin)],
  ['@deepseek-ai/dsh-typert-registry', coveredFactory(TypertRegistry)],
  ['@deepseek-ai/dsh-api-gateway', coveredFactory(ApiGateway)],
  ['@deepseek-ai/dsh-api-remotes', coveredFactory(ApiRemotes)],
  // provider group: the seed provides the store word too; this factory is the
  // composite-side fallback for the same require edge (seed wins). Controllers and
  // conversation families are first-screen plugins mirrored by their factories.
  ['@deepseek-ai/dsh-client-store', coveredFactory(Store)],
  // The primitives platform word (seed does not answer it); factory only.
  ['@deepseek-ai/dsh-client-ui-primitives', coveredFactory(UiPrimitives)],
  // The docking-kit word: factory only, never ctx.plugin'd.
  ['@deepseek-ai/dsh-client-ui-dockkit', coveredFactory(UiDockkit)],
  ['@deepseek-ai/dsh-api-session-controller', coveredFactory(ApiSessionController)],
  ['@deepseek-ai/dsh-api-workspace-controller', coveredFactory(ApiWorkspaceController)],
  ['@deepseek-ai/dsh-client-locale', coveredFactory(Locale)],
  // The default class IS the official row's module.exports (tsdown emits
  // `module.exports = ShortcutsService`), so the require edge gets that identity
  // rather than a namespace wrapper.
  ['@deepseek-ai/dsh-client-shortcuts', coveredFactory(ShortcutsService)],
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

// Union-table completion: register the covered factories. Only the map↔list lockstep is
// unchecked here (enforced in apply), and a drift fails THIS entry loudly.
for (const [id, covered] of COVERED_FACTORIES) {
  win.__ModuleLoader__.load({ id, factory: covered })
}
