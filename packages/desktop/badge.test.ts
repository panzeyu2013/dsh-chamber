/**
 * badge.ts pure-logic tests (design 19 §3.7) — node:test, no electron.
 * Covers the IPC payload whitelist (finite non-negative capped integers),
 * the settings adjudication (badgeEnabled off forces 0 = clear), and the
 * platform gate (darwin/linux supported, win32 gated off with a reason).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BADGE_COUNT,
  adjudicateBadgeCount,
  badgePlatformGate,
  validateBadgeRequest,
} from './badge.ts';

// ---- payload 白名单 ----

test('validateBadgeRequest: accepts a valid object payload', () => {
  const ok = validateBadgeRequest({ count: 3 });
  assert.deepEqual(ok, { ok: true, count: 3 });
});

test('validateBadgeRequest: 0 is the valid clear value', () => {
  assert.deepEqual(validateBadgeRequest({ count: 0 }), { ok: true, count: 0 });
});

test('validateBadgeRequest: rejects non-object payloads', () => {
  assert.equal(validateBadgeRequest(null).ok, false);
  assert.equal(validateBadgeRequest('3').ok, false);
  assert.equal(validateBadgeRequest([3]).ok, false);
  assert.equal(validateBadgeRequest(3).ok, false);
});

test('validateBadgeRequest: rejects missing / non-number / non-finite counts', () => {
  assert.equal(validateBadgeRequest({}).ok, false);
  assert.equal(validateBadgeRequest({ count: '3' }).ok, false);
  assert.equal(validateBadgeRequest({ count: true }).ok, false);
  assert.equal(validateBadgeRequest({ count: null }).ok, false);
  // 结构化克隆可携带 NaN/Infinity —— 必须显式拒绝。
  assert.equal(validateBadgeRequest({ count: Number.NaN }).ok, false);
  assert.equal(validateBadgeRequest({ count: Number.POSITIVE_INFINITY }).ok, false);
  assert.equal(validateBadgeRequest({ count: Number.NEGATIVE_INFINITY }).ok, false);
});

test('validateBadgeRequest: rejects negatives and above-cap counts loudly (no silent clamp)', () => {
  assert.equal(validateBadgeRequest({ count: -1 }).ok, false);
  assert.equal(validateBadgeRequest({ count: MAX_BADGE_COUNT + 1 }).ok, false);
  const atCap = validateBadgeRequest({ count: MAX_BADGE_COUNT });
  assert.deepEqual(atCap, { ok: true, count: MAX_BADGE_COUNT });
});

test('validateBadgeRequest: floors fractional counts (OpenChamber parity tolerance)', () => {
  assert.deepEqual(validateBadgeRequest({ count: 2.9 }), { ok: true, count: 2 });
  assert.deepEqual(validateBadgeRequest({ count: 0.5 }), { ok: true, count: 0 });
});

// ---- 设置裁决 ----

test('adjudicateBadgeCount: badgeEnabled off forces 0 (clear), on passes through', () => {
  assert.equal(adjudicateBadgeCount({ badgeEnabled: false }, 3), 0);
  assert.equal(adjudicateBadgeCount({ badgeEnabled: false }, 0), 0);
  assert.equal(adjudicateBadgeCount({ badgeEnabled: true }, 3), 3);
  assert.equal(adjudicateBadgeCount({ badgeEnabled: true }, 0), 0);
});

// ---- 平台门 ----

test('badgePlatformGate: darwin/linux supported when the API exists', () => {
  assert.equal(badgePlatformGate('darwin', true).supported, true);
  assert.equal(badgePlatformGate('linux', true).supported, true);
});

test('badgePlatformGate: win32 is gated off in v1 with a reason (overlay icon follow-up)', () => {
  const win = badgePlatformGate('win32', true);
  assert.equal(win.supported, false);
  assert.ok(win.reason.length > 0);
});

test('badgePlatformGate: the win32 design-23 reason survives a missing API (platform judged before API availability)', () => {
  // win32 上 app.setBadgeCount 恒为 undefined——平台判定必须先于 API 判定，
  // 否则专属原因会被泛化的「API 缺失」吞掉（review 收敛项 B2）。
  const win = badgePlatformGate('win32', false);
  assert.equal(win.supported, false);
  assert.match(win.reason, /Windows taskbar overlay/);
});

test('badgePlatformGate: a missing API is unsupported on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(badgePlatformGate(platform, false).supported, false, platform);
  }
  assert.equal(badgePlatformGate('freebsd', true).supported, false);
});
