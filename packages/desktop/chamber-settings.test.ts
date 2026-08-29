/**
 * chamber-settings.ts pure-logic tests (design 14 D7) — node:test, no
 * electron. Covers normalize / atomic file round-trip / corrupt preservation /
 * platform gates / close-window decision / quit-risk (update exemption) /
 * patch validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CHAMBER_SETTINGS,
  closeToTrayRecoveryAvailable,
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
  const ok = normalizeSettings({ windowCloseBehavior: 'quit', launchAtLogin: true, keepAwake: true, quitConfirmation: false, registryOrigin: 'https://registry.npmmirror.com', futureKey: 42 });
  assert.deepEqual(ok, { windowCloseBehavior: 'quit', launchAtLogin: true, keepAwake: true, quitConfirmation: false, registryOrigin: 'https://registry.npmmirror.com', notifications: DEFAULT_CHAMBER_SETTINGS.notifications });
  // Bad enum / non-boolean values fall back to defaults silently (normalize is
  // the persistence read path; loud validation lives in validatePatch).
  const bad = normalizeSettings({ windowCloseBehavior: 'minimize', launchAtLogin: 'yes', keepAwake: 1, quitConfirmation: 'yes' });
  assert.deepEqual(bad, DEFAULT_CHAMBER_SETTINGS);
  assert.equal(normalizeSettings({ registryOrigin: 'https://registry.example/private' }).registryOrigin, DEFAULT_CHAMBER_SETTINGS.registryOrigin);
  assert.equal(normalizeSettings({ registryOrigin: 'https://registry.example/?token=x' }).registryOrigin, DEFAULT_CHAMBER_SETTINGS.registryOrigin);
});

test('normalizeSettings: nested notifications — missing/invalid fields fall back to defaults', () => {
  // 缺字段 → 整组默认。
  assert.deepEqual(normalizeSettings({ notifications: {} }).notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  // 非对象（null/数组/标量）→ 整组默认。
  assert.deepEqual(normalizeSettings({ notifications: null }).notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  assert.deepEqual(normalizeSettings({ notifications: 'yes' }).notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  assert.deepEqual(normalizeSettings({ notifications: ['x'] }).notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  // 部分字段 → 缺失用默认；合法字段保留；非法值回落默认。
  const partial = normalizeSettings({ notifications: { enabled: true, mode: 'always', onAsk: false, onComplete: 'yes' } });
  assert.deepEqual(partial.notifications, { enabled: true, mode: 'always', onComplete: true, onAsk: false, onRequest: true });
  const invalid = normalizeSettings({ notifications: { enabled: 'yes', mode: 'sometimes', onRequest: 1 } });
  assert.deepEqual(invalid.notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  // 未知嵌套键忽略（前向兼容，persistence 读路径语义同顶层）。
  const unknown = normalizeSettings({ notifications: { enabled: true, futureNested: 42 } });
  assert.deepEqual(unknown.notifications, { enabled: true, mode: 'hidden-only', onComplete: true, onAsk: true, onRequest: true });
});

test('writeSettingsFile + readSettingsFile round-trip (atomic, 0600)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const file = path.join(dir, 'chamber-settings.json');
  const settings = {
    windowCloseBehavior: 'quit' as const,
    launchAtLogin: true,
    keepAwake: true,
    quitConfirmation: false,
    registryOrigin: 'https://registry.npmjs.org',
    notifications: { enabled: true, mode: 'always' as const, onComplete: false, onAsk: true, onRequest: false },
  };
  writeSettingsFile(file, settings);
  const read = readSettingsFile(file);
  assert.equal(read.notice, null);
  assert.deepEqual(read.settings, settings);
  const stat = readFileSync(file, 'utf8');
  assert.ok(stat.includes('"quit"'));
  assert.ok(stat.includes('"always"'));
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

test('readSettingsFile: invalid persisted registry trust anchor is preserved as corrupt', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-invalid-registry-'));
  const file = path.join(dir, 'chamber-settings.json');
  try {
    writeFileSync(file, JSON.stringify({ registryOrigin: 'http://private.example/path' }));
    const read = readSettingsFile(file);
    assert.equal(read.settings.registryOrigin, DEFAULT_CHAMBER_SETTINGS.registryOrigin);
    assert.match(read.notice ?? '', /corrupt/);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.corrupt`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSettingsFile: malformed nested notifications block is preserved as corrupt (review 2026-08)', () => {
  // The notifications sub-block is part of the file's SHAPE: a scalar, an
  // array, or a wrongly-typed field must never be silently re-normalized to
  // defaults (corrupt-preserve discipline, same as registryOrigin).
  const malformed: unknown[] = [
    { notifications: 'enabled' },
    { notifications: ['enabled', true] },
    { notifications: { enabled: true, mode: 'sometimes' } },
    { notifications: { enabled: 'yes', mode: 'always' } },
    { notifications: { enabled: true, mode: 'always', onComplete: 1 } },
  ];
  for (const [index, payload] of malformed.entries()) {
    const dir = mkdtempSync(path.join(tmpdir(), `chamber-settings-bad-notifications-${index}-`));
    const file = path.join(dir, 'chamber-settings.json');
    try {
      writeFileSync(file, JSON.stringify(payload));
      const read = readSettingsFile(file);
      assert.match(read.notice ?? '', /corrupt/, `notifications payload #${index} must be corrupt`);
      assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS, `notifications payload #${index} falls back to defaults`);
      assert.equal(existsSync(file), false, `notifications payload #${index} file moved away`);
      assert.equal(existsSync(`${file}.corrupt`), true, `notifications payload #${index} preserved`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // A well-formed notifications block stays valid (and unknown nested keys
  // remain a forward-compat tolerance, like the top level).
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-good-notifications-'));
  const file = path.join(dir, 'chamber-settings.json');
  try {
    writeFileSync(file, JSON.stringify({
      notifications: { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: false, futureKey: 'x' },
    }));
    const read = readSettingsFile(file);
    assert.equal(read.notice, null, 'well-formed notifications block reads clean');
    assert.deepEqual(read.settings.notifications, { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeSupported: launchAtLogin off on win32; closeToTray follows tray availability, always on darwin', () => {
  assert.deepEqual(computeSupported('win32', true), { launchAtLogin: false, closeToTray: true });
  assert.deepEqual(computeSupported('win32', false), { launchAtLogin: false, closeToTray: false });
  assert.deepEqual(computeSupported('darwin', false), { launchAtLogin: true, closeToTray: true });
  assert.deepEqual(computeSupported('linux', true), { launchAtLogin: true, closeToTray: true });
  assert.deepEqual(computeSupported('linux', false), { launchAtLogin: true, closeToTray: false });
});

test('closeToTrayRecoveryAvailable: macOS Dock always recovers; elsewhere the tray is the gate', () => {
  assert.equal(closeToTrayRecoveryAvailable('darwin', false), true, 'macOS Dock icon recovery is always available');
  assert.equal(closeToTrayRecoveryAvailable('darwin', true), true);
  assert.equal(closeToTrayRecoveryAvailable('linux', true), true);
  assert.equal(closeToTrayRecoveryAvailable('linux', false), false, 'no tray on linux → no recovery surface');
  assert.equal(closeToTrayRecoveryAvailable('win32', true), true);
  assert.equal(closeToTrayRecoveryAvailable('win32', false), false);
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

test('validatePatch: nested notifications — valid partial patches accepted', () => {
  const full = validatePatch({ notifications: { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: true } });
  assert.ok(full.ok);
  if (full.ok) assert.deepEqual(full.patch.notifications, { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: true });
  // 部分嵌套字段合法（未提供的字段不落 patch，由 applySettingsPatch deep-merge 兜底）。
  const partial = validatePatch({ notifications: { enabled: true, mode: 'hidden-only' } });
  assert.ok(partial.ok);
  if (partial.ok) assert.deepEqual(partial.patch.notifications, { enabled: true, mode: 'hidden-only' });
  // 空对象也是合法 partial（无操作）。
  const empty = validatePatch({ notifications: {} });
  assert.ok(empty.ok);
});

test('validatePatch: nested notifications — invalid values rejected loudly', () => {
  const notObject = validatePatch({ notifications: 'yes' });
  assert.equal(notObject.ok, false);
  const nullNested = validatePatch({ notifications: null });
  assert.equal(nullNested.ok, false);
  const arrayNested = validatePatch({ notifications: ['enabled'] });
  assert.equal(arrayNested.ok, false);
  const badMode = validatePatch({ notifications: { mode: 'sometimes' } });
  assert.equal(badMode.ok, false);
  const badBool = validatePatch({ notifications: { onComplete: 'yes' } });
  assert.equal(badBool.ok, false);
  const unknownNested = validatePatch({ notifications: { enabled: true, futureNested: 42 } });
  assert.equal(unknownNested.ok, false);
  // 嵌套非法时顶层合法键也不应被采纳（整体失败）。
  const mixed = validatePatch({ keepAwake: true, notifications: { mode: 'always' as unknown } });
  assert.ok(mixed.ok, 'mode 合法时整体通过');
  const mixedBad = validatePatch({ keepAwake: true, notifications: { mode: 'sometimes' } });
  assert.equal(mixedBad.ok, false);
});
