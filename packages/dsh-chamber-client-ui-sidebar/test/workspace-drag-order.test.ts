/**
 * workspace-drag-order.ts unit tests (plain node:test, no dsh, no DOM): the
 * single drop resolver behind the workspace-drag marker / onDragOver gate /
 * drop handler / commit (design 06 §2.2, design 08 §11). Covers the repo
 * family invariant: no foreign workspace may land INSIDE a contiguous family,
 * a worktree reorders only within its family, a main drag relocates the whole
 * family, and marker/commit lockstep over fold-hidden rows.
 *
 * Invariant of the fixtures: the dragged workspace is always a member of
 * `order` (a drag starts on an existing row).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWorkspaceDrop, type WorkspaceDropEnv, type WorkspaceDropVerdict } from '../src/shared/workspace-drag-order.ts'
import type { WorkspaceGitFlag } from '../src/shared/workspace-git-flags.ts'

/** Build a drop environment: order + per-id git flags + a hidden set. */
function env(
  order: string[],
  flags: Record<string, Partial<WorkspaceGitFlag>>,
  hiddenIds: string[] = [],
): WorkspaceDropEnv {
  return {
    order,
    flag: id => (flags[id] === undefined ? undefined : (flags[id] as WorkspaceGitFlag)),
    hidden: id => hiddenIds.includes(id),
  }
}

/** Common flags: M is the main of worktrees W1/W2; B of BW1. */
function repoFlags(): Record<string, Partial<WorkspaceGitFlag>> {
  return {
    M: { isWorktree: false, isMain: true, repoKey: 'r' },
    W1: { isWorktree: true, isMain: false, mainWorkspaceId: 'M', repoKey: 'r' },
    W2: { isWorktree: true, isMain: false, mainWorkspaceId: 'M', repoKey: 'r' },
    B: { isWorktree: false, isMain: true, repoKey: 's' },
    BW1: { isWorktree: true, isMain: false, mainWorkspaceId: 'B', repoKey: 's' },
  }
}

function expectMove(verdict: WorkspaceDropVerdict): { order: string[]; moved: string[] } {
  assert.equal(verdict.kind, 'move', `expected a move, got ${verdict.kind}`)
  const move = verdict as { kind: 'move'; order: string[]; moved: string[] }
  return { order: move.order, moved: move.moved }
}

function expectBlocked(verdict: WorkspaceDropVerdict): void {
  assert.equal(verdict.kind, 'blocked', `expected blocked, got ${verdict.kind}`)
}

function expectNoop(verdict: WorkspaceDropVerdict): void {
  assert.equal(verdict.kind, 'noop', `expected noop, got ${verdict.kind}`)
}

// ---------------------------------------------------------------------------
// Foreign workspaces must never land inside a contiguous family
// ---------------------------------------------------------------------------

test('foreign drop into the family interior is blocked', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2', 'F'], flags)
  // The reported bug: inserting a foreign workspace after the main (between
  // it and its first worktree) or between two worktrees.
  expectBlocked(resolveWorkspaceDrop(e, 'F', { id: 'M', half: 'after' }))
  expectBlocked(resolveWorkspaceDrop(e, 'F', { id: 'W1', half: 'before' }))
  expectBlocked(resolveWorkspaceDrop(e, 'F', { id: 'W1', half: 'after' }))
  expectBlocked(resolveWorkspaceDrop(e, 'F', { id: 'W2', half: 'before' }))
})

test('foreign drops on the family exterior are legal', () => {
  const flags = repoFlags()
  // F below the family: above the head is a real move...
  const e = env(['M', 'W1', 'W2', 'F'], flags)
  const above = expectMove(resolveWorkspaceDrop(e, 'F', { id: 'M', half: 'before' }))
  assert.deepEqual(above.order, ['F', 'M', 'W1', 'W2'])
  // ...sitting at the tail is a noop...
  expectNoop(resolveWorkspaceDrop(e, 'F', { id: 'W2', half: 'after' }))
  // ...and the interior just above the tail stays blocked.
  expectBlocked(resolveWorkspaceDrop(e, 'F', { id: 'W2', half: 'before' }))
  // F above the family: moving below the whole family is legal.
  const e2 = env(['F', 'M', 'W1', 'W2'], flags)
  const below = expectMove(resolveWorkspaceDrop(e2, 'F', { id: 'W2', half: 'after' }))
  assert.deepEqual(below.order, ['M', 'W1', 'W2', 'F'])
})

