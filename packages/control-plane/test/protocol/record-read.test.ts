/**
 * The shared Node-side record guard (control-plane/src/record-read.ts).
 *
 * readStringArray was byte-identical in the desktop main process and the
 * gateway server before the 2026-12 single-sourcing pass; this locks the
 * "absent is empty, never guessed" behavior all three hosts rely on.
 *
 * Run directly: node packages/control-plane/test/protocol/record-read.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readStringArray } from '../../src/record-read.ts'

test('readStringArray walks the path and returns the string members in order', () => {
  assert.deepEqual(readStringArray({ dsh: { profile: { bundles: ['b', 'a'] } } }, ['dsh', 'profile', 'bundles']), ['b', 'a'])
  assert.deepEqual(readStringArray({ a: ['x'] }, ['a']), ['x'])
})

test('readStringArray treats every non-array as absent, at every depth', () => {
  assert.deepEqual(readStringArray({}, ['dsh', 'profile', 'bundles']), [])
  assert.deepEqual(readStringArray({ dsh: null }, ['dsh', 'profile']), [])
  assert.deepEqual(readStringArray({ dsh: 'text' }, ['dsh', 'profile']), [])
  assert.deepEqual(readStringArray({ dsh: 7 }, ['dsh', 'profile']), [])
  assert.deepEqual(readStringArray({ dsh: { profile: { bundles: 'not-an-array' } } }, ['dsh', 'profile', 'bundles']), [])
  assert.deepEqual(readStringArray({ dsh: { profile: { bundles: null } } }, ['dsh', 'profile', 'bundles']), [])
})

test('readStringArray drops non-string members instead of stringifying them', () => {
  assert.deepEqual(readStringArray({ a: ['x', 1, null, {}, true, 'y'] }, ['a']), ['x', 'y'])
})

test('readStringArray never mutates the input record', () => {
  const record = { a: ['x', 'y'] }
  const copy = structuredClone(record)
  readStringArray(record, ['a'])
  assert.deepEqual(record, copy)
})
