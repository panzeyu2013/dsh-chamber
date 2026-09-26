import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceRunIdentities } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { createNotificationOutbox, NOTIFICATION_OUTBOX_KEY, NOTIFICATION_OUTBOX_LIMIT } from '../../src/notification-outbox.ts'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values,
  }
}

const completion = { sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'complete' as const, watermark: 100 }

/** 同一个宿主完成在 outbox 层的两种身份族：无 seq 的壳边（显式 runId）与带序的 facts 边（`completionSeq`）。 */
function edgeOf(options: { runId?: string; hostObservedAt?: number; completionSeq?: number }) {
  return {
    sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'complete' as const,
    ...options,
  }
}

test('pending completion survives reload; only shown or policy suppression settles it', () => {
  const disk = storage()
  let now = 1_000
  const first = createNotificationOutbox(disk, () => now)
  const intent = first.enqueue(completion)!
  assert.ok(disk.values.has(NOTIFICATION_OUTBOX_KEY))
  const second = createNotificationOutbox(disk, () => now)
  assert.equal(second.entries()[0]?.key, intent.key)
  const firstAttempt = second.begin(intent.key)
  assert.ok(firstAttempt)
  assert.deepEqual(second.settle(firstAttempt, 'retryable'), { accepted: true, delivered: null })
  assert.equal(second.entries().length, 1)
  assert.deepEqual(second.due(), [])
  now += 6_000
  assert.deepEqual(second.due().map(row => row.key), [intent.key])
  const retry = second.begin(intent.key)
  assert.ok(retry)
  assert.equal(second.settle(retry, 'shown').delivered?.watermark, 100)
  assert.deepEqual(createNotificationOutbox(disk).entries(), [])
})

test('stable host-watermark key deduplicates retries and isolates incarnations', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const first = outbox.enqueue(completion)!
  assert.equal(outbox.enqueue(completion)?.key, first.key)
  assert.notEqual(outbox.enqueue({ ...completion, sourceFingerprint: 'host-2' })?.key, first.key)
  assert.notEqual(outbox.enqueue({ ...completion, watermark: 101 })?.key, first.key)
  assert.equal(outbox.entries().length, 3)
})

test('runtime completion can acquire the observed watermark while awaiting the host receipt', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const entry = outbox.enqueue({ ...completion, watermark: undefined })!
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1', { watermark: 100, hostUpdatedAt: 100 }), true)
  const attempt = outbox.begin(entry.key)
  assert.ok(attempt)
  assert.equal(outbox.settle(attempt, 'suppressed').delivered?.watermark, 100)
  assert.deepEqual(outbox.entries(), [])
})

test('删除批替代锁：身份是唯一 run key，第二身份族不再被别名改写（关联归投影）', () => {
  const outbox = createNotificationOutbox(undefined, () => 10_000)
  const runtime = edgeOf({ runId: 'chamber:fp:0:s1:7', hostObservedAt: 1_000 })
  const first = outbox.enqueue(runtime)!
  outbox.settle(outbox.begin(first.key)!, 'shown')
  // facts 完成现在携带宿主事件序（实机复核：turn/end 记录 seq=106/2877 就在线上），所以
  // 「第二个身份族解析回首报 id」的改写已出局：同一完成的两个身份族在 outbox 层是两个事件，
  // 关联由投影的 absorbCandidate 在候选阶段完成（design 19 §3.2.7 ⑥/⑦；失败方向是重复，不是丢失）。
  const replay = outbox.enqueue({ ...runtime, runId: 'host:turn%2F9' as const })!
  assert.equal(replay.runId, 'host:turn%2F9', '身份按 notificationRunId 派生，不再改写成首报 id')
  assert.notEqual(replay.key, first.key, '两个身份族在 outbox 层是两个事件（跨族关联不属于 outbox）')
})

test('a distinct completion sequence is a distinct identity and event key', () => {
  const outbox = createNotificationOutbox(undefined, () => 10_000)
  const first = outbox.enqueue(edgeOf({ completionSeq: 5, hostObservedAt: 1_000 }))!
  const second = outbox.enqueue(edgeOf({ completionSeq: 6, hostObservedAt: 2_000 }))!
  assert.notEqual(first.runId, second.runId, '每个宿主事件序都是自己的身份')
  assert.notEqual(first.key, second.key, '身份不同 ⇒ 交付键不同（不得被水位的等价窗吞掉）')
})

