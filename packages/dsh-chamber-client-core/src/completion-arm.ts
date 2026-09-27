/**
 * N-ctx completion-arm correction — the ONLY chamber-side state in the
 * completed-unread model.
 *
 * Authority is the vendor's own `uiSession.sessionStatus.completionUnread`
 * (memory-only; armed on a running→idle edge while the session is NOT retained
 * by this ctx's main view; cleared on re-running, on becoming main-retained, or
 * when the row leaves a ready list). The chamber keeps every mounted instance
 * view alive with its own mainView retention across source switches (session
 * keep-alive, design 06 §4.2), so a HIDDEN source's last-opened session keeps
 * `isMain === true` forever and every completion in it is silently never armed.
 * That session is exactly the one the user just left — the most likely
 * background completion.
 *
 * This pure step fills ONLY that hole: each fresh running→idle edge can arm the
 * ctx's mainView-retained `current` row of a source that is not painted. It is
 * ROW-keyed and never sweeps — reading one row clears only that row — so a source
 * whose `current` moved on can hold one arm per distinct completed row (exactly
 * the upstream "N unread sessions" semantics). Disarmed by re-running, by reading
 * it (the source becomes painted with that row as its current), or by leaving an
 * authoritative list. Source retirement is the App dropping the whole per-source
 * table, so this step never sees it.
 *
 * Deliberately NOT a second ledger: no persistence, no watermark, no clock, no
 * facts track. When the official bit is true the arm is irrelevant —
 * `mergeRuntimeFacts` ORs them, and the vendor clears its own bit on reading.
 */

/** Fresh-channel rows of one source (the per-session facts slice the channel reports). */
export type CompletionArmRows = Readonly<Record<string, { running?: boolean } | undefined>>

/** One step's inputs: the App's reading fact plus that source's fresh report. */
export interface CompletionArmStepInput {
  /** The ctx's mainView-retained row (the vendor `isMain` target), if any. */
  current: string | undefined
  /** Fresh channel rows; undefined = no report (freeze — memory kept, never arm). */
  rows: CompletionArmRows | undefined
  /** The source is the PAINTED (on-screen) view — the App fact, never the bridge selection. */
  painted: boolean
  /** The official list is authoritative (an absent row means deleted). */
  listComplete: boolean
  /** A stale (disconnected) report is never arm evidence. */
  stale: boolean
}

/** Next state for one source. `arms` is row-keyed: an entry comes only from
 * that row's own completion edge (no sweep), so no stale true survives in it. */
export interface CompletionArmStepResult {
  arms: Record<string, boolean>
  running: Record<string, boolean>
  changed: boolean
}

/** True-only table comparison (absent = false); the tables never store false. */
export function sameTrueTable(
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if ((left[key] === true) !== (right[key] === true)) return false
  }
  return true
}

export function stepCompletionArm(
  prevArms: Readonly<Record<string, boolean>>,
  prevRunning: Readonly<Record<string, boolean>>,
  input: CompletionArmStepInput,
): CompletionArmStepResult {
  if (input.rows === undefined) {
    // Freeze: no report means no evidence either way (never arm, never clear).
    return { arms: { ...prevArms }, running: { ...prevRunning }, changed: false }
  }
  const nextRunning: Record<string, boolean> = {}
  for (const [id, row] of Object.entries(input.rows)) {
    if (row?.running === true) nextRunning[id] = true
  }
  const arms: Record<string, boolean> = { ...prevArms }
  // Re-running disarms (the vendor deletes its own bit on the same edge).
  for (const id of Object.keys(nextRunning)) if (arms[id] === true) delete arms[id]
  // Reading disarms: the painted source is showing its current row.
  if (input.painted && input.current !== undefined && arms[input.current] === true) delete arms[input.current]
  // Authoritative list: rows that left it drop both the arm and the edge memory.
  if (input.listComplete) {
    for (const id of Object.keys(arms)) if (input.rows[id] === undefined) delete arms[id]
    for (const id of Object.keys(prevRunning)) if (input.rows[id] === undefined) delete nextRunning[id]
  }
  // The hole: the vendor suppressed this completion as main-retained, while the
  // user is on another source. Exactly one candidate per source (the current row).
  if (!input.painted && !input.stale && input.current !== undefined
    && prevRunning[input.current] === true && input.rows[input.current]?.running === false) {
    arms[input.current] = true
  }
  const changed = !sameTrueTable(arms, prevArms) || !sameTrueTable(nextRunning, prevRunning)
  return { arms, running: nextRunning, changed }
}
