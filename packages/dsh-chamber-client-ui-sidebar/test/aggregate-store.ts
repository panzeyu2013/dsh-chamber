import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge } from '../src/shared/aggregate-store.ts'
import type { InstanceSnapshot } from '../src/shared/instance-api.ts'

const snapshot = (id: string): InstanceSnapshot => ({
  workspaces: [],
  sessions: [{ sessionId: id, running: false, blank: false }],
  archivedSessionIds: [],
})

test('snapshot producers replay complete state, re-report after withdrawal, and ignore old-generation cleanup', () => {
  const events: string[] = []
  const first = chamberBridge.registerInstanceSnapshotProducer('source-test')
  first.report(snapshot('one'))
  const unsubscribe = chamberBridge.onInstanceSnapshot((sourceId, value) => {
    events.push(`${sourceId}:${value?.sessions[0]?.sessionId ?? 'clear'}`)
  })
  assert.deepEqual(events, ['source-test:one'])

  const second = chamberBridge.registerInstanceSnapshotProducer('source-test')
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

test('host producers replay live version, clear unknown, dedupe and ignore old generations', () => {
  const events: string[] = []
  const first = chamberBridge.registerInstanceHostProducer('host-source')
  first.report({ dshVersion: '1.0.0' })
  const unsubscribe = chamberBridge.onInstanceHost((sourceId, report) => {
    if (sourceId === 'host-source') events.push(report?.dshVersion ?? 'unknown')
  })
  assert.deepEqual(events, ['1.0.0'])

  first.report({ dshVersion: '1.0.0' })
  assert.deepEqual(events, ['1.0.0'], 'identical host facts are deduplicated')

  const second = chamberBridge.registerInstanceHostProducer('host-source')
  second.report({ dshVersion: '2.0.0' })
  first.clear()
  assert.deepEqual(events, ['1.0.0', 'unknown', '2.0.0'])

  second.report(undefined)
  second.clear()
  assert.deepEqual(events, ['1.0.0', 'unknown', '2.0.0', 'unknown'])
  unsubscribe()
})
