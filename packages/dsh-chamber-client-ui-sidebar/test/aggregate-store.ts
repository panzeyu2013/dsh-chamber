import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge } from '../src/shared/aggregate-store.ts'
import type { InstanceSnapshot } from '../src/shared/instance-api.ts'

const snapshot = (id: string): InstanceSnapshot => ({
  workspaces: [],
  sessions: [{ sessionId: id, running: false, blank: false }],
  archivedSessionIds: [],
})

test('snapshot producers replay complete state and old generations cannot clear newer reports', () => {
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
  second.clear()
  unsubscribe()
})
