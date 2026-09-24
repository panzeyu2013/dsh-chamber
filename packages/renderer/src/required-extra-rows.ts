/**
 * Extra-row facts the composite entry must reason about: which services its own
 * plugins require (first-screen from the start, deferred as their chunks mount)
 * and which covered ids register only AFTER the boot settled. Needed by code
 * that cannot import chamber-entry.ts (its imports resolve to source), which
 * reconciles its roster against {@link DEFERRED_EXTRA_ROW_IDS} at apply time.
 * The required-service roster is DERIVED from the registered namespaces' `inject`
 * faces and is not first-screen-only: the deferred cluster adds members no
 * first-screen face probes, each provided by a first-screen composite plugin.
 * Its motivating risk is `sidebarRight` — injected by ui-chat but provided ONLY
 * by the non-covered ui-sidebar-right row, so the ui-chat fiber stays PENDING and
 * the conversation view never registers despite a successful boot; a failed
 * deferred chunk or an `external` require onto such an id is the same silent gap.
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
 * Normalize one namespace's exported cordis `inject` declaration into service
 * names, exactly as `Object.keys(entry.fiber.inject)` would: an ARRAY of names,
 * or a name→config MAP whose KEYS are the services (values configure
 * interception, not extra members). Anything else fails LOUD — silently
 * reading `[]` would shrink the probed set without a trace.
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
 * The union of the registered plugins' inject members in registration order
 * (first occurrence wins): this IS the probed roster, derived and never
 * maintained, and it is the module's order authority.
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
 * Which roster services are still unprovided, each with the registered plugins
 * that inject it. Order is {@link injectedServices}' — one union rule for the
 * whole module, so probe and diagnostic can never disagree.
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
 * Probe deadline — PER ROSTER MEMBER, not per boot: a member added by the
 * deferred cluster's re-arm gets its own 5 s instead of being judged against
 * the boot's t=0 start. Extra rows load after the composite; 5 s is generous
 * for a cold chunk fetch.
 */
export const REQUIRED_SERVICE_PROBE_DEADLINE_MS = 5000

/** Probe re-check interval (both the grace poll and the bounded re-check). */
export const REQUIRED_SERVICE_PROBE_INTERVAL_MS = 250

/**
 * How long the probe keeps re-checking AFTER every member's deadline: a provider
 * that materializes too late must not leave a permanent false banner (the shell
 * has no other revocation path), yet a torn-down mount must not hold a timer
 * forever. 30 s ≈ one health window.
 */
export const REQUIRED_SERVICE_PROBE_RECHECK_WINDOW_MS = 30_000

/**
 * The probe's clock: `performance.now()` when available, `Date.now()` otherwise.
 * A wall-clock jump (sleep/resume plus a time correction) could otherwise
 * satisfy a deadline in one step and judge a service ~250 ms from materializing;
 * a monotonic clock cannot jump. The fallback keeps non-browser hosts on
 * `Date.now()` semantics.
 */
export function monotonicNowMs(source?: { now?(): number }): number {
  return monotonicNow(source)
}

/**
 * Per-member grace + revocation bookkeeping, one instance per boot: a verdict may
 * only be produced once every member had its OWN full window (a re-armed member
 * must not be judged with ZERO grace), and polling after the verdict is bounded
 * by the newest member's deadline plus the recheck window (so the revocation path
 * is time-bounded).
 */
export class RequiredServiceProbeWindows {
  private readonly arrivalsMs = new Map<string, number>()

  /** Record every member present in the roster; the FIRST sighting is its
   *  arrival, so a re-arm never restarts an already-probed member's window. */
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

/** When re-checking may stop: newest arrival + deadline + recheck window;
   *  `undefined` while no member was ever noted. */
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
 * `DEFERRED_ROWS`). Invariants: unique, every id ∈ `CHAMBER_COVERED_IDS`
 * (loading its host-graph row would double-register) and ∉
 * `CHAMBER_COVERED_FACTORY_IDS` (no boot-time module-table factory — that is
 * what makes a require of it a guaranteed miss). chamber-entry asserts its own
 * roster equals this list exactly at apply time.
 */
export const DEFERRED_EXTRA_ROW_IDS: readonly string[] = [
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-skill',
  // ui-tool declares the `tool.call.toolview` slot the extra row ui-cordis injects into.
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
 * The one line shape every chamber-entry diagnostic uses:
 * `[chamber-entry] (instance <id>) <detail>`; `detail` is already spelled out
 * by the caller and the instance clause is omitted when unknown.
 */
export function chamberEntryDiagnosticMessage(detail: string, instanceId?: string): string {
  const where = instanceId === undefined ? '' : ` (instance ${instanceId})`
  return `[chamber-entry]${where} ${detail}`
}

/**
 * The STRUCTURED face of one probe verdict: missing service names plus the
 * registered plugins that inject them, so the frame can name WHICH service is
 * missing instead of parsing it back out of the diagnostic line. Order is the
 * roster's; `injectedBy` is deduped in first-seen order.
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
 * cordis service name. The roster knows only the INJECTORS (plugins pending on a
 * service); the actionable half is usually the missing PROVIDER row, which the
 * single banner slot must be able to name. Ids are upstream package names, pinned
 * against the vendored declarations; a service with no known provider is named
 * explicitly rather than silently omitted.
 */
export const KNOWN_SERVICE_PROVIDERS: Readonly<Record<string, string>> = {
  // vendor ui-sidebar-right/src/client/index.ts: ctx.reflect.provide('sidebarRight', …)
  sidebarRight: '@deepseek-ai/dsh-client-ui-sidebar-right',
  // the chain the row waits on: ui-sidebar-right injects `resources`, provided only by @deepseek-ai/dsh-client-resources.
  resources: '@deepseek-ai/dsh-client-resources',
}

/**
 * Build the operator-facing diagnostic for a still-missing set: the line names
 * every missing service WITH its registered injectors (upstream's sweep prints
 * the same pairing per pending fiber). It is a post-settle DIAGNOSTIC, never a
 * boot gate — the boot has already settled successfully, and a gateway/mobile
 * shape legitimately omits host-graph rows.
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
 * Build the operator-facing diagnostic for deferred chunk/registration failures.
 * The boot is NOT blocked (the settled UI simply misses those families); the
 * point is to NAME every id whose slots/services are missing, because a
 * host-graph row injecting into one of them never activates.
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
