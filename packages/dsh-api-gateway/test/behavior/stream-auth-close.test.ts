import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRemoteStreamAuthCloseCode,
  REMOTE_STREAM_AUTH_CLOSE_CODES,
} from '../../src/client/stream-auth.ts'

test('the proxy auth close codes are the only ones classified as auth', () => {
  assert.deepEqual([...REMOTE_STREAM_AUTH_CLOSE_CODES], [4401, 4403])
  for (const code of [4401, 4403]) assert.equal(isRemoteStreamAuthCloseCode(code), true, String(code))
  for (const code of [0, 1000, 1001, 1006, 1012, 4002, 4400, 4402, 1011]) {
    assert.equal(isRemoteStreamAuthCloseCode(code), false, String(code))
  }
})
