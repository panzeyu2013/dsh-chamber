/**
 * SessionRunId - the identity spine for one running episode.
 *
 * WHY. "Running / completed / notified / unread / pending delivery" used to be keyed by
 * (sourceId, sessionId) plus watermark heuristics; when one status frame is lost the
 * watermark and the running edge disagree, and same-millisecond completions become
 * indistinguishable. One identity per episode removes the heuristics: two families
 * exist and NEVER compare or merge - a host-provided run key when the host has one,
 * and the chamber's own namespace derived from its observed episode ordinal.
 *
 * PURITY (enforced by scripts/test.mjs): this module imports NOTHING.
 */

/** Opaque, stable for the lifetime of one running episode. */
export type SessionRunId = string

/** The host's own run key (opaque to the chamber). */
const HOST_RUN_PREFIX = 'host:'
/** The chamber's namespace: source fingerprint + generation + session + episode ordinal. */
const CHAMBER_RUN_PREFIX = 'chamber:'

export interface ChamberRunParts {
  readonly sourceFingerprint: string
  readonly generation: number
  readonly sessionId: string
  readonly episode: number
}

export type RunIdFamily = 'host' | 'chamber' | 'legacy'

/** Encode one chamber-namespace run id. Component text is percent-encoded so ':' stays structural. */
export function chamberRunId(parts: ChamberRunParts): SessionRunId {
  return CHAMBER_RUN_PREFIX + [parts.sourceFingerprint, String(parts.generation), parts.sessionId, String(parts.episode)]
    .map(part => encodeURIComponent(part)).join(':')
}

/** Encode one host-provided run key. */
export function hostRunId(key: string): SessionRunId {
  return HOST_RUN_PREFIX + encodeURIComponent(key)
}

/** Which family an id belongs to; anything else is an opaque pre-spine (legacy) key. */
export function runIdFamily(runId: SessionRunId): RunIdFamily {
  if (runId.startsWith(HOST_RUN_PREFIX)) return 'host'
  if (runId.startsWith(CHAMBER_RUN_PREFIX)) return 'chamber'
  return 'legacy'
}

/** Decode a chamber-namespace id; null for other families or malformed payloads. */
export function parseChamberRunId(runId: SessionRunId): ChamberRunParts | null {
  if (!runId.startsWith(CHAMBER_RUN_PREFIX)) return null
  const parts = runId.slice(CHAMBER_RUN_PREFIX.length).split(':')
  if (parts.length !== 4) return null
  const decoded: (string | null)[] = parts.map(part => { try { return decodeURIComponent(part) } catch { return null } })
  if (decoded.some(part => part === null)) return null
  const generation = Number(decoded[1])
  const episode = Number(decoded[3])
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(episode)) return null
  return { sourceFingerprint: decoded[0] as string, generation, sessionId: decoded[2] as string, episode }
}

/** Identity equality inside one family. Different families are never equal. */

/**
 * Which id owns a session when both channels report one. A host id always beats the
 * chamber namespace; two ids of the same family with different values are a CONFLICT
 * the caller must instrument (never silently merge).
 */
export function preferRunId(
  hostCandidate: SessionRunId | undefined,
  chamberCandidate: SessionRunId | undefined,
): { readonly runId: SessionRunId | undefined; readonly conflict: boolean } {
  if (hostCandidate === undefined) return { runId: chamberCandidate, conflict: false }
  if (chamberCandidate === undefined || hostCandidate === chamberCandidate) {
    return { runId: hostCandidate, conflict: false }
  }
  const hostFamily = runIdFamily(hostCandidate)
  const chamberFamily = runIdFamily(chamberCandidate)
  if (hostFamily === 'host') return { runId: hostCandidate, conflict: chamberFamily === 'host' }
  if (chamberFamily === 'host') return { runId: chamberCandidate, conflict: true }
  return { runId: hostCandidate, conflict: true }
}

/** Bounded diagnostic label (never carries copy). */
export function describeRunId(runId: SessionRunId | undefined): string {
  if (runId === undefined) return 'no-run'
  const family = runIdFamily(runId)
  if (family === 'chamber') {
    const parts = parseChamberRunId(runId)
    if (parts !== null) return 'chamber:' + parts.sessionId + '#' + String(parts.episode)
  }
  return family
}
