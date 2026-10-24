/**
 * Per-ctx settings-navigation seat (design 05 §5): request sequencing, acknowledgement
 * and the shell-side command. Pure module — no React, no vendor imports.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSettingsNavigationSeat,
  settingsAckDecision,
  settingsOpenCommand,
} from '../../src/client/settings-navigation.ts'

test('open queues a request and notifies; ack clears only the matching sequence', () => {
  const seat = createSettingsNavigationSeat()
  let notifications = 0
  const unsubscribe = seat.subscribe(() => { notifications += 1 })
  assert.equal(seat.getRequest(), undefined)
  seat.open('plugin-manager')
  assert.deepEqual(seat.getRequest(), { seq: 1, sectionId: 'plugin-manager' })
  assert.equal(notifications, 1)
  seat.acknowledge(0)
  assert.notEqual(seat.getRequest(), undefined, 'a stale ack never clears a live request')
  seat.acknowledge(1)
  assert.equal(seat.getRequest(), undefined)
  seat.open('models')
  assert.deepEqual(seat.getRequest(), { seq: 2, sectionId: 'models' })
  unsubscribe()
  seat.open('general')
  assert.equal(notifications, 2, 'unsubscribed listeners are not called')
})

test('a newer request replaces an unconsumed one and a stale ack cannot clear it', () => {
  const seat = createSettingsNavigationSeat()
  seat.open('plugin-manager')
  seat.open('models')
  assert.deepEqual(seat.getRequest(), { seq: 2, sectionId: 'models' })
  seat.acknowledge(1)
  assert.deepEqual(seat.getRequest(), { seq: 2, sectionId: 'models' })
  seat.acknowledge(2)
  assert.equal(seat.getRequest(), undefined)
})

test('settingsOpenCommand: absent/old → undefined; new → the section only', () => {
  assert.equal(settingsOpenCommand(undefined, 0), undefined)
  assert.equal(settingsOpenCommand({ seq: 1, sectionId: 'x' }, 1), undefined)
  assert.deepEqual(
    settingsOpenCommand({ seq: 2, sectionId: 'plugin-manager' }, 1),
    { seq: 2, sectionId: 'plugin-manager' },
    'the shell forces its own instance on consumption; the command carries no constant id',
  )
})

test('settingsAckDecision: ack on the target, wait on another section, drop when closed', () => {
  assert.equal(settingsAckDecision(undefined, true, 'x'), undefined)
  const request = { seq: 1, sectionId: 'plugin-manager' }
  assert.equal(settingsAckDecision(request, false, undefined), 'drop', 'a close before the target commit dismisses the intent')
  assert.equal(settingsAckDecision(request, true, 'models'), 'wait', 'a manual visit to another section must not consume it')
  assert.equal(settingsAckDecision(request, true, 'plugin-manager'), 'ack')
  assert.equal(settingsAckDecision(request, true, undefined), 'wait')
})

test('open ignores an empty section id', () => {
  const seat = createSettingsNavigationSeat()
  seat.open('')
  assert.equal(seat.getRequest(), undefined)
  seat.open('plugin-manager')
  assert.equal(seat.getRequest()?.sectionId, 'plugin-manager')
})
