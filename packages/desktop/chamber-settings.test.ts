/**
 * chamber-settings.ts pure-logic tests (design 14 D7) — node:test, no
 * electron. Covers normalize / atomic file round-trip / corrupt preservation /
 * platform gates / close-window decision / quit-risk (update exemption) /
 * patch validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CHAMBER_SETTINGS,
  computeQuitRisk,
  computeSupported,
  normalizeSettings,
  readSettingsFile,
  shouldHideToTray,
  validatePatch,
  writeSettingsFile,
} from './chamber-settings.ts';

test('normalizeSettings: defaults for null / non-object', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_CHAMBER_SETTINGS);
  assert.deepEqual(normalizeSettings('nope'), DEFAULT_CHAMBER_SETTINGS);
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_CHAMBER_SETTINGS);
});

test('normalizeSettings: accepts valid fields, rejects bad values, ignores unknown keys', () => {
  const ok = normalizeSettings({ windowCloseBehavior: 'quit', launchAtLogin: true, keepAwake: true, futureKey: 42 });
  assert.deepEqual(ok, { windowCloseBehavior: 'quit', launchAtLogin: true, keepAwake: true });
  // Bad enum / non-boolean values fall back to defaults silently (normalize is
  // the persistence read path; loud validation lives in validatePatch).
  const bad = normalizeSettings({ windowCloseBehavior: 'minimize', launchAtLogin: 'yes', keepAwake: 1 });
  assert.deepEqual(bad, DEFAULT_CHAMBER_SETTINGS);
});

test('writeSettingsFile + readSettingsFile round-trip (atomic, 0600)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const file = path.join(dir, 'chamber-settings.json');
  const settings = { windowCloseBehavior: 'quit' as const, launchAtLogin: true, keepAwake: true };
  writeSettingsFile(file, settings);
  const read = readSettingsFile(file);
  assert.equal(read.notice, null);
  assert.deepEqual(read.settings, settings);
  const stat = readFileSync(file, 'utf8');
  assert.ok(stat.includes('"quit"'));
  assert.ok(!existsSync(`${file}.tmp`), 'tmp file cleaned up by rename');
});

test('readSettingsFile: missing file → defaults, no notice', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const read = readSettingsFile(path.join(dir, 'absent.json'));
  assert.equal(read.notice, null);
  assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS);
});

test('readSettingsFile: corrupt file preserved as *.corrupt, defaults + loud notice', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const file = path.join(dir, 'chamber-settings.json');
  writeFileSync(file, '{ not json !!!', 'utf8');
  const read = readSettingsFile(file);
  assert.ok(read.notice !== null, 'corrupt read must produce a notice');
  assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS);
  assert.ok(existsSync(`${file}.corrupt`), 'corrupt file preserved');
  assert.ok(!existsSync(file), 'corrupt file moved away');
});

test('readSettingsFile: non-object JSON is corrupt', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const file = path.join(dir, 'chamber-settings.json');
  writeFileSync(file, '["not","an","object"]', 'utf8');
  const read = readSettingsFile(file);
  assert.ok(read.notice !== null);
  assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS);
});

test('computeSupported: launchAtLogin off on win32; closeToTray follows tray availability, always on darwin', () => {
  assert.deepEqual(computeSupported('win32', true), { launchAtLogin: false, closeToTray: true });
  assert.deepEqual(computeSupported('win32', false), { launchAtLogin: false, closeToTray: false });
  assert.deepEqual(computeSupported('darwin', false), { launchAtLogin: true, closeToTray: true });
  assert.deepEqual(computeSupported('linux', true), { launchAtLogin: true, closeToTray: true });
  assert.deepEqual(computeSupported('linux', false), { launchAtLogin: true, closeToTray: false });
});

test('shouldHideToTray: needs behavior + recovery surface + no quit in flight', () => {
  assert.equal(shouldHideToTray('hide-to-tray', true, false), true);
  assert.equal(shouldHideToTray('hide-to-tray', false, false), false, 'no recovery surface → never hide');
  assert.equal(shouldHideToTray('hide-to-tray', true, true), false, 'quit in flight → never hide');
  assert.equal(shouldHideToTray('quit', true, false), false);
});

test('computeQuitRisk: remote tunnels + local instance trigger confirm', () => {
  const both = computeQuitRisk({ remoteReadyCount: 2, localRunning: true, updateDownloadReady: false });
  assert.equal(both.needsConfirm, true);
  assert.deepEqual(both.reasons, ['2 条远程隧道活动', '本地 dsh 实例运行中']);
  const none = computeQuitRisk({ remoteReadyCount: 0, localRunning: false, updateDownloadReady: false });
  assert.equal(none.needsConfirm, false);
  assert.deepEqual(none.reasons, []);
  const remoteOnly = computeQuitRisk({ remoteReadyCount: 1, localRunning: false, updateDownloadReady: false });
  assert.equal(remoteOnly.needsConfirm, true);
  assert.deepEqual(remoteOnly.reasons, ['1 条远程隧道活动']);
});

test('computeQuitRisk: downloaded update exempts confirmation (design 14 D2)', () => {
  const risk = computeQuitRisk({ remoteReadyCount: 5, localRunning: true, updateDownloadReady: true });
  assert.equal(risk.needsConfirm, false);
  assert.deepEqual(risk.reasons, []);
});

test('validatePatch: rejects unknown keys and bad types loudly', () => {
  const unknown = validatePatch({ nope: true });
  assert.equal(unknown.ok, false);
  const badEnum = validatePatch({ windowCloseBehavior: 'minimize' });
  assert.equal(badEnum.ok, false);
  const badBool = validatePatch({ keepAwake: 'yes' });
  assert.equal(badBool.ok, false);
  const notObject = validatePatch('x');
  assert.equal(notObject.ok, false);
});

test('validatePatch: accepts known partial patches', () => {
  const ok = validatePatch({ windowCloseBehavior: 'quit', keepAwake: true });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.patch, { windowCloseBehavior: 'quit', keepAwake: true });
});
