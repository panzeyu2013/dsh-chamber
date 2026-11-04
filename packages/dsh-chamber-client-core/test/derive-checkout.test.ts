/**
 * derive.ts checkout-row integration (design 08 PR2 §5.2): family rows follow
 * their main, placement never rewrites host membership, the `only` filter keeps
 * derived rows, and BOTH publish signatures move when placement moves.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveServerWorkspaces,
  instanceSnapshotSignature,
  projectInstanceSnapshot,
  serversProjectionSignature,
} from '../src/derive.ts'
import type { ChamberServerAggregate, ChamberServerWorkspace } from '../src/aggregate-store.ts'
import type { InstanceSnapshot } from '../src/instance-api.ts'
import { layout, session, snapshot, workspace, worktree } from './support/fixtures.ts'

const MAIN = '/repo'
const FEAT = '/repo/.agents/worktrees/feat'
const OTHER = '/repo/.agents/worktrees/other'

function derive(snap: InstanceSnapshot, layouts = [layout('r1', 'm1', [worktree(FEAT, { branch: 'feat' })])]) {
  return deriveServerWorkspaces(snap, 'srv-a', '', undefined, 1000, 'default', layouts, 1)
}

function rowOf(rows: readonly ChamberServerWorkspace[], id: string): ChamberServerWorkspace | undefined {
  return rows.find(row => row.id === id)
}

/** Wrap derived rows in one source aggregate for the publish-signature cases. */
function aggregateOf(workspaces: readonly ChamberServerWorkspace[]): ChamberServerAggregate {
  return {
    id: 'srv-a',
    sourceFingerprint: 'a'.repeat(64),
    kind: 'dsh',
    transport: 'ssh',
    label: 'srv-a',
    connected: true,
    phase: 'ready',
    workspaces: [...workspaces],
    updatedAt: 0,
  }
}

function signatureOf(rows: readonly ChamberServerWorkspace[]): string {
  return serversProjectionSignature([aggregateOf(rows)])
}

test('checkout rows follow the main row and take the placed sessions; the main keeps its full order', () => {
  const snap = snapshot(
    [workspace('m1', MAIN, ['s1', 's2', 's3'])],
    [
      session('s1', { cwd: MAIN }),
      session('s2', { workingDirectory: FEAT }),
      session('s3', { cwd: `${FEAT}/src` }),
    ],
  )
  const rows = derive(snap)
  assert.deepEqual(rows.map(row => row.id), ['m1', `__checkout__:${FEAT}`], 'the checkout row is inserted right after its main')
  const main = rowOf(rows, 'm1')
  assert.deepEqual(main?.sessions.map(row => row.id), ['s1'], 'placed sessions no longer render in the source row')
  assert.deepEqual(main?.allSessionIds, ['s1', 's2', 's3'], 'the PRE-placement order rides the source row (drag anchors)')
  assert.equal(main?.kind, undefined)
  const checkout = rowOf(rows, `__checkout__:${FEAT}`)
  assert.equal(checkout?.kind, 'checkout')
  assert.equal(checkout?.repoKey, 'r1')
  assert.equal(checkout?.familyMainId, 'm1')
  assert.equal(checkout?.path, FEAT)
  assert.equal(checkout?.title, 'feat')
  assert.equal(checkout?.synthetic, undefined, 'checkout rows are NOT synthetic')
  assert.deepEqual(checkout?.sessions.map(row => row.id), ['s2', 's3'], 'checkout order = main membership order')
  assert.deepEqual(snap.workspaces[0]?.sessionIds, ['s1', 's2', 's3'], 'host sessionIds are never rewritten')

  // No layouts (unmounted/unary source): the PR1 projection is unchanged.
  const plain = deriveServerWorkspaces(snap, 'srv-a', '', undefined, 1000)
  assert.deepEqual(plain.map(row => row.id), ['m1'])
  assert.deepEqual(plain[0]?.sessions.map(row => row.id), ['s1', 's2', 's3'])
  assert.equal(plain[0]?.allSessionIds, undefined)
})

