/**
 * Gate-2 path resolution for BOTH open-in seats (design 20 §7.2, ruling D-01 = B):
 * the Files tab hands the displayed directory over as the slot owner prop
 * (`sidebar.right.tab.files.actions`, rc.2); the header seat opens the session's
 * CURRENT directory projection (`workingDirectory` — the checkout when the
 * session works in one; upstream `selectSessionDirectory`), falling back to the
 * session's workspace root when nothing is projected. The owner path is trimmed
 * and a whitespace-only value falls back (never a dead button). Pure over plain
 * data, plain node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveOpenInPath,
  selectSessionDirectory,
  workspacePathForSession,
  type OpenInSessionsState,
} from '../../src/client/open-in-gates.ts'

const WORKSPACES = [
  { workspaceId: 'w1', path: '/repo/main', sessionIds: ['s1'] },
  { workspaceId: 'w2', path: '/repo/other', sessionIds: ['s2'] },
]

test('resolveOpenInPath: the owner path wins over any session lookup, trimmed', () => {
  assert.equal(resolveOpenInPath('/displayed/root', WORKSPACES, 's1'), '/displayed/root')
  assert.equal(resolveOpenInPath('  /displayed/root  ', WORKSPACES, 's2'), '/displayed/root')
})

test('resolveOpenInPath: empty/whitespace owner paths fall back to the session workspace', () => {
  assert.equal(resolveOpenInPath('', WORKSPACES, 's2'), '/repo/other')
  assert.equal(resolveOpenInPath('   ', WORKSPACES, 's1'), '/repo/main')
  assert.equal(resolveOpenInPath(undefined, WORKSPACES, 's1'), '/repo/main')
})

test('resolveOpenInPath: no owner path and no usable session renders null (no dead button)', () => {
  assert.equal(resolveOpenInPath(undefined, WORKSPACES, undefined), undefined)
  assert.equal(resolveOpenInPath('', WORKSPACES, undefined), undefined)
  assert.equal(resolveOpenInPath(undefined, WORKSPACES, ''), undefined)
  assert.equal(resolveOpenInPath(undefined, WORKSPACES, 'unknown-session'), undefined)
  assert.equal(resolveOpenInPath('', [], 's1'), undefined)
})

test('workspacePathForSession stays the single lookup (regression)', () => {
  assert.equal(workspacePathForSession(WORKSPACES, 's1'), '/repo/main')
  assert.equal(workspacePathForSession(WORKSPACES, 'none'), undefined)
})

test('selectSessionDirectory: shared projection bag → row projection bag → header cwd (upstream port)', () => {
  const state: OpenInSessionsState = {
    projectionsBySession: {
      s1: { values: { workingDirectory: '/repo/.agents/worktrees/feat' } },
      s2: { values: {} },
    },
    byId: {
      s1: { cwd: '/repo/main', projectionValues: { workingDirectory: '/stale/projected' } },
      s2: { cwd: '/repo/main', projectionValues: { workingDirectory: '/repo/from-row' } },
      s3: { cwd: '/repo/main' },
      s4: {},
    },
  }
  assert.equal(selectSessionDirectory(state, 's1'), '/repo/.agents/worktrees/feat',
    'the shared projection bag wins: the LIVE checkout directory')
  assert.equal(selectSessionDirectory(state, 's2'), '/repo/from-row', 'then the store row projection bag')
  assert.equal(selectSessionDirectory(state, 's3'), '/repo/main', 'then the header cwd (original project)')
  assert.equal(selectSessionDirectory(state, 's4'), undefined, 'unknown stays unknown')
  assert.equal(selectSessionDirectory(state, 'missing'), undefined)
  assert.equal(selectSessionDirectory(state, ''), undefined)
  assert.equal(selectSessionDirectory({}, 's1'), undefined, 'a cold/empty list projects nothing')
  // Non-string projection shapes are not a directory claim (never render a garbage path).
  assert.equal(selectSessionDirectory({ byId: { s: { projectionValues: { workingDirectory: 42 } } } }, 's'),
    undefined)
})

test('header seat: the session current directory (checkout) wins over the workspace root', () => {
  const FEAT = '/repo/.agents/worktrees/feat'
  assert.equal(resolveOpenInPath(undefined, WORKSPACES, 's1', FEAT), FEAT,
    'a session inside a checkout opens the checkout, not workspace.path')
  assert.equal(resolveOpenInPath('/displayed/root', WORKSPACES, 's1', FEAT), '/displayed/root',
    'the Files seat owner path still wins over the session directory')
  assert.equal(resolveOpenInPath(undefined, WORKSPACES, 's1'), '/repo/main',
    'no projection (cold list) → the session workspace fallback, old behavior')
  assert.equal(resolveOpenInPath(undefined, WORKSPACES, 's1', '   '), '/repo/main',
    'whitespace-only directory falls back to the workspace (never a padded launch)')
  assert.equal(resolveOpenInPath(undefined, WORKSPACES, 's1', ''), '/repo/main')
  assert.equal(resolveOpenInPath(undefined, WORKSPACES, undefined, FEAT), FEAT,
    'a projected directory needs no session lookup to reach gate 2')
})
