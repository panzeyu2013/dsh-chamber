/**
 * Gate-2 path resolution for BOTH open-in seats (design 20 §7.2, ruling D-01 = B):
 * the Files tab hands the displayed directory over as the slot owner prop
 * (`sidebar.right.tab.files.actions`, rc.2); the header seat keeps resolving its
 * own session's workspace. The owner path is trimmed and a whitespace-only value
 * falls back (never a dead button). Pure over plain data, plain node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveOpenInPath, workspacePathForSession } from '../../src/client/open-in-gates.ts'

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
