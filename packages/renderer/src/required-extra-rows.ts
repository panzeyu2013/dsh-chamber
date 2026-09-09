/**
 * Required host-graph extra-row services (alpha.2).
 *
 * The chamber composite registers the first-screen plugins directly, so their
 * fibers are NOT part of the boot kernel's loader sweep. Exactly ONE service
 * they require is provided only by a non-covered host-graph row (2026-09 round-3
 * audit over every root `inject` of every composite plugin):
 *
 *  - `ui-chat` injects `sidebarRight` -> the `ui-sidebar-right` row provides it
 *    (`ctx.reflect.provide('sidebarRight', …)`).
 *
 * When that row never applies, the `ui-chat` fiber stays PENDING, its whole
 * `apply` is skipped, and the conversation view stays unregistered while the
 * boot still reports success — this module owns the decision and the message,
 * and `chamber-entry.ts` owns the timer (tied to the ctx lifecycle).
 *
 * History (keep the reasoning; the list must stay minimal and true):
 *  - `fileUpload` was listed in round 2 because `ui-conversation`'s and
 *    `api-session-controller`'s root injects require it. Round 3 COVERED the
 *    upload client in the composite (its vendor bundle needs the registered
 *    base-path patch), so the composite now provides it — the entry was removed.
 *  - `resources` was listed as if a first-screen plugin injected it; it is a
 *    rendering-time `useResource` seat consumed only by non-covered rows, and it
 *    can never go missing without `sidebarRight` also missing (the row that
 *    injects `resources` is the one that provides `sidebarRight`). Removed as a
 *    redundant, misleading entry rather than kept for a seat the composite does
 *    not consume.
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
  const where = instanceId === undefined ? '' : ` (instance ${instanceId})`
  return `[chamber-entry]${where} required extra-row service(s) missing after ${REQUIRED_SERVICE_PROBE_DEADLINE_MS}ms: `
    + `${missing.join(', ')} — the ui-sidebar-right host-graph row did not apply; `
    + 'the conversation view may stay unregistered (ui-chat pends on sidebarRight)'
}
