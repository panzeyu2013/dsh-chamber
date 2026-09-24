/**
 * Extra-row facts the chamber composite entry must reason about: which services
 * the composite's own plugins require — the
 * first-screen families from the start, the deferred families as their chunks
 * mount — and which covered ids the composite
 * registers only AFTER the boot settled. Both facts are needed by code that
 * cannot import chamber-entry.ts (its imports resolve to source, so neither the
 * node tests nor host-graph.ts may pull it in) — the entry reconciles its own
 * roster against {@link DEFERRED_EXTRA_ROW_IDS} at apply time instead.
 *
 * ## 1. The required-service probe roster
 *
 * Upstream derives this fact PER FIBER once the boot settled: `assertEntriesActive`
 * (vendor `packages/client/web/src/boot.ts:138-158`) walks
 * `ctx.loader.entries()` and, for every entry whose fiber is still pending,
 * reports `Object.keys(entry.fiber.inject).filter(service => ctx.get(service)
 * === undefined)`. The chamber's own copy of that sweep is
 * `packages/dsh-client-web/src/boot.ts` (plus the version-tolerance rules in
 * its `boot-tolerance.ts`).
 *
 * The PROBE still has to exist here: the composite mounts its first-screen
 * plugins with a direct `ctx.plugin()` call, so their fibers are children of
 * the entry fiber, NOT loader entries — upstream's sweep cannot see them, and a
 * pending child is invisible to a boot that reports success. An INVENTED roster
 * does not exist: `chamber-entry.ts` derives the probed service
 * set from the `inject` face of the very namespaces it registered (the same
 * declaration upstream reads off the fiber), and this module owns the pure
 * union / missing-set / message rules:
 *
 *  - {@link registeredInjectMembers} normalizes one namespace's exported
 *    `inject` (array form `['a','b']`, or cordis's name→config map form — its
 *    KEYS are the services, exactly what `Object.keys(fiber.inject)` yields);
 *  - {@link injectedServices} is the union in registration order — the probed
 *    roster itself, and the order authority {@link missingInjectedServices}
 *    walks (one definition of "the roster", used by production, not a test-only
 *    helper);
 *  - {@link missingInjectedServices} probes that union through
 *    `ctx.get(name) === undefined` and keeps, per missing service, WHICH
 *    registered plugins inject it;
 *  - {@link requiredServiceProbeMessage} names both.
 *
 * The roster is not first-screen-only.
 * Excluding the deferred cluster on the strength of the split
 * invariant alone would leave 11 members probed by NOTHING — `remote.goals`,
 * `remote.skills`, `remote.messageFeedback`, `remote.sessionFeedback`,
 * `remote.agentPresets`, `remote.credentials`, `remote.llm`,
 * `remote.pluginInventory`, `remote.fileReferences`,
 * `remote.sessionReferenceResolver` and `settingsSchema` appear in deferred
 * `inject` faces but in no first-screen one. Each of them is provided by a
 * FIRST-SCREEN COMPOSITE plugin (the api-gateway/api-remotes generated-remote
 * mounts, and ui-settings for `settingsSchema`), which is why the deferred split
 * stays safe — but "the provider is first-screen" is exactly the assumption a
 * probe exists to check, so `chamber-entry.ts` feeds every deferred row's
 * face into the same roster as it mounts and re-arms one probe pass. The
 * per-id faces this derivation is fed from are CI-pinned against the sources
 * (`required-extra-rows.test.ts`): a namespace that stops exporting its
 * declaration is a visible test failure, never a silently smaller roster.
 *
 * What that derivation yields in the pinned tree (audit over every
 * root `inject` of every composite first-screen namespace) is ONE service whose
 * only provider is a non-covered host-graph row — plus the kernel-adopted
 * renderer's `slots`, which the shell always materializes. The deferred members
 * the roster also carries do not widen that risk set: every one of
 * them is provided by a COMPOSITE first-screen plugin, so no non-covered row can
 * be their only provider:
 *
 *  - `sidebarRight` (injected by `ui-chat`, vendor
 *    `ui-chat/src/client/apply.ts:47-50`) is provided ONLY by the non-covered
 *    `ui-sidebar-right` row — `ctx.reflect.provide('sidebarRight', …)`, vendor
 *    `ui-sidebar-right/src/client/index.ts:109`. When that row never applies,
 *    the `ui-chat` fiber stays PENDING, its whole `apply` is skipped, and the
 *    conversation view stays unregistered while the boot still reports success.
 *
 *
 * ## 2. The deferred-covered roster
 *
 * {@link DEFERRED_EXTRA_ROW_IDS} lists the ids `chamber-entry.ts`
 * registerDeferred registers. They are a third kind of row: COVERED (their
 * host-graph rows are filtered out of the merge, so the composite's copy is the
 * only one that may load) but FACTORY-LESS at boot (the composite's
 * module-table factory registration covers the first-screen families only;
 * these chunks evaluate after the boot settled). Two consequences are owned
 * here, both reported through the shared line shape
 * ({@link chamberEntryDiagnosticMessage}):
 *
 *  - a deferred chunk that fails (`deferredRegistrationFailureMessage`): the
 *    family's slots/services are never declared this boot, so a host-graph row
 *    injecting into one of its slots (e.g. the extra row `ui-cordis` into
 *    `tool.call.toolview`, declared by the deferred `ui-tool` — vendor
 *    `ui-tool/src/client/apply.ts:38`, `ui-cordis/src/client/index.ts:119-143`)
 *    never activates: a SILENT gap unless the id set is named;
 *  - an extra row whose `external` requests such an id (`host-graph.ts`
 *    `findDeferredExternalDependencies`): the synchronous `require` at
 *    materialization can never be answered (the kernel resolves it through the
 *    module table's factory branch, upstream `system.ts` `makeRequire`).
 */