test('删除批：存量别名键在构造时被清掉，且不再写入', () => {
  const disk = storage()
  const aliasKey = 'dsh-chamber.notification-outbox.aliases.v1'
  disk.setItem(aliasKey, JSON.stringify([{ hostKey: '["ssh-a","host-1","s1","at:1000"]', runId: 'chamber:fp:0:s1:7', at: 1_000 }]))
  const outbox = createNotificationOutbox(disk, () => 10_000)
  const entry = outbox.enqueue({
    sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'complete' as const,
    runId: 'chamber:fp:0:s1:7' as const, hostObservedAt: 1_000,
  })!
  assert.ok(entry)
  assert.equal(disk.getItem(aliasKey), null, '旧别名行不会自己消失：构造时一次性删除')
  createNotificationOutbox(disk, () => 10_000)
  assert.equal(disk.getItem(aliasKey), null, '重建后也不回写')
})

test('a new run never claims the previous run\'s pending edge', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const runtime = {
    sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'complete' as const,
    runId: 'chamber:fp:0:s1:7' as const, hostObservedAt: 1_000,
  }
  const runOne = outbox.enqueue(runtime)!
  // The SAME run's facts completion claims the pending runtime edge (it is stamped,
  // not enqueued as a second banner); a NEWER run's completion must be refused.
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1',
    { watermark: 2_000, hostUpdatedAt: 2_000 }), false,
    'a newer run must not be swallowed by the older pending edge')
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1',
    { watermark: 1_000, hostUpdatedAt: 1_000 }), true, 'the same run claims the edge')
  const runTwo = outbox.enqueue({ ...runtime, runId: 'chamber:fp:0:s1:8' as const, hostObservedAt: 2_000 })!
  assert.notEqual(runTwo.key, runOne.key, 'a new run has its own event key')
})

test('regression: completedAt newer than the runtime updatedAt anchor still claims the same run', () => {
  // One completion carries two host fields: the runtime edge anchored on `updatedAt`
  // (last activity), while the facts row's content watermark is
  // `max(completedAt, updatedAt)` - normally LATER. Comparing the two was the defect:
  // the facts frame could not claim the edge, the session was absent from
  // pendingSessions, and the projection minted a second delivery key for one completion.
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const runtime = {
    sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'complete' as const,
    runId: 'chamber:fp:0:s1:7' as const, hostObservedAt: 1_000,
  }
  const entry = outbox.enqueue(runtime)!
  const sameRun = { watermark: 2_000, hostUpdatedAt: 1_000 }
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1', sameRun), true,
    'the same run must claim the edge although the content watermark is newer than its activity anchor')
  assert.equal(outbox.entries()[0]?.watermark, 2_000)
  assert.equal(outbox.entries()[0]?.key, entry.key,
    'claiming must not re-key the durable native event')
  // A later run advanced the host `updatedAt`; its facts frame must not be absorbed.
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1',
    { watermark: 3_000, hostUpdatedAt: 2_000 }), false)
})

test('a host-time-less runtime anchor still owns the next facts completion', () => {
  // 旧 planner 的 legacy 兜底（runtimeSettled 无 host 时间）：没有可比较的锚点时，
  // 结算标记仍认领下一条 facts 完成，不得因此二次发横幅。
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const entry = outbox.enqueue({ ...completion, watermark: undefined })!
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1', { watermark: 2_000, hostUpdatedAt: 2_000 }), true,
    'a runtime edge without host time is still a marker')
  assert.equal(outbox.entries()[0]?.key, entry.key, 'claiming must not re-key the durable native event')
})

test('a disagreeing host sequence never claims the edge, whatever the times say', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const runtime = {
    sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'complete' as const,
    runId: 'chamber:fp:0:s1:7' as const, hostObservedAt: 5_000, completionSeq: 7,
  }
  outbox.enqueue(runtime)
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1',
    { watermark: 1_000, hostUpdatedAt: 1_000, completionSeq: 8 }), false,
    'a later sequence is a new run even when its host time looks older')
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1',
    { watermark: 5_000, hostUpdatedAt: 5_000, completionSeq: 7 }), true)
})

test('two questions with no host-domain evidence never share an identity or a receipt key', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const ask = { sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'ask' as const }
  const first = outbox.enqueue(ask)!
  const second = outbox.enqueue(ask)!
  assert.notEqual(second.runId, first.runId, 'a new question is a new event, not a re-observation')
  assert.notEqual(second.key, first.key, 'a shared key lets the durable native receipt drop the second question')
})

test('a permanently failed edge cannot absorb a later run completion', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const runtimeComplete = { sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'complete' as const }
  const runOne = outbox.enqueue(runtimeComplete)!
  const attempt = outbox.begin(runOne.key)!
  assert.deepEqual(outbox.settle(attempt, 'permanent'), { accepted: true, delivered: null })
  assert.equal(outbox.entries()[0]?.blocked, true)
  const runTwo = outbox.enqueue({ ...runtimeComplete, runId: 'host:turn%2F7' })!
  assert.notEqual(runTwo.key, runOne.key, 'the blocked entry must not answer for a later run')
  assert.equal(runTwo.blocked, false)
})

