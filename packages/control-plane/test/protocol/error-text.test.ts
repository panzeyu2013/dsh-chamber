/**
 * The shared Node-side error-text projection (control-plane/src/error-text.ts):
 * the control plane's instance of the primitive the browser side shares in
 * dsh-chamber-client-ui-sidebar/src/shared/error-text.ts.
 *
 * Run directly: node packages/control-plane/test/protocol/error-text.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorMessage } from '../../src/error-text.ts'

test('errorMessage: Error.message verbatim, everything else stringified', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage(new TypeError('typed')), 'typed')
  assert.equal(errorMessage('plain'), 'plain')
  assert.equal(errorMessage(undefined), 'undefined')
  assert.equal(errorMessage(null), 'null')
  assert.equal(errorMessage(42), '42')
  assert.equal(errorMessage({ message: 'not an Error' }), '[object Object]')
})

test('errorMessage is the cheap projection: an empty message stays empty', () => {
  assert.equal(errorMessage(new Error('')), '')
})