test('no checkout row for an unregistered main, a vanished main row, or an already-registered path', () => {
  const snap = snapshot(
    [workspace('m1', MAIN, ['s1', 's2']), workspace('registered', FEAT, ['s2'])],
    [session('s1', { cwd: MAIN }), session('s2', { cwd: FEAT })],
  )
  for (const mainWorkspaceId of [null, 'gone']) {
    const rows = derive(snap, [layout('r1', mainWorkspaceId, [worktree(FEAT)])])
    assert.deepEqual(rows.map(row => row.id), ['m1', 'registered'])
    assert.equal(rows.some(row => row.kind === 'checkout'), false)
    assert.equal(rows[0]?.allSessionIds, undefined)
  }
  // A checkout path registered as a workspace stays that workspace row; its
  // host membership is unchanged (membership is never rewritten).
  const rows = derive(snap, [layout('r1', 'm1', [worktree(FEAT)])])
  assert.deepEqual(rows.map(row => row.id), ['m1', 'registered'])
  assert.deepEqual(rowOf(rows, 'm1')?.sessions.map(row => row.id), ['s1', 's2'])
  assert.deepEqual(rowOf(rows, 'registered')?.sessions.map(row => row.id), ['s2'])
})

test('the only filter exempts derived rows from the empty-row drop but keeps the family anchored', () => {
  const snap = snapshot(
    [workspace('m1', MAIN, ['s1', 's2', 's3', 's4'])],
    [
      session('s1', { cwd: MAIN }),
      session('s2', { cwd: FEAT }),
      session('s3', { cwd: FEAT }),
      session('s4', { cwd: OTHER }),
    ],
    { archivedSessionIds: ['s3'] },
  )
  const layouts = [layout('r1', 'm1', [worktree(FEAT), worktree(OTHER)])]
  const only = deriveServerWorkspaces(snap, 'srv-a', '', undefined, 1000, 'only', layouts, 1)
  assert.deepEqual(only.map(row => row.id), ['m1', `__checkout__:${FEAT}`, `__checkout__:${OTHER}`],
    'the main row survives because its placed archived member is visible, and empty checkout rows are exempt')
  assert.deepEqual(only[0]?.sessions, [], 'the visible archived member is rendered in its checkout row')
  assert.deepEqual(rowOf(only, `__checkout__:${FEAT}`)?.sessions.map(row => row.id), ['s3'])
  assert.deepEqual(rowOf(only, `__checkout__:${OTHER}`)?.sessions, [], 'an empty checkout row still renders under only')
  // default: archived hidden, the live checkout member renders.
  const plain = derive(snap, layouts)
  assert.deepEqual(rowOf(plain, `__checkout__:${FEAT}`)?.sessions.map(row => row.id), ['s2'])
  // a family with NO visible member under the filter is dropped whole (main and
  // its checkout rows together, never an orphaned derived row).
  const nothingVisible = snapshot([workspace('m1', MAIN, ['a1'])], [session('a1', { cwd: MAIN })])
  const dropped = deriveServerWorkspaces(nothingVisible, 'srv-a', '', undefined, 1000, 'only', layouts, 1)
  assert.deepEqual(dropped, [])
})

test('instanceSnapshotSignature carries workingDirectory (the placement input)', () => {
  const base = snapshot([workspace('m1', MAIN, ['s1'])], [session('s1', { cwd: MAIN })])
  const moved = snapshot([workspace('m1', MAIN, ['s1'])], [session('s1', { cwd: MAIN, workingDirectory: FEAT })])
  assert.notEqual(instanceSnapshotSignature(moved), instanceSnapshotSignature(base))
  assert.equal(instanceSnapshotSignature(moved), instanceSnapshotSignature({ ...moved }), 'stable for identical content')
})

