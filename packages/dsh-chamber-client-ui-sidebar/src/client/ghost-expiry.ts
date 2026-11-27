/** Pure expiry clock for the blank-row GHOST slot (design 06 §2.2).
 *  Keeping it DOM/React-free lets the re-arm vs stale-timer rule be behavior-tested. */

/** Source-scoped slot key: cloned instances can carry the same session UUID, so a bare session id would cross sources. */
export function ghostSlotKey(sourceId: string, sessionId: string): string {
  return sourceId + ':' + sessionId
}

/** Arm (or re-arm) one session's ghost deadline; returns the stored deadline. */
export function armGhostExpiry(map: Map<string, number>, slotKey: string, now: number, graceMs: number): number {
  const deadline = now + graceMs
  map.set(slotKey, deadline)
  return deadline
}

/** Delete the slot only when its stored deadline has actually passed.
 *  A stale timer firing after a newer re-arm must therefore keep the newer deadline. */
export function expireGhostSlot(map: Map<string, number>, slotKey: string, now: number): boolean {
  const deadline = map.get(slotKey)
  if (deadline === undefined || deadline > now) return false
  map.delete(slotKey)
  return true
}
