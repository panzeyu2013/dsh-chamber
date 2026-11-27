/** Blank-row GHOST 本地过期时钟（design 06 §2.2）：重臂/旧 timer 迟到/到期的三态行为。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { armGhostExpiry, expireGhostSlot, ghostSlotKey } from '../../src/client/ghost-expiry.ts'

test('the slot key is source-scoped for cloned session UUIDs', () => {
  assert.equal(ghostSlotKey('source-a', 'session-1'), 'source-a:session-1')
  assert.notEqual(ghostSlotKey('source-a', 'session-1'), ghostSlotKey('source-b', 'session-1'))
})

test('arm stores now + grace, and a re-arm moves the deadline', () => {
  const map = new Map<string, number>()
  assert.equal(armGhostExpiry(map, 's1', 1_000, 350), 1_350)
  assert.equal(map.get('s1'), 1_350)
  assert.equal(armGhostExpiry(map, 's1', 1_100, 350), 1_450)
  assert.equal(map.get('s1'), 1_450)
})

test('expire only deletes when the stored deadline has passed', () => {
  const map = new Map<string, number>([['s1', 1_350]])
  assert.equal(expireGhostSlot(map, 's1', 1_349), false)
  assert.equal(map.has('s1'), true)
  assert.equal(expireGhostSlot(map, 's1', 1_350), true)
  assert.equal(map.has('s1'), false)
  assert.equal(expireGhostSlot(map, 's1', 1_400), false)
})

test('a stale timer after a re-arm keeps the newer deadline', () => {
  const map = new Map<string, number>()
  armGhostExpiry(map, 's1', 1_000, 350)
  armGhostExpiry(map, 's1', 1_100, 350)
  // old timer fires at 1350 but the stored deadline is 1450
  assert.equal(expireGhostSlot(map, 's1', 1_350), false)
  assert.equal(map.get('s1'), 1_450)
  assert.equal(expireGhostSlot(map, 's1', 1_450), true)
})

test('the hook wires both pure expiry helpers', () => {
  const source = stripComments(readFileSync(new URL('../../src/client/sidebar-root-ghost.ts', import.meta.url), 'utf8'))
  assert.match(source, /armGhostExpiry\(ghostExpiry\.current, slotKey, Date\.now\(\), BLANK_GHOST_GRACE_MS\)/u)
  assert.match(source, /expireGhostSlot\(ghostExpiry\.current, slotKey, Date\.now\(\)\)/u)
  assert.match(source, /ghostSlotKey\(active\.id, current\)/u)
  assert.doesNotMatch(source, /ghostExpiry\.current\.set\(/u, 'the hook must arm through the pure helper')
  assert.doesNotMatch(source, /ghostExpiry\.current\.delete\(/u, 'the hook must expire through the pure helper')
})
