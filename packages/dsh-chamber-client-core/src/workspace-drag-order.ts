/**
 * Pure workspace-drag order rules: ONE implementation of the repo-group
 * invariant, shared by drop marker, onDragOver gate, drop handler and commit.
 * Invariant: a git MAIN checkout and its derived (worktree) workspaces form a
 * contiguous family (main first, worktrees after in registry order); a drag
 * never moves a foreign workspace into a contiguous family's interior or a
 * worktree out of its own family, and dragging the family's main moves the
 * WHOLE family. Legacy non-contiguous families are not repaired by foreign
 * drops, but a worktree can never be dropped at or above its own main (only a
 * main drag heals). Fold-hidden rows render nothing, so an 'after' drop anchors
 * on the next VISIBLE row (view/commit lockstep).
 */
import type { WorkspaceGitFlag } from './workspace-git-flags.ts'

export interface WorkspaceDropOver {
  id: string
  half: 'before' | 'after'
}

export type WorkspaceDropVerdict =
  /** The position would break a contiguous repo family: marker suppressed, drop ignored. */
  | { kind: 'blocked' }
  /** Valid position but nothing changes (vanished pieces / already in place). */
  | { kind: 'noop' }
  /** Valid move: `moved` (block order, main first) lands before the element following it in `order` (append when none). */
  | { kind: 'move'; order: string[]; moved: string[] }

export interface WorkspaceDropEnv {
  /** Real workspace ids in the current display order (no ungrouped/synthetic buckets — neither draggable nor drop targets). */
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
  // Vanished target or dragged row: nothing to commit (id-keyed, never index-keyed — a mid-drag re-render/poll may drop either).
  const targetIndex = order.indexOf(over.id)
  if (targetIndex === -1) return { kind: 'noop' }
  if (!order.includes(draggedId)) return { kind: 'noop' }

  // The dragged unit: the whole family when the dragged row IS the family head (flag lag still counts), else the single row.
  const dragFlag = flag(draggedId)
  const ownDerived = derivedOf(order, draggedId, flag)
  const moved = dragFlag?.isMain === true || ownDerived.length > 0
    ? [draggedId, ...ownDerived]
    : [draggedId]

  // Where the unit lands: 'before' = at the target row; 'after' = at the next VISIBLE row (fold-hidden rows render nothing between).
  let anchor: string | undefined
  if (over.half === 'before') {
    anchor = over.id
  } else {
    let i = targetIndex + 1
    while (i < order.length && hidden(order[i]!)) i += 1
    anchor = order[i]
  }
  // Dropping inside the dragged unit's own span (main onto one of its worktrees) leaves the order untouched.
  if (anchor !== undefined && moved.includes(anchor)) return { kind: 'noop' }

  const rest = order.filter(id => !moved.includes(id))
  const anchorIndex = anchor === undefined ? rest.length : rest.indexOf(anchor)
  if (anchor !== undefined && anchorIndex === -1) return { kind: 'noop' }
  const candidate = [...rest.slice(0, anchorIndex), ...moved, ...rest.slice(anchorIndex)]
  if (candidate.length === order.length && candidate.every((id, i) => id === order[i])) {
    return { kind: 'noop' }
  }

  // A drop is blocked when it splits a currently-contiguous family; broken (legacy) families stay unconstrained until a main drag heals them.
  const families = familiesOf(order, flag)
  for (const [headId, members] of families) {
    if (!contiguous(order, headId, members)) continue
    if (!contiguous(candidate, headId, members)) return { kind: 'blocked' }
  }

  // Absolute head-first rule for the dragged row itself: a worktree may never END UP at or
  // above its own main — the contiguous-family check above skips broken families, so without
  // this a split worktree could be dragged above its main, deepening the violation.
  const dragMainId = dragFlag?.isWorktree === true ? dragFlag.mainWorkspaceId : undefined
  if (dragMainId !== undefined && order.includes(dragMainId)) {
    const draggedAt = candidate.indexOf(draggedId)
    const mainAt = candidate.indexOf(dragMainId)
    if (draggedAt !== -1 && mainAt !== -1 && draggedAt < mainAt) return { kind: 'blocked' }
  }

  return { kind: 'move', order: candidate, moved }
}
