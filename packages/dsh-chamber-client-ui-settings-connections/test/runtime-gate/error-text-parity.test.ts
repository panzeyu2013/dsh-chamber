/**
 * The connections error-text helper (2026-12 audit P1-3): the card and the
 * dialog carried two byte-identical copies, now one module. settings-bridge
 * keeps its own one-liner (no cross-package sharing), so the second case locks
 * the two bodies to the same expression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('the settings-bridge copy is the same expression (cross-package lockstep)', () => {
  const source = readFileSync(
    new URL('../../../dsh-chamber-client-ui-settings-bridge/src/client/DshRuntimeSection.tsx', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /function errorMessage\(error: unknown\): string \{\s*return error instanceof Error \? error\.message : String\(error\)\s*\}/u,
    'the bridge copy must stay the same one-liner as error-text.ts',
  )
})
