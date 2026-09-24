/**
 * Per-source ledger plumbing (`Readonly<Record<sourceId, readonly T[]>>`) shared by the chamber
 * echo/tombstone ledgers and the membership grace maps. IDENTITY DISCIPLINE: every helper is
 * reference-preserving — an unchanged row set keeps the SAME ledger object AND row array (React
 * identity checks depend on it), an emptied source loses its key rather than lingering as `[]`,
 * and no helper mutates its input. Row shapes, TTLs and predicates stay with the concrete ledgers.
 */

/** One `sourceId -> rows` ledger. */
export type Ledger<T> = Readonly<Record<string, readonly T[]>>

/** Replace one source's rows: an identical reference returns the ledger unchanged;
 *  `undefined`/empty removes the key. */
export function setLedgerRows<T>(ledger: Ledger<T>, sourceId: string, next: readonly T[] | undefined): Ledger<T> {
  const current = ledger[sourceId]
  if (next === current) return ledger
  if (next === undefined || next.length === 0) {
    if (current === undefined) return ledger
    const copy: Record<string, readonly T[]> = { ...ledger }
    delete copy[sourceId]
    return copy
  }
  return { ...ledger, [sourceId]: next }
}

/** Keep only the rows of ONE source that satisfy `keep` (identity-preserving when nothing is dropped). */
export function filterLedgerRows<T>(ledger: Ledger<T>, sourceId: string, keep: (row: T) => boolean): Ledger<T> {
  const rows = ledger[sourceId]
  if (rows === undefined) return ledger
  const kept = rows.filter(keep)
  return kept.length === rows.length ? ledger : setLedgerRows(ledger, sourceId, kept)
}

/** Map one source's rows (identity-preserving when every mapped row is the same reference). */
export function mapLedgerRows<T>(ledger: Ledger<T>, sourceId: string, map: (row: T) => T): Ledger<T> {
  const rows = ledger[sourceId]
  if (rows === undefined) return ledger
  let changed = false
  const next = rows.map((row) => {
    const mapped = map(row)
    if (mapped !== row) changed = true
    return mapped
  })
  return changed ? setLedgerRows(ledger, sourceId, next) : ledger
}

/** Drop expired rows from EVERY source (empty sources are removed); `isExpired(row, sourceId)`
 *  is the TTL predicate. Identity-preserving when nothing expires. */
export function sweepLedger<T>(ledger: Ledger<T>, isExpired: (row: T, sourceId: string) => boolean): Ledger<T> {
  let changed = false
  const next: Record<string, readonly T[]> = {}
  for (const [sourceId, rows] of Object.entries(ledger)) {
    const kept = rows.filter(row => !isExpired(row, sourceId))
    if (kept.length === rows.length) {
      next[sourceId] = rows
      continue
    }
    changed = true
    if (kept.length > 0) next[sourceId] = kept
  }
  return changed ? next : ledger
}

/** Drop every source key in `retired` (identity-preserving when none matches). */
export function forgetLedgerSources<T>(ledger: Ledger<T>, retired: ReadonlySet<string>): Ledger<T> {
  let changed = false
  const next: Record<string, readonly T[]> = { ...ledger }
  for (const sourceId of retired) {
    if (next[sourceId] === undefined) continue
    delete next[sourceId]
    changed = true
  }
  return changed ? next : ledger
}

/** Forget keys whose source left `live` (grace-map counterpart of {@link forgetLedgerSources});
 *  mutates the caller-owned map and reports whether anything was removed. */
export function forgetMapSources<K, V>(
  map: Map<K, V>,
  sourceOf: (key: K) => string,
  live: ReadonlySet<string>,
): boolean {
  let changed = false
  for (const key of [...map.keys()]) {
    if (live.has(sourceOf(key))) continue
    map.delete(key)
    changed = true
  }
  return changed
}
