/**
 * Creation-echo placement (design 08 PR2 §5.3): a checkout session is echoed
 * with its intended `workingDirectory`, so the derived row places it in the
 * checkout IMMEDIATELY and converges onto the authoritative snapshot without a
 * visible jump back to the source row.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveServerWorkspaces } from '../src/derive.ts'
import {
  reconcilePendingSessions,
  recordPendingSession,
  sessionEchoRow,
  voidPendingSessionPlacement,
  withSessionEcho,
  type PendingSession,
} from '../src/session-echo.ts'
import type { InstanceAggregate } from '../src/instance-api.ts'
import { layout, session, snapshot, workspace, worktree } from './support/fixtures.ts'

const MAIN = '/repo'
const FEAT = '/repo/.agents/worktrees/feat'

function derive(aggregate: InstanceAggregate, current = 's-new') {
  return deriveServerWorkspaces(aggregate, 'srv-a', '', current, 1000, 'default',
    [layout('r1', 'm1', [worktree(FEAT, { branch: 'feat' })])], 1)
}

function aggregateOf(workspaces: ReturnType<typeof workspace>[], sessions: ReturnType<typeof session>[]): InstanceAggregate {
  return { ...snapshot(workspaces, sessions), state: 'ok', error: null }
}

function rowOf(rows: ReturnType<typeof derive>, id: string) {
  return rows.find(row => row.id === id)
}

function shape(rows: ReturnType<typeof derive>) {
  return rows.map(row => ({ id: row.id, sessions: row.sessions.map(session => session.id) }))
}

const PENDING: PendingSession = {
  sessionId: 's-new',
  workspaceId: 'm1',
  path: MAIN,
  workingDirectory: FEAT,
  blank: true,
  at: 1000,
}

test('the creation echo carries and renders the intended checkout directory', () => {
  assert.equal(sessionEchoRow(PENDING).workingDirectory, FEAT)
  const ledger = recordPendingSession({}, 'srv-a', PENDING, 1000)
  assert.equal(ledger['srv-a']?.[0]?.workingDirectory, FEAT)
  // Absent stays sparse: an ordinary echo renders exactly as before.
  assert.equal('workingDirectory' in sessionEchoRow({ sessionId: 's', blank: true, at: 1 }), false)
})

test('an echoed checkout creation is placed in its checkout row immediately', () => {
  const echoed = withSessionEcho(aggregateOf([workspace('m1', MAIN)], []), [PENDING])
  const rows = derive(echoed)
  assert.deepEqual(shape(rows), [
    { id: 'm1', sessions: [] },
    { id: `__checkout__:${FEAT}`, sessions: ['s-new'] },
  ])
  assert.deepEqual(rowOf(rows, 'm1')?.allSessionIds, ['s-new'],
    'the echo membership already provides the drag anchor')
})

test('without a working directory the same echo stays in the source row (the field is load-bearing)', () => {
  const plain: PendingSession = { sessionId: 's-new', workspaceId: 'm1', path: MAIN, blank: true, at: 1000 }
  const rows = derive(withSessionEcho(aggregateOf([workspace('m1', MAIN)], []), [plain]))
  assert.deepEqual(shape(rows), [
    { id: 'm1', sessions: ['s-new'] },
    { id: `__checkout__:${FEAT}`, sessions: [] },
  ])
})

test('the authoritative snapshot retires the echo without moving the row', () => {
  const pendingLedger = recordPendingSession({}, 'srv-a', PENDING, 1000)
  const echoed = withSessionEcho(aggregateOf([workspace('m1', MAIN)], []), [PENDING])
  const authoritative = aggregateOf(
    [workspace('m1', MAIN, ['s-new'])],
    [session('s-new', { cwd: MAIN, workingDirectory: FEAT, blank: true })],
  )
  // A mounted push accounts the id: the echo is dropped and the aggregate is
  // returned unchanged (no duplicate row, no second membership).
  assert.equal(withSessionEcho(authoritative, [PENDING]), authoritative)
  assert.deepEqual(reconcilePendingSessions(pendingLedger, 'srv-a', authoritative.workspaces, authoritative.sessions), {})
  assert.deepEqual(shape(derive(authoritative)), shape(derive(echoed)),
    'echo and authoritative placement are identical: no visible jump')
})

test('the enter window: accounting alone does NOT retire the placement intent (no source-row flash)', () => {
  // The push that accounts the new membership lands BEFORE `gitWorkTree/enter` (a second
  // unary), so it still reports the source cwd with no `workingDirectory` projection.
  const window = aggregateOf(
    [workspace('m1', MAIN, ['s-new'])],
    [session('s-new', { cwd: MAIN, blank: true })],
  )
  const ledger = recordPendingSession({}, 'srv-a', PENDING, 1000)
  const held = reconcilePendingSessions(ledger, 'srv-a', window.workspaces, window.sessions)
  assert.deepEqual(held['srv-a']?.map(entry => entry.sessionId), ['s-new'],
    'membership accounting is no convergence signal for a placement intent')
  assert.equal(window.sessions[0]?.workingDirectory, undefined, 'control: the host has not projected it yet')
  const projected = withSessionEcho(window, held['srv-a'])
  assert.equal(projected.sessions[0]?.workingDirectory, FEAT, 'the intent rides the listed row')
  assert.deepEqual(shape(derive(projected)), [
    { id: 'm1', sessions: [] },
    { id: `__checkout__:${FEAT}`, sessions: ['s-new'] },
  ], 'the row stays in its checkout row for the whole enter window')
  // The host's own placement fact is the retirement point; nothing is left to patch.
  const converged = aggregateOf(
    [workspace('m1', MAIN, ['s-new'])],
    [session('s-new', { cwd: MAIN, workingDirectory: FEAT, blank: true })],
  )
  assert.deepEqual(reconcilePendingSessions(held, 'srv-a', converged.workspaces, converged.sessions), {})
  assert.equal(withSessionEcho(converged, held['srv-a']), converged, 'identity preserved once the fact exists')
})

test('a different host value wins: the intent never overrides a present workingDirectory', () => {
  const ledger = recordPendingSession({}, 'srv-a', PENDING, 1000)
  const diverged = aggregateOf(
    [workspace('m1', MAIN, ['s-new'])],
    [session('s-new', { cwd: MAIN, workingDirectory: '/repo/.agents/worktrees/other', blank: true })],
  )
  assert.equal(withSessionEcho(diverged, ledger['srv-a']), diverged, 'a present fact is never patched')
  assert.deepEqual(reconcilePendingSessions(ledger, 'srv-a', diverged.workspaces, diverged.sessions), {},
    'the host fact retires the intent (the row follows the host)')
})

test('the enter failure voids the intent: the row follows the authoritative source cwd', () => {
  const ledger = recordPendingSession({}, 'srv-a', PENDING, 1000)
  const voided = voidPendingSessionPlacement(ledger, 'srv-a', 's-new')
  assert.deepEqual(voided['srv-a'], [{ sessionId: 's-new', workspaceId: 'm1', path: MAIN, blank: true, at: 1000 }])
  assert.equal(voidPendingSessionPlacement(ledger, 'srv-a', 's-other'), ledger, 'an unknown id changes nothing')
  assert.equal(voidPendingSessionPlacement(voided, 'srv-a', 's-new'), voided, 'already void = same reference')
  const window = aggregateOf([workspace('m1', MAIN, ['s-new'])], [session('s-new', { cwd: MAIN, blank: true })])
  assert.equal(withSessionEcho(window, voided['srv-a']), window, 'no intent = no patch')
  assert.deepEqual(reconcilePendingSessions(voided, 'srv-a', window.workspaces, window.sessions), {},
    'without an intent, authoritative accounting retires the echo as before')
  assert.deepEqual(shape(derive(withSessionEcho(window, voided['srv-a']))), [
    { id: 'm1', sessions: ['s-new'] },
    { id: `__checkout__:${FEAT}`, sessions: [] },
  ], 'the row renders under the source workspace, which is where the host actually left it')
})