import { monotonicNow } from './monotonic-now.ts'

/**
 * One plugin the composite registered with `ctx.plugin()`, paired with the id
 * it was registered under. `inject` is that plugin namespace's exported cordis
 * declaration VERBATIM (the composite never rewrites it).
 */
export interface RegisteredPluginInject {
  /** The id the composite mounted the plugin under (package / boot-graph id). */
  id: string
  /** The namespace's exported `inject` face, as imported. */
  inject: unknown
}

/** One probed service that is still unprovided, with its registered injectors. */
export interface MissingRequiredService {
  /** The service name the fiber waits on. */
  service: string
  /** Registered plugin ids whose `inject` face names it (registration order). */
  injectedBy: string[]
}

/**
 * Normalize one namespace's exported cordis `inject` declaration into its
 * service names — the same set cordis hands to the fiber and upstream reads as
 * `Object.keys(entry.fiber.inject)`.
 *
 * Two legal shapes (vendor cordis `registry.ts` `Inject.resolve`): an ARRAY of
 * service names, or a name→config MAP whose KEYS are the services (the object
 * form's values configure interception, they are not extra members). A
 * namespace that exports anything else cannot be trusted as a roster source and
 * fails LOUD here: silently reading `[]` out of it would shrink the probed set
 * without a trace, which is exactly the blind spot this roster exists to close.
 * @param id - the registered plugin id (diagnostic subject).
 * @param inject - the namespace's exported `inject` value.
 * @returns the declared service names (empty when the plugin injects nothing).
 */
export function registeredInjectMembers(id: string, inject: unknown): string[] {
  if (inject === undefined || inject === null) return []
  if (Array.isArray(inject)) {
    if (inject.some(member => typeof member !== 'string')) {
      throw new Error(`chamber-entry: plugin ${id} exports a non-string member in its inject array`)
    }
    return [...(inject as string[])]
  }
  if (typeof inject === 'object') return Object.keys(inject as Record<string, unknown>)
  throw new Error(`chamber-entry: plugin ${id} exports a non-array/non-map inject face (${typeof inject})`)
}

/**
 * The union of the registered plugins' inject members, in registration order
 * (first occurrence wins), ignoring the plugins that inject nothing. This IS
 * the probed roster: it is derived, never maintained — and it is the roster's
 * ORDER authority, consumed by {@link missingInjectedServices} (the union is
 * production code, not a test-only seam).
 * @param plugins - the composite's registered plugins, in registration order.
 * @returns the service names to probe, deduped.
 */
