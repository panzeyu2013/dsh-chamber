/**
 * Merged nested settings-group access tests: notifications (design 19 §3.4,
 * 「通用」control group) and sessionTodo (sidebar todo area control group).
 * Both groups share one contract - an absent block reads as the design
 * defaults, and patches ride as PARTIAL nested objects (validatePatch accepts
 * partial nested keys and applySettingsPatch deep-merges, so a stale
 * full-object snapshot from another N-ctx shell can never clobber the sibling
 * switches). Plain node:test, no DOM.
 *
 * merged 2026-12 test reorg: test/notifications-settings.test.ts +
 * test/session-todo-settings.test.ts. The two sources declared the identical
 * `settings` fixture; it is declared once below. Test bodies are unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChamberSettings } from '../../src/ambient/settings-bridge.d.ts';
import { en, zh } from '../../src/locales.ts';
import { NOTIFICATIONS_DEFAULTS, notificationsOf, notificationsPatch } from '../../src/client/notifications-settings.ts';
import { SESSION_TODO_DEFAULTS, sessionTodoOf, sessionTodoPatch } from '../../src/client/session-todo-settings.ts';

// Loose fixtures: cast through unknown so these tests stay valid whether or
// not the renderer ChamberSettings type has gained the `notifications` key.
// Both merged sources declared this fixture identically; it is declared once.
const settings = (extra: object): ChamberSettings => ({ ...extra }) as unknown as ChamberSettings;

// --- merged from test/notifications-settings.test.ts ---

/**
 * notifications-settings.ts pure-logic tests (design 19 §3.4, merged into the
 *「通用」notifications control group) — node:test, no DOM. Covers the group's
 * settings access: an absent notifications block reads as the design defaults,
 * and patches ride as PARTIAL nested objects — the main-process validatePatch
 * accepts partial nested keys and applySettingsPatch deep-merges them, so a
 * stale full-object snapshot from another N-ctx shell can never clobber the
 * sibling switches.
 */

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
  assert.equal(got.badgeEnabled, true, '未读徽标缺省回落默认 true（被动指示）');
});

test('notificationsOf: a full block passes through untouched', () => {
  const got = notificationsOf(settings({
    notifications: { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: false, badgeEnabled: false },
  }));
  assert.deepEqual(got, {
    enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: false, badgeEnabled: false,
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
  // 未读徽标（design 19 §3.7）同样只骑自己的键——开关切换不携带兄弟键。
  assert.deepEqual(notificationsPatch({ badgeEnabled: false }), {
    notifications: { badgeEnabled: false },
  });
});

test('notificationsPatch: never carries sibling keys of the current snapshot', () => {
  const patch = notificationsPatch({ onComplete: false });
  assert.deepEqual(patch, { notifications: { onComplete: false } });
  assert.equal('enabled' in patch.notifications, false, '陈旧快照的兄弟键不得上 wire');
  assert.equal('mode' in patch.notifications, false);
  const badge = notificationsPatch({ badgeEnabled: true });
  assert.ok(badge.notifications !== undefined, 'badge patch 携带 notifications 子块');
  assert.equal('enabled' in badge.notifications, false, 'badge 开关 patch 不携带主开关');
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
    badgeEnabled: true,
  });
});

// --- merged from test/session-todo-settings.test.ts ---

/**
 * session-todo-settings.ts pure-logic tests (sidebar todo area control group)
 * — node:test, no DOM. Covers the group's settings access: an absent
 * sessionTodo block reads as the design defaults (ALL ON — passive
 * presentation, unlike the opt-in notifications master switch), and patches
 * ride as PARTIAL nested objects — the main-process validatePatch accepts
 * partial nested keys and applySettingsPatch deep-merges them, so a stale
 * full-object snapshot from another N-ctx shell can never clobber the sibling
 * switches.
 */

test('sessionTodo defaults are ALL ON and mirror the desktop store defaults', () => {
  // Mirror assertion: desktop DEFAULT_CHAMBER_SETTINGS.sessionTodo is
  // { enabled: true, onComplete: true, onAsk: true, onRequest: true }.
  assert.deepEqual(SESSION_TODO_DEFAULTS, { enabled: true, onComplete: true, onAsk: true, onRequest: true });
});

