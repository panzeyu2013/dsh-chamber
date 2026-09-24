/**
 * Guarded read of the per-instance list faces the sidebar's runtime-facts producer
 * projects from (`ctx.sessions.list` / `ctx.workspaces.list`). A bare cast over a
 * ctx whose service proxy throws for an uncarried member, or whose observables are
 * absent (a fork, or a future upstream rev that moves the store), would kill the
 * effect on the first snapshot read or half-register a producer that could never
 * report — so a missing face is WARNED and the registration SKIPPED: an inert seam
 * must never be silent.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** The ctx services whose `.list` observable the producer reads. */
export type InstanceListServiceName = 'sessions' | 'workspaces'

/** Resolve one list face, or warn and return undefined. `readService` is a thunk
 *  because the cordis ctx proxy throws for a member it does not carry. */
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

/** One loud line: the producer registration is skipped, and why. */
function warnSkipped(instanceId: string, serviceName: InstanceListServiceName, reason: string): void {
  console.warn(`[chamber] sidebar runtime-facts producer for ${instanceId} found no ${serviceName}.list observable `
    + `(${reason}) — the producer registration is SKIPPED: this instance reports no session/workspace snapshots`)
}
