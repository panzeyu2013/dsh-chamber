import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeSessionCreateValue, decodeWorkspaceCreateValue, decodeWorkspaceDeleteValue,
} from '../src/shared/instance-mutation-values.ts'
import { InstanceRpcError } from '../src/shared/instance-rpc-error.ts'

test('workspace create decode validates structure but tolerates the host canonical path', () => {
  // The host canonicalizes every path through fs.realpath while the browser
  // dialog may pick a symlinked spelling — the official client never compares
  // the returned path, so a canonicalized response must decode fine.
  assert.deepEqual(
    decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '/real/target' }, created: true }),
    { workspaceId: 'ws-1', path: '/real/target', created: true },
  )
  assert.deepEqual(
    decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '/link/target' }, created: false }),
    { workspaceId: 'ws-1', path: '/link/target', created: false },
  )
  assert.throws(
    () => decodeWorkspaceCreateValue({ workspace: { path: '/expected' }, created: true }),
    (error: unknown) => error instanceof InstanceRpcError && error.code === 'invalid-response',
  )
  assert.throws(
    () => decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '' }, created: true }),
    (error: unknown) => error instanceof InstanceRpcError && error.code === 'invalid-response',
  )
  assert.throws(
    () => decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '/expected' } }),
    (error: unknown) => error instanceof InstanceRpcError && error.code === 'invalid-response',
  )
  assert.throws(
    () => decodeSessionCreateValue({ sessionId: 'different-session' }, 'session-fixed'),
    (error: unknown) => error instanceof InstanceRpcError && error.code === 'invalid-response',
  )
})

test('workspace delete requires an explicit deleted:true acknowledgement', () => {
  assert.throws(
    () => decodeWorkspaceDeleteValue({ deleted: false }),
    (error: unknown) => error instanceof InstanceRpcError && error.code === 'invalid-response',
  )
})
