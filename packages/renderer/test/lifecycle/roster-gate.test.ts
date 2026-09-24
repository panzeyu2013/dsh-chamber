/**
 * Roster gate contract (host/roster-gate.ts): ONE authority for "the
 * authoritative roster landed / the listener is attached". These cases pin the
 * generation semantics that replaced the App's state+ref boolean mirrors and
 * the two-argument canReplayRosterIntents helper, plus a source lock that the
 * mirrors and the helper do not come back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createRosterGate, rosterSettled } from '../../src/host/roster-gate.ts'

test('a fresh gate is unsettled; settle() marks the CURRENT generation', () => {
  const gate = createRosterGate()
  assert.equal(gate.isSettled(), false, 'nothing landed yet')
  assert.equal(rosterSettled(gate.getSnapshot()), false)
  gate.settle()
  assert.equal(gate.isSettled(), true, 'the authoritative list landed')
})

test('invalidate() opens a new generation: the old settle no longer counts', () => {
  const gate = createRosterGate()
  gate.settle()
  gate.invalidate()
  assert.equal(gate.isSettled(), false, 'an instances-changed event must hold intents again')
  gate.settle()
  assert.equal(gate.isSettled(), true, 'the replacement generation landed')
})

test('listenerReady is a single source: set/clear round-trips', () => {
  const gate = createRosterGate()
  assert.equal(gate.isListenerReady(), false)
  gate.setListenerReady(true)
  assert.equal(gate.isListenerReady(), true)
  assert.equal(gate.getSnapshot().listenerReady, true)
  gate.setListenerReady(false)
  assert.equal(gate.isListenerReady(), false, 'teardown must be visible to the same read')
})

test('subscribers fire once per real change and no-op writes stay silent', () => {
  const gate = createRosterGate()
  let notifications = 0
  const unsubscribe = gate.subscribe(() => { notifications += 1 })
  gate.settle()
  gate.settle()
  assert.equal(notifications, 1, 'settling an already-settled generation is a no-op')
  gate.setListenerReady(true)
  gate.setListenerReady(true)
  assert.equal(notifications, 2, 'a repeated listener write is a no-op')
  gate.invalidate()
  assert.equal(notifications, 3)
  unsubscribe()
  gate.invalidate()
  assert.equal(notifications, 3, 'an unsubscribed listener is never called')
})

test('the App consumes the gate and keeps no state/ref mirror of it', () => {
  const app = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')
  assert.match(app, /createRosterGate/, 'the App must own one gate instance')
  assert.match(app, /rosterGate\.isSettled\(\)/, 'replay decisions read the single source synchronously')
  assert.doesNotMatch(app, /remoteRosterSettledRef|rosterListenerReadyRef/, 'the mirrored refs must not come back')
  assert.doesNotMatch(app, /canReplayRosterIntents/, 'the two-authority helper must not come back')
})