test('serversProjectionSignature carries checkout identity/placement but never dirty/locked', () => {
  const snap = snapshot(
    [workspace('m1', MAIN, ['s1', 's2'])],
    [session('s1', { cwd: FEAT }), session('s2', { cwd: OTHER })],
  )
  const dirtyLayouts = [layout('r1', 'm1', [
    worktree(FEAT, { branch: 'feat', dirty: true, locked: true }),
    worktree(OTHER, { dirty: null, locked: false }),
  ])]
  const cleanLayouts = [layout('r1', 'm1', [worktree(FEAT, { branch: 'feat' }), worktree(OTHER)])]
  const dirty = derive(snap, dirtyLayouts)
  const clean = derive(snap, cleanLayouts)
  assert.equal(signatureOf(dirty), signatureOf(clean),
    'dirty/locked are occupant facts, never aggregate signature inputs')

  // title (branch) / repoKey are render/action facts and must move the gate.
  const renamed = derive(snap, [layout('r1', 'm1', [worktree(FEAT, { branch: 'feat2' }), worktree(OTHER)])])
  assert.notEqual(signatureOf(renamed), signatureOf(clean))
  const otherRepo = derive(snap, [layout('r2', 'm1', [worktree(FEAT, { branch: 'feat' }), worktree(OTHER)])])
  assert.notEqual(signatureOf(otherRepo), signatureOf(clean))

  // Placement moves a session between rows: same snapshot, different layout.
  const unplaced = derive(snap, [layout('r1', 'm1', [worktree(FEAT, { branch: 'feat' })])])
  assert.notEqual(signatureOf(unplaced), signatureOf(clean),
    'a session moving from the source row into a checkout row moves the gate')

  // allSessionIds participates: swapping the host order of two sessions that
  // live in DIFFERENT checkouts changes only the anchor space.
  const orderA = snapshot([workspace('m1', MAIN, ['s1', 's2'])], [session('s1', { cwd: FEAT }), session('s2', { cwd: OTHER })])
  const orderB = snapshot([workspace('m1', MAIN, ['s2', 's1'])], [session('s1', { cwd: FEAT }), session('s2', { cwd: OTHER })])
  const layouts = [layout('r1', 'm1', [worktree(FEAT, { branch: 'feat' }), worktree(OTHER)])]
  const rowsA = derive(orderA, layouts)
  const rowsB = derive(orderB, layouts)
  assert.deepEqual(rowsA[1]?.sessions.map(row => row.id), rowsB[1]?.sessions.map(row => row.id), 'each checkout keeps its single member')
  assert.notDeepEqual(rowsA[0]?.allSessionIds, rowsB[0]?.allSessionIds)
  assert.notEqual(signatureOf(rowsA), signatureOf(rowsB), 'the anchor order is signature content')
})

test('a blank session placed in a checkout is never the source row reusable blank', () => {
  const snap = snapshot([workspace('m1', MAIN, ['b1'])], [session('b1', { cwd: MAIN, workingDirectory: FEAT, blank: true })])
  const rows = deriveServerWorkspaces(snap, 'srv-a', '', 'b1', 1000, 'default',
    [layout('r1', 'm1', [worktree(FEAT)])], 1)
  assert.equal(rowOf(rows, 'm1')?.reusableBlankSessionId, undefined,
    'the source "+" must not reopen a blank row whose effective directory is a checkout')
  assert.deepEqual(rowOf(rows, `__checkout__:${FEAT}`)?.sessions.map(row => row.id), ['b1'])
})

test('mounted projection extracts the sparse workingDirectory fact from the projection bag', () => {
  const workspaces = { items: [workspace('m1', MAIN, ['s1'])], archivedSessionIds: [], state: 'idle', phase: 'ready' }
  const project = (projectionValues?: Record<string, unknown>) => projectInstanceSnapshot(workspaces, {
    ids: ['s1'],
    phase: 'ready',
    byId: { s1: { id: 's1', cwd: MAIN, running: false, blank: false, ...(projectionValues === undefined ? {} : { projectionValues }) } },
  })
  assert.equal(project({ workingDirectory: FEAT })?.sessions[0]?.workingDirectory, FEAT)
  assert.equal(project({ workingDirectory: '' })?.sessions[0]?.workingDirectory, undefined, 'empty is not a projected fact')
  assert.equal(project({ workingDirectory: 42 })?.sessions[0]?.workingDirectory, undefined)
  assert.equal(project({})?.sessions[0]?.workingDirectory, undefined)
  assert.equal(project()?.sessions[0]?.cwd, MAIN, 'cwd stays the header fact')
})
