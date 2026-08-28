/**
 * notifications.ts pure-logic tests (design 19 §3.3) — node:test, no
 * electron. Covers the decideNotification matrix (test bypass / disabled /
 * kind switches / requireHidden / mode) / dedupe claim (5s TTL) / payload
 * whitelist validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BoundedAckDeliveryQueue } from './deep-link.ts';
import {
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
  readNotificationHostBoolean,
  claimNotification,
  decideNotification,
  shouldFocusApplicationBeforeShowing,
  showNativeNotificationHonestly,
  validateNotificationRequest,
} from './notifications.ts';
import type { NotificationOpenIntent, NotificationRequest, NotificationSettingsLike } from './notifications.ts';

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

  // Keep one live head claim while thousands of same-window claims behind it
  // are immediately released. Tombstones must compact below 2*limit instead
  // of accumulating until the head TTL expires.
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

test('showNativeNotificationHonestly settles true only on the native show event', async () => {
  const shown = new FakeNativeNotification(self => setImmediate(() => self.emit('show')))
  assert.deepEqual(await showNativeNotificationHonestly(shown, 100), { shown: true })

  const failed = new FakeNativeNotification(self => setImmediate(() => self.emit('failed', {}, 'unsigned binary')))
  assert.deepEqual(
    await showNativeNotificationHonestly(failed, 100),
    { shown: false, error: 'unsigned binary' },
  )

  const thrown = new FakeNativeNotification(() => { throw new Error('constructor bridge failed') })
  assert.deepEqual(
    await showNativeNotificationHonestly(thrown, 100),
    { shown: false, error: 'constructor bridge failed' },
  )
})

test('showNativeNotificationHonestly never hangs or rethrows a hostile failed value', async () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error('getPrototypeOf trap') },
    get() { throw new Error('get trap') },
  })
  const failed = new FakeNativeNotification(self => queueMicrotask(() => self.emit('failed', {}, hostile)))
  assert.deepEqual(
    await showNativeNotificationHonestly(failed, 100),
    { shown: false, error: 'unknown error' },
  )

  const silent = new FakeNativeNotification(() => {})
  assert.deepEqual(
    await showNativeNotificationHonestly(silent, 5),
    { shown: false, error: 'notification show timed out' },
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
  assert.ok(validateNotificationRequest(makeRequest({ sourceId: 'ssh-dev_01' })).ok);
  assert.ok(validateNotificationRequest(makeRequest({ sourceId: `ssh-${'a'.repeat(64)}` })).ok);
  // test kind 同样合法。
  assert.ok(validateNotificationRequest(makeRequest({ kind: 'test' })).ok);
});

test('notification host boolean probes contain throws, hostile values, and invalid returns', () => {
  assert.deepEqual(readNotificationHostBoolean(() => true), { ok: true, value: true })
  assert.deepEqual(readNotificationHostBoolean(() => false), { ok: true, value: false })
  assert.deepEqual(readNotificationHostBoolean(() => 'yes'), {
    ok: false,
    error: 'notification host probe returned a non-boolean value',
  })
  const hostile = new Proxy({}, {
    get() { throw new Error('formatter trap') },
    getPrototypeOf() { throw new Error('instanceof trap') },
  })
  assert.deepEqual(readNotificationHostBoolean(() => { throw hostile }), { ok: false, error: 'unknown error' })
});

test('validateNotificationRequest: sourceId is strictly local or ssh-<registry id>', () => {
  for (const sourceId of [
    'remote-1',
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
  assert.equal(validateNotificationRequest(makeRequest({ sourceId: 'ssh-valid', sourceFingerprint: 'a'.repeat(64) })).ok, true)
  for (const sourceFingerprint of ['', 'local', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
    assert.equal(validateNotificationRequest(makeRequest({ sourceId: 'ssh-valid', sourceFingerprint })).ok, false, sourceFingerprint)
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
