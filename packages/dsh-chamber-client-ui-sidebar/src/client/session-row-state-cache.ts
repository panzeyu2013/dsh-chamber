/**
 * One-derivation cache for the per-row state readers of the ServerSection subtree.
 *
 * Every row face (marker / label / pending / dot, plus the hover card's status
 * line) routes through `sessionRowStateOf(server, session)`, so ONE row render
 * asks for the same result 9-12 times. The leaf `sessionRowState` is pure and its
 * whole input is the triple (facts row object identity, `session.running`, the
 * source `stale` bit): `mergeRuntimeFacts` re-publishes a CHANGED row as a new
 * object and keeps every untouched row by reference, so the row identity is the
 * change signal. The cache hands back one mutable slot per triple; the caller
 * fills `slot.result` once and every later reader call gets the same result
 * object instead of re-deriving it.
 *
 * WeakMap-keyed on the facts row: a session leaving the projection releases its
 * slots together with the row object (rows without facts share one sentinel key,
 * separated by the running/stale variant).
 */

/** Mutable holder the deriving caller fills (undefined until then; the leaf always returns an object). */
export interface SessionRowStateSlot<T> {
  result?: T
}

export interface SessionRowStateCache<T> {
  /** The slot for (facts, running, stale): the same triple always maps to the same slot object. */
  slot(facts: object | undefined, running: boolean | undefined, stale: boolean | undefined): SessionRowStateSlot<T>
}

/** Create one cache per consumer (the readers of one hook instance). */
export function createSessionRowStateCache<T>(): SessionRowStateCache<T> {
  // WeakMap keys must be objects; absent facts is a shared sentinel whose slot
  // variants still separate running/stale combinations.
  const noFacts: object = {}
  const byFacts = new WeakMap<object, Map<string, SessionRowStateSlot<T>>>()
  return {
    slot(facts, running, stale) {
      const key = facts ?? noFacts
      let variants = byFacts.get(key)
      if (variants === undefined) {
        variants = new Map()
        byFacts.set(key, variants)
      }
      // The variant key names the raw values: true / false / undefined are three
      // different inputs (runningRingVisible reads the difference).
      const variant = `${running === true ? 'r' : running === false ? 'R' : '-'}:${stale === true ? 's' : stale === false ? 'S' : '-'}`
      let slot = variants.get(variant)
      if (slot === undefined) {
        slot = {}
        variants.set(variant, slot)
      }
      return slot
    },
  }
}
