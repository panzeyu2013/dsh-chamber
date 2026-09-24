/**
 * Discard-authorization decisions of the remove-worktree dialog.
 * A removal needs at most ONE explicit discard authorization, and BOTH ways of needing it —
 * a dirty working tree (design 08 §5.3) and a submodule checkout Git refuses to drop without
 * force (`worktree-submodules`) — are collected by the official `RiskConfirmation` and then
 * ride the SAME `discardChanges` wire flag (the host's `--force`).
 * `nextDiscardGate` is asked at CLICK time and the dialog HOLDS the answered kind for as long
 * as the gate is up: the answer goes back to null the moment the named acknowledgement is
 * ticked, so deriving the gate's own `open` from it would dismiss the gate before its confirm
 * could run (dead code + a second `Remove` click).
 */

/** The two acknowledgements the official `RiskConfirmation` gate can collect. */
export type DiscardGateKind = 'dirty' | 'submodule'

/** The dialog's current authorization facts; both flags are its own state. */
export interface DiscardGateFacts {
  /** The target is dirty, or the fresh preflight reported it dirty (stale row fact). */
  needsDiscardConfirmation: boolean
  /** The dirty acknowledgement is already given (`discardChanges`). */
  discardChanges: boolean
  /** The host refused with `worktree-submodules` (deterministic, pre-mutation, nothing removed). */
  submoduleBlock: boolean
  /** The submodule acknowledgement is already given. */
  discardSubmodules: boolean
}

/** Which discard authorization a `Remove` click still has to collect: the dirty one
 *  first (it covers a worktree also blocked by a submodule), then the submodule one,
 *  else none — in which case the click removes directly. */
export function nextDiscardGate(facts: DiscardGateFacts): DiscardGateKind | null {
  if (facts.needsDiscardConfirmation && !facts.discardChanges) return 'dirty'
  if (facts.submoduleBlock && !facts.discardSubmodules) return 'submodule'
  return null
}

/** Whether the removal may carry `discardChanges: true` (the host's `--force`):
 *  either acknowledgement authorizes it, and the branch, its commits and HEAD stay
 *  untouched in both cases. */
export function discardAuthorized(facts: DiscardGateFacts): boolean {
  return (facts.needsDiscardConfirmation && facts.discardChanges)
    || (facts.submoduleBlock && facts.discardSubmodules)
}
