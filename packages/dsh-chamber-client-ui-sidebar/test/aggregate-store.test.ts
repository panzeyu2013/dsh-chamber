import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge, isValidProducerSourceFingerprint } from '../src/shared/aggregate-store.ts'
import type { InstanceSnapshot } from '../src/shared/instance-api.ts'

const snapshot = (id: string): InstanceSnapshot => ({
  workspaces: [],
  sessions: [{ sessionId: id, running: false, blank: false }],
  archivedSessionIds: [],
})
const firstProof = 'a'.repeat(64)
const secondProof = 'b'.repeat(64)

test('producer proof validation accepts only local or opaque 64-character lowercase remote hex', () => {
  assert.equal(isValidProducerSourceFingerprint('local', 'local'), true)
  assert.equal(isValidProducerSourceFingerprint('local', firstProof), false)
  assert.equal(isValidProducerSourceFingerprint('ssh-dev', firstProof), true)
  for (const invalid of [undefined, '', 'local', 'a'.repeat(63), 'A'.repeat(64)]) {
    assert.equal(isValidProducerSourceFingerprint('ssh-dev', invalid), false)
  }
})

test('snapshot producers replay complete state, re-report after withdrawal, and ignore old-generation cleanup', () => {
  const events: string[] = []
  const first = chamberBridge.registerInstanceSnapshotProducer('source-test', firstProof)
  first.report(snapshot('one'))
  const unsubscribe = chamberBridge.onInstanceSnapshot((sourceId, value) => {
    events.push(`${sourceId}:${value?.sessions[0]?.sessionId ?? 'clear'}`)
  })
  assert.deepEqual(events, ['source-test:one'])

  const second = chamberBridge.registerInstanceSnapshotProducer('source-test', secondProof)
  second.report(snapshot('two'))
  first.clear()
  assert.equal(chamberBridge.getInstanceSnapshots()['source-test']?.sessions[0]?.sessionId, 'two')

  second.report(undefined)
  assert.equal(chamberBridge.getInstanceSnapshots()['source-test'], undefined)
  assert.deepEqual(events, ['source-test:one', 'source-test:clear', 'source-test:two', 'source-test:clear'])
  // Reconnect baseline may be byte-for-byte identical. Once loading withdrew
  // the old report, the recovered generation must be publishable again.
  second.report(snapshot('two'))
  assert.equal(chamberBridge.getInstanceSnapshots()['source-test']?.sessions[0]?.sessionId, 'two')
  assert.deepEqual(events, ['source-test:one', 'source-test:clear', 'source-test:two', 'source-test:clear', 'source-test:two'])
  second.clear()
  assert.equal(chamberBridge.getInstanceSnapshots()['source-test'], undefined)
  unsubscribe()
})

test('runtime producers ignore old-generation report and cleanup after a replacement reports', () => {
  const events: string[] = []
  const unsubscribe = chamberBridge.onRuntimeReport((sourceId, report) => {
    if (sourceId === 'runtime-generation-test') events.push(report?.current ?? 'clear')
  })
  const first = chamberBridge.registerInstanceRuntimeProducer('runtime-generation-test', firstProof)
  first.report({ current: 'one', sessions: {} })

  const second = chamberBridge.registerInstanceRuntimeProducer('runtime-generation-test', secondProof)
  second.report({ current: 'two', sessions: {} })
  first.report({ current: 'stale', sessions: {} })
  first.clear()
  assert.deepEqual(events, ['one', 'clear', 'two'])

  second.clear()
  assert.deepEqual(events, ['one', 'clear', 'two', 'clear'])
  unsubscribe()
})