test('a corrupt persisted run identity is dropped at the journal restore boundary', () => {
  const disk = storage()
  const row = (sessionId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId, kind: 'complete',
    attempts: 0, nextAttemptAt: 0, blocked: false, ...extra,
  })
  disk.setItem(NOTIFICATION_OUTBOX_KEY, JSON.stringify([
    row('corrupt', { runId: 'host:%' }),
    row('valid', { runId: 'host:turn%2F7' }),
    row('preSpine', { watermark: 5 }),
  ]))
  const outbox = createNotificationOutbox(disk, () => 1_000)
  assert.deepEqual(outbox.entries().map(entry => entry.sessionId).sort(), ['preSpine', 'valid'],
    'a corrupt id is dropped; a real identity and a pre-spine row survive')
})

test('an anonymous ask keeps its identity across a journal reload', () => {
  const disk = storage()
  const ask = { sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'ask' as const }
  const first = createNotificationOutbox(disk, () => 1_000)
  const entry = first.enqueue(ask)!
  // A second page lifetime has a fresh local-event nonce; re-deriving the identity
  // would re-key the stored entry and decouple it from the receipt the host holds.
  const reloaded = createNotificationOutbox(disk, () => 1_000)
  assert.equal(reloaded.entries()[0]?.runId, entry.runId)
  assert.equal(reloaded.entries()[0]?.key, entry.key)
})

test('permanent native failure remains visible without a retry loop', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const entry = outbox.enqueue(completion)!
  const attempt = outbox.begin(entry.key)
  assert.ok(attempt)
  assert.deepEqual(outbox.settle(attempt, 'permanent'), { accepted: true, delivered: null })
  assert.equal(outbox.entries()[0]?.blocked, true)
  assert.deepEqual(outbox.due(1_000_000), [])
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1',
    { watermark: 100, hostUpdatedAt: 100 }), true,
    'a permanently failed edge still answers for its OWN watermark (handled, not retried)')
  assert.equal(outbox.associateCompletion('ssh-a', 'host-1', 's1',
    { watermark: 101, hostUpdatedAt: 101 }), false)
  assert.notEqual(outbox.enqueue({ ...completion, watermark: 101 })?.key, entry.key)
})

test('terminal failures cannot permanently fill the delivery journal', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  let oldest = ''
  for (let index = 0; index < NOTIFICATION_OUTBOX_LIMIT; index += 1) {
    const entry = outbox.enqueue({ ...completion, watermark: 100 + index })!
    if (index === 0) oldest = entry.key
    const attempt = outbox.begin(entry.key)
    assert.ok(attempt)
    outbox.settle(attempt, 'permanent')
  }
  const newer = outbox.enqueue({ ...completion, watermark: 100 + NOTIFICATION_OUTBOX_LIMIT })
  assert.ok(newer)
  assert.equal(outbox.entries().length, NOTIFICATION_OUTBOX_LIMIT)
  assert.equal(outbox.entries().some(entry => entry.key === oldest), false)
  assert.equal(outbox.entries().some(entry => entry.key === newer.key), true)
})

test('E2E regression: a producer remount cannot collapse two real runs into one delivery', () => {
  // Lifetime A: run 1 of s1 completes and its banner is shown (durable receipt).
  const fp = 'a'.repeat(64)
  const lifetimeA = advanceRunIdentities({
    previous: new Map(), running: new Set(['s1']), live: new Set(['s1']), sourceFingerprint: fp, generation: 11_000,
  })
  const runOne = lifetimeA.identities.get('s1')!.runId
  const disk = storage()
  const outbox = createNotificationOutbox(disk, () => 1_000)
  const first = outbox.enqueue({ sourceId: 'ssh-a', sourceFingerprint: fp, sessionId: 's1', kind: 'complete', runId: runOne })!
  const attempt = outbox.begin(first.key)!
  assert.equal(outbox.settle(attempt, 'shown').delivered?.runId, runOne)
  assert.deepEqual(outbox.entries(), [], 'run 1 is delivered and out of the journal')
  // The sidebar ctx remounts (new lifetime) and run 2 of the SAME session completes.
  const lifetimeB = advanceRunIdentities({
    previous: new Map(), running: new Set(['s1']), live: new Set(['s1']), sourceFingerprint: fp, generation: 12_000,
  })
  const runTwo = lifetimeB.identities.get('s1')!.runId
  const second = outbox.enqueue({ sourceId: 'ssh-a', sourceFingerprint: fp, sessionId: 's1', kind: 'complete', runId: runTwo })!
  assert.notEqual(second.runId, first.runId, 'the two real runs must carry different identities')
  assert.notEqual(second.key, first.key,
    'the native eventKey must differ, or the durable shown-receipt treats run 2 as already displayed')
  assert.equal(outbox.entries().length, 1, 'run 2 is pending, not suppressed')
})

