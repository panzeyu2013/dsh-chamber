/**
 * notifications.ts pure-logic tests (design 19 §3.3) — node:test, no electron.
 * Covers decideNotification (test bypass / gates / requireHidden / mode), the
 * 5s-TTL dedupe claim, payload whitelist validation and the bounded registry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { BoundedAckDeliveryQueue } from '../../deep-link.ts';
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts';
import { hostileThrownValue } from './hostile.ts'
import {
  BoundedActiveNotifications,
  BoundedRateLimiter,
  MAX_ACTIVE_NATIVE_NOTIFICATIONS,
  MAX_NOTIFICATION_CLAIMS,
  MAX_NATIVE_NOTIFICATION_SHOWS_PER_WINDOW,
  NOTIFICATION_DEDUPE_TTL_MS,
  MAX_PENDING_NOTIFICATION_OPENS,
  NotificationClaimWindow,
  NotificationSourceIncarnations,
  NotificationSourceProofs,
  REMOTE_SOURCE_FINGERPRINT_PATTERN,
  claimNotification,
  decideNotification,
  describeNativeNotificationFailure,
  interpretNativeNotificationReply,
  shouldFocusApplicationBeforeShowing,
  showNativeNotificationHonestly,
  validateNotificationRequest,
} from '../../notifications.ts';
import type { NotificationOpenIntent, NotificationRequest, NotificationSettingsLike } from '../../notifications.ts';

function makeRequest(overrides: Partial<NotificationRequest> = {}): NotificationRequest {
  const sourceId = overrides.sourceId ?? 'local'
  return {
    sourceId,
    sourceFingerprint: overrides.sourceFingerprint ?? (sourceId === 'local' ? 'local' : 'a'.repeat(64)),
    sessionId: 's1',
    kind: 'complete',
    title: '会话已完成',
    body: 'local · 会话标题',
    requireHidden: false,
    ...overrides,
  };
}

function proofInstance(overrides: Partial<{
  id: string
  label: string
  kind: string
  host: string
  user: string | null
  sshPort: number | null
  remotePort: number
  serviceName: string | null
  remoteDshHome: string | null
}> = {}) {
  return {
    id: 'same',
    label: 'host',
    kind: 'ssh',
    host: 'a.example.com',
    user: null,
    sshPort: null,
    remotePort: 2222,
    serviceName: null,
    remoteDshHome: null,
    ...overrides,
  }
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
test('notification-open delivery retains send-return work, replays FIFO after reload, and frees capacity only on ACK', () => {
  const queue = new BoundedAckDeliveryQueue<NotificationOpenIntent>(2)
  const a = { sourceId: 'local', sourceFingerprint: 'local', sessionId: 's1', sourceGeneration: 1 }
  const b = { sourceId: 'ssh-2', sourceFingerprint: 'a'.repeat(64), sessionId: 's2', sourceGeneration: 1 }
  queue.enqueue(a)
  queue.enqueue(b)
  const oldA = queue.shift()!
  const oldB = queue.shift()!
  assert.equal(queue.trackedCount, 2, 'webContents.send return is not a commit')
  assert.deepEqual(
    queue.enqueue({ sourceId: 'local', sourceFingerprint: 'local', sessionId: 's3', sourceGeneration: 1 }),
    { accepted: false, dropped: null, reason: 'saturated' },
  )
  queue.requeueInFlight()
  const replayA = queue.shift()!
  const replayB = queue.shift()!
  assert.deepEqual([replayA.payload, replayB.payload], [a, b])
  assert.equal(queue.acknowledge(oldA.deliveryId, oldA.attempt), false, 'old renderer attempt cannot consume replay')
  assert.equal(queue.acknowledge(replayA.deliveryId, replayA.attempt), true)
  assert.equal(queue.enqueue({ sourceId: 'local', sourceFingerprint: 'local', sessionId: 's3', sourceGeneration: 1 }).accepted, true, 'ACK releases hard-cap ownership')
  assert.equal(queue.acknowledge(replayB.deliveryId, replayB.attempt), true)
  assert.equal(oldB.attempt + 1, replayB.attempt)
  assert.equal(MAX_PENDING_NOTIFICATION_OPENS, 64)
});
test('source incarnation retires old native clicks and pending/in-flight opens on remove or identity edit', () => {
  const sources = new NotificationSourceIncarnations()
  sources.replaceRemoteSources([{ sourceId: 'ssh-same', fingerprint: 'host-a' }])
  const old = sources.capture('ssh-same')!
  assert.equal(sources.owns(old), true)
  assert.equal(sources.matches('ssh-same', 'host-a'), true)

  const queue = new BoundedAckDeliveryQueue<NotificationOpenIntent>(4)
  queue.enqueue({ sourceId: 'ssh-same', sourceFingerprint: old.fingerprint, sessionId: 'pending', sourceGeneration: old.generation })
  queue.enqueue({ sourceId: 'ssh-same', sourceFingerprint: old.fingerprint, sessionId: 'sent', sourceGeneration: old.generation })
  const sent = queue.shift()!
  assert.deepEqual(sources.replaceRemoteSources([{ sourceId: 'ssh-same', fingerprint: 'host-b' }]), ['ssh-same'])
  assert.equal(sources.owns(old), false, 'old Notification click closure no longer owns the source')
  assert.equal(sources.matches('ssh-same', 'host-a'), false, 'old producer fingerprint is rejected after edit commit')
  assert.equal(sources.matches('ssh-same', 'host-b'), true)
  assert.equal(
    queue.discardWhere(intent => intent.sourceId === old.sourceId && intent.sourceGeneration === old.generation),
    2,
    'both pending and send-return/in-flight opens are retired',
  )
  assert.equal(queue.trackedCount, 0)
  assert.equal(sent.payload.sourceFingerprint, 'host-a', 'an already-sent IPC payload remains bound to the retired proof')
  assert.equal(queue.acknowledge(sent.deliveryId, sent.attempt), false, 'retirement consumed main ownership before a late renderer ACK')

  const replacement = sources.capture('ssh-same')!
  assert.notEqual(replacement.generation, old.generation)
  sources.replaceRemoteSources([])
  assert.equal(sources.owns(replacement), false)
  assert.equal(sources.capture('ssh-same'), null)
  sources.replaceRemoteSources([{ sourceId: 'ssh-same', fingerprint: 'host-b' }])
  assert.notEqual(sources.capture('ssh-same')!.generation, replacement.generation, 'same-fingerprint re-add is still fresh')
  assert.equal(sources.owns(sources.capture('local')!), true, 'local source is never retired by remote roster changes')
});
test('source-incarnation unique-id churn leaves no generation tombstones', () => {
  const sources = new NotificationSourceIncarnations()
  for (let index = 0; index < 10_000; index += 1) {
    sources.replaceRemoteSources([{ sourceId: `ssh-churn-${index}`, fingerprint: `host-${index}` }])
    assert.equal(sources.activeCount, 2, 'only local plus the current remote source are retained')
  }
  sources.replaceRemoteSources([])
  assert.equal(sources.activeCount, 1, 'retiring the final remote leaves only local ownership')
});

test('main-memory source proofs rotate on retirement and same-tuple re-add, but not on non-retiring edits', () => {
  let minted = 0
  const proofs = new NotificationSourceProofs(() => (++minted).toString(16).padStart(64, '0'))
  const first = proofs.replaceRemoteInstances([proofInstance()])[0]
  assert.match(first.sourceFingerprint, REMOTE_SOURCE_FINGERPRINT_PATTERN)

  const presentation = proofs.replaceRemoteInstances([proofInstance({
    label: 'renamed',
    serviceName: 'dsh-alt.service',
    remoteDshHome: '~/alt-dsh',
  })])[0]
  assert.equal(presentation.sourceFingerprint, first.sourceFingerprint, 'non-retiring edits preserve shell ownership')

  const transportEdit = proofs.replaceRemoteInstances([proofInstance({ host: 'b.example.com' })])[0]
  assert.notEqual(transportEdit.sourceFingerprint, first.sourceFingerprint, 'transport retirement rotates proof')
  proofs.replaceRemoteInstances([])
  assert.equal(proofs.activeCount, 0, 'removal deletes sidecar ownership without tombstones')
  const sameTupleReadd = proofs.replaceRemoteInstances([proofInstance({ host: 'b.example.com' })])[0]
  assert.notEqual(sameTupleReadd.sourceFingerprint, transportEdit.sourceFingerprint, 'same-tuple re-add is a fresh incarnation')
});

test('default source proofs are strict 64-character lowercase hex and unique', () => {
  const proofs = new NotificationSourceProofs()
  const first = proofs.replaceRemoteInstances([proofInstance({ id: 'one' })])[0].sourceFingerprint
  const second = proofs.replaceRemoteInstances([
    proofInstance({ id: 'one' }),
    proofInstance({ id: 'two' }),
  ])[1].sourceFingerprint
  assert.match(first, REMOTE_SOURCE_FINGERPRINT_PATTERN)
  assert.match(second, REMOTE_SOURCE_FINGERPRINT_PATTERN)
  assert.notEqual(first, second)
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

test('claimNotification treats a fresh authoritative source proof as a new incarnation', () => {
  const now = 1_500_000
  const oldIncarnation = makeRequest({
    sourceId: 'ssh-same',
    sourceFingerprint: 'a'.repeat(64),
    sessionId: 'same-session',
    kind: 'complete',
  })
  const replacement = makeRequest({
    ...oldIncarnation,
    sourceFingerprint: 'b'.repeat(64),
  })
  assert.equal(claimNotification(oldIncarnation, now), true)
  assert.equal(claimNotification(oldIncarnation, now + 1), false)
  assert.equal(claimNotification(replacement, now + 1), true, 'old proof cannot suppress a fresh same-id host')
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

test('claimNotification: key space covers sourceId|sourceFingerprint|sessionId|kind (title/body excluded)', () => {
  const now = 4_000_000;
  const base = makeRequest({ sourceId: 'local', sessionId: 's1', kind: 'complete' });
  const retitled = makeRequest({ sourceId: 'local', sessionId: 's1', kind: 'complete', title: '另一标题' });
  assert.equal(claimNotification(base, now), true);
  assert.equal(claimNotification(retitled, now + 100), false, 'title 变化不构成新 key');
});

// ---------------------------------------------------------------------------
// 内容水位：claim 键的第五个分量
// ---------------------------------------------------------------------------

test('claimNotification: watermark is event identity — same completion once, later completion not swallowed', () => {
  const now = 5_000_000;
  const firstCompletion = makeRequest({
    sourceId: 'gateway-a',
    sourceFingerprint: 'a'.repeat(64),
    sessionId: 's1',
    kind: 'complete',
    watermark: 1_700_000_000_000,
  });
  // 第二入口（gateway 事实源）对同一次完成必须传同一水位函数
  // （complete = completedAt ?? updatedAt）⇒ 5s 内合并成一条横幅。
  const sameCompletion = { ...firstCompletion };
  // 同会话的下一次完成水位更高 ⇒ 新事件，不得被前一次的 claim 吞掉。
  const nextCompletion = { ...firstCompletion, watermark: firstCompletion.watermark! + 60_000 };
  assert.equal(claimNotification(firstCompletion, now), true);
  assert.equal(claimNotification(sameCompletion, now + 100), false, '同一完成（同水位）不得被二次通知');
  assert.equal(claimNotification(nextCompletion, now + 200), true, '不同完成（水位更高）不得被吞');
});

test('claimNotification: kind and fingerprint stay in the watermark-era key', () => {
  const now = 6_000_000;
  const complete = makeRequest({
    sourceId: 'gateway-a',
    sourceFingerprint: 'a'.repeat(64),
    sessionId: 's1',
    kind: 'complete',
    watermark: 42,
  });
  const askAtSameWatermark = makeRequest({ ...complete, kind: 'ask' });
  const freshHost = makeRequest({ ...complete, sourceFingerprint: 'b'.repeat(64) });
  assert.equal(claimNotification(complete, now), true);
  assert.equal(claimNotification(askAtSameWatermark, now + 1), true, '同水位的 ask 不得被 complete 吞并');
  assert.equal(claimNotification(freshHost, now + 1), true, 'same-id 换宿主（新 fingerprint）不继承旧 claim');
});

test('NotificationClaimWindow: the claim key is the five-tuple with watermark ?? null (L13)', () => {
  const claims = new NotificationClaimWindow();
  const stamped = claims.claim(makeRequest({ watermark: 123 }), 1_000);
  assert.equal(stamped.accepted, true);
  if (!stamped.accepted || stamped.token === null) throw new Error('expected a claim token');
  assert.equal(stamped.token.key, JSON.stringify(['local', 'local', 's1', 'complete', 123]));
  // 缺省水位序列化为 null：旧调用方的键是同一四元组 + 恒 null 的第五项，
  // 行为与升级前逐字一致。
  const legacy = claims.claim(makeRequest({ sessionId: 'legacy' }), 1_000);
  assert.equal(legacy.accepted, true);
  if (!legacy.accepted || legacy.token === null) throw new Error('expected a claim token');
  assert.equal(legacy.token.key, JSON.stringify(['local', 'local', 'legacy', 'complete', null]));
  // watermark: 0 是合法水位且不与缺省混淆（?? 只折叠 null/undefined，不折叠 0）。
  const zero = claims.claim(makeRequest({ sessionId: 'zero', watermark: 0 }), 1_000);
  assert.equal(zero.accepted, true);
  if (!zero.accepted || zero.token === null) throw new Error('expected a claim token');
  assert.equal(zero.token.key, JSON.stringify(['local', 'local', 'zero', 'complete', 0]));
  assert.equal(legacy.token.key === zero.token.key, false, '缺省 null 与显式 0 是两个事件');
});

test('NotificationClaimWindow has a hard cap, O(1) expiry queue, and conditional release', () => {
  const claims = new NotificationClaimWindow(2, 100)
  const a = makeRequest({ sessionId: 'cap-a' })
  const b = makeRequest({ sessionId: 'cap-b' })
  const c = makeRequest({ sessionId: 'cap-c' })
  const first = claims.claim(a, 1_000)
  assert.equal(first.accepted, true)
  assert.equal(claims.claim(b, 1_000).accepted, true)
  assert.deepEqual(claims.claim(c, 1_000), { accepted: false, reason: 'saturated' })
  assert.deepEqual(claims.claim(a, 1_001), { accepted: false, reason: 'duplicate' })
  if (first.accepted) claims.release(first.token)
  assert.equal(claims.claim(c, 1_002).accepted, true, 'failed native show releases capacity')
  assert.equal(claims.size, 2)
  assert.equal(claims.claim(makeRequest({ sessionId: 'after-expiry' }), 1_200).accepted, true)
  assert.equal(claims.size, 1, 'expired claims are pruned before admission')
  assert.equal(MAX_NOTIFICATION_CLAIMS, 64)

  // One live head claim with thousands of immediately released same-window
  // claims: tombstones must compact below 2*limit, not accumulate.
  const churn = new NotificationClaimWindow(4, 10_000)
  assert.equal(churn.claim(makeRequest({ sessionId: 'live-head' }), 5_000).accepted, true)
  for (let index = 0; index < 10_000; index += 1) {
    const transient = churn.claim(makeRequest({ sessionId: `transient-${index}` }), 5_000)
    assert.equal(transient.accepted, true)
    if (transient.accepted) churn.release(transient.token)
    assert.ok(churn.backingCount < 8, `backing queue escaped hard threshold at ${index}`)
  }
  assert.equal(churn.size, 1)

  // Timestamp equality is not token identity: a delayed release from an old
  // same-ms attempt must not erase its replacement's dedupe claim.
  const sameTick = new NotificationClaimWindow(2, 100)
  const old = sameTick.claim(makeRequest({ sessionId: 'same-tick' }), 7_000)
  assert.equal(old.accepted, true)
  if (!old.accepted) return
  sameTick.release(old.token)
  const replacement = sameTick.claim(makeRequest({ sessionId: 'same-tick' }), 7_000)
  assert.equal(replacement.accepted, true)
  sameTick.release(old.token)
  assert.deepEqual(
    sameTick.claim(makeRequest({ sessionId: 'same-tick' }), 7_001),
    { accepted: false, reason: 'duplicate' },
  )
})

test('BoundedRateLimiter applies the same hard window to test and real show attempts', () => {
  const limiter = new BoundedRateLimiter(2, 100)
  assert.equal(limiter.tryAcquire(1_000), true)
  assert.equal(limiter.tryAcquire(1_001), true)
  assert.equal(limiter.tryAcquire(1_099), false)
  assert.equal(limiter.tryAcquire(1_100), true)
  assert.equal(limiter.size, 2)
  assert.equal(MAX_NATIVE_NOTIFICATION_SHOWS_PER_WINDOW, 8)
  assert.equal(MAX_ACTIVE_NATIVE_NOTIFICATIONS, 16)
})

class FakeNativeNotification extends EventEmitter {
  readonly #showImpl: (self: FakeNativeNotification) => void
  closed = false

  constructor(showImpl: (self: FakeNativeNotification) => void) {
    super()
    this.#showImpl = showImpl
  }

  show(): void {
    this.#showImpl(this)
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }
}

test('interpretNativeNotificationReply: explicit outcomes are authoritative; unknown shapes are failures (P-06)', () => {
  // Swift 腿的 honest-show 应答：显式失败必须成为 {shown:false}（core 据此释放
  // 去重 claim），未知形状绝不乐观当成功。
  assert.deepEqual(interpretNativeNotificationReply({ shown: false, error: 'not authorized' }), {
    shown: false,
    error: 'not authorized',
  });
  assert.deepEqual(interpretNativeNotificationReply({ shown: false }), {
    shown: false,
    error: 'native notification was not shown',
  });
  assert.deepEqual(interpretNativeNotificationReply({ shown: false, error: '' }), {
    shown: false,
    error: 'native notification was not shown',
  });
  assert.deepEqual(interpretNativeNotificationReply({ shown: true, error: 'ignored' }), { shown: true });
  // 该线协议下 leg 只以 edge 错误报告失败，ok 的 null 应答保持 shown:true。
  assert.deepEqual(interpretNativeNotificationReply(null), { shown: true });
  assert.deepEqual(interpretNativeNotificationReply(undefined), { shown: true });
  // 不认识的形状（数组/数字/无 shown 的对象）一律失败。
  for (const weird of [[], 0, 'ok', {}, { ok: true }]) {
    assert.equal(interpretNativeNotificationReply(weird).shown, false, `${JSON.stringify(weird)} 不得被采信为成功`);
  }
});
test('showNativeNotificationHonestly settles true only on the native show event', async () => {
  const shown = new FakeNativeNotification(self => setImmediate(() => self.emit('show')))
  assert.deepEqual(await showNativeNotificationHonestly(shown, 100), { shown: true })

  const failed = new FakeNativeNotification(self => setImmediate(() => self.emit('failed', {}, 'unsigned binary')))
  assert.deepEqual(
    await showNativeNotificationHonestly(failed, 100),
    { shown: false, error: 'unsigned binary', reason: 'failed' },
  )

  const thrown = new FakeNativeNotification(() => { throw new Error('constructor bridge failed') })
  assert.deepEqual(
    await showNativeNotificationHonestly(thrown, 100),
    { shown: false, error: 'constructor bridge failed', reason: 'threw' },
  )
})
test('showNativeNotificationHonestly never hangs or rethrows a hostile failed value', async () => {
  const failed = new FakeNativeNotification(self => queueMicrotask(() => self.emit('failed', {}, hostileThrownValue())))
  assert.deepEqual(
    await showNativeNotificationHonestly(failed, 100),
    { shown: false, error: 'unknown error', reason: 'failed' },
  )

  const silent = new FakeNativeNotification(() => {})
  assert.deepEqual(
    await showNativeNotificationHonestly(silent, 5),
    { shown: false, error: 'notification show timed out', reason: 'timed-out' },
  )
  assert.equal(silent.closed, true)
})
test('showNativeNotificationHonestly rolls back partial listener setup and contains hostile cleanup', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let showCalls = 0
  const setupFailure = {
    on(event: 'show' | 'failed' | 'close', listener: (...args: unknown[]) => void) {
      if (event === 'failed') throw new Error('listener boom')
      listeners.set(event, listener)
    },
    removeListener(event: 'show' | 'failed' | 'close') { listeners.delete(event) },
    show() { showCalls += 1 },
    close() {},
  }
  assert.deepEqual(await showNativeNotificationHonestly(setupFailure, 20), {
    shown: false,
    error: 'notification listener setup failed: listener boom',
    reason: 'threw',
  })
  assert.equal(showCalls, 0, 'show never runs after partial listener installation fails')
  assert.equal(listeners.size, 0, 'already-installed listeners are rolled back')

  const hostileCleanup = new FakeNativeNotification(self => queueMicrotask(() => self.emit('show')))
  hostileCleanup.removeListener = () => { throw new Error('removeListener boom') }
  assert.deepEqual(await showNativeNotificationHonestly(hostileCleanup, 20), { shown: true })
})
test('Darwin application focus policy is explicit and platform-scoped', () => {
  assert.equal(shouldFocusApplicationBeforeShowing('darwin'), true)
  assert.equal(shouldFocusApplicationBeforeShowing('linux'), false)
  assert.equal(shouldFocusApplicationBeforeShowing('win32'), false)
})
test('validateNotificationRequest: accepts a valid payload', () => {
  const valid = validateNotificationRequest(makeRequest());
  assert.ok(valid.ok);
  if (valid.ok) assert.deepEqual(valid.request, makeRequest());
  assert.ok(validateNotificationRequest(makeRequest({ sourceId: 'dsh-dev_01' })).ok);
  assert.ok(validateNotificationRequest(makeRequest({ sourceId: `gateway-${'a'.repeat(64)}` })).ok);
  const legacy = validateNotificationRequest(makeRequest({ sourceId: 'ssh-dev_01' }));
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.equal(legacy.request.sourceId, 'dsh-dev_01', 'legacy ssh alias is canonicalized before ownership lookup');
  // test kind 同样合法。
  assert.ok(validateNotificationRequest(makeRequest({ kind: 'test' })).ok);
});

test('validateNotificationRequest: sourceId is local, canonical dsh/gateway, or the exact legacy ssh alias', () => {
  for (const sourceId of [
    'remote-1',
    'http-valid',
    'future-valid',
    'dsh-',
    'dsh-local',
    'dsh-bad/id',
    'gateway-',
    'gateway-local',
    'gateway-with space',
    'ssh-',
    'ssh-local',
    'ssh-bad/id',
    'ssh-a.b',
    'ssh-with space',
    'ssh-服务器',
    `ssh-${'a'.repeat(65)}`,
  ]) {
    assert.equal(validateNotificationRequest(makeRequest({ sourceId })).ok, false, sourceId);
  }
});
test('validateNotificationRequest accepts only the authoritative proof wire format', () => {
  assert.equal(validateNotificationRequest(makeRequest({ sourceId: 'local', sourceFingerprint: 'local' })).ok, true)
  assert.equal(validateNotificationRequest(makeRequest({ sourceId: 'local', sourceFingerprint: 'a'.repeat(64) })).ok, false)
  assert.equal(validateNotificationRequest(makeRequest({ sourceId: 'dsh-valid', sourceFingerprint: 'a'.repeat(64) })).ok, true)
  assert.equal(validateNotificationRequest(makeRequest({ sourceId: 'gateway-valid', sourceFingerprint: 'a'.repeat(64) })).ok, true)
  assert.equal(validateNotificationRequest(makeRequest({ sourceId: 'ssh-valid', sourceFingerprint: 'a'.repeat(64) })).ok, true)
  for (const sourceFingerprint of ['', 'local', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
    assert.equal(validateNotificationRequest(makeRequest({ sourceId: 'gateway-valid', sourceFingerprint })).ok, false, sourceFingerprint)
  }
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
test('validateNotificationRequest: enforces field length caps after source semantics', () => {
  const longSource = makeRequest({ sourceId: 'x'.repeat(257) });
  assert.equal(validateNotificationRequest(longSource).ok, false);

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
test('validateNotificationRequest: the optional watermark must be a non-negative safe integer', () => {
  // 缺省（旧调用方）：字段保持缺席，校验后的 request 与升级前逐字一致。
  const absent = validateNotificationRequest(makeRequest());
  assert.ok(absent.ok);
  if (absent.ok) assert.equal('watermark' in absent.request, false, '缺省不得凭空补出 watermark 键');
  // 0 是合法水位（不得被 `?? null` 折叠成缺省）。
  const zero = validateNotificationRequest(makeRequest({ watermark: 0 }));
  assert.ok(zero.ok);
  if (zero.ok) assert.equal(zero.request.watermark, 0);
  const boundary = validateNotificationRequest(makeRequest({ watermark: Number.MAX_SAFE_INTEGER }));
  assert.ok(boundary.ok, 'MAX_SAFE_INTEGER 边界合法');
  const stamped = validateNotificationRequest(makeRequest({ watermark: 1_700_000_000_000 }));
  assert.ok(stamped.ok);
  if (stamped.ok) assert.equal(stamped.request.watermark, 1_700_000_000_000);
  for (const watermark of [1.5, -1, 'x', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      validateNotificationRequest(makeRequest({ watermark: watermark as unknown as number })).ok,
      false,
      `watermark ${String(watermark)} 必须被校验拒（不归一、不静默）`,
    );
  }
});
test('BoundedActiveNotifications: constructor rejects non-positive or fractional limits', () => {
  assert.throws(() => new BoundedActiveNotifications(0), RangeError);
  assert.throws(() => new BoundedActiveNotifications(-1), RangeError);
  assert.throws(() => new BoundedActiveNotifications(1.5), RangeError);
  assert.equal(new BoundedActiveNotifications(1).size, 0);
});
test('BoundedActiveNotifications: grows below the limit without evicting', () => {
  const registry = new BoundedActiveNotifications<string>(3);
  assert.equal(registry.add('a', null), null);
  assert.equal(registry.add('b', null), null);
  assert.equal(registry.add('c', null), null);
  assert.equal(registry.size, 3);
  assert.ok(registry.has('a') && registry.has('b') && registry.has('c'));
});
test('BoundedActiveNotifications: full add evicts the oldest (FIFO) and returns it — never rejects', () => {
  const registry = new BoundedActiveNotifications<string>(3);
  registry.add('a', null);
  registry.add('b', null);
  registry.add('c', null);
  const evicted = registry.add('d', null);
  assert.equal(evicted, 'a', '最旧插入项先被淘汰');
  assert.equal(registry.size, 3, '硬上界不变');
  assert.equal(registry.has('a'), false, '被淘汰项已离开登记');
  assert.ok(registry.has('b') && registry.has('c') && registry.has('d'));
  // 连续满员添加继续按插入序淘汰：b → c → d。
  assert.equal(registry.add('e', null), 'b');
  assert.equal(registry.add('f', null), 'c');
  assert.equal(registry.add('g', null), 'd');
  assert.equal(registry.size, 3);
});
test('BoundedActiveNotifications: delete frees capacity so the next add evicts nothing', () => {
  const registry = new BoundedActiveNotifications<string>(3);
  registry.add('a', null);
  registry.add('b', null);
  registry.add('c', null);
  registry.delete('a');
  assert.equal(registry.size, 2);
  assert.equal(registry.add('d', null), null, '有空位不淘汰');
  assert.equal(registry.size, 3);
  assert.ok(registry.has('b') && registry.has('c') && registry.has('d'));
});
test('BoundedActiveNotifications: eviction order follows surviving insertion order', () => {
  const registry = new BoundedActiveNotifications<string>(3);
  registry.add('a', null);
  registry.add('b', null);
  registry.add('c', null);
  registry.delete('b'); // 存活顺序 a → c
  assert.equal(registry.add('d', null), null, '有空位（size 2 < 3）不淘汰');
  assert.equal(registry.add('e', null), 'a', '再满员时淘汰最早插入的存活项 a');
  // 存活顺序 c → d → e
  registry.delete('c');
  assert.equal(registry.add('f', null), null, '删除腾位后不淘汰');
  assert.equal(registry.add('g', null), 'd', '淘汰按剩余插入序（d 早于 e、f）');
  assert.equal(registry.size, 3);
  assert.ok(registry.has('e') && registry.has('f') && registry.has('g'));
});
test('BoundedActiveNotifications: duplicate add is a no-op that keeps the original token', () => {
  const registry = new BoundedActiveNotifications<string>(2);
  const token = { sourceId: 'dsh-x1', fingerprint: 'a'.repeat(64), generation: 7 };
  registry.add('n', token);
  assert.equal(registry.add('n', null), null, '重复登记不淘汰、不替换');
  const pairs = [...registry.entries()];
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0][1], token, '原 token 保留（click 路由不受影响）');
});
test('BoundedActiveNotifications: entries() yields live insertion-ordered pairs and tolerates delete-during-iteration', () => {
  const registry = new BoundedActiveNotifications<string>(5);
  registry.add('a', null);
  registry.add('b', null);
  registry.add('c', null);
  const seen: string[] = [];
  for (const [item, token] of registry.entries()) {
    seen.push(item);
    if (item === 'a') registry.delete(item); // 边迭代边删（Map 语义安全）
    assert.ok(token === null);
  }
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(registry.size, 2);
  assert.ok(!registry.has('a'));
});

// ---------------------------------------------------------------------------
// Electron 侧 macOS 通知授权的诚实面——主进程没有授权查询/申请 API，
// 授权状态只经 addNotificationRequest 的 completion handler 回话（非 nil
// error → 原生 failed 事件）。唯一可得的诚实面 = 把 OS 拒绝投递/限时无回执
// 如实表述为「可能未授权/被抑制」；预检查询/申请仍是登记在案的残余。
// ---------------------------------------------------------------------------
test('S-44 describeNativeNotificationFailure: OS refusal/doubt is named honestly, local artifacts are not', () => {
  const refused = describeNativeNotificationFailure('darwin', 'failed', 'Notifications are not allowed for this application.');
  assert.match(refused, /authorization may be denied/);
  assert.match(refused, /Notifications are not allowed for this application./, 'the OS text must be preserved verbatim');
  const timedOut = describeNativeNotificationFailure('darwin', 'timed-out', 'notification show timed out');
  assert.match(timedOut, /authorization may be denied/);
  assert.match(timedOut, /Focus\/Do Not Disturb/);
  assert.match(timedOut, /notification show timed out/);
  // Local construction/eviction failures are NOT an OS authorization verdict
  // (a capped-registry eviction closes before show; a listener throw is our bug).
  assert.equal(describeNativeNotificationFailure('darwin', 'threw', 'listener boom'), 'listener boom');
  assert.equal(describeNativeNotificationFailure('darwin', 'closed', 'notification closed before show'), 'notification closed before show');
  assert.equal(describeNativeNotificationFailure('darwin', undefined, 'plain'), 'plain');
  // Non-darwin keeps the raw error (Windows' failed is a delivery error, not auth).
  assert.equal(describeNativeNotificationFailure('win32', 'failed', 'toast failed'), 'toast failed');
  assert.equal(describeNativeNotificationFailure('linux', 'timed-out', 'timeout'), 'timeout');
  // An empty OS detail still has to describe the failure itself.
  assert.match(describeNativeNotificationFailure('darwin', 'failed', '   '), /no detail/);
});
test('S-44 electron-edges routes every macOS delivery failure through the honest describer', () => {
  // electron-edges imports electron, so the wiring is pinned on comment-stripped
  // source: the raw outcome must be translated before core's claim release.
  const source = stripComments(readFileSync(new URL('../../electron-edges.ts', import.meta.url), 'utf8'));
  assert.match(source, /describeNativeNotificationFailure\(process\.platform, outcome\.reason, outcome\.error\)/,
    'the NOTIFY host leg must surface why the OS refused/never confirmed the banner');
  assert.match(source, /showNativeNotificationHonestly\(created\)/,
    'the honest-show settlement must remain the single source of the outcome');
});
