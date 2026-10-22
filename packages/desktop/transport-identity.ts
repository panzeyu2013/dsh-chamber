/**
 * The three names one remote instance has, and the conversions between them.
 *
 *   raw id        'abc'         the manager/registry key (`TransportInstanceSpec.id`)
 *   connectionId  'dsh:abc'     what the control plane registers and revokes
 *   sourceId      'dsh-abc'     what the page and the proxy path (/api/i/<id>) use
 *                               (that direction is owned by the renderer's
 *                               transport-source.ts; the desktop never needs it)
 *
 * They used to be converted ad hoc at every boundary. The failure-driven probe
 * and the link-busy signal cross the boundary in BOTH directions, and a mismatch
 * fails SILENTLY (`states.get(unknownId)` is simply undefined), so both
 * conversions live here, are tested, and are the only place allowed to do it.
 */

/** The production consumer is the link-busy adapter below; the identity tests also
 *  import it directly (a deliberate seam, not a dead export). */
export function connectionIdForRawInstance(id: string, kind: string): string {
  return `${kind}:${id}`
}

/** The inverse of {@link connectionIdForRawInstance}; null for a malformed id. */
export function instanceIdFromConnectionId(connectionId: string): string | null {
  const separator = connectionId.indexOf(':')
  if (separator <= 0 || separator === connectionId.length - 1) return null
  return connectionId.slice(separator + 1)
}

/** The two adapters that cross the manager ⇄ control-plane boundary. They are
 *  factories so the composed contract is testable without an assembly: the
 *  manager callback speaks RAW ids, the plane speaks connectionIds. */
export interface InstanceIdentityRow {
  readonly id: string
  readonly kind: string
}

/** manager -> plane: resolve the raw id to its connectionId, or "not busy". */
export function linkBusyAdapter(
  listInstances: () => readonly InstanceIdentityRow[],
  isBusy: (connectionId: string) => boolean,
): (id: string) => boolean {
  return (id) => {
    const spec = listInstances().find(instance => instance.id === id)
    if (spec === undefined) return false
    return isBusy(connectionIdForRawInstance(id, spec.kind))
  }
}

/** plane -> manager: map the emitted connectionId back to the raw id. */
export function linkFailureAdapter(notify: (id: string) => void): (connectionId: string) => void {
  return (connectionId) => {
    const id = instanceIdFromConnectionId(connectionId)
    if (id !== null) notify(id)
  }
}
