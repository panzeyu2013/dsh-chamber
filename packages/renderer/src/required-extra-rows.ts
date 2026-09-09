/**
 * Required host-graph extra-row services (alpha.2).
 *
 * The chamber composite registers several first-screen plugins directly, so
 * their fibers are NOT part of the boot kernel's loader sweep. `ui-chat`
 * declares `sidebarRight` in its cordis inject set, and that service is
 * provided by the `ui-sidebar-right` host-graph row; `resources` comes from
 * the `client-resources` row and backs the global `useResource` hook. When one
 * of those rows never applies, the dependent fiber stays PENDING and the
 * surface silently disappears while the boot still reports success — this
 * module owns the decision and the message, and `chamber-entry.ts` owns the
 * timer (tied to the ctx lifecycle).
 */

/** Services the composite's first-screen plugins require from extra rows. */
export const REQUIRED_EXTRA_ROW_SERVICES = ['sidebarRight', 'resources'] as const

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
    + `${missing.join(', ')} — the ui-sidebar-right / client-resources host-graph rows did not apply; `
    + 'the conversation surface may stay unregistered'
}