test('a backward wall-clock jump cannot strand a retry for hours', () => {
  let now = 1_000_000
  const outbox = createNotificationOutbox(undefined, () => now)
  const entry = outbox.enqueue(completion)!
  const attempt = outbox.begin(entry.key)
  assert.ok(attempt)
  outbox.settle(attempt, 'retryable')
  now -= 3_600_000
  assert.deepEqual(outbox.due().map(row => row.key), [entry.key])
  assert.equal(outbox.nextDueAt(), now)
})

test('an old native receipt cannot settle a re-created event with the same stable key', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const entry = outbox.enqueue(completion)!
  const old = outbox.begin(entry.key)
  assert.ok(old)
  outbox.forget(entry.key)
  const replacement = outbox.enqueue(completion)!
  assert.equal(replacement.key, entry.key, 'native deduplication still uses the stable event key')
  const fresh = outbox.begin(replacement.key)
  assert.ok(fresh)
  assert.notEqual(old.id, fresh.id)
  assert.deepEqual(outbox.settle(old, 'shown'), { accepted: false, delivered: null })
  assert.equal(outbox.entries().length, 1)
  assert.equal(outbox.settle(fresh, 'shown').delivered?.key, entry.key)
  assert.deepEqual(outbox.entries(), [])
})

test('a late failure cannot release or block a newer retry', () => {
  let now = 1_000
  const outbox = createNotificationOutbox(undefined, () => now)
  const entry = outbox.enqueue(completion)!
  const old = outbox.begin(entry.key)
  assert.ok(old)
  outbox.settle(old, 'retryable')
  now += 6_000
  const fresh = outbox.begin(entry.key)
  assert.ok(fresh)
  assert.deepEqual(outbox.settle(old, 'permanent'), { accepted: false, delivered: null })
  assert.deepEqual(outbox.due(), [], 'the fresh attempt remains in flight')
  assert.equal(outbox.entries()[0]?.blocked, false)
  assert.equal(outbox.settle(fresh, 'shown').accepted, true)
})

test('the journal is v2: a v1 journal is adopted once and removed only after v2 is persisted', () => {
  const disk = storage()
  const v1Entry = {
    key: '["ssh-a","host-1","s1","complete",["time",100]]',
    sourceId: 'ssh-a', sourceFingerprint: 'host-1', sessionId: 's1', kind: 'complete',
    watermark: 100, attempts: 0, nextAttemptAt: 0, blocked: false,
  }
  disk.values.set('dsh-chamber.notification-outbox.v1', JSON.stringify([v1Entry]))
  const outbox = createNotificationOutbox(disk, () => 1_000)
  assert.equal(outbox.entries().length, 1)
  assert.ok(outbox.entries()[0]?.runId?.startsWith('chamber:'), 'the lost identity is re-derived in the chamber family')
  assert.equal(disk.values.has('dsh-chamber.notification-outbox.v1'), false, 'v1 is drained after v2 is on disk')
  assert.ok(disk.values.has(NOTIFICATION_OUTBOX_KEY))
  const reloaded = createNotificationOutbox(disk, () => 1_000)
  assert.deepEqual(reloaded.entries().map(entry => entry.key), outbox.entries().map(entry => entry.key))
})

test('a v1 row already represented in v2 is not duplicated', () => {
  const disk = storage()
  const outbox = createNotificationOutbox(disk, () => 1_000)
  const entry = outbox.enqueue(completion)!
  disk.values.set('dsh-chamber.notification-outbox.v1', JSON.stringify([{ ...entry, key: 'stale-v1-key' }]))
  const reloaded = createNotificationOutbox(disk, () => 1_000)
  assert.equal(reloaded.entries().length, 1)
  assert.equal(reloaded.entries()[0]?.key, entry.key)
})

test('run identity: an explicit id wins and a host turn seq outranks the watermark episode', () => {
  const outbox = createNotificationOutbox(undefined, () => 1_000)
  const hostSeq = outbox.enqueue({ ...completion, completionSeq: 7 })!
  assert.equal(hostSeq.runId, 'host:turn%2F7')
  const explicit = outbox.enqueue({ ...completion, completionSeq: 7, runId: 'host:explicit' })!
  assert.equal(explicit.runId, 'host:explicit')
  assert.notEqual(explicit.key, hostSeq.key)
  const watermarkOnly = outbox.enqueue(completion)!
  assert.match(watermarkOnly.runId ?? '', /^chamber:/)
  assert.notEqual(watermarkOnly.key, hostSeq.key)
})
