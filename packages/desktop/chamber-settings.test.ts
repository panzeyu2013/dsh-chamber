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
  const ok = normalizeSettings({ windowCloseBehavior: 'quit', launchAtLogin: true, keepAwake: true, quitConfirmation: false, futureKey: 42 });
  assert.deepEqual(ok, { windowCloseBehavior: 'quit', launchAtLogin: true, keepAwake: true, quitConfirmation: false });
  // Bad enum / non-boolean values fall back to defaults silently (normalize is
  // the persistence read path; loud validation lives in validatePatch).
  const bad = normalizeSettings({ windowCloseBehavior: 'minimize', launchAtLogin: 'yes', keepAwake: 1, quitConfirmation: 'yes' });
  assert.deepEqual(bad, DEFAULT_CHAMBER_SETTINGS);
});

test('writeSettingsFile + readSettingsFile round-trip (atomic, 0600)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const file = path.join(dir, 'chamber-settings.json');
  const settings = { windowCloseBehavior: 'quit' as const, launchAtLogin: true, keepAwake: true, quitConfirmation: false };
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

test('computeQuitRisk: only a running local instance triggers confirm (2026-08: remote tunnels never prompt)', () => {
  const local = computeQuitRisk({ quitConfirmation: true, localRunning: true, updateDownloadReady: false });
  assert.equal(local.needsConfirm, true);
  assert.deepEqual(local.reasons, ['正在运行的本地 dsh 实例']);
  const none = computeQuitRisk({ quitConfirmation: true, localRunning: false, updateDownloadReady: false });
  assert.equal(none.needsConfirm, false);
  assert.deepEqual(none.reasons, []);
});

test('computeQuitRisk: quitConfirmation off never confirms', () => {
  const off = computeQuitRisk({ quitConfirmation: false, localRunning: true, updateDownloadReady: false });
  assert.equal(off.needsConfirm, false);
  assert.deepEqual(off.reasons, []);
});

test('computeQuitRisk: downloaded update exempts confirmation (design 14 D2)', () => {
  const risk = computeQuitRisk({ quitConfirmation: true, localRunning: true, updateDownloadReady: true });
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
  const ok = validatePatch({ windowCloseBehavior: 'quit', keepAwake: true, quitConfirmation: false });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.patch, { windowCloseBehavior: 'quit', keepAwake: true, quitConfirmation: false });
});
