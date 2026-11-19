/**
 * Fork-child title increment — the chamber's port of the upstream
 * session-controller client's `increasedForkTitle(title, taken)`.
 *
 * Upstream increments a trailing half-width or full-width parenthesized number
 * (BigInt, no precision loss) until the candidate is not taken; any other title
 * starts at ` (1)` (vendor
 * `packages/api/session-controller/src/client/sessions/service.ts:132-160`).
 * The live runtime line ships the same two-argument shape (its compiled
 * `@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js`
 * keeps `while (taken.has(next))`).
 *
 * WHY this module: the `taken` semantics are the one part of the port the old
 * single-argument copy dropped, and `derive.ts` sits under the god-file line
 * ratchet — the pure function lives here instead of growing it. Consumers:
 * `session-mutations.ts` (the unique session-mutation funnel) and the leaf
 * suite. The caller owns where the taken set comes from and how fresh it is;
 * this module is pure and source-agnostic.
 */

/** Increment a trailing fork number, preserving its half-width or full-width parentheses. */
function incrementedTitle(title: string): string {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  return `${title} (1)`
}

/**
 * Increment the fork number until the candidate is not taken.
 * @param title - source session's durable title.
 * @param taken - durable titles the child must not collide with (same source).
 * @returns the title assigned to the fork child.
 */
export function increasedForkTitle(title: string, taken: ReadonlySet<string>): string {
  let next = incrementedTitle(title)
  while (taken.has(next)) next = incrementedTitle(next)
  return next
}

/**
 * The non-empty durable titles of one session-row list. Blank rows and rows
 * without a title carry no name to skip; duplicates collapse.
 * @param rows - session rows (mounted snapshot or projection rows).
 * @returns the title set, possibly empty.
 */
export function sessionDurableTitles(rows: readonly { title?: string }[]): ReadonlySet<string> {
  const titles = new Set<string>()
  for (const row of rows) {
    if (typeof row.title === 'string' && row.title !== '') titles.add(row.title)
  }
  return titles
}
