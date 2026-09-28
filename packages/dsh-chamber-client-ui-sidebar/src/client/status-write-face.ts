/**
 * The authoritative running-bit write face (upstream-drift batch-3 I-10).
 *
 * The tier-3 write-back in `index.ts` needs a way to push a proven-false running
 * bit into the official store. Upstream's write lives on the CONCRETE
 * `ClientSessions.handleSessionStatus()` member — public, but NOT part of the
 * `ISessions` contract (pinned by
 * `test/session-state/vendor-session-fact-contract.test.ts`, fact #3). This leaf
 * turns that fact into one probe with three outcomes, so the executor depends on
 * a tested face instead of a specific member name:
 *  - `contract`  — a contract method from {@link CONTRACT_STATUS_WRITE_METHODS}
 *    (empty today; extended in the same change that lands the upstream contract
 *    method, when the vendor lockstep test reds).
 *  - `concrete`  — `handleSessionStatus()`, upstream-public but non-contract:
 *    usable, with a WARN-once so a pin upgrade cannot drop it silently.
 *  - `none`      — no write face: the ladder degrades to read-only (no write-back).
 */

/** The write only ever asks false (see the tier-3 discipline in index.ts). */
export type StatusRunningWriter = (sessionId: string, running: boolean) => void

export type StatusWriteFaceKind = 'contract' | 'concrete' | 'none'

export interface StatusWriteFace {
  readonly kind: StatusWriteFaceKind
  /** Member that carries the write (`contract`/`concrete`); absent for `none`. */
  readonly member?: string
  /** true = upstream-public but outside the pinned `ISessions` contract. */
  readonly nonContract: boolean
  /** Bound writer; absent for `none`. */
  readonly write?: StatusRunningWriter
}

/**
 * Contract-shaped status-write methods, in probe order. EMPTY today: the pinned
 * `ISessions` contract exposes no status write
 * (`…/client/contract/sessions.ts`), which is exactly why the write-back is a
 * `concrete` face. When upstream ships the contract method
 * (upstream-proposals §4 item 6), the vendor lockstep test reds; add the real
 * name here in the same change — the probe then prefers it and the concrete WARN
 * disappears.
 */
export const CONTRACT_STATUS_WRITE_METHODS: readonly string[] = Object.freeze([])

/**
 * Probe one sessions service for its authoritative status-write face.
 * @param sessions - `ctx.sessions` (or a fixture).
 * @param contractMethods - contract probe table; override only in tests.
 * @returns the bound face; unknown/throwing services degrade to `none`.
 */
export function detectStatusWriteFace(
  sessions: unknown,
  contractMethods: readonly string[] = CONTRACT_STATUS_WRITE_METHODS,
): StatusWriteFace {
  try {
    if (sessions === null || typeof sessions !== 'object') return { kind: 'none', nonContract: false }
    const record = sessions as Record<string, unknown>
    for (const member of contractMethods) {
      const candidate = record[member]
      if (typeof candidate === 'function') {
        return {
          kind: 'contract',
          member,
          nonContract: false,
          write: (sessionId, running) => { (candidate as StatusRunningWriter).call(record, sessionId, running) },
        }
      }
    }
    const concrete = record.handleSessionStatus
    if (typeof concrete === 'function') {
      return {
        kind: 'concrete',
        member: 'handleSessionStatus',
        nonContract: true,
        write: (sessionId, running) => { (concrete as StatusRunningWriter).call(record, sessionId, running) },
      }
    }
    return { kind: 'none', nonContract: false }
  } catch {
    // A service proxy may throw on member access; an unavailable write face is a
    // degraded ladder, never a crash.
    return { kind: 'none', nonContract: false }
  }
}