test('event-side retirement rejects old reports before a replacement producer registers', () => {
  const sourceId = 'event-retire-before-replacement-test'
  const runtimeEvents: string[] = []
  const snapshotEvents: string[] = []
  const unsubscribeRuntime = chamberBridge.onRuntimeReport((changedSourceId, report, fingerprint) => {
    if (changedSourceId === sourceId) runtimeEvents.push(`${report?.current ?? 'clear'}:${fingerprint ?? 'none'}`)
  })
  const unsubscribeSnapshot = chamberBridge.onInstanceSnapshot((changedSourceId, value, fingerprint) => {
    if (changedSourceId === sourceId) snapshotEvents.push(`${value?.sessions[0]?.sessionId ?? 'clear'}:${fingerprint ?? 'none'}`)
  })

  const oldRuntime = chamberBridge.registerInstanceRuntimeProducer(sourceId, firstProof)
  const oldSnapshot = chamberBridge.registerInstanceSnapshotProducer(sourceId, firstProof)
  oldRuntime.report({ current: 'old', sessions: {} })
  oldSnapshot.report(snapshot('old'))

  chamberBridge.retireInstanceProducers(sourceId)
  assert.deepEqual(runtimeEvents, [`old:${firstProof}`, `clear:${firstProof}`])
  assert.deepEqual(snapshotEvents, [`old:${firstProof}`, `clear:${firstProof}`])
  assert.equal(chamberBridge.getInstanceSnapshots()[sourceId], undefined)

  // No replacement is registered yet: this is the old async disposer window
  // that replacement-registration token tests do not cover.
  oldRuntime.report({ current: 'late-old', sessions: {} })
  oldSnapshot.report(snapshot('late-old'))
  oldRuntime.clear()
  oldSnapshot.clear()
  assert.deepEqual(runtimeEvents, [`old:${firstProof}`, `clear:${firstProof}`])
  assert.deepEqual(snapshotEvents, [`old:${firstProof}`, `clear:${firstProof}`])

  const replacementRuntime = chamberBridge.registerInstanceRuntimeProducer(sourceId, secondProof)
  const replacementSnapshot = chamberBridge.registerInstanceSnapshotProducer(sourceId, secondProof)
  replacementRuntime.report({ current: 'new', sessions: {} })
  replacementSnapshot.report(snapshot('new'))
  oldRuntime.report({ current: 'later-old', sessions: {} })
  oldSnapshot.report(snapshot('later-old'))
  assert.deepEqual(runtimeEvents, [`old:${firstProof}`, `clear:${firstProof}`, `new:${secondProof}`])
  assert.deepEqual(snapshotEvents, [`old:${firstProof}`, `clear:${firstProof}`, `new:${secondProof}`])

  replacementRuntime.clear()
  replacementSnapshot.clear()
  unsubscribeRuntime()
  unsubscribeSnapshot()
})

test('open-session outcomes fan out to subscribers and unsubscribing stops delivery', () => {
  const events: string[] = []
  const unsubscribe = chamberBridge.onOpenSessionOutcome((outcome) => {
    events.push(`${outcome.sourceId}/${outcome.sessionId}/${outcome.message ?? 'ok'}`)
  })
  chamberBridge.reportOpenSessionOutcome({ sourceId: 'ssh-a', sessionId: 's1' })
  chamberBridge.reportOpenSessionOutcome({ sourceId: 'ssh-a', sessionId: 's1', message: '打开会话失败：boom' })
  chamberBridge.reportOpenSessionOutcome({ sourceId: 'local', sessionId: 's2', message: '等待超时' })
  assert.deepEqual(events, [
    'ssh-a/s1/ok',
    'ssh-a/s1/打开会话失败：boom',
    'local/s2/等待超时',
  ])
  unsubscribe()
  chamberBridge.reportOpenSessionOutcome({ sourceId: 'ssh-a', sessionId: 's1' })
  assert.deepEqual(events, [
    'ssh-a/s1/ok',
    'ssh-a/s1/打开会话失败：boom',
    'local/s2/等待超时',
  ])
})

test('session-list refresh requests broadcast to every subscriber with the source id', () => {
  const received: string[] = []
  const first = chamberBridge.onRequestSessionListRefresh(sourceId => { received.push(`a:${sourceId}`) })
  const second = chamberBridge.onRequestSessionListRefresh(sourceId => { received.push(`b:${sourceId}`) })
  chamberBridge.requestSessionListRefresh('local')
  chamberBridge.requestSessionListRefresh('ssh-dev')
  assert.deepEqual(received, ['a:local', 'b:local', 'a:ssh-dev', 'b:ssh-dev'])
  first()
  chamberBridge.requestSessionListRefresh('local')
  assert.deepEqual(received, ['a:local', 'b:local', 'a:ssh-dev', 'b:ssh-dev', 'b:local'])
  // Unsubscribing the last subscriber must not throw and the request is a no-op.
  second()
  chamberBridge.requestSessionListRefresh('gateway-west')
  assert.deepEqual(received, ['a:local', 'b:local', 'a:ssh-dev', 'b:ssh-dev', 'b:local'])
})

