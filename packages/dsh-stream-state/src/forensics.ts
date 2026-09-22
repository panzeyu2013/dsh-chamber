/**
 * Bounded stream-lifecycle forensics (P5).
 *
 * WHY A RING. The page already publishes one live fact per carrier transition
 * (api-gateway stream-forensics.ts), but a live event is gone the moment nobody
 * listens: after a renderer hang or a JSC crash there was no resident record of the
 * last transitions (the console is not persisted, the Swift shell exposes no
 * DevTools). This ring is the bounded, in-page tail buffer - the ONE resident
 * buffer until the upstream instance exposes a renderer-writable forensics verb -
 * and every export path drains it through {@link ForensicsSink}.
 *
 * REDACTION BY CONSTRUCTION. Hosts must only feed bounded diagnostic copy (never a
 * payload, prompt, path or credential); {@link redactForensicsDetail} is the
 * defense-in-depth second line and lives here once. The ring never throws into its
 * caller: a throwing sink or an unusable timestamp must not be able to break the
 * stream lifecycle it observes.
 *
 * PURITY: zero imports, no clock reads (the caller stamps `at`).
 */

/** Default retention bound; the ring never grows past its cap. */
export const FORENSICS_RING_CAP = 256

/** Longest detail copied into one entry. */
export const FORENSICS_DETAIL_MAX = 120

/** Longest kind copied into one entry. */
export const FORENSICS_KIND_MAX = 48

/** One retained lifecycle fact. */
export interface ForensicsEntry {
  /** 1-based record order inside this ring (survives eviction of older entries). */
  readonly seq: number
  /** Caller-stamped milliseconds; a non-finite stamp is conservatively 0. */
  readonly at: number
  /** Sanitized transition kind. */
  readonly kind: string
  /** Redacted, bounded diagnostic copy - never a payload or credential. */
  readonly detail: string
}

/** The only export port: every path that persists/forwards entries takes one. */
export interface ForensicsSink {
  (entry: ForensicsEntry): void
}

const SECRET_ASSIGNMENT =
  /(authorization|bearer|basic|cookie|password|passwd|secret|token|api[-_]?key)(\s*[=:]\s*|\s+)((?:bearer|basic)\s+)?([^\s,;]+)/giu

/**
 * Mask credential-shaped substrings and remove control characters. This is a
 * second line, not the contract: the caller must not feed secrets in the first
 * place (the reporter's cause strings are bounded diagnostic copy).
 */
export function redactForensicsDetail(detail: string): string {
  const text = String(detail ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    // URL userinfo (//user:password@host) never reaches a fact.
    .replace(/\/\/([^/@\s:]+):([^/@\s]+)@/gu, '//***@')
    .replace(SECRET_ASSIGNMENT, (_match: string, name: string) => name + '=***')
    .replace(/\s+/gu, ' ')
    .trim()
  return text.slice(0, FORENSICS_DETAIL_MAX)
}

/** Sanitize a transition kind to lowercase `[a-z0-9-]`, bounded. */
export function sanitizeForensicsKind(kind: string): string {
  return String(kind ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, FORENSICS_KIND_MAX)
}

export interface ForensicsRing {
  /** Append one fact, evicting the oldest entries past the cap. */
  record(kind: string, detail: string, at: number): ForensicsEntry
  /** Read-only copy of the retained tail, oldest first. */
  snapshot(): readonly ForensicsEntry[]
  /** Flush the tail to a sink, oldest first, and empty the ring. Returns the count. */
  flush(sink: ForensicsSink): number
  /** Current retained entries. */
  size(): number
}

/**
 * Build the bounded ring.
 * @param options - optional cap; non-finite/negative/zero values fall back to
 *   {@link FORENSICS_RING_CAP} (a ring that cannot hold anything is not a buffer).
 */
export function createForensicsRing(options: { readonly cap?: number } = {}): ForensicsRing {
  const cap = Number.isFinite(options.cap) && (options.cap as number) >= 1
    ? Math.floor(options.cap as number)
    : FORENSICS_RING_CAP
  const entries: ForensicsEntry[] = []
  let seq = 0
  return {
    record(kind: string, detail: string, at: number): ForensicsEntry {
      seq += 1
      const entry: ForensicsEntry = {
        seq,
        at: Number.isFinite(at) ? at : 0,
        kind: sanitizeForensicsKind(kind),
        detail: redactForensicsDetail(detail),
      }
      entries.push(Object.freeze(entry))
      if (entries.length > cap) entries.splice(0, entries.length - cap)
      return entry
    },
    snapshot(): readonly ForensicsEntry[] {
      // Copies, not references: a reader (or a sink) mutating a snapshot entry must
      // not be able to corrupt the retained tail.
      return entries.map((entry) => ({ ...entry }))
    },
    flush(sink: ForensicsSink): number {
      const flushed = entries.splice(0, entries.length)
      let delivered = 0
      for (const entry of flushed) {
        try {
          sink(entry)
          delivered += 1
        } catch {
          // A throwing sink must never break the ring's owner; the entry is already
          // out of the buffer either way (flush is a transfer, not a copy).
        }
      }
      return delivered
    },
    size(): number {
      return entries.length
    },
  }
}
