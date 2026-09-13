/**
 * Guarded read of the per-instance list faces the sidebar's runtime-facts
 * producer projects from (`ctx.sessions.list` / `ctx.workspaces.list`).
 *
 * WHY a runtime guard instead of trusting the declared services: the producer
 * effect runs inside `apply`, i.e. once the fiber's `inject` list is satisfied,
 * but the two list observables belong to the OFFICIAL api session/workspace
 * controller clients. A ctx that provides the services without the observables
 * (a fork, or a future upstream rev that moves the store), or one whose
 * service proxy throws for a member it does not carry, used to be read through
 * a bare cast — the effect then died on the first snapshot read, or
 * half-registered producers that could never report. A missing face is
 * therefore WARNED and the producer registration is skipped: an inert seam
 * must never be silent (same discipline as the `refresh()` guard inside the
 * same effect).
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** The ctx services whose `.list` observable the producer reads. */
export type InstanceListServiceName = 'sessions' | 'workspaces'

/**
 * Resolve one list face, or warn and return undefined.
 * @param instanceId - the chamber instance the producer reports for (warning context).
 * @param serviceName - the ctx service name, named in the warning.
 * @param readService - reads the service off the ctx; a thunk because the cordis ctx proxy throws for a member it does not carry.
 * @returns the observable snapshot face, or undefined after a loud warning.
 */
export function resolveInstanceListFace<T>(
  instanceId: string,
  serviceName: InstanceListServiceName,
  readService: () => unknown,
): ObservableSnapshot<T> | undefined {
  let list: unknown
  try {
    list = (readService() as { list?: unknown } | undefined)?.list
  } catch (error) {
    warnSkipped(instanceId, serviceName, error instanceof Error ? error.message : String(error))
    return undefined
  }
  const face = list as { getSnapshot?: unknown; subscribe?: unknown } | undefined
  if (typeof face?.getSnapshot !== 'function' || typeof face.subscribe !== 'function') {
    warnSkipped(instanceId, serviceName, 'the service carries no list observable')
    return undefined
  }
  return list as ObservableSnapshot<T>
}

/**
 * One loud line: the producer registration is skipped, and why.
 * @param instanceId - the chamber instance.
 * @param serviceName - the ctx service missing its list observable.
 * @param reason - the observed cause.
 */
function warnSkipped(instanceId: string, serviceName: InstanceListServiceName, reason: string): void {
  console.warn(`[chamber] sidebar runtime-facts producer for ${instanceId} found no ${serviceName}.list observable `
    + `(${reason}) — the producer registration is SKIPPED: this instance reports no session/workspace snapshots`)
}
