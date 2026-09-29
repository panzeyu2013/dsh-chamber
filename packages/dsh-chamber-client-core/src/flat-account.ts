/**
 * Single-list mode's per-source order account key — the chamber twin of the
 * official `FLAT_SESSION_ORDER_KEY`. One flat account per source: the
 * `view-prefs.flatOrder[sourceId]` array owns the manual baseline, and the
 * updated-mode twin lives under the NUL-sentinel key returned by
 * {@link flatAccountKey} in `updatedOrder`. The drag commit and the render
 * derivation share that one helper so they can never disagree.
 */
export const FLAT_ACCOUNT_KEY = '__flat__'

/**
 * The updated-mode account key for a source's flat list. A NUL sentinel (not
 * `sourceId + '/' + FLAT_ACCOUNT_KEY`) because a real workspace whose wire id is
 * literally `__flat__` would otherwise share that workspace's account and the two
 * derivations would clobber each other; NUL cannot appear in a workspace id the
 * host mints (precedent: the \u0001-joined fact identity keys in derive.ts).
 */
export function flatAccountKey(sourceId: string): string {
  return `${sourceId}/\u0000flat`
}
