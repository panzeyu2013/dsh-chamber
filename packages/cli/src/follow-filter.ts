/**
 * Host-log follow filtering (packages/cli host logs --follow).
 *
 * The control-plane wire writes `ts` as an ISO-8601 string
 * (`new Date().toISOString()`, control-plane/src/host-logs.ts). The old CLI
 * implementation parsed it with Number() — which yields NaN for ISO strings —
 * and dropped every line, silently rendering --follow empty. This module is
 * the pure, testable core of the incremental window.
 */

/** A host-log line as served by GET /api/host/logs. Deliberately no index
 * signature so concrete line types (LogLine) stay structurally assignable. */
export interface HostLogFollowEntry {
  ts?: unknown
  stream?: unknown
  line?: unknown
}

/** Parse a host-log timestamp: numeric epoch ms or ISO-8601 string; NaN when
 * unparseable (such entries are treated as "always new" by the filter). */
export function parseLogTs(ts: unknown): number {
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string' && ts !== '') return Date.parse(ts)
  return Number.NaN
}

export interface FollowWindow<T extends HostLogFollowEntry = HostLogFollowEntry> {
  /** Entries newer than `lastTs` (unparseable ts is always new). */
  newLines: T[]
  /** The advanced watermark: newest parsed ts, never moved backwards. */
  nextTs: number
}

/** One incremental follow poll over `lines` given the previous watermark. */
export function followNewLines<T extends HostLogFollowEntry>(
  lines: readonly T[] | null | undefined,
  lastTs: number,
): FollowWindow<T> {
  const newLines: T[] = []
  let maxTs = lastTs
  for (const entry of lines ?? []) {
    const ts = parseLogTs(entry?.ts)
    if (!Number.isFinite(ts) || ts > lastTs) newLines.push(entry)
    if (Number.isFinite(ts) && ts > maxTs) maxTs = ts
  }
  return { newLines, nextTs: maxTs }
}
