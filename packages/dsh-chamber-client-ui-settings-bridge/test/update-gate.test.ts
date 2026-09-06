/**
 * update-gate.ts pure-logic tests (design 11) — node:test, no DOM. Covers the
 *「检查更新」button disable gates, mirrored from the main-process runCheck()
 * phase gates (a re-check must never clobber an in-flight check/download or a
 * completed download), plus the「重启并安装」availability gate, mirrored from
 * updater.restartAndInstall() (2026-12 user decision: restart into the
 * downloaded update — completed download on an installable shape only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateCheckDisabled, updateCheckPlatformBlocked, updateRestartAvailable } from '../src/client/update-gate.ts';

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

test('updateRestartAvailable: only a completed download on an installable shape offers the restart action', () => {
  assert.equal(updateRestartAvailable('downloaded', null, 'darwin'), true);
  assert.equal(updateRestartAvailable('downloaded', null, 'win32'), true);
  assert.equal(updateRestartAvailable('downloaded', null, undefined), true);
  assert.equal(updateRestartAvailable('downloaded', null, null), true);
});

test('updateRestartAvailable: every non-downloaded phase is not restartable', () => {
  assert.equal(updateRestartAvailable(undefined, null, 'darwin'), false);
  assert.equal(updateRestartAvailable('idle', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('checking', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('up-to-date', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('available', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('downloading', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('error', null, 'darwin'), false);
});

test('updateRestartAvailable: a blocked install shape never offers the restart action', () => {
  assert.equal(updateRestartAvailable('downloaded', 'auto-update is not supported on this platform', 'darwin'), false);
  assert.equal(updateRestartAvailable('downloaded', 'missing Developer ID signature', 'darwin'), false);
  assert.equal(updateRestartAvailable('downloaded', 'development build', 'darwin'), false);
  assert.equal(updateRestartAvailable('downloaded', undefined, 'darwin'), false);
});

test('updateRestartAvailable: linux never offers the restart action (AppImage single-instance race, H1)', () => {
  // Even a completed download on an installable linux shape (AppImage) keeps
  // only the quit-install leg — updater.restartAndInstall() refuses linux too.
  assert.equal(updateRestartAvailable('downloaded', null, 'linux'), false);
});
