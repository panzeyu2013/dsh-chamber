/**
 * notifications-settings.ts pure-logic tests (design 19 §3.4, merged into the
 *「通用」notifications control group) — node:test, no DOM. Covers the group's
 * settings access: an absent notifications block reads as the design defaults,
 * and patches ride as PARTIAL nested objects — the main-process validatePatch
 * accepts partial nested keys and applySettingsPatch deep-merges them, so a
 * stale full-object snapshot from another N-ctx shell can never clobber the
 * sibling switches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChamberSettings } from '../src/ambient/settings-bridge.d.ts';
import {
  NOTIFICATIONS_DEFAULTS,
  notificationsOf,
  notificationsPatch,
} from '../src/client/notifications-settings.ts';

// Loose fixtures: cast through unknown so these tests stay valid whether or
// not the renderer ChamberSettings type has gained the `notifications` key.
const settings = (extra: object): ChamberSettings => ({ ...extra }) as unknown as ChamberSettings;

test('notificationsOf: an absent block reads as the design defaults', () => {
  assert.deepEqual(notificationsOf(undefined), NOTIFICATIONS_DEFAULTS);
  assert.deepEqual(notificationsOf(settings({})), NOTIFICATIONS_DEFAULTS);
  assert.deepEqual(notificationsOf(settings({ windowCloseBehavior: 'quit' })), NOTIFICATIONS_DEFAULTS);
  // null block（损坏/未来形态）同样回落默认，不抛。
  assert.deepEqual(notificationsOf(settings({ notifications: null })), NOTIFICATIONS_DEFAULTS);
});

test('notificationsOf: a partial block fills missing keys from the defaults', () => {
  const got = notificationsOf(settings({ notifications: { enabled: true } }));
  assert.equal(got.enabled, true);
  assert.equal(got.mode, 'hidden-only');
  assert.equal(got.onComplete, true);
  assert.equal(got.onAsk, true);
  assert.equal(got.onRequest, true);
});

test('notificationsOf: a full block passes through untouched', () => {
  const got = notificationsOf(settings({
    notifications: { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: false },
  }));
  assert.deepEqual(got, {
    enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: false,
  });
});

test('notificationsOf: unknown future keys are filtered out (validatePatch rejects them)', () => {
  const got = notificationsOf(settings({
    notifications: { enabled: true, futureKey: true, onAsk: 'bogus' },
  }));
  // futureKey 被过滤、onAsk 非布尔忽略；合法键 enabled 照常读取。
  assert.deepEqual(got, { ...NOTIFICATIONS_DEFAULTS, enabled: true });
  // 非法值回落默认。
  const mixed = notificationsOf(settings({
    notifications: { enabled: true, mode: 'weird', onComplete: false },
  }));
  assert.deepEqual(mixed, { ...NOTIFICATIONS_DEFAULTS, enabled: true, onComplete: false });
});

test('notificationsPatch: rides PARTIAL nested keys only (deep-merge lives in the main process)', () => {
  assert.deepEqual(notificationsPatch({ enabled: true }), {
    notifications: { enabled: true },
  });
  assert.deepEqual(notificationsPatch({ onComplete: false }), {
    notifications: { onComplete: false },
  });
  assert.deepEqual(notificationsPatch({ mode: 'always' }), {
    notifications: { mode: 'always' },
  });
});

test('notificationsPatch: never carries sibling keys of the current snapshot', () => {
  const patch = notificationsPatch({ onComplete: false });
  assert.deepEqual(patch, { notifications: { onComplete: false } });
  assert.equal('enabled' in patch.notifications, false, '陈旧快照的兄弟键不得上 wire');
  assert.equal('mode' in patch.notifications, false);
});

test('NOTIFICATIONS_DEFAULTS mirrors the desktop store defaults (chamber-settings.ts)', () => {
  // 双份默认值漂移守卫：desktop DEFAULT_CHAMBER_SETTINGS.notifications 的镜像
  // 断言（值变更时此处显式报错，强制两边同步）。
  assert.deepEqual(NOTIFICATIONS_DEFAULTS, {
    enabled: false,
    mode: 'hidden-only',
    onComplete: true,
    onAsk: true,
    onRequest: true,
  });
});