test('foreign drop between two adjacent families is legal', () => {
  const flags = repoFlags()
  const e = env(['F', 'M', 'W1', 'B', 'BW1'], flags)
  const move = expectMove(resolveWorkspaceDrop(e, 'F', { id: 'B', half: 'before' }))
  assert.deepEqual(move.order, ['M', 'W1', 'F', 'B', 'BW1'])
  assert.deepEqual(move.moved, ['F'])
})

test('a family head of another repo is equally blocked inside a family', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2', 'B', 'BW1'], flags)
  expectBlocked(resolveWorkspaceDrop(e, 'B', { id: 'W1', half: 'before' }))
  expectBlocked(resolveWorkspaceDrop(e, 'B', { id: 'M', half: 'after' }))
})

// ---------------------------------------------------------------------------
// Worktrees reorder inside their own family only
// ---------------------------------------------------------------------------

test('worktree drags inside the family produce moves', () => {
  const flags = repoFlags()
  const toTail = expectMove(resolveWorkspaceDrop(env(['M', 'W1', 'W2'], flags), 'W1', { id: 'W2', half: 'after' }))
  assert.deepEqual(toTail.order, ['M', 'W2', 'W1'])
  const toHead = expectMove(resolveWorkspaceDrop(env(['M', 'W2', 'W1'], flags), 'W1', { id: 'W2', half: 'before' }))
  assert.deepEqual(toHead.order, ['M', 'W1', 'W2'])
})

test('worktree drop before its own main is blocked', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2'], flags)
  expectBlocked(resolveWorkspaceDrop(e, 'W1', { id: 'M', half: 'before' }))
})

test('worktree drop onto the family tail edge is legal, beyond it is blocked', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2', 'X'], flags)
  // Directly after the last member: interior reorder to the tail.
  const tail = expectMove(resolveWorkspaceDrop(e, 'W1', { id: 'W2', half: 'after' }))
  assert.deepEqual(tail.order, ['M', 'W2', 'W1', 'X'])
  // 'before X' == tail edge (X directly follows the family) — legal too.
  const edge = expectMove(resolveWorkspaceDrop(e, 'W1', { id: 'X', half: 'before' }))
  assert.deepEqual(edge.order, ['M', 'W2', 'W1', 'X'])
  // Past X the family would split — blocked.
  const e2 = env(['M', 'W1', 'W2', 'X', 'Y'], flags)
  expectBlocked(resolveWorkspaceDrop(e2, 'W1', { id: 'X', half: 'after' }))
  expectBlocked(resolveWorkspaceDrop(e2, 'W1', { id: 'Y', half: 'before' }))
})

test('worktree drop onto itself or its own place is a noop', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2'], flags)
  expectNoop(resolveWorkspaceDrop(e, 'W1', { id: 'W1', half: 'before' }))
  expectNoop(resolveWorkspaceDrop(e, 'W1', { id: 'W1', half: 'after' }))
  // 'after M' anchors on W1 itself (the dragged row) — its own spot.
  expectNoop(resolveWorkspaceDrop(e, 'W1', { id: 'M', half: 'after' }))
})

test('worktree drop above its own main is blocked even in a legacy-broken family', () => {
  const flags = repoFlags()
  // W2 is split away from [M, W1]; placing it at or above M stays refused
  // (the head-first rule is absolute — a broken family is never deepened,
  // only the main's own drag heals it).
  const e = env(['M', 'W1', 'F', 'W2'], flags)
  expectBlocked(resolveWorkspaceDrop(e, 'W2', { id: 'M', half: 'before' }))
  // Below the main stays legal and partly heals the interleaving...
  const heal = expectMove(resolveWorkspaceDrop(e, 'W2', { id: 'W1', half: 'after' }))
  assert.deepEqual(heal.order, ['M', 'W1', 'W2', 'F'])
  // ...while its own current spot (right after F) is an identity noop.
  expectNoop(resolveWorkspaceDrop(e, 'W2', { id: 'F', half: 'after' }))
})

// ---------------------------------------------------------------------------
// Main drags relocate the whole family as a block
// ---------------------------------------------------------------------------

test('main drag to the top moves the family above the foreign row (no split)', () => {
  const flags = repoFlags()
  const e = env(['Y', 'M', 'W1', 'W2'], flags)
  const move = expectMove(resolveWorkspaceDrop(e, 'M', { id: 'Y', half: 'before' }))
  assert.deepEqual(move.order, ['M', 'W1', 'W2', 'Y'])
  assert.deepEqual(move.moved, ['M', 'W1', 'W2'])
})

