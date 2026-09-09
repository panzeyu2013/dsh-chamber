/**
 * Launch-time baseline harvest (design 05 §2.3; STATUS "首屏整源降级直到被
 * 点击" registration).
 *
 * A ready source that has never been mounted has no ctx, so its only data path
 * is the unary fallback: cwd-derived SYNTHETIC workspace rows, an EMPTY archive
 * set (`archiveSetKnown:false`) and therefore archived sessions surfacing as
 * ordinary rows. Every self-healing arm requires `mounted === true` (at least
 * one push), and the 30s watchdog only re-submits the same fallback, so an
 * untouched source stays degraded until the user clicks it (selectView → mount
 * → ctx boot → follow baseline). The harvest closes that window by mounting
 * such a source ONCE in the background prewarm slot, keeping it only until its
 * first authoritative push lands, then reclaiming it — after which the source
 * holds the already-shipped "reclaimed source" state (authoritative groups +
 * archive set, sessions refreshed by the 30s unary merge).
 *
 * Bookkeeping is renderer-local and never persisted. Attempts are bounded so a
 * source whose shell cannot boot is not retried forever, and the backoff keeps
 * a failing source from occupying the single background slot.
 */

/** Per-source harvest bookkeeping. */
import { BOOT_TIMEOUT_MS } from './boot-budget.ts'

export interface HarvestRecord {
  /** Mount attempts already started. */
  attempts: number
  /** Epoch ms of the current attempt's mount, 0 before the first attempt. */
  mountedAt: number
  /** Epoch ms before which no new attempt may start (backoff after an attempt). */
  retryAt: number
  /** A producer push landed: the source holds its authoritative baseline. */
  satisfied: boolean
}

/** Attempts per source before it is parked until a click or a roster change. */
export const HARVEST_MAX_ATTEMPTS = 2
/** Backoff between attempts: bounds how often a failing source takes the slot. */
export const HARVEST_RETRY_BACKOFF_MS = 120_000
/**
 * An attempt that has produced no push by this deadline is abandoned. It is
 * derived from the shell boot budget (`boot-budget.ts`), so the coupling is
 * structural: a healthy source over a slow tunnel may legitimately take that
 * long, and reclaiming it mid-boot would turn the slow case into the exact
 * degradation this harvest exists to remove. The sweep additionally requires
 * the shell to have settled, so this deadline only ever judges a boot that
 * already finished.
 */
export const HARVEST_DEADLINE_MS = BOOT_TIMEOUT_MS + 15_000

/** Whether this source still needs (or still deserves) a harvest attempt. */
export function harvestPending(record: HarvestRecord | undefined): boolean {
  if (record === undefined) return true
  return !record.satisfied && record.attempts < HARVEST_MAX_ATTEMPTS
}

/**
 * A source that EXHAUSTED its attempt budget without ever landing a baseline.
 * It must not fall back to ordinary warm prewarm: that would give it a third
 * boot and (being `autoPrewarmed`) let it hold the single background slot — and
 * with one hidden shell retention never reclaims it, so no other source could
 * ever be prewarmed or harvested again for the rest of the session.
 */
export function harvestParked(record: HarvestRecord | undefined): boolean {
  return record !== undefined && !record.satisfied && record.attempts >= HARVEST_MAX_ATTEMPTS
}

/** Whether the backoff elapsed: the queue may start another attempt now. */
export function harvestRetryDue(record: HarvestRecord | undefined, now: number): boolean {
  return record === undefined || now >= record.retryAt
}

/** Record a started attempt (bounded) and arm its backoff. */
export function harvestAttemptStarted(record: HarvestRecord | undefined, now: number): HarvestRecord {
  return {
    attempts: (record?.attempts ?? 0) + 1,
    mountedAt: now,
    retryAt: now + HARVEST_RETRY_BACKOFF_MS,
    satisfied: false,
  }
}

/** Record the authoritative push that ends harvesting for this source. */
export function harvestSatisfied(record: HarvestRecord | undefined): HarvestRecord {
  return { attempts: record?.attempts ?? 0, mountedAt: 0, retryAt: 0, satisfied: true }
}

/** Whether an in-flight attempt passed its deadline without a push. */
export function harvestDeadlinePassed(record: HarvestRecord, now: number): boolean {
  return record.satisfied !== true && record.mountedAt > 0 && now - record.mountedAt >= HARVEST_DEADLINE_MS
}

