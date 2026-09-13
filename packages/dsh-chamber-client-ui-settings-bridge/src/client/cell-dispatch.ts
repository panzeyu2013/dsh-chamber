/**
 * Cell dispatch of a bridged slot ledger (keyed + list), mirroring the official
 * outlet's dispatch branches (dsh-client-ui-renderer/src/client/scoped-slots.tsx
 * `renderOutletContent`, 2026-09-11 upstream-alignment T4).
 *
 * The distinction this module owns is the one the official outlet makes between
 * the RAW ledger (`SlotsService.entries`: every live registration, losers and
 * abdicated entries included) and the shadowing winners per cell
 * (`entriesOfSlot`). A cell whose registrations all abdicated (every candidate
 * crashed) has no winner but is still OCCUPIED — the official outlet renders an
 * addressable `<div data-slot-error="<key>">` there instead of the owner's
 * natural-empty fallback, so a broken registrant can never pass for "the owner
 * declared nothing". Both branches are pure functions of the two ledger views,
 * so the upstream contract is pinned by plain unit tests.
 */

/** One registered entry as these projections read it (the registry's public read face). */
export interface DispatchEntry {
  options: { id?: string; key?: string; order?: number }
}

/**
 * Keyed dispatch outcome: the registered entry for the requested key, an
 * addressable dead cell (the key is occupied but every candidate abdicated), or
 * the owner's fallback (the key was never registered here).
 */
export type KeyedCell<E> = { kind: 'entry'; entry: E } | { kind: 'dead' } | { kind: 'fallback' }

/**
 * Dispatch one keyed cell.
 * @param all - the raw ledger view (`entries`).
 * @param winners - the shadowing winners (`entriesOfSlot`).
 * @param entryKey - the key the owner asked for.
 * @returns the winning entry, or the occupied-but-absent / never-registered outcome.
 */
export function dispatchKeyedCell<E extends DispatchEntry>(
  all: readonly E[],
  winners: readonly E[],
  entryKey: string | undefined,
): KeyedCell<E> {
  const entry = winners.find(candidate => candidate.options.key === entryKey)
  if (entry !== undefined) return { kind: 'entry', entry }
  const occupied = all.some(candidate => candidate.options.key === entryKey)
  return occupied ? { kind: 'dead' } : { kind: 'fallback' }
}

/** One list row: the cell's shadowing winner, or a dry cell (`entry` absent) anchored at its head's declared order. */
export interface ListCell<E> {
  entry: E | undefined
  id: string | undefined
  order: number
}

/**
 * Project one list slot's cells into display rows: winners first, then a dry
 * row for every occupied id whose winners all abdicated (the official outlet's
 * addressable crash face), refined by `order`, then filtered by `only`.
 * @param all - the raw ledger view (`entries`).
 * @param winners - the shadowing winners (`entriesOfSlot`).
 * @param only - the owner's id filter (`opts.only`), when given.
 * @returns the rows to render, in order.
 */
export function dispatchListCells<E extends DispatchEntry>(
  all: readonly E[],
  winners: readonly E[],
  only: string | undefined,
): ListCell<E>[] {
  const rows: ListCell<E>[] = winners.map(entry => ({
    entry,
    id: entry.options.id,
    order: entry.options.order ?? 0,
  }))
  const rowIds = new Set(rows.map(row => row.id))
  for (const entry of all) {
    const id = entry.options.id
    if (rowIds.has(id)) continue
    rowIds.add(id)
    rows.push({ entry: undefined, id, order: entry.options.order ?? 0 })
  }
  rows.sort((a, b) => a.order - b.order)
  return only === undefined ? rows : rows.filter(row => row.id === only)
}
