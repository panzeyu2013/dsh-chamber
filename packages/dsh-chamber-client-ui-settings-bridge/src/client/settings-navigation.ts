/**
 * Per-ctx settings-navigation seat: the settings shell owns the dialog, and other
 * plugins ask it to open one section.
 *
 * WHY a seat instead of a page-level event or lifted state: the shell is mounted per
 * instance boot ctx (design 05 §5), so a source-scoped request must reach exactly that
 * ctx's shell. A plain observable keyed by ctx keeps N-ctx isolation; the shell keeps
 * its local open/active state and only consumes a request, so no ownership moves. The
 * seat outlives a temporarily unmounted shell, so a request that arrives while the
 * settings chunk is still loading is consumed on mount instead of being dropped.
 */

/** One "open this section" request; `seq` makes repeated opens distinguishable. */
export interface SettingsOpenRequest {
  readonly seq: number
  readonly sectionId: string
}

/**
 * The seat: a per-ctx request channel plus the mutation the shell uses to consume one
 * request. Provided by the settings-bridge plugin as `chamberSettingsNavigation`;
 * consumers resolve it structurally (no chamber package dependency).
 */
export interface SettingsNavigationSeat {
  /** Latest unconsumed request, or undefined. */
  getRequest(): SettingsOpenRequest | undefined
  /** Subscribe to new requests; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /**
   * Queue a request to open `sectionId`, replacing any unconsumed one.
   * @param sectionId - the section to select.
   */
  open(sectionId: string): void
  /**
   * Mark `seq` consumed. A stale seq (already replaced) is ignored, so a slow
   * consumer can never clear a newer request.
   * @param seq - the request sequence the consumer handled.
   */
  acknowledge(seq: number): void
}

/** The shell-side decision for one request, or undefined when there is nothing to consume. */
export interface SettingsOpenCommand {
  /** Request sequence to acknowledge after the shell opens. */
  readonly seq: number
  /** Section to select. */
  readonly sectionId: string
}

/** What the shell does with a consumed request after a commit. */
export type SettingsAckDecision = 'ack' | 'drop' | 'wait'

/**
 * Decide a pending request's fate for the committed render. Acknowledge it when
 * its section is the one now active; drop it when the panel closed before the
 * request could be shown (a remount must not replay a dismissed open); wait while
 * the user is on another section, so a later visit to the requested section
 * completes the already-consumed request.
 * @param request - the consumed request awaiting an acknowledge, if any.
 * @param open - whether the panel is open in this commit.
 * @param activeId - the section selected in this commit.
 * @returns the decision, or undefined when no request is pending.
 */
export function settingsAckDecision(
  request: SettingsOpenRequest | undefined,
  open: boolean,
  activeId: string | undefined,
): SettingsAckDecision | undefined {
  if (request === undefined) return undefined
  if (!open) return 'drop'
  return activeId === request.sectionId ? 'ack' : 'wait'
}

/**
 * Decide whether a request is new and what the shell must do. The shell always
 * re-anchors the server dropdown to its OWN instance on consumption: the seat is
 * per boot ctx, so the requesting plugin and the consuming shell share that id
 * (the requested section lives in that source's ledger). Keeping the id out of
 * the command avoids a constant field.
 * @param request - latest seat request.
 * @param lastSeq - highest sequence already consumed by this shell.
 * @returns the command, or undefined for an absent/older request.
 */
export function settingsOpenCommand(
  request: SettingsOpenRequest | undefined,
  lastSeq: number,
): SettingsOpenCommand | undefined {
  if (request === undefined || request.seq <= lastSeq) return undefined
  return { seq: request.seq, sectionId: request.sectionId }
}

/**
 * Create the per-ctx seat. One instance per settings-bridge plugin (one per instance
 * boot ctx); the sequence starts at zero, so a fresh ctx never replays an old request.
 * @returns the seat.
 */
export function createSettingsNavigationSeat(): SettingsNavigationSeat {
  let request: SettingsOpenRequest | undefined
  let seq = 0
  const listeners = new Set<() => void>()
  return {
    getRequest: () => request,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: (sectionId) => {
      if (sectionId === '') return
      seq += 1
      request = { seq, sectionId }
      // Snapshot the listeners: a consumer may unsubscribe (or open again) inside.
      for (const listener of [...listeners]) listener()
    },
    acknowledge: (consumedSeq) => {
      if (request?.seq === consumedSeq) request = undefined
    },
  }
}
