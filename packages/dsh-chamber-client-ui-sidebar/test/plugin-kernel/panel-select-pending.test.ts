/**
 * Panel-select intent windows (design 05 §2 / design 06 §4.7), as BEHAVIOR rather
 * than source text: the two race windows the sidebar must survive are
 *  - boot race: the intent arrives before the panellist extra row has registered;
 *  - teardown handoff: a shell released mid-flight returns the intent to the core
 *    slot without renewing its TTL (the next generation re-arms with the original
 *    click instant).
 * Pure leaf: the clock, the axis membership read and the selection callback are fake.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPanelSelectPending } from '../../src/client/panel-select-pending.ts'

const TTL = 15_000

function machine(options: { registered?: readonly string[]; now?: number } = {}) {
  let now = options.now ?? 1_000
  let registered = new Set<string>(options.registered ?? [])
  const selected: string[] = []
  const pending = createPanelSelectPending({
    ttlMs: TTL,
    now: () => now,
    isRegistered: (panelId) => registered.has(panelId),
    selectPanel: (panelId) => { selected.push(panelId) },
  })
  return {
    pending,
    selected,
    advance(ms: number) { now += ms },
    setNow(value: number) { now = value },
    register(id: string) { registered = new Set([...registered, id]) },
  }
}

test('an intent that arrives before the registration is held, not dropped', () => {
  const bot = machine()
  bot.pending.arm('schedules')
  assert.deepEqual(bot.selected, [], 'not registered yet: nothing selected')
  assert.notEqual(bot.pending.pending(), undefined, 'the intent is held locally')
  bot.register('schedules')
  assert.equal(bot.pending.tryResolve(), true, 'the axis change wakes the held intent')
  assert.deepEqual(bot.selected, ['schedules'])
  assert.equal(bot.pending.pending(), undefined, 'a resolved intent is cleared')
})

test('an already-registered panel hits immediately', () => {
  const bot = machine({ registered: ['schedules'] })
  bot.pending.arm('schedules')
  assert.deepEqual(bot.selected, ['schedules'])
  assert.equal(bot.pending.pending(), undefined)
})

test('ONLY the TTL drops a held intent, measured from the original click instant', () => {
  const bot = machine()
  bot.pending.arm('schedules', 1_000)
  bot.advance(TTL)
  assert.equal(bot.pending.tryResolve(), false, 'inside the TTL an unregistered intent stays held')
  assert.notEqual(bot.pending.pending(), undefined)
  bot.advance(1)
  assert.equal(bot.pending.tryResolve(), false, 'expired: dropped')
  assert.equal(bot.pending.pending(), undefined)
  bot.register('schedules')
  assert.equal(bot.pending.tryResolve(), false, 'an expired intent never surfaces on a later registration')
  assert.deepEqual(bot.selected, [])
})

test('teardown handoff keeps the unresolved intent and its original instant', () => {
  const first = machine()
  first.pending.arm('schedules', 2_000)
  const held = first.pending.pending()
  assert.deepEqual(held, { panelId: 'schedules', at: 2_000 })
  // The next shell re-arms with the SAME instant: a handoff must not renew the TTL.
  const second = machine({ now: 2_000 + TTL - 1 })
  second.pending.arm(held!.panelId, held!.at)
  second.register('schedules')
  assert.equal(second.pending.tryResolve(), true, 'still inside the original TTL')
  assert.deepEqual(second.selected, ['schedules'])
  // A handoff landing past the original TTL is dropped, never re-armed on a fresh clock.
  const late = machine({ now: 2_000 + TTL + 1 })
  late.pending.arm('schedules', 2_000)
  assert.equal(late.pending.tryResolve(), false)
  assert.equal(late.pending.pending(), undefined)
})

test('clear drops the held intent without selecting', () => {
  const bot = machine()
  bot.pending.arm('schedules')
  bot.pending.clear()
  bot.register('schedules')
  assert.equal(bot.pending.tryResolve(), false)
  assert.deepEqual(bot.selected, [])
})