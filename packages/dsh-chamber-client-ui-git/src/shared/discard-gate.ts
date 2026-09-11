/**
 * Discard-authorization decisions of the remove-worktree dialog
 * (2026-09-11 review-fix, F1/F2).
 *
 * A removal needs at most ONE explicit discard authorization, and BOTH ways of
 * needing it — a dirty working tree (design 08 §5.3) and a submodule checkout
 * Git refuses to drop without force (2026-09, refusal code
 * `worktree-submodules`) — are collected by the official `RiskConfirmation` and
 * then ride the SAME `discardChanges` wire flag (the host's `--force`).
 *
 * The dialog asks `nextDiscardGate` at CLICK time and, when it answers a kind,
 * HOLDS that kind in state for as long as the gate is up. The answer goes back
 * to `null` the moment the acknowledgement it named is ticked, so deriving the
 * gate's own `open` from it would dismiss the gate before its confirm could ever
 * run — the confirm became dead code and the removal needed a second `Remove`
 * click (2026-09-11 review-fix, F1). `discardAuthorized` is the other half:
 * whether the removal may send `discardChanges: true`.
 */

/** The two acknowledgements the official `RiskConfirmation` gate can collect. */
export type DiscardGateKind = 'dirty' | 'submodule'

/** The dialog's current authorization facts; both flags are its own state. */
export interface DiscardGateFacts {
  /** The target is dirty, or the fresh preflight reported it dirty (stale row
   *  fact). */
  needsDiscardConfirmation: boolean
  /** The dirty acknowledgement is already given (`discardChanges`). */
  discardChanges: boolean
  /** The host refused with `worktree-submodules` (deterministic, pre-mutation,
   *  nothing removed). */
  submoduleBlock: boolean
  /** The submodule acknowledgement is already given. */
  discardSubmodules: boolean
}

/** Which discard authorization a `Remove` click still has to collect: the dirty
 *  one first (it covers a worktree that is ALSO blocked by a submodule), then
 *  the submodule one, else none — in which case the click removes directly.
 *  @param facts - the dialog's current authorization facts.
 *  @returns the gate kind to open, or null when nothing is missing. */
export function nextDiscardGate(facts: DiscardGateFacts): DiscardGateKind | null {
  if (facts.needsDiscardConfirmation && !facts.discardChanges) return 'dirty'
  if (facts.submoduleBlock && !facts.discardSubmodules) return 'submodule'
  return null
}

/** Whether the removal may carry `discardChanges: true` (the host's `--force`).
 *  Either acknowledgement authorizes it: both mean "discard the checkout's
 *  working-tree content", the single thing that flag turns on. The branch, its
 *  commits and HEAD stay untouched in both cases.
 *  @param facts - the dialog's current authorization facts.
 *  @returns true when one of the two acknowledgements is given. */
export function discardAuthorized(facts: DiscardGateFacts): boolean {
  return (facts.needsDiscardConfirmation && facts.discardChanges)
    || (facts.submoduleBlock && facts.discardSubmodules)
}
