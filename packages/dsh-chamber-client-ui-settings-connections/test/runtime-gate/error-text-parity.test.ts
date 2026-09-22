/**
 * The connections error-text projection: the card and the dialog render the
 * one shared module.
 *
 * The implementation is single-sourced on the sidebar shared face
 * (src/shared/error-text.ts) and covered there; this file keeps the
 * connections-side behavior assertion through the module this package's callers
 * import. The former cross-package source-text lockstep case is gone with the
 * duplicate it pinned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../../src/client/error-text.ts';

test('errorMessage: Error.message verbatim, everything else stringified', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage(new TypeError('typed')), 'typed')
  assert.equal(errorMessage('plain'), 'plain')
  assert.equal(errorMessage(undefined), 'undefined')
  assert.equal(errorMessage(null), 'null')
  assert.equal(errorMessage(42), '42')
  assert.equal(errorMessage({ message: 'not an Error' }), '[object Object]')
})