export function injectedServices(plugins: readonly RegisteredPluginInject[]): string[] {
  const out: string[] = []
  for (const plugin of plugins) {
    for (const service of registeredInjectMembers(plugin.id, plugin.inject)) {
      if (!out.includes(service)) out.push(service)
    }
  }
  return out
}

/**
 * Which of the registered plugins' injected services are still unprovided,
 * each with the registered plugins that inject it (upstream's
 * `Object.keys(entry.fiber.inject).filter(service => ctx.get(service) ===
 * undefined)`, lifted from the per-fiber sweep to the composite's own roster).
 *
 * The service order — and therefore the verdict's readability — is
 * {@link injectedServices}: one union rule for the whole module, so a change to
 * "what the roster is" can never apply to the probe but miss the diagnostic.
 * @param plugins - the composite's registered plugins, in registration order.
 * @param isProvided - membership test over the live ctx service store.
 * @returns one entry per missing service, in roster order (empty when complete).
 */
export function missingInjectedServices(
  plugins: readonly RegisteredPluginInject[],
  isProvided: (name: string) => boolean,
): MissingRequiredService[] {
  const injectors = new Map<string, string[]>()
  for (const plugin of plugins) {
    for (const service of registeredInjectMembers(plugin.id, plugin.inject)) {
      const known = injectors.get(service)
      if (known === undefined) injectors.set(service, [plugin.id])
      else if (!known.includes(plugin.id)) known.push(plugin.id)
    }
  }
  const out: MissingRequiredService[] = []
  for (const service of injectedServices(plugins)) {
    if (isProvided(service)) continue
    out.push({ service, injectedBy: injectors.get(service) ?? [] })
  }
  return out
}

/**
 * Probe deadline — PER ROSTER MEMBER, not per boot: the window
 * starts when the probe first sees a service in the roster, so a member the
 * deferred cluster's re-arm adds at t=30s gets the same 5 s as a first-screen
 * member instead of being judged instantly against the boot's t=0 start. The
 * extra rows load after the composite and their applies settle a few microtasks
 * later; 5 s is generous for a cold chunk fetch.
 */
export const REQUIRED_SERVICE_PROBE_DEADLINE_MS = 5000

/** Probe re-check interval (both the grace poll and the bounded re-check). */
export const REQUIRED_SERVICE_PROBE_INTERVAL_MS = 250

/**
 * How long the probe keeps re-checking AFTER every member's deadline elapsed:
 * a provider that materializes too late for the verdict must not
 * leave a permanent false banner, because the probe stops at the verdict and
 * the shell has no other revocation path. The probe polls for up to this long past
 * the NEWEST member's deadline and reports a retraction once the missing set
 * empties; the bound keeps a torn-down/abandoned mount from holding a live timer
 * forever. 30 s is one health-window: long enough for a slow async provider
 * chain, short enough to stay inside the shell's own boot/health budget.
 */
export const REQUIRED_SERVICE_PROBE_RECHECK_WINDOW_MS = 30_000

/**
 * The probe's clock: `performance.now()` when the host has one,
 * `Date.now()` otherwise. A wall-clock jump (a Windows sleep/resume plus a
 * w32time correction moves `Date.now()` forward by more than the whole deadline
 * in one step) could otherwise satisfy the deadline on the first pass and judge a
 * service that was ~250 ms from materializing; a monotonic clock cannot jump.
 * The fallback keeps every non-browser host (plain-node tests) on the `Date.now()`
 * semantics.
 * @param source - injectable `performance`-like source (test seam).
 * @returns milliseconds from an arbitrary but non-jumping origin.
 */
export function monotonicNowMs(source?: { now?(): number }): number {
  return monotonicNow(source)
}

