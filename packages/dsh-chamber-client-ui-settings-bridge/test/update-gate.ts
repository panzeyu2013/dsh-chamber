/**
 * update-gate.ts pure-logic tests (design 11) — node:test, no DOM. Covers the
 *「检查更新」button disable gates, mirrored from the main-process runCheck()
 * phase gates (a re-check must never clobber an in-flight check/download or a
 * completed download).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateCheckDisabled, updateCheckPlatformBlocked } from '../src/client/update-gate.ts';

test('updateCheckDisabled: an explicit check is disabled while a check/download owns the flow', () => {
  assert.equal(updateCheckDisabled('checking'), true);
  assert.equal(updateCheckDisabled('downloading'), true);
});

test('updateCheckDisabled: a completed download is final for this version', () => {
  assert.equal(updateCheckDisabled('downloaded'), true);
});

test('updateCheckDisabled: checkable phases stay enabled', () => {
  assert.equal(updateCheckDisabled(undefined), false);
  assert.equal(updateCheckDisabled('idle'), false);
  assert.equal(updateCheckDisabled('up-to-date'), false);
  assert.equal(updateCheckDisabled('available'), false);
  assert.equal(updateCheckDisabled('error'), false);
});

test('updateCheckPlatformBlocked: linux is blocked, mac-signing is not', () => {
  assert.equal(updateCheckPlatformBlocked('auto-update is not supported on this platform'), true);
  assert.equal(updateCheckPlatformBlocked('missing Developer ID signature'), false);
  assert.equal(updateCheckPlatformBlocked(null), false);
  assert.equal(updateCheckPlatformBlocked(undefined), false);
});
