import { test } from 'node:test'
import assert from 'node:assert/strict'
// Both modules are package-internal (no public face, not on the barrel): the test
// references the sources directly.
import {
  decodeSessionArchiveActivity,
  decodeSessionCreateValue, decodeWorkspaceCreateValue, decodeWorkspaceDeleteValue,
} from '../../../dsh-chamber-client-core/src/instance-mutation-values.ts'
import { InstanceRpcError } from '../../../dsh-chamber-client-core/src/instance-rpc-error.ts'

/** The decoder rejection contract: an InstanceRpcError with code invalid-response. */
const invalidResponse = (error: unknown): boolean => error instanceof InstanceRpcError && error.code === 'invalid-response'

test('workspace create decode validates structure but tolerates the host canonical path', () => {
  // The host canonicalizes every path through fs.realpath while the browser dialog may pick a symlinked spelling —
  // the official client never compares the returned path, so a canonicalized response must decode fine.
  assert.deepEqual(decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '/real/target' }, created: true }),
    { workspaceId: 'ws-1', path: '/real/target', created: true })
  assert.deepEqual(decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '/link/target' }, created: false }),
    { workspaceId: 'ws-1', path: '/link/target', created: false })
  assert.throws(() => decodeWorkspaceCreateValue({ workspace: { path: '/expected' }, created: true }), invalidResponse)
  assert.throws(() => decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '' }, created: true }), invalidResponse)
  assert.throws(() => decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '/expected' } }), invalidResponse)
  assert.throws(() => decodeSessionCreateValue({ sessionId: 'different-session' }, 'session-fixed'), invalidResponse)
})

test('workspace delete requires an explicit deleted:true acknowledgement', () => {
  assert.throws(() => decodeWorkspaceDeleteValue({ deleted: false }), invalidResponse)
})

test('session archive activity decodes the official families and normalizes absent items', () => {
  assert.deepEqual(decodeSessionArchiveActivity({
    sessionId: 's1',
    activity: [
      { kind: 'turn' },
      { kind: 'job', items: [{ id: 'j1' }, { id: 'j2', label: 'build' }] },
    ],
  }), [
    { kind: 'turn', items: [] },
    { kind: 'job', items: [{ id: 'j1' }, { id: 'j2', label: 'build' }] },
  ])
})

test('session archive activity keeps unknown kinds (provider-extensible map) but is all-or-nothing', () => {
  // A family established by a provider package this build never compiled still
  // decodes: the dialog's generic line names it instead of dropping the row.
  assert.deepEqual(
    decodeSessionArchiveActivity({ activity: [{ kind: 'future-family', items: [{ id: 'x' }] }] }),
    [{ kind: 'future-family', items: [{ id: 'x' }] }],
  )
  const malformed: unknown[] = [
    undefined, null, {}, { activity: [] }, { activity: 'turn' },
    { activity: [{}] }, { activity: [{ kind: '' }] },
    { activity: [{ kind: 'job', items: 'j1' }] },
    { activity: [{ kind: 'job', items: [{}] }] },
    { activity: [{ kind: 'job', items: [{ id: 7 }] }] },
    { activity: [{ kind: 'job', items: [{ id: 'j1', label: '' }] }] },
    { activity: [{ kind: 'k'.repeat(65) }] },
    { activity: [{ kind: 'job', items: Array.from({ length: 4097 }, () => ({ id: 'j1' })) }] },
  ]
  for (const [index, bad] of malformed.entries()) {
    assert.equal(decodeSessionArchiveActivity(bad), undefined, `malformed case ${index} must not decode`)
  }
})

test('session archive activity caps are inclusive and the decode never keeps a valid prefix', () => {
  const families = (count: number): unknown => ({
    activity: Array.from({ length: count }, (_, index) => ({ kind: `family-${String(index)}` })),
  })
  assert.equal(decodeSessionArchiveActivity(families(64))?.length, 64)
  assert.equal(decodeSessionArchiveActivity(families(65)), undefined)
  const withItems = (count: number) => ({
    activity: [{ kind: 'job', items: Array.from({ length: count }, () => ({ id: 'j1' })) }],
  })
  assert.equal(decodeSessionArchiveActivity(withItems(4096))?.[0]?.items.length, 4096)
  assert.equal(decodeSessionArchiveActivity(withItems(4097)), undefined)
  const withId = (length: number) => ({ activity: [{ kind: 'job', items: [{ id: 'x'.repeat(length) }] }] })
  assert.equal(decodeSessionArchiveActivity(withId(512))?.[0]?.items[0]?.id.length, 512)
  assert.equal(decodeSessionArchiveActivity(withId(513)), undefined)
  assert.equal(decodeSessionArchiveActivity({
    activity: [{ kind: 'job', items: [{ id: 'j1', label: 'y'.repeat(512) }] }],
  })?.[0]?.items[0]?.label?.length, 512)
  assert.equal(decodeSessionArchiveActivity({
    activity: [{ kind: 'job', items: [{ id: 'j1', label: 'y'.repeat(513) }] }],
  }), undefined)
  assert.equal(decodeSessionArchiveActivity({ activity: [{ kind: 'k'.repeat(64) }] })?.[0]?.kind.length, 64)
  assert.equal(decodeSessionArchiveActivity({ activity: [{ kind: 'k'.repeat(65) }] }), undefined)
  // A valid prefix followed by one bad entry must decode NOTHING: a partial list
  // would be shown as the dialog's "what will stop" promise.
  assert.equal(decodeSessionArchiveActivity({
    activity: [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'j1' }] }, { kind: 'job', items: [{}] }],
  }), undefined)
})