test('main drag below the family relocates the whole group', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2', 'Y'], flags)
  const move = expectMove(resolveWorkspaceDrop(e, 'M', { id: 'Y', half: 'after' }))
  assert.deepEqual(move.order, ['Y', 'M', 'W1', 'W2'])
  // Same when a foreign row separates the family from the tail.
  const e2 = env(['X', 'M', 'W1', 'W2', 'Y'], flags)
  const move2 = expectMove(resolveWorkspaceDrop(e2, 'M', { id: 'Y', half: 'after' }))
  assert.deepEqual(move2.order, ['X', 'Y', 'M', 'W1', 'W2'])
})

test('main drag into another family interior is blocked', () => {
  const flags = repoFlags()
  // M's whole family dropped between B and BW1 would split B's family.
  const e = env(['M', 'W1', 'W2', 'B', 'BW1'], flags)
  expectBlocked(resolveWorkspaceDrop(e, 'M', { id: 'BW1', half: 'before' }))
  expectBlocked(resolveWorkspaceDrop(e, 'M', { id: 'B', half: 'after' }))
})

test('main drop inside its own family span is a noop', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2'], flags)
  expectNoop(resolveWorkspaceDrop(e, 'M', { id: 'W1', half: 'before' }))
  expectNoop(resolveWorkspaceDrop(e, 'M', { id: 'W1', half: 'after' }))
  // 'after W2' with nothing after the family = already at the tail.
  expectNoop(resolveWorkspaceDrop(e, 'M', { id: 'W2', half: 'after' }))
  // Same with a foreign row below.
  expectNoop(resolveWorkspaceDrop(env(['Y', 'M', 'W1', 'W2'], flags), 'M', { id: 'W2', half: 'after' }))
})

test('main without derived rows moves like a plain workspace', () => {
  const flags = { M: { isWorktree: false, isMain: true, repoKey: 'r' } }
  const move = expectMove(resolveWorkspaceDrop(env(['M', 'X'], flags), 'M', { id: 'X', half: 'after' }))
  assert.deepEqual(move.order, ['X', 'M'])
  assert.deepEqual(move.moved, ['M'])
})

test('main drag heals a legacy split: members are pulled together, main first', () => {
  const flags = repoFlags()
  const e = env(['W1', 'M', 'X', 'W2'], flags)
  const move = expectMove(resolveWorkspaceDrop(e, 'M', { id: 'X', half: 'before' }))
  assert.deepEqual(move.moved, ['M', 'W1', 'W2'])
  // The block lands at X's position with the head first.
  assert.equal(move.order[0], 'M')
  assert.equal(move.order[3], 'X')
  assert.deepEqual(new Set(move.order.slice(0, 3)), new Set(['M', 'W1', 'W2']))
})

test('main drop already in place is a noop', () => {
  const flags = repoFlags()
  const e = env(['Y', 'M', 'W1', 'W2', 'Z'], flags)
  expectNoop(resolveWorkspaceDrop(e, 'M', { id: 'Y', half: 'after' }))
  // Drop lines at the family tail with a foreign row directly below — the
  // family already occupies the spot, both boundaries are identity noops.
  const e2 = env(['M', 'W1', 'W2', 'X'], flags)
  expectNoop(resolveWorkspaceDrop(e2, 'M', { id: 'W2', half: 'after' }))
  expectNoop(resolveWorkspaceDrop(e2, 'M', { id: 'X', half: 'before' }))
})

// ---------------------------------------------------------------------------
// Vanished pieces, broken orders, flag lag
// ---------------------------------------------------------------------------

test('vanished dragged row or target is a noop', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2'], flags)
  expectNoop(resolveWorkspaceDrop(e, 'GHOST', { id: 'W1', half: 'before' }))
  expectNoop(resolveWorkspaceDrop(e, 'W1', { id: 'GHOST', half: 'before' }))
})

test('head row without its own isMain flag still drags as a family head', () => {
  // Flag lag: the main's own flag has not been re-published but the worktree
  // still carries the link — dragging the main must still move the family.
  const flags = { W1: { isWorktree: true, isMain: false, mainWorkspaceId: 'M', repoKey: 'r' } }
  const move = expectMove(resolveWorkspaceDrop(env(['Y', 'M', 'W1'], flags), 'M', { id: 'Y', half: 'before' }))
  assert.deepEqual(move.moved, ['M', 'W1'])
})

