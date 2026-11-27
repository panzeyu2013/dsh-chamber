/** Pure expiry clock for the blank-row GHOST slot (design 06 §2.2).
 *  Keeping it DOM/React-free lets the re-arm vs stale-timer rule be behavior-tested. */

/** Arm (or re-arm) one session's ghost deadline; returns the stored deadline. */
export function armGhostExpiry(map: Map<string, number>, sessionId: string, now: number, graceMs: number): number {
  const deadline = now + graceMs
  map.set(sessionId, deadline)
  return deadline
}

/** Delete the slot only when its stored deadline has actually passed.
 *  A stale timer firing after a newer re-arm must therefore keep the newer deadline. */
export function expireGhostSlot(map: Map<string, number>, sessionId: string, now: number): boolean {
  const deadline = map.get(sessionId)
  if (deadline === undefined || deadline > now) return false
  map.delete(sessionId)
  return true
}