/**
 * Rotating refresh wave (design 08 §5 / design 26 §D7).
 *
 * The 30s tick must NOT fan one unary out per connected source: the page's
 * same-origin pool is shared, and a wide fleet would starve the local baseline
 * behind remote Git reads. Each tick therefore refreshes at most `cap` sources,
 * starting where the previous wave stopped, so a stable roster is covered in
 * `ceil(N/cap)` beats without a source ever being skipped forever.
 *
 * Pure and roster-agnostic: the coordinator owns eligibility (connected, not
 * busy) and the cursor.
 */
export interface PollWave {
  /** Sources to refresh this beat (no duplicates; length <= cap and <= eligible). */
  readonly wave: readonly string[]
  /** Cursor to pass into the next call (a position in the eligible list). */
  readonly cursor: number
}

export function selectPollWave(eligible: readonly string[], cursor: number, cap: number): PollWave {
  const size = eligible.length
  if (size === 0 || cap <= 0) return { wave: [], cursor: 0 }
  const limit = Math.min(cap, size)
  // Positive modulo: a negative cursor (never produced today) must not select
  // from the tail through a negative index.
  const start = ((Math.trunc(cursor) % size) + size) % size
  const wave: string[] = []
  for (let offset = 0; offset < limit; offset += 1) wave.push(eligible[(start + offset) % size] as string)
  return { wave, cursor: (start + limit) % size }
}