test('worktrees of an absent main are unconstrained (no family to keep)', () => {
  const flags = {
    W1: { isWorktree: true, isMain: false, mainWorkspaceId: 'GONE', repoKey: 'r' },
    W2: { isWorktree: true, isMain: false, mainWorkspaceId: 'GONE', repoKey: 'r' },
  }
  const move = expectMove(resolveWorkspaceDrop(env(['W1', 'X', 'Y'], flags), 'W1', { id: 'Y', half: 'before' }))
  assert.deepEqual(move.order, ['X', 'W1', 'Y'])
  // Siblings of the same absent main: no head to protect, so a foreign row
  // may interleave freely between them.
  const interleave = expectMove(resolveWorkspaceDrop(env(['W1', 'W2', 'F'], flags), 'F', { id: 'W2', half: 'before' }))
  assert.deepEqual(interleave.order, ['W1', 'F', 'W2'])
})

test('already-broken families do not block foreign drops until healed', () => {
  const flags = repoFlags()
  // W2 is split away from [M, W1] — nothing contiguous to protect, so X may
  // land between W1 and F; the broken family is only healed by a main drag.
  const e = env(['M', 'W1', 'F', 'W2', 'X'], flags)
  const move = expectMove(resolveWorkspaceDrop(e, 'X', { id: 'F', half: 'before' }))
  assert.deepEqual(move.order, ['M', 'W1', 'X', 'F', 'W2'])
})

// ---------------------------------------------------------------------------
// Fold-hidden rows (design 08 §11.7): 'after' anchors on the next visible row
// ---------------------------------------------------------------------------

test("'after' a visible row skips the hidden rows that follow it", () => {
  const flags = repoFlags()
  // M folded: W1 + W2 render nothing between M and X.
  const e = env(['F', 'M', 'W1', 'W2', 'X'], flags, ['W1', 'W2'])
  const move = expectMove(resolveWorkspaceDrop(e, 'F', { id: 'M', half: 'after' }))
  assert.deepEqual(move.order, ['M', 'W1', 'W2', 'F', 'X'])
})

test('hidden rows keep blocking foreign interior drops (commit side)', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2', 'F', 'X'], flags, ['W1', 'W2'])
  // A stale over on a now-hidden worktree interior is still rejected.
  expectBlocked(resolveWorkspaceDrop(e, 'F', { id: 'W2', half: 'before' }))
})

test("'after' a visible row appends below a fold block that runs to the list end", () => {
  const flags = repoFlags()
  // M folded, W1 + W2 hidden to the very end: 'after M' has no next visible
  // row, so the unit appends — the marker below M lands below the block.
  const e = env(['F', 'M', 'W1', 'W2'], flags, ['W1', 'W2'])
  const move = expectMove(resolveWorkspaceDrop(e, 'F', { id: 'M', half: 'after' }))
  assert.deepEqual(move.order, ['M', 'W1', 'W2', 'F'])
})

test('a worktree above its main can drag down to the tail (self-heal)', () => {
  const flags = repoFlags()
  // Legacy split with W1 ABOVE M: only the at/above-main placement is
  // absolute — dragging W1 down to the tail heals the family.
  const e = env(['W1', 'M', 'W2'], flags)
  const move = expectMove(resolveWorkspaceDrop(e, 'W1', { id: 'W2', half: 'after' }))
  assert.deepEqual(move.order, ['M', 'W2', 'W1'])
})

test('a folded family relocates as a block on a main drag', () => {
  const flags = repoFlags()
  const e = env(['M', 'W1', 'W2', 'X'], flags, ['W1', 'W2'])
  const move = expectMove(resolveWorkspaceDrop(e, 'M', { id: 'X', half: 'after' }))
  assert.deepEqual(move.order, ['X', 'M', 'W1', 'W2'])
})

// ---------------------------------------------------------------------------
// Plain workspaces keep full freedom outside families
// ---------------------------------------------------------------------------

test('plain workspace drop is a noop at its own place and a move elsewhere', () => {
  const e = env(['A', 'B', 'C'], {})
  expectNoop(resolveWorkspaceDrop(e, 'A', { id: 'A', half: 'after' }))
  const middle = expectMove(resolveWorkspaceDrop(e, 'A', { id: 'B', half: 'after' }))
  assert.deepEqual(middle.order, ['B', 'A', 'C'])
  const end = expectMove(resolveWorkspaceDrop(e, 'A', { id: 'C', half: 'after' }))
  assert.deepEqual(end.order, ['B', 'C', 'A'])
})
