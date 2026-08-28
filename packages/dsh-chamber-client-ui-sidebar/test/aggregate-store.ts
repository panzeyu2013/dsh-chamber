import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge } from '../src/shared/aggregate-store.ts'
import type { InstanceSnapshot } from '../src/shared/instance-api.ts'

const snapshot = (id: string): InstanceSnapshot => ({
  workspaces: [],
  sessions: [{ sessionId: id, running: false, blank: false }],
  archivedSessionIds: [],
})

test('runtime producers ignore reports and cleanup from an old shell generation', () => {
  const events: string[] = []
  const unsubscribe = chamberBridge.onRuntimeReport((sourceId, value) => {
    events.push(`${sourceId}:${Object.keys(value?.sessions ?? {}).join(',') || 'clear'}`)
  })
  chamberBridge.reserveInstanceProducerGeneration('runtime-source', 1)
  const first = chamberBridge.registerInstanceRuntimeProducer('runtime-source', 1)
  first.report({ sessions: { old: { running: true } } })
  chamberBridge.reserveInstanceProducerGeneration('runtime-source', 2)
  const second = chamberBridge.registerInstanceRuntimeProducer('runtime-source', 2)
  second.report({ sessions: { fresh: { running: false } } })

  const lateFirst = chamberBridge.registerInstanceRuntimeProducer('runtime-source', 1)
  lateFirst.report({ sessions: { tooLate: { running: false } } })
  first.report({ sessions: { stale: { running: false } } })
  first.clear()
  second.clear()

  assert.deepEqual(events, [
    'runtime-source:old',
    'runtime-source:clear',
    'runtime-source:fresh',
    'runtime-source:clear',
  ])
  unsubscribe()
})

test('snapshot producers replay complete state, re-report after withdrawal, and ignore old-generation cleanup', () => {
  const events: string[] = []
  chamberBridge.reserveInstanceProducerGeneration('source-test', 1)
  const first = chamberBridge.registerInstanceSnapshotProducer('source-test', 1)
  first.report(snapshot('one'))
  const unsubscribe = chamberBridge.onInstanceSnapshot((sourceId, value) => {
    events.push(`${sourceId}:${value?.sessions[0]?.sessionId ?? 'clear'}`)
  })
  assert.deepEqual(events, ['source-test:one'])

  chamberBridge.reserveInstanceProducerGeneration('source-test', 2)
  const second = chamberBridge.registerInstanceSnapshotProducer('source-test', 2)
  second.report(snapshot('two'))
  const lateFirst = chamberBridge.registerInstanceSnapshotProducer('source-test', 1)
  lateFirst.report(snapshot('too-late'))
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
