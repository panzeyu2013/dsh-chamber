/**
 * Pure workspace-drag order rules (design 06 §2.2 / design 08 §11): ONE
 * implementation of the repo-group invariant, shared by the drop marker, the
 * onDragOver gate, the drop handler and the commit — the visual, the accepted
 * drop and the committed order can no longer drift.
 *
 * Invariant (user decision 2026-08, completed 2026-12): a git MAIN checkout
 * and its derived (worktree) workspaces form a contiguous family — the main
 * first, its worktrees after it in the registry order. A drag therefore:
 *  - may never move a foreign workspace INTO a contiguous family's interior;
 *  - may never move a worktree out of its own family (it reorders inside);
 *  - when dragging the family's main, moves the WHOLE family as one block
 *    (a main drag relocates the group; it can never split it).
 * Families that are already non-contiguous (legacy interleaved orders) are
 * not repaired by foreign drops — they stop constraining them until a main
 * drag pulls the members back together (moved = the whole family, main
 * first). One rule stays ABSOLUTE in a broken family too: a worktree can
 * never be dropped at or above its own main — the violation is never
 * deepened; only the main's own drag heals the family.
 *
 * Rows hidden by their main's repo-group fold render nothing (design 08
 * §11.7), so an 'after' drop must anchor on the next VISIBLE row — the
 * resolver takes a hidden() verdict per row to keep view and commit in
 * lockstep (a marker drawn below a visible row lands below the hidden block
 * that follows it).
 */
import type { WorkspaceGitFlag } from './workspace-git-flags.ts'

export interface WorkspaceDropOver {
  id: string
  half: 'before' | 'after'
}

export type WorkspaceDropVerdict =
  /** The position would break a contiguous repo family: marker suppressed,
   *  drop ignored (nothing moves). */
  | { kind: 'blocked' }
  /** Valid position but nothing changes (vanished pieces / already in place). */
  | { kind: 'noop' }
  /** Valid move: `moved` (block order, main first) lands before the element
   *  following it in `order` (append when none). */
  | { kind: 'move'; order: string[]; moved: string[] }

export interface WorkspaceDropEnv {
  /** Real workspace ids in the current display order (no ungrouped /
   *  synthetic buckets — they are neither draggable nor drop targets). */
  order: readonly string[]
  /** Per-workspace git flag lookup (shared/workspace-git-flags.ts). */
  flag: (workspaceId: string) => WorkspaceGitFlag | undefined
  /** Whether a row is hidden by its repo group's fold (renders nothing). */
  hidden: (workspaceId: string) => boolean
}

/** Derived members (worktrees) of `headId` present in `order`, in order. */
function derivedOf(order: readonly string[], headId: string, flag: WorkspaceDropEnv['flag']): string[] {
  const derived: string[] = []
  for (const id of order) {
    if (flag(id)?.mainWorkspaceId === headId) derived.push(id)
  }
  return derived
}

/** All members of the family `order` actually contains, keyed by head id. */
function familiesOf(order: readonly string[], flag: WorkspaceDropEnv['flag']): Map<string, string[]> {
  const families = new Map<string, string[]>()
  for (const id of order) {
    const mainId = flag(id)?.mainWorkspaceId
    if (mainId === undefined || !order.includes(mainId)) continue
    const members = families.get(mainId)
    if (members === undefined) families.set(mainId, [id])
    else members.push(id)
  }
  return families
}

/** True when the head and all its derived rows form one run, head first. */
function contiguous(list: readonly string[], headId: string, members: readonly string[]): boolean {
  const first = list.indexOf(headId)
  if (first === -1) return false
  for (const member of members) {
    if (list.indexOf(member) < first) return false
  }
  for (let i = 0; i < members.length; i += 1) {
    const id = list[first + 1 + i]
    if (id === undefined || !members.includes(id)) return false
  }
  return true
}

export function resolveWorkspaceDrop(
  env: WorkspaceDropEnv,
  draggedId: string,
  over: WorkspaceDropOver,
): WorkspaceDropVerdict {
  const { order, flag, hidden } = env
  // Vanished target or dragged row: nothing to commit (id-keyed, never
  // index-keyed — a mid-drag re-render/poll may drop either).
  const targetIndex = order.indexOf(over.id)
  if (targetIndex === -1) return { kind: 'noop' }
  if (!order.includes(draggedId)) return { kind: 'noop' }

  // The dragged unit: the whole family when the dragged row IS the family
  // head (a main drag relocates the group; the head also counts when only the
  // worktrees still carry the link — flag lag), the single row otherwise.
  const dragFlag = flag(draggedId)
  const ownDerived = derivedOf(order, draggedId, flag)
  const moved = dragFlag?.isMain === true || ownDerived.length > 0
    ? [draggedId, ...ownDerived]
    : [draggedId]

  // Where the unit lands: 'before' = at the target row; 'after' = at the
  // next VISIBLE row (fold-hidden rows render nothing between visible rows).
  let anchor: string | undefined
  if (over.half === 'before') {
    anchor = over.id
  } else {
    let i = targetIndex + 1
    while (i < order.length && hidden(order[i]!)) i += 1
    anchor = order[i]
  }
  // Dropping inside the dragged unit's own span (e.g. the main onto one of
  // its worktrees) leaves the order untouched.
  if (anchor !== undefined && moved.includes(anchor)) return { kind: 'noop' }

  const rest = order.filter(id => !moved.includes(id))
  const anchorIndex = anchor === undefined ? rest.length : rest.indexOf(anchor)
  if (anchor !== undefined && anchorIndex === -1) return { kind: 'noop' }
  const candidate = [...rest.slice(0, anchorIndex), ...moved, ...rest.slice(anchorIndex)]
  if (candidate.length === order.length && candidate.every((id, i) => id === order[i])) {
    return { kind: 'noop' }
  }

  // A drop is blocked when it splits a family that is contiguous right now.
  // Broken (legacy) families stay unconstrained until a main drag heals them.
  const families = familiesOf(order, flag)
  for (const [headId, members] of families) {
    if (!contiguous(order, headId, members)) continue
    if (!contiguous(candidate, headId, members)) return { kind: 'blocked' }
  }

  // Absolute head-first rule for the dragged row itself: a worktree may never
  // END UP at or above its own main — this holds in a legacy-broken family
  // too (the constraint above skips non-contiguous families, so without this
  // check a split worktree could be dragged above its main, deepening the
  // violation the old render gate always refused).
  const dragMainId = dragFlag?.isWorktree === true ? dragFlag.mainWorkspaceId : undefined
  if (dragMainId !== undefined && order.includes(dragMainId)) {
    const draggedAt = candidate.indexOf(draggedId)
    const mainAt = candidate.indexOf(dragMainId)
    if (draggedAt !== -1 && mainAt !== -1 && draggedAt < mainAt) return { kind: 'blocked' }
  }

  return { kind: 'move', order: candidate, moved }
}
