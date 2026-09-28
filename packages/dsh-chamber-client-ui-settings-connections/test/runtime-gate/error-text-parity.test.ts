/**
 * The connections error-text projection is a RE-EXPORT, not an implementation.
 *
 * The behavior table lives with the owner: the sidebar suite
 * (test/shared/error-text.test.ts) covers errorMessage and describeThrown,
 * hostile inputs included. This file keeps the one connections-specific fact —
 * the face resolves to the SAME function object, so a second implementation can
 * never grow behind the re-export.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../../src/client/error-text.ts';
import { errorMessage as coreErrorMessage } from '@dsh-chamber/dsh-chamber-client-core';

test('the connections face re-exports the single client-core implementation', () => {
  assert.equal(errorMessage, coreErrorMessage);
});
