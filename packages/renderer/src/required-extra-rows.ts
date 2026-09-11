/**
 * Extra-row facts the chamber composite entry must reason about (alpha.2 +
 * 2026-12 review fix): which host-graph-only services the composite's own
 * first-screen plugins require, and which covered ids the composite registers
 * only AFTER the boot settled. Both facts are needed by code that cannot import
 * chamber-entry.ts (its imports resolve to source, so neither the node tests nor
 * host-graph.ts may pull it in) — the entry reconciles its own roster against
 * {@link DEFERRED_EXTRA_ROW_IDS} at apply time instead.
 *
 * ## 1. Required extra-row services (the probe roster)
 *
 * The chamber composite registers the first-screen plugins directly, so their
 * fibers are NOT part of the boot kernel's loader sweep. Exactly ONE service
 * they require is provided only by a non-covered host-graph row (2026-09 round-3
 * audit over every root `inject` of every composite plugin):
 *
 *  - `ui-chat` root-injects `sidebarRight` (vendor
 *    `ui-chat/src/client/apply.ts:47-50`), and the ONLY provider is the
 *    non-covered `ui-sidebar-right` row — `ctx.reflect.provide('sidebarRight',
 *    …)`, vendor `ui-sidebar-right/src/client/index.ts:109`.
 *
 * When that row never applies, the `ui-chat` fiber stays PENDING, its whole
 * `apply` is skipped, and the conversation view stays unregistered while the
 * boot still reports success — this module owns the decision and the message,
 * and `chamber-entry.ts` owns the timer (tied to the ctx lifecycle).
 *
 * History (keep the reasoning; the list must stay minimal and true):
 *  - `fileUpload` was listed in round 2 because `ui-conversation`'s and
 *    `api-session-controller`'s root injects require it (a composite-covered
 *    plugin requiring a host-graph-only service — the probe's own case). Round 3
 *    COVERED the upload client in the composite (its vendor bundle needs the
 *    registered base-path patch), so the composite now provides it — the entry
 *    was removed.
 *  - `resources` was listed on a FALSE premise ("the same row provides
 *    `resources` and `sidebarRight`"). The mirror is the other way round:
 *    `ui-sidebar-right` INJECTS `resources` (vendor
 *    `ui-sidebar-right/src/client/index.ts:73-76`: `export const inject =
 *    ['slots', 'layout', 'locale', 'resources']`), and the provider is the
 *    SEPARATE `client-resources` host-graph row (`ctx.reflect.provide(
 *    'resources', resources)`, vendor `dsh-client-resources/src/client/index.ts:34`).
 *    The probe set still needs only `sidebarRight`, but for the right reason: no
 *    COVERED first-screen plugin injects `resources` at its apply root, so a
 *    missing `resources` provider can only ever be observed through the
 *    non-covered `ui-sidebar-right` row pending on it — which is exactly the
 *    `sidebarRight` miss this roster already probes (that row is the provider of
 *    `sidebarRight` in the same `apply`).
 *    MAINTENANCE: if an upstream version ever makes a COVERED first-screen
 *    plugin inject `resources` directly, that miss becomes independently
 *    observable and `'resources'` must be added back here.
 *
 * ## 2. The deferred-covered roster (review F1/F2, 2026-12)
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

/** Services the composite's first-screen plugins require from extra rows. */
export const REQUIRED_EXTRA_ROW_SERVICES = ['sidebarRight'] as const

/**
 * Probe deadline. The extra rows load after the composite and their applies
 * settle a few microtasks later; 5 s is generous for a cold chunk fetch while
 * staying well under the shell's own boot tolerance (30 s health window,
 * 15 s boot deadline).
 */
export const REQUIRED_SERVICE_PROBE_DEADLINE_MS = 5000

/** Probe re-check interval. */
export const REQUIRED_SERVICE_PROBE_INTERVAL_MS = 250

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
  // C4 settings cluster (ui-settings itself stays first-screen).
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
 * Which required services are still unprovided.
 * @param isProvided - membership test over the live ctx service store.
 * @param required - services to check (defaults to {@link REQUIRED_EXTRA_ROW_SERVICES}).
 * @returns the missing service names, in declaration order.
 */
export function missingRequiredServices(
  isProvided: (name: string) => boolean,
  required: readonly string[] = REQUIRED_EXTRA_ROW_SERVICES,
): string[] {
  return required.filter(name => !isProvided(name))
}

/**
 * Build the operator-facing diagnostic for a still-missing set.
 * @param missing - the missing service names.
 * @param instanceId - the per-entry instance id, when known.
 * @returns one line naming the services, the instance, and the consequence.
 */
export function requiredServiceProbeMessage(missing: readonly string[], instanceId?: string): string {
  return chamberEntryDiagnosticMessage(
    `required extra-row service(s) missing after ${REQUIRED_SERVICE_PROBE_DEADLINE_MS}ms: `
    + `${missing.join(', ')} — the ui-sidebar-right host-graph row did not apply; `
    + 'the conversation view may stay unregistered (ui-chat pends on sidebarRight)',
    instanceId,
  )
}

/**
 * Build the operator-facing diagnostic for a deferred chunk/registration
 * failure set (review F2). The boot is NOT blocked by these failures (the
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
