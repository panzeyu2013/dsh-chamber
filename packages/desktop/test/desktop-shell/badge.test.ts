/**
 * badge.ts pure-logic tests (design 19 §3.7) — node:test, no electron. Covers
 * the payload whitelist (finite non-negative capped integers), the settings
 * adjudication (badgeEnabled off forces 0 = clear) and the platform gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts';
import {
  MAX_BADGE_COUNT,
  adjudicateBadgeCount,
  badgePlatformGate,
  validateBadgeRequest,
} from '../../badge.ts';

/** 主进程徽标接线的两个源码事实面（合并投影输入的单一权威 + 重载清 0）。
 *  shell-core.ts 是 electron-free core 且 BADGE_COUNT 注册体在其中，注释剥离后
 *  做文本锚点断言——与 ipc-surface-mirror.test.ts 的 badge wiring pin 同款纪律
 *  （该文件钉住注册/裁决/退出清 0 的存在性，本文件钉住输入语义）。 */
const badgeModuleSource = stripComments(readFileSync(new URL('../../badge.ts', import.meta.url), 'utf8'));
const shellCoreSource = stripComments(
  readFileSync(new URL('../../shell-core.ts', import.meta.url), 'utf8')
  // 2026-12 stage-3 域拆分：BADGE_COUNT 注册体迁入 shell-ipc-settings.ts。
  + readFileSync(new URL('../../shell-ipc-settings.ts', import.meta.url), 'utf8'),
);

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
  // win32 上 setBadgeCount 恒为 undefined：平台判定必须先于 API 判定（B2）。
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

// ---- 合并投影输入：单一权威 + 重载清 0（主计划 §3.3-7 / §5-14，裁决 14） ----

/** BADGE_COUNT 注册体文本（到下一个 handler 注册点截止；注释已剥离）。 */
function badgeCountHandlerSource(): string {
  const start = shellCoreSource.indexOf('deps.ipc.handle(IPC_CHANNELS.BADGE_COUNT');
  assert.notEqual(start, -1, 'BADGE_COUNT handler must stay registered (shell-core 或拆分后的 shell-ipc-settings.ts)');
  const end = shellCoreSource.indexOf('IPC_CHANNELS.DEEP_LINK_READY', start);
  return shellCoreSource.slice(start, end === -1 ? start + 800 : end);
}

test('badge input is the renderer merged projection — the desktop never re-derives a count', () => {
  // badge.ts 是纯平台/裁决叶：不得读事实账本、合并投影或会话行——否则就是
  // 与 renderer 投影并存的第二权威（裁决 14 明确徽标输入 = 合并投影）。
  assert.doesNotMatch(
    badgeModuleSource,
    /completedBySource|runtimeFacts|mergeRuntimeFacts|projectBadgeCount|sessionId/,
    'badge.ts must stay a pure intake/adjudication leaf; the count is the renderer merged projection',
  );
  const handler = badgeCountHandlerSource();
  assert.match(handler, /pendingBadgeCount = validated\.count/, 'the holder records exactly the renderer-pushed count');
  assert.match(handler, /adjudicateBadgeCount\(/, 'settings adjudication stays the only transform');
  assert.doesNotMatch(
    handler,
    /completedBySource|runtimeFacts|projectBadgeCount|\.sessions\b/,
    'the BADGE_COUNT handler must not tally sessions itself (single authority)',
  );
});

test('badge intake keeps the renderer retry/reload-zero semantics (design 19 §3.7)', () => {
  // 0 = 合法清除值：窗口重载后 renderer 的 completedBySource 复位为 {}，挂载兜底
  // 推 0 依赖主进程照单接收并清除遗留徽标。
  assert.deepEqual(validateBadgeRequest({ count: 0 }), { ok: true, count: 0 });
  const handler = badgeCountHandlerSource();
  // holder 是「替换」而非「合并/取大」：取大会让重载的 0 被旧计数压住。
  assert.doesNotMatch(handler, /Math\.max\(/, 'the holder must be replace-on-push, never a max/merge');
  // 主进程不做值去重：renderer 的有界 retry 会重推同值（IPC 拒绝后重试），
  // 「值相同即跳过」会把 retry 变成空转（app.setBadgeCount 本身幂等）。
  assert.doesNotMatch(handler, /validated\.count === pendingBadgeCount/);
  // 平台门 + 设置裁决仍在：重载 0 也走同一条呈现链（badgeEnabled 关时本就 0）。
  assert.match(handler, /applyBadgePresentation\(count\)/);
});