/**
 * Absolute cap for an attempt whose shell NEVER settles (a hung fetch/loader
 * leaves `shellStates[id]` booting forever, so `harvestDeadlinePassed`'s
 * settled gate can never fire). Exceeds the deadline by the boot budget so a
 * slow-but-settling boot is always judged by the deadline first.
 */
export const HARVEST_ABANDON_MS = HARVEST_DEADLINE_MS + BOOT_TIMEOUT_MS

/** Whether an attempt never settled and must be abandoned (and parked). */
export function harvestAbandoned(record: HarvestRecord, now: number): boolean {
  return record.satisfied !== true && record.mountedAt > 0 && now - record.mountedAt >= HARVEST_ABANDON_MS
}

/**
 * Park a source whose attempt wedged: attempts exhausted, never satisfied. It
 * then fails `harvestPending` and `harvestParked` keeps it out of warm prewarm,
 * so the queue cannot retry it into the same wedge.
 */
export function harvestParkedRecord(): HarvestRecord {
  return { attempts: HARVEST_MAX_ATTEMPTS, mountedAt: 0, retryAt: 0, satisfied: false }
}

/**
 * The eligible set for the single background slot.
 *
 * While ANY harvest candidate is pending the slot is RESERVED for baseline
 * recovery: only harvest ids are eligible, so `pickPrewarmTarget` can reach a
 * due candidate behind a not-due head. A warm shell mounted instead would
 * become `autoPrewarmed`, and with exactly one hidden shell retention never
 * reclaims it (`excess = 1 - RETAINED_HIDDEN_VIEWS = 0`), so `remaining` would
 * be 0 for the rest of the session and every remaining source would stay in the
 * unary-fallback view — one failed source blocking all the others, which the
 * correctness invariants forbid. Idling the slot for one backoff window is the
 * bounded, accepted cost; warm prewarm resumes once no harvest is pending.
 * @param harvestIds - Ready, unmounted, still-harvest-pending source ids.
 * @param warmIds - Ready, unmounted, warm-prewarm-eligible source ids.
 * @param remaining - Free background slots (0 or 1 today).
 * @returns The eligible ids.
 */
export function prewarmCandidates(
  harvestIds: readonly string[],
  warmIds: readonly string[],
  remaining: number,
): string[] {
  if (remaining <= 0) return []
  if (harvestIds.length > 0) return [...harvestIds]
  return [...warmIds.slice(0, remaining)]
}

/**
 * Whether a satisfied harvest shell must give up the single background slot.
 *
 * Keeping the LAST harvested shell mounted saves a full background boot and
 * keeps that source's runtime facts live, but the slot must stay available for
 * baseline recovery: the kept shell is `autoPrewarmed` and hidden, so retention
 * never reclaims it (`excess = 1 - RETAINED_HIDDEN_VIEWS = 0`) and a source that
 * becomes ready later would never be harvested. So: yield as soon as any other
 * source still needs a baseline.
 * @param candidates - Current harvest candidates (ledger mirror).
 * @param selfId - The source whose push just landed.
 * @param isPending - Whether a candidate still needs an attempt.
 * @returns True when this shell must be reclaimed now.
 */
export function shouldReclaimHarvestedShell(
  candidates: ReadonlySet<string>,
  selfId: string,
  isPending: (id: string) => boolean,
): boolean {
  for (const id of candidates) {
    if (id !== selfId && isPending(id)) return true
  }
  return false
}

/**
 * Choose the next background mount from the queue: a DUE harvest candidate wins
 * over a warm shell (baseline recovery is the point of the slot), and a harvest
 * candidate still inside its backoff is skipped rather than blocking a later
 * due candidate behind it.
 * @param queue - Pending candidate ids in seeding order.
 * @param eligible - Current eligibility set (`prewarmCandidates`).
 * @param isHarvestPending - Whether the id still needs a harvest attempt.
 * @param isHarvestDue - Whether the id's harvest backoff elapsed.
 * @returns The chosen id, or undefined when nothing may mount now.
 */
export function pickPrewarmTarget(
  queue: readonly string[],
  eligible: ReadonlySet<string>,
  isHarvestPending: (id: string) => boolean,
  isHarvestDue: (id: string) => boolean,
): string | undefined {
  for (const id of queue) {
    if (eligible.has(id) && isHarvestPending(id) && isHarvestDue(id)) return id
  }
  for (const id of queue) {
    if (eligible.has(id) && !isHarvestPending(id)) return id
  }
  return undefined
}