/**
 * Per-member grace + revocation bookkeeping of the required-service probe
 * The probe owns one instance per boot; the two pure
 * questions it answers are:
 *
 *  - is any roster member still inside its OWN window ({@link withinGrace})? A
 *    verdict may only be produced once every member had its full window — a
 *    re-armed member must not be judged with ZERO grace against the boot's start;
 *  - until when may the probe keep polling after a verdict
 *    ({@link recheckUntilMs})? The bound is the newest member's deadline plus
 *    {@link REQUIRED_SERVICE_PROBE_RECHECK_WINDOW_MS}, so the revocation path
 *    (late provider → missing set empties → retraction) is time-bounded.
 */
export class RequiredServiceProbeWindows {
  private readonly arrivalsMs = new Map<string, number>()

  /**
   * Record every member now present in the roster. The FIRST sighting is the
   * member's arrival: a re-arm after the roster grew must not restart an
   * already-probed member's window (that would defer a real verdict forever).
   */
  note(members: readonly string[], nowMs: number): void {
    for (const member of members) {
      if (!this.arrivalsMs.has(member)) this.arrivalsMs.set(member, nowMs)
    }
  }

  /** The members whose own deadline has not elapsed at `nowMs`. */
  withinGrace(members: readonly string[], nowMs: number): string[] {
    return members.filter(member =>
      nowMs - (this.arrivalsMs.get(member) ?? nowMs) < REQUIRED_SERVICE_PROBE_DEADLINE_MS)
  }

  /**
   * When the probe may stop re-checking: the newest member's deadline plus the
   * bounded revocation window. `undefined` while no member was ever noted.
   */
  recheckUntilMs(): number | undefined {
    let latest: number | undefined
    for (const arrival of this.arrivalsMs.values()) {
      if (latest === undefined || arrival > latest) latest = arrival
    }
    return latest === undefined
      ? undefined
      : latest + REQUIRED_SERVICE_PROBE_DEADLINE_MS + REQUIRED_SERVICE_PROBE_RECHECK_WINDOW_MS
  }
}

/**
 * The ids the composite's deferred cluster registers (chamber-entry.ts
 * `DEFERRED_ROWS`). Invariants (CI-pinned in required-extra-rows.test.ts):
 * unique, every id ∈ `CHAMBER_COVERED_IDS` (loading its host-graph row would
 * double-register), and every id ∉ `CHAMBER_COVERED_FACTORY_IDS` (no boot-time
 * module-table factory — that is what makes a require of it a guaranteed miss).
 * chamber-entry asserts its own roster equals this list exactly at apply time.
 */
export const DEFERRED_EXTRA_ROW_IDS: readonly string[] = [
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-skill',
  // ui-tool declares the `tool.call.toolview` slot the extra row ui-cordis
  // injects into — the concrete silent gap this roster's diagnostics exist for.
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-deliverables',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-session-log-export',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-reference',
  // settings cluster (ui-settings itself stays first-screen).
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@dsh-chamber/dsh-chamber-client-ui-settings-connections',
  '@dsh-chamber/dsh-chamber-client-ui-settings-bridge',
]

/**
 * The one line shape every chamber-entry diagnostic uses (the required-service
 * probe and the deferred-cluster report): `[chamber-entry] (instance <id>)
 * <detail>`, the instance clause omitted when unknown.
 * @param detail - the fact, already spelled out by the caller.
 * @param instanceId - the per-entry instance id, when known.
 * @returns the single operator-facing line.
 */
export function chamberEntryDiagnosticMessage(detail: string, instanceId?: string): string {
  const where = instanceId === undefined ? '' : ` (instance ${instanceId})`
  return `[chamber-entry]${where} ${detail}`
}

/**
 * The STRUCTURED face of one probe verdict (design 05 §4): the missing
 * service names and the registered plugins that inject them.
 *
 * The producer stops flattening its fact into a sentence here. The user-facing
 * copy is the frame's (`renderer/src/locales.ts`, keyed by the fact kind), and
 * the frame may name WHICH service is missing — parsing it back out of the
 * diagnostic line would be brittle. Order is the roster's
 * ({@link missingInjectedServices}); `injectedBy` is the deduped union in
 * first-seen order, so one plugin injecting two missing services is named once.
 * @param missing - the missing services with their registered injectors.
 * @returns the structured fact fields, never empty for a non-empty input.
 */
