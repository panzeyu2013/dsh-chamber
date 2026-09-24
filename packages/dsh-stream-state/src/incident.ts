/**
 * The ONE incident instrument (P1).
 *
 * WHY. Reliability evidence already exists per domain - the notification
 * decision ledger, the delivery owner's symptoms, the carrier forensics ring,
 * the authority action log, the Electron frame watchdog - but each lives in a
 * different shell or module, so a real incident asks "which shell saw what?"
 * across five readers. This ring is the single resident place every shell
 * writes one bounded entry into and reads back with one global
 * ({@link INCIDENT_GLOBAL_KEY}); the run identity travels with the entry so
 * evidence about the same run lines up across shells.
 *
 * REDACTION BY CONSTRUCTION: reuse the forensics sanitizers (kind/token/detail
 * are bounded and credential-masked). The ring never throws into its caller and
 * never grows past {@link INCIDENT_RING_CAP}.
 *
 * PURITY: imports only the same package's forensics sanitizers; callers stamp
 * `at` and own the transport.
 */
import { redactForensicsDetail, sanitizeForensicsKind } from './forensics.ts'

export type IncidentSource = 'renderer' | 'electron-main' | 'swift' | 'carrier' | 'authority'

const INCIDENT_SOURCES: readonly IncidentSource[] = ['renderer', 'electron-main', 'swift', 'carrier', 'authority']

/** The one page/global read view every shell shares. */
const INCIDENT_GLOBAL_KEY = '__dshChamberIncident'

/** Retention bound; the ring never grows past its cap (published on the global view). */
const INCIDENT_RING_CAP = 512

/** Longest id (sessionId / sourceId / runId) copied into one entry. */
const INCIDENT_ID_MAX = 256

/** Longest symptom/action token copied into one entry. */
const INCIDENT_TOKEN_MAX = 48

export interface IncidentEntry {
  /** 1-based record order inside this ring (survives eviction of older entries). */
  readonly seq: number
  /** Caller-stamped milliseconds; a non-finite stamp is conservatively 0. */
  readonly at: number
  readonly source: IncidentSource
  /** Sanitized event kind (lowercase token). */
  readonly kind: string
  readonly runId?: string
  readonly sessionId?: string
  readonly sourceId?: string
  /** Delivery symptom, when the entry reports one. */
  readonly symptom?: string
  /** Action/decision taken, when the entry reports one. */
  readonly action?: string
  /** Redacted, bounded diagnostic copy - never a payload or credential. */
  readonly detail: string
}

export interface IncidentDraft {
  readonly at?: number
  readonly source: IncidentSource
  readonly kind: string
  readonly runId?: string
  readonly sessionId?: string
  readonly sourceId?: string
  readonly symptom?: string
  readonly action?: string
  readonly detail?: string
}

function boundedId(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > INCIDENT_ID_MAX) return undefined
  return value
}

function boundedToken(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.replace(/[^a-zA-Z0-9:_-]/gu, '-').slice(0, INCIDENT_TOKEN_MAX)
}

export class IncidentInstrument {
  #entries: IncidentEntry[] = []
  #seq = 0

  record(draft: IncidentDraft): IncidentEntry {
    const source = INCIDENT_SOURCES.includes(draft.source) ? draft.source : 'renderer'
    const at = typeof draft.at === 'number' && Number.isFinite(draft.at) && draft.at >= 0 ? draft.at : 0
    const entry: IncidentEntry = {
      seq: ++this.#seq,
      at,
      source,
      kind: sanitizeForensicsKind(draft.kind),
      detail: redactForensicsDetail(draft.detail ?? ''),
      ...(boundedId(draft.runId) === undefined ? {} : { runId: boundedId(draft.runId) as string }),
      ...(boundedId(draft.sessionId) === undefined ? {} : { sessionId: boundedId(draft.sessionId) as string }),
      ...(boundedId(draft.sourceId) === undefined ? {} : { sourceId: boundedId(draft.sourceId) as string }),
      ...(boundedToken(draft.symptom) === undefined ? {} : { symptom: boundedToken(draft.symptom) as string }),
      ...(boundedToken(draft.action) === undefined ? {} : { action: boundedToken(draft.action) as string }),
    }
    this.#entries.push(entry)
    if (this.#entries.length > INCIDENT_RING_CAP) {
      this.#entries.splice(0, this.#entries.length - INCIDENT_RING_CAP)
    }
    return entry
  }

  /** Oldest first (newest last), a copy the reader may keep. */
  snapshot(): readonly IncidentEntry[] {
    return [...this.#entries]
  }

  clear(): void {
    this.#entries = []
    this.#seq = 0
  }

  get size(): number {
    return this.#entries.length
  }
}

/** Idempotent install of the one read view; a later install replaces it. */
export function installIncidentInstrument(target: unknown, instrument: IncidentInstrument): void {
  ;(target as Record<string, unknown>)[INCIDENT_GLOBAL_KEY] = {
    cap: INCIDENT_RING_CAP,
    entries: (): readonly IncidentEntry[] => instrument.snapshot(),
    record: (draft: IncidentDraft): IncidentEntry => instrument.record(draft),
    clear: (): void => instrument.clear(),
  }
}
