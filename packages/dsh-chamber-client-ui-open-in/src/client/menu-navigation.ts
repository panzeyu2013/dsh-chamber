/** Pure roving-focus decisions for the open-in app menu. */

export type MenuMove = 'next' | 'previous' | 'first' | 'last'
export type MenuOpenFocus = 'selected' | 'first' | 'last'
export type TabDirection = 'forward' | 'backward'

/** DOM-independent snapshot used by the portal owner guard.  The component
 * reads these facts from the trigger and its owning `.instance-view`; keeping
 * the decision pure makes the fail-closed boundary deterministic to test even
 * though this package deliberately has no browser-DOM test dependency. */
export interface MenuOwnerSnapshot {
  triggerConnected: boolean
  ownerConnected: boolean
  ownerContainsTrigger: boolean
  ownerIsInstanceView: boolean
  ownerHasInactiveClass: boolean
  ownerHidden: boolean
  ownerAriaHidden: boolean
  rendered: boolean
}

export function menuOwnerAllowsInteraction(snapshot: MenuOwnerSnapshot): boolean {
  return snapshot.triggerConnected &&
    snapshot.ownerConnected &&
    snapshot.ownerContainsTrigger &&
    snapshot.ownerIsInstanceView &&
    !snapshot.ownerHasInactiveClass &&
    !snapshot.ownerHidden &&
    !snapshot.ownerAriaHidden &&
    snapshot.rendered
}

export function initialMenuIndex(ids: readonly string[], selectedId: string, intent: MenuOpenFocus): number {
  if (ids.length === 0) return -1
  if (intent === 'first') return 0
  if (intent === 'last') return ids.length - 1
  const selected = ids.indexOf(selectedId)
  return selected < 0 ? 0 : selected
}

export function moveMenuIndex(length: number, current: number, move: MenuMove): number {
  if (length <= 0) return -1
  if (move === 'first') return 0
  if (move === 'last') return length - 1
  const normalized = current >= 0 && current < length ? current : 0
  if (move === 'next') return (normalized + 1) % length
  return (normalized - 1 + length) % length
}

/** Return document indexes in the browser's sequential focus order: positive
 * tabindex values first (ascending, retaining DOM order for ties), followed
 * by ordinary tabindex=0 stops in DOM order. Negative entries are excluded. */
export function orderedTabStopIndexes(tabIndexes: readonly number[]): number[] {
  return tabIndexes
    .map((tabIndex, documentIndex) => ({ tabIndex, documentIndex }))
    .filter(entry => Number.isInteger(entry.tabIndex) && entry.tabIndex >= 0)
    .sort((left, right) => {
      const leftPositive = left.tabIndex > 0
      const rightPositive = right.tabIndex > 0
      if (leftPositive && rightPositive) {
        return left.tabIndex - right.tabIndex || left.documentIndex - right.documentIndex
      }
      if (leftPositive) return -1
      if (rightPositive) return 1
      return left.documentIndex - right.documentIndex
    })
    .map(entry => entry.documentIndex)
}

/** Resolve the adjacent stop around the trigger in an already ordered list.
 * A boundary returns -1 rather than wrapping: focus must never jump to an
 * arbitrary stale instance merely because no sibling stop exists. */
export function adjacentTabStopIndex(
  orderedDocumentIndexes: readonly number[],
  triggerDocumentIndex: number,
  direction: TabDirection,
): number {
  const current = orderedDocumentIndexes.indexOf(triggerDocumentIndex)
  if (current < 0) return -1
  const next = direction === 'forward' ? current + 1 : current - 1
  return next >= 0 && next < orderedDocumentIndexes.length
    ? orderedDocumentIndexes[next]
    : -1
}
