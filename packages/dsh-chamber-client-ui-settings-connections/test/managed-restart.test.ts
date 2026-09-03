/**
 * managed-restart.ts tests (plain node:test, no dsh, no React): gateway
 * managed-dsh restart result classification and server-refusal projection
 * (design 21 §5.1/§5.3). The poll errors under test are the English strings
 * thrown by the sidebar shared pollGatewayReady (gateway-runtime-poll.ts) —
 * unlocalized copy is a registered deviation (design 21 §5.2).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRestartError, serverRefusalText } from '../src/client/managed-restart.ts'

test('classifyRestartError: the poll timeout is accepted-timeout with an empty detail', () => {
  const result = classifyRestartError(new Error('restart accepted but the gateway did not reach ready in time'))
  assert.deepEqual(result, { kind: 'accepted-timeout', detail: '' })
})

test('classifyRestartError: a poll failure is failed with the trimmed thrown message as detail', () => {
  const result = classifyRestartError(new Error('restart failed: spawn probe timed out'))
  assert.deepEqual(result, { kind: 'failed', detail: 'restart failed: spawn probe timed out' })
})

test('classifyRestartError: whitespace around a thrown message is trimmed', () => {
  const result = classifyRestartError(new Error('  restart failed: boom  '))
  assert.deepEqual(result, { kind: 'failed', detail: 'restart failed: boom' })
})

test('classifyRestartError: a non-Error throw input is failed with its stringified value', () => {
  assert.deepEqual(classifyRestartError('boom'), { kind: 'failed', detail: 'boom' })
  assert.deepEqual(classifyRestartError(undefined), { kind: 'failed', detail: 'undefined' })
})

test('serverRefusalText: body.error is returned verbatim when present', () => {
  assert.equal(serverRefusalText({ error: 'another restart is in flight', code: 'busy' }, 409), 'another restart is in flight')
})

test('serverRefusalText: an empty or non-string error falls back to the status-anchored text', () => {
  assert.equal(serverRefusalText({ code: 'busy' }, 409), 'restart refused (409)')
  assert.equal(serverRefusalText({ error: '' }, 400), 'restart refused (400)')
  assert.equal(serverRefusalText(null, 400), 'restart refused (400)')
  assert.equal(serverRefusalText('refused', 400), 'restart refused (400)')
})