export function missingServiceFact(
  missing: readonly MissingRequiredService[],
): { services: string[]; injectedBy: string[] } {
  const services: string[] = []
  const injectedBy: string[] = []
  for (const entry of missing) {
    services.push(entry.service)
    for (const id of entry.injectedBy) {
      if (!injectedBy.includes(id)) injectedBy.push(id)
    }
  }
  return { services, injectedBy }
}

/**
 * The known NON-COVERED host-graph rows that PROVIDE a probed service, keyed by
 * the cordis service name. The roster only knows the INJECTORS —
 * the composite plugins that stay pending on a service — while the actionable
 * half of the fact is usually the missing PROVIDER row, which the single banner
 * slot must be able to name (a bare "缺少 sidebarRight" names the waiter and
 * never the provider).
 *
 * The ids are the host-graph row ids (upstream package names) and are pinned by
 * the roster tests against the vendored declarations. A service with no known
 * provider is named explicitly in the diagnostic rather than silently omitted,
 * so the line never pretends to have localized the provider.
 */
export const KNOWN_SERVICE_PROVIDERS: Readonly<Record<string, string>> = {
  // vendor ui-sidebar-right/src/client/index.ts: ctx.reflect.provide('sidebarRight', …)
  sidebarRight: '@deepseek-ai/dsh-client-ui-sidebar-right',
  // the extra chain the row itself waits on: ui-sidebar-right injects `resources`,
  // whose only provider is the non-covered @deepseek-ai/dsh-client-resources row.
  resources: '@deepseek-ai/dsh-client-resources',
}

/**
 * Build the operator-facing diagnostic for a still-missing set.
 *
 * The line names every missing service WITH
 * the registered plugins that inject it, so the responsible surface is readable
 * straight from the line (upstream's sweep prints the same pairing per pending
 * fiber). It is a post-settle DIAGNOSTIC, never a boot
 * gate — the boot has already settled successfully, and a gateway/mobile shape
 * legitimately omits host-graph rows.
 * @param missing - the missing services with their registered injectors.
 * @param instanceId - the per-entry instance id, when known.
 * @returns one line naming each service, its injectors, the instance and the
 *   consequence.
 */
export function requiredServiceProbeMessage(
  missing: readonly MissingRequiredService[],
  instanceId?: string,
): string {
  const detail = missing
    .map(entry => {
      const provider = KNOWN_SERVICE_PROVIDERS[entry.service]
      const providerText = provider === undefined
        ? 'provider row unknown'
        : `provider row ${provider}`
      return `${entry.service} (injected by ${entry.injectedBy.join(', ')}; ${providerText})`
    })
    .join('; ')
  return chamberEntryDiagnosticMessage(
    `composite service(s) still unprovided after ${REQUIRED_SERVICE_PROBE_DEADLINE_MS}ms: ${detail} — `
    + 'every registered plugin injecting them stays PENDING, so the surfaces those fibers mount never register '
    + '(a missing provider here is an extra host-graph row or a kernel service that never activated); '
    + 'the boot is NOT blocked',
    instanceId,
  )
}

/**
 * Build the operator-facing diagnostic for a deferred chunk/registration
 * failure set. The boot is NOT blocked by these failures (the
 * settled UI simply misses those families); the point of the line is to NAME
 * every id whose slots/services are missing this boot, because a host-graph row
 * injecting into one of those slots never activates and is otherwise a silent
 * gap.
 * @param failed - the deferred ids that failed to load or register, in roster order.
 * @param instanceId - the per-entry instance id, when known.
 * @returns one line naming the ids, the instance, and the consequence.
 */
export function deferredRegistrationFailureMessage(failed: readonly string[], instanceId?: string): string {
  return chamberEntryDiagnosticMessage(
    `deferred plugin registration failed for ${failed.length} id(s): ${failed.join(', ')} — `
    + 'those families registered nothing this boot, so the slots/services they declare stay undeclared '
    + '(host-graph rows injecting into them never activate); the boot is NOT blocked, '
    + 'and a shell re-boot retries the chunks',
    instanceId,
  )
}
