/**
 * Incremental host-log follow over the REST endpoint's bounded tail snapshot.
 * ISO timestamps are only millisecond-precise, so they cannot be a lossless
 * cursor. Compare the previous suffix with the current prefix instead.
 */
export interface HostLogFollowEntry {
  ts?: unknown
  stream?: unknown
  line?: unknown
}

export interface FollowWindow<T extends HostLogFollowEntry = HostLogFollowEntry> {
  newLines: T[]
  nextKeys: string[]
}

function entryKey(entry: HostLogFollowEntry): string {
  return JSON.stringify([entry.ts ?? null, entry.stream ?? null, entry.line ?? null])
}

/** The REST limit is capped at 1000, so this direct comparison is bounded. */
function overlapLength(previous: readonly string[], current: readonly string[]): number {
  for (let length = Math.min(previous.length, current.length); length > 0; length -= 1) {
    const previousStart = previous.length - length
    let matches = true
    for (let index = 0; index < length; index += 1) {
      if (previous[previousStart + index] !== current[index]) {
        matches = false
        break
      }
    }
    if (matches) return length
  }
  return 0
}

export function followNewLines<T extends HostLogFollowEntry>(
  lines: readonly T[] | null | undefined,
  previousKeys: readonly string[],
): FollowWindow<T> {
  const current = [...(lines ?? [])]
  const nextKeys = current.map(entryKey)
  return { newLines: current.slice(overlapLength(previousKeys, nextKeys)), nextKeys }
}
