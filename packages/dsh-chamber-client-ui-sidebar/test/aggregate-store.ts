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
test('host producers replay live version, clear unknown, dedupe and ignore old generations', () => {
  const events: string[] = []
  const first = chamberBridge.registerInstanceHostProducer('host-source', firstProof)
  first.report({ dshVersion: '1.0.0' })
  const unsubscribe = chamberBridge.onInstanceHost((sourceId, report) => {
    if (sourceId === 'host-source') events.push(report?.dshVersion ?? 'unknown')
  })
  assert.deepEqual(events, ['1.0.0'])

  first.report({ dshVersion: '1.0.0' })
  assert.deepEqual(events, ['1.0.0'], 'identical host facts are deduplicated')

  const second = chamberBridge.registerInstanceHostProducer('host-source', secondProof)
  second.report({ dshVersion: '2.0.0' })
  first.clear()
  assert.deepEqual(events, ['1.0.0', 'unknown', '2.0.0'])

  second.report(undefined)
  second.clear()
  assert.deepEqual(events, ['1.0.0', 'unknown', '2.0.0', 'unknown'])
  unsubscribe()
})
