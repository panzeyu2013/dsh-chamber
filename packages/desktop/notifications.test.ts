/**
 * notifications.ts pure-logic tests (design 19 §3.3) — node:test, no
 * electron. Covers the decideNotification matrix (test bypass / disabled /
 * kind switches / requireHidden / mode) / dedupe claim (5s TTL) / payload
 * whitelist validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_DEDUPE_TTL_MS,
  claimNotification,
  decideNotification,
  validateNotificationRequest,
} from './notifications.ts';
import type { NotificationRequest, NotificationSettingsLike } from './notifications.ts';

function makeRequest(overrides: Partial<NotificationRequest> = {}): NotificationRequest {
  return {
    sourceId: 'local',
    sessionId: 's1',
    kind: 'complete',
    title: '会话已完成',
    body: 'local · 会话标题',
    requireHidden: false,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<NotificationSettingsLike> = {}): NotificationSettingsLike {
  return {
    enabled: true,
    mode: 'hidden-only',
    onComplete: true,
    onAsk: true,
    onRequest: true,
    ...overrides,
  };
}

const show = (request: NotificationRequest, settings: NotificationSettingsLike, anyWindowFocused: boolean) =>
  decideNotification({ request, settings, anyWindowFocused });

test('decideNotification: kind=test bypasses every settings gate', () => {
  const testReq = makeRequest({ kind: 'test' });
  // 主开关关 + 事件开关关 + 窗口聚焦 + hidden-only → 仍 show（测试按钮语义）。
  const gated = makeSettings({ enabled: false, onComplete: false, onAsk: false, onRequest: false });
  assert.deepEqual(show(testReq, gated, true), { action: 'show' });
  assert.deepEqual(show(testReq, gated, false), { action: 'show' });
});

test('decideNotification: kind=test not affected by requireHidden', () => {
  const testReq = makeRequest({ kind: 'test', requireHidden: true });
  const settings = makeSettings();
  assert.deepEqual(show(testReq, settings, true), { action: 'show' });
  assert.deepEqual(show(testReq, settings, false), { action: 'show' });
});

test('decideNotification: enabled=false skips every kind', () => {
  const settings = makeSettings({ enabled: false });
  for (const kind of ['complete', 'ask', 'request'] as const) {
    assert.deepEqual(show(makeRequest({ kind }), settings, false), { action: 'skip', reason: 'disabled' });
    assert.deepEqual(show(makeRequest({ kind }), settings, true), { action: 'skip', reason: 'disabled' });
  }
});

test('decideNotification: kind switches gate their own kind only', () => {
  // complete 关 → 仅 complete skip；ask/request 不受影响。
  const noComplete = makeSettings({ onComplete: false });
  assert.deepEqual(show(makeRequest({ kind: 'complete' }), noComplete, false), { action: 'skip', reason: 'kind-off' });
  assert.deepEqual(show(makeRequest({ kind: 'ask' }), noComplete, false), { action: 'show' });
  assert.deepEqual(show(makeRequest({ kind: 'request' }), noComplete, false), { action: 'show' });

  const noAsk = makeSettings({ onAsk: false });
  assert.deepEqual(show(makeRequest({ kind: 'ask' }), noAsk, false), { action: 'skip', reason: 'kind-off' });
  assert.deepEqual(show(makeRequest({ kind: 'complete' }), noAsk, false), { action: 'show' });
  assert.deepEqual(show(makeRequest({ kind: 'request' }), noAsk, false), { action: 'show' });

  const noRequest = makeSettings({ onRequest: false });
  assert.deepEqual(show(makeRequest({ kind: 'request' }), noRequest, false), { action: 'skip', reason: 'kind-off' });
  assert.deepEqual(show(makeRequest({ kind: 'complete' }), noRequest, false), { action: 'show' });
  assert.deepEqual(show(makeRequest({ kind: 'ask' }), noRequest, false), { action: 'show' });
});

test('decideNotification: requireHidden && focused → skip on-screen', () => {
  const settings = makeSettings();
  const req = makeRequest({ requireHidden: true });
  assert.deepEqual(show(req, settings, true), { action: 'skip', reason: 'on-screen' });
  // 未聚焦 → 放行（requireHidden 不构成独立门槛）。
  assert.deepEqual(show(req, settings, false), { action: 'show' });
  // requireHidden=false 聚焦 → 不被 on-screen 拦（由 mode 规则决定）。
  assert.deepEqual(show(makeRequest({ requireHidden: false }), settings, true), { action: 'skip', reason: 'focused-hidden-only' });
});

test('decideNotification: hidden-only + focused → skip focused-hidden-only; unfocused → show', () => {
  const settings = makeSettings({ mode: 'hidden-only' });
  const req = makeRequest({ requireHidden: false });
  assert.deepEqual(show(req, settings, true), { action: 'skip', reason: 'focused-hidden-only' });
  assert.deepEqual(show(req, settings, false), { action: 'show' });
});

test('decideNotification: mode=always lets focused-through (except on-screen exemption)', () => {
  const settings = makeSettings({ mode: 'always' });
  // 普通请求：聚焦也放行。
  assert.deepEqual(show(makeRequest({ requireHidden: false }), settings, true), { action: 'show' });
  assert.deepEqual(show(makeRequest({ requireHidden: false }), settings, false), { action: 'show' });
  // 正在查看的会话（requireHidden）仍豁免——always 不覆盖 on-screen。
  assert.deepEqual(show(makeRequest({ requireHidden: true }), settings, true), { action: 'skip', reason: 'on-screen' });
});

test('decideNotification: happy path shows', () => {
  const settings = makeSettings();
  for (const kind of ['complete', 'ask', 'request'] as const) {
    assert.deepEqual(show(makeRequest({ kind }), settings, false), { action: 'show' });
  }
});

test('claimNotification: same key within TTL is deduped, different keys independent', () => {
  const now = 1_000_000;
  const a1 = makeRequest({ sourceId: 'local', sessionId: 's1', kind: 'complete' });
  const a2 = makeRequest({ sourceId: 'local', sessionId: 's1', kind: 'complete' });
  const b = makeRequest({ sourceId: 'ssh-2', sessionId: 's9', kind: 'complete' });
  const c = makeRequest({ sourceId: 'local', sessionId: 's1', kind: 'ask' });
  assert.equal(claimNotification(a1, now), true);
  assert.equal(claimNotification(a2, now + 100), false, 'same key within TTL → false');
  assert.equal(claimNotification(b, now + 100), true, 'different source → independent');
  assert.equal(claimNotification(c, now + 100), true, 'different kind → independent');
});

test('claimNotification: claim recovers after TTL elapses', () => {
  const now = 2_000_000;
  // 边界：TTL-1 仍拦，恰好 TTL 放行（claim 重置窗口）。
  const boundary = makeRequest({ sourceId: 'local', sessionId: 'b', kind: 'request' });
  assert.equal(claimNotification(boundary, now), true);
  assert.equal(claimNotification(boundary, now + NOTIFICATION_DEDUPE_TTL_MS - 1), false, 'still inside TTL');
  assert.equal(claimNotification(boundary, now + NOTIFICATION_DEDUPE_TTL_MS), true, 'exactly at TTL → allowed again');
  // 恢复：TTL+1 放行（独立 key，避免恰好 TTL 的 claim 重置窗口）。
  const recovered = makeRequest({ sourceId: 'local', sessionId: 'r', kind: 'request' });
  assert.equal(claimNotification(recovered, now), true);
  assert.equal(claimNotification(recovered, now + NOTIFICATION_DEDUPE_TTL_MS + 1), true, 'beyond TTL → allowed again');
});

test('claimNotification: test kind never claims (always true)', () => {
  const req = makeRequest({ kind: 'test' });
  assert.equal(claimNotification(req, 3_000_000), true);
  assert.equal(claimNotification(req, 3_000_000 + 1), true, 'test 连点每次都放行');
  assert.equal(claimNotification(req, 3_000_000 + 5_000), true);
});

test('claimNotification: key space covers sourceId|sessionId|kind only (title/body not part of key)', () => {
  const now = 4_000_000;
  const base = makeRequest({ sourceId: 'local', sessionId: 's1', kind: 'complete' });
  const retitled = makeRequest({ sourceId: 'local', sessionId: 's1', kind: 'complete', title: '另一标题' });
  assert.equal(claimNotification(base, now), true);
  assert.equal(claimNotification(retitled, now + 100), false, 'title 变化不构成新 key');
});

test('validateNotificationRequest: accepts a valid payload', () => {
  const valid = validateNotificationRequest(makeRequest());
  assert.ok(valid.ok);
  if (valid.ok) assert.deepEqual(valid.request, makeRequest());
  // test kind 同样合法。
  assert.ok(validateNotificationRequest(makeRequest({ kind: 'test' })).ok);
});

test('validateNotificationRequest: rejects non-object payloads', () => {
  assert.equal(validateNotificationRequest(null).ok, false);
  assert.equal(validateNotificationRequest(undefined).ok, false);
  assert.equal(validateNotificationRequest('x').ok, false);
  assert.equal(validateNotificationRequest(42).ok, false);
  assert.equal(validateNotificationRequest(['a']).ok, false);
});

test('validateNotificationRequest: rejects empty/missing string fields', () => {
  assert.equal(validateNotificationRequest(makeRequest({ sourceId: '' })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ sourceId: undefined as unknown as string })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ sessionId: '' })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ sessionId: 7 as unknown as string })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ title: '' })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ title: 42 as unknown as string })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ body: '' })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ body: null as unknown as string })).ok, false);
});

test('validateNotificationRequest: test kind exempts the empty sessionId (settings-page test button)', () => {
  // 设置页「发送测试通知」没有会话上下文（sessionId: ''）——'test' 是唯一豁免。
  const testEmpty = validateNotificationRequest(makeRequest({ kind: 'test', sessionId: '' }));
  assert.ok(testEmpty.ok, 'test + 空 sessionId 必须合法');
  if (testEmpty.ok) assert.equal(testEmpty.request.sessionId, '');
  // 非 test 空 sessionId 仍拒绝。
  assert.equal(validateNotificationRequest(makeRequest({ sessionId: '' })).ok, false);
  // test 的 sourceId/title/body 仍受非空与长度约束（豁免只限 sessionId）。
  assert.equal(validateNotificationRequest(makeRequest({ kind: 'test', title: '' })).ok, false);
});

test('validateNotificationRequest: enforces length caps (256/256/256/512)', () => {
  const longSource = makeRequest({ sourceId: 'x'.repeat(257) });
  assert.equal(validateNotificationRequest(longSource).ok, false);
  assert.ok(validateNotificationRequest(makeRequest({ sourceId: 'x'.repeat(256) })).ok, '256 边界合法');

  const longSession = makeRequest({ sessionId: 'y'.repeat(257) });
  assert.equal(validateNotificationRequest(longSession).ok, false);
  assert.ok(validateNotificationRequest(makeRequest({ sessionId: 'y'.repeat(256) })).ok, '256 边界合法');

  const longTitle = makeRequest({ title: 'z'.repeat(257) });
  assert.equal(validateNotificationRequest(longTitle).ok, false);
  assert.ok(validateNotificationRequest(makeRequest({ title: 'z'.repeat(256) })).ok, '256 边界合法');

  const longBody = makeRequest({ body: 'w'.repeat(513) });
  assert.equal(validateNotificationRequest(longBody).ok, false);
  assert.ok(validateNotificationRequest(makeRequest({ body: 'w'.repeat(512) })).ok, '512 边界合法');
});

test('validateNotificationRequest: rejects bad kind and non-boolean requireHidden', () => {
  assert.equal(validateNotificationRequest(makeRequest({ kind: 'error' as NotificationRequest['kind'] })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ kind: 'completed' as NotificationRequest['kind'] })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ kind: '' as NotificationRequest['kind'] })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ requireHidden: 'yes' as unknown as boolean })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ requireHidden: 1 as unknown as boolean })).ok, false);
  assert.equal(validateNotificationRequest(makeRequest({ requireHidden: undefined as unknown as boolean })).ok, false);
});

test('validateNotificationRequest: unknown extra fields ignored (whitelist semantics)', () => {
  const extra = { ...makeRequest(), futureField: 'x', secret: 42 };
  const result = validateNotificationRequest(extra);
  assert.ok(result.ok, '白名单校验只检查必要字段');
});