test('sessionTodoOf: an absent block reads as the design defaults (never a fake off)', () => {
  assert.deepEqual(sessionTodoOf(undefined), SESSION_TODO_DEFAULTS);
  assert.deepEqual(sessionTodoOf(settings({})), SESSION_TODO_DEFAULTS);
  assert.deepEqual(sessionTodoOf(settings({ windowCloseBehavior: 'quit' })), SESSION_TODO_DEFAULTS);
  // null block（损坏/未来形态）同样回落默认，不抛。
  assert.deepEqual(sessionTodoOf(settings({ sessionTodo: null })), SESSION_TODO_DEFAULTS);
  // Array block：与 desktop normalizeSessionTodoSettings 同款前置拒绝（守卫对齐）。
  assert.deepEqual(sessionTodoOf(settings({ sessionTodo: ['enabled'] })), SESSION_TODO_DEFAULTS);
});

test('sessionTodoOf: a full explicit block passes through exactly (keys can never be dropped/inverted)', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: false, onComplete: false, onAsk: false, onRequest: false } }));
  assert.deepEqual(got, { enabled: false, onComplete: false, onAsk: false, onRequest: false });
});

test('sessionTodoOf: a partial block fills missing keys from the defaults', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: false } }));
  assert.equal(got.enabled, false);
  assert.equal(got.onComplete, true);
  assert.equal(got.onAsk, true);
  assert.equal(got.onRequest, true);
});

test('sessionTodoOf: a mixed block keeps the valid keys and falls back per invalid key', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: false, onAsk: 'bogus' } }));
  assert.deepEqual(got, { enabled: false, onComplete: true, onAsk: true, onRequest: true });
});

test('sessionTodoOf: unknown future nested keys are filtered out', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: false, futureKey: 42 } }));
  assert.deepEqual(got, { enabled: false, onComplete: true, onAsk: true, onRequest: true });
});

test('sessionTodoOf: non-boolean values fall back to the defaults', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: 'yes', onComplete: 1 } }));
  assert.deepEqual(got, SESSION_TODO_DEFAULTS);
});

test('sessionTodoPatch: rides as a PARTIAL nested object (siblings never clobbered)', () => {
  const patch = sessionTodoPatch({ enabled: false });
  assert.deepEqual(patch, { sessionTodo: { enabled: false } });
  assert.equal('onComplete' in (patch.sessionTodo as object), false, 'untouched switches do not ride the wire');
});

// --- 未读徽标平台能力门（design 19 §3.7 / design 23 M3，2026-12 windows 修复） ---

/**
 * 主进程 status 投影新增 supported.badgeSupported（win32=false：任务栏
 * overlay 角标 v1 未接线），GeneralView 的未读徽标开关在 false 时禁用并显示
 * 原因。GeneralView 是 React 组件（引 primitives/CSS），因此这里钉两件纯 node
 * 可测的事：zh/en 字典键镜像，以及组件的源码级能力门（仓库既有的
 * source-assertion 纪律，同 IPC surface mirror）。
 */
const generalViewSource = readFileSync(
  join(import.meta.dirname, '..', '..', 'src', 'client', 'GeneralView.tsx'),
  'utf8',
);

test('badge capability: the unsupported reason exists in both dictionaries (zh is the key-set source)', () => {
  assert.equal(typeof zh.generalNotificationsBadgeUnsupported, 'string');
  assert.equal(typeof en.generalNotificationsBadgeUnsupported, 'string');
  assert.notEqual(zh.generalNotificationsBadgeUnsupported.trim(), '');
  assert.notEqual(en.generalNotificationsBadgeUnsupported.trim(), '');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en/zh key sets must mirror');
});

test('badge capability: GeneralView reads badgeSupported as an optional fact (old main process = supported)', () => {
  // 局部可选交叉类型：能力字段加入前的旧主进程缺该字段时保持原渲染（开关
  // 启用）——向后兼容；只有显式 false 才禁用。
  assert.match(generalViewSource, /badgeSupported\?: boolean/);
  assert.match(generalViewSource, /supported\?\.badgeSupported !== false/);
});

test('badge capability: GeneralView disables the badge toggle and shows the reason when unsupported', () => {
  // 徽标开关自身携带能力门（通知主开关 / 会话待办开关仍只受 hydration 门）。
  assert.match(generalViewSource, /disabled=\{!hydrated \|\| !badgeSupported\}/);
  // 行变淡，且标签旁渲染一条短原因。
  assert.match(generalViewSource, /\(!hydrated \|\| !badgeSupported\) && css\.generalDisabled/);
  assert.match(generalViewSource, /!badgeSupported && \(/);
  assert.match(generalViewSource, /t\('generalNotificationsBadgeUnsupported'\)/);
});