test('the active-view fact publishes on change only, and undefined is a real value', () => {
  assert.equal(chamberBridge.getActiveSource(), undefined, 'unpublished until the App writes it')
  const seen: (string | undefined)[] = []
  const off = chamberBridge.onActiveSource(sourceId => { seen.push(sourceId) })
  chamberBridge.setActiveSource('local')
  chamberBridge.setActiveSource('local')
  chamberBridge.setActiveSource('ssh-dev')
  chamberBridge.setActiveSource(undefined)
  assert.deepEqual(seen, ['local', 'ssh-dev', undefined], 'same-value writes are no-ops; clearing notifies')
  assert.equal(chamberBridge.getActiveSource(), undefined)
  off()
  chamberBridge.setActiveSource('local')
  assert.deepEqual(seen, ['local', 'ssh-dev', undefined])
})

test('producer registration is boot-generation fenced (a late older boot cannot steal the token)', () => {
  // 2026-12 复查 BLOCKER：一个挂死后恢复的老 boot 若在健康后继注册之后再注册，
  // 旧实现会让它夺走 token，其 teardown clear() 随即清空后继的通道。
  const sourceId = 'ssh-producer-fence'
  const fingerprint = 'f'.repeat(64)
  const store = chamberBridge
  const seen: (string | undefined)[] = []
  const unsubscribe = store.onInstanceSnapshot((_sourceId, value) => {
    seen.push(value === undefined ? undefined : String(value.sessions.length))
  })
  try {
    const newer = store.registerInstanceSnapshotProducer(sourceId, fingerprint, 2)
    newer.report(snapshot('one'))
    assert.deepEqual(seen, ['1'])
    // 老代（gen 1）迟到注册：必须作废，且它的 clear 不得清空通道。
    const older = store.registerInstanceSnapshotProducer(sourceId, fingerprint, 1)
    older.report(snapshot('stale'))
    assert.deepEqual(seen, ['1'], 'an older generation must not report')
    older.clear()
    assert.deepEqual(seen, ['1'], 'an older generation must not clear the newer channel')
    newer.report(snapshot('two'))
    assert.deepEqual(seen, ['1', '1'], 'the newer generation keeps the channel')
    newer.clear()
    assert.deepEqual(seen, ['1', '1', undefined], 'the owner can still clear')
  } finally {
    unsubscribe()
    store.retireInstanceProducers(sourceId)
  }
})

test('the generation fence is order-independent for equal generations and re-arms after a clear', () => {
  // 同级重注册必须胜出（重试同代/非 chamber 挂载）；被清理过的来源必须可以再次
  // 注册（否则一次 clear 会永久封死该源；2026-12 复查 NIT）。
  const sourceId = 'ssh-producer-fence-2'
  const fingerprint = 'a'.repeat(64)
  const store = chamberBridge
  const seen: (string | undefined)[] = []
  const unsubscribe = store.onInstanceSnapshot((_sourceId, value) => {
    seen.push(value === undefined ? undefined : String(value.sessions.length))
  })
  try {
    const first = store.registerInstanceSnapshotProducer(sourceId, fingerprint, 3)
    first.report(snapshot('one'))
    const sameGeneration = store.registerInstanceSnapshotProducer(sourceId, fingerprint, 3)
    sameGeneration.report(snapshot('two'))
    // 注册即接管：旧 report 先被撤回（既有的"后注册者胜"语义）。
    assert.deepEqual(seen, ['1', undefined, '1'], 'an equal generation re-registration wins')
    sameGeneration.clear()
    assert.deepEqual(seen, ['1', undefined, '1', undefined])
    // 清理后同代或更老的注册都必须被接受（记录已随 clear 删除）。
    const after = store.registerInstanceSnapshotProducer(sourceId, fingerprint, 2)
    after.report(snapshot('three'))
    assert.deepEqual(seen, ['1', undefined, '1', undefined, '1'], 'a cleared source is re-registrable')
  } finally {
    unsubscribe()
    store.retireInstanceProducers(sourceId)
  }
})
