/**
 * The page's evidence ledger (design 14 §D4) — bounded, persisted, greppable.
 *
 * Every liveness verdict (accepted OR rejected) is recorded here with its provenance,
 * so "the note lit up again" can be answered after the fact — including after a silent
 * reload — from the field: which deadline fired, whether the page was scheduled, what
 * the classifier decided, and what the consumer did with it. Console lines carry the
 * same payload for a live inspector session.
 *
 * Never throws: storage, JSON and console are all guarded (a diagnostics path must not
 * become a failure path). Zero runtime dependencies.
 */

/** One recorded liveness decision. */
export interface EvidenceLogEntry {
  /** Wall clock (ms) — the page's own clock, same as every other page timestamp. */
  readonly at: number
  /** Which subsystem observed it (\`mux-facts\`, \`facts-stream\`, \`authority-read\`, …). */
  readonly owner: string
  /** The verdict word from \`dsh-stream-state/evidence.ts\`. */
  readonly verdict: string
  /** Whether the consumer booked a source fact from it. */
  readonly booked: boolean
  /** Free-form provenance (source id, method, budget, scheduling gap, error name, …). */
  readonly detail: Record<string, unknown>
}

/** In-memory ring size (console/inspector tail). */
export const EVIDENCE_LOG_RING_MAX = 256
/** Persisted tail size (survives a reload; read back by diagnostics). */
export const EVIDENCE_LOG_PERSIST_MAX = 128
/** localStorage key (versioned, like every other chamber page record). */
export const EVIDENCE_LOG_STORAGE_KEY = 'dsh-chamber.evidence-log.v1'
/** Persist at most this often (ms) — one write per burst, not one per observation. */
export const EVIDENCE_LOG_PERSIST_INTERVAL_MS = 1_000

const ring: EvidenceLogEntry[] = []
let lastPersistAt = 0
let pendingPersist: ReturnType<typeof setTimeout> | null = null

function consoleEmit(entry: EvidenceLogEntry): void {
  try {
    console.debug('[chamber:evidence] ' + entry.verdict + ' booked=' + String(entry.booked) + ' ' + entry.owner + ' ' + JSON.stringify(entry.detail))
  } catch { /* console must never break a caller */ }
}

function storage(): Storage | null {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage
    return candidate ?? null
  } catch { return null }
}

function writeNow(): void {
  lastPersistAt = Date.now()
  const store = storage()
  if (store === null) return
  try {
    store.setItem(EVIDENCE_LOG_STORAGE_KEY, JSON.stringify({ v: 1, entries: ring.slice(-EVIDENCE_LOG_PERSIST_MAX) }))
  } catch { /* quota/private mode: the ring still holds this session */ }
}

/**
 * Record one liveness decision. \`booked\` says whether it changed a source fact — a
 * \`false\` next to \`unscheduled\` is the exact signature of a rejected false alarm.
 */
export function recordEvidence(owner: string, verdict: string, detail: Record<string, unknown>, booked: boolean): void {
  const entry: EvidenceLogEntry = { at: Date.now(), owner, verdict, booked, detail }
  ring.push(entry)
  if (ring.length > EVIDENCE_LOG_RING_MAX) ring.splice(0, ring.length - EVIDENCE_LOG_RING_MAX)
  consoleEmit(entry)
  const now = Date.now()
  if (now - lastPersistAt >= EVIDENCE_LOG_PERSIST_INTERVAL_MS) {
    if (pendingPersist !== null) { clearTimeout(pendingPersist); pendingPersist = null }
    writeNow()
    return
  }
  if (pendingPersist === null) {
    pendingPersist = setTimeout(() => { pendingPersist = null; writeNow() }, EVIDENCE_LOG_PERSIST_INTERVAL_MS)
  }
}

/** The in-memory tail, oldest first. */
export function readEvidenceLog(): readonly EvidenceLogEntry[] {
  return ring.slice()
}

/** The persisted tail (survives reloads); empty when nothing was ever written. */
export function readPersistedEvidenceLog(): readonly EvidenceLogEntry[] {
  const store = storage()
  if (store === null) return []
  try {
    const raw = store.getItem(EVIDENCE_LOG_STORAGE_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as { entries?: EvidenceLogEntry[] }
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch { return [] }
}

/** One-line-per-entry text for a copy-diagnostics action. */
export function evidenceLogText(): string {
  return readEvidenceLog().map((e) => new Date(e.at).toISOString() + ' ' + e.verdict + ' booked=' + String(e.booked) + ' ' + e.owner + ' ' + JSON.stringify(e.detail)).join('\n')
}

/** Test seam. */
export function resetEvidenceLogForTests(): void {
  ring.length = 0
  lastPersistAt = 0
  if (pendingPersist !== null) { clearTimeout(pendingPersist); pendingPersist = null }
}
