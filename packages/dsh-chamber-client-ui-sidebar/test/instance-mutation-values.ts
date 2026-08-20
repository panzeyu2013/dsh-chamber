import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeSessionCreateValue, decodeWorkspaceCreateValue, decodeWorkspaceDeleteValue,
} from '../src/shared/instance-mutation-values.ts'
import { InstanceRpcError } from '../src/shared/instance-rpc-error.ts'

test('instance mutation wrappers correlate workspace path/created and preallocated session id', () => {
  assert.throws(
    () => decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '/wrong' }, created: true }, '/expected'),
    (error: unknown) => error instanceof InstanceRpcError && error.code === 'invalid-response',
  )
  assert.throws(
    () => decodeWorkspaceCreateValue({ workspace: { workspaceId: 'ws-1', path: '/expected' } }, '/expected'),
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
