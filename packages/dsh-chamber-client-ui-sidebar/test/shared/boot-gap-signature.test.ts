/*
 * The settled-boot gap identity used by BOTH publish signatures (sidebar
 * derive.ts projection signature + settings-bridge roster signature).
 *
 * It is one implementation with one test.
 *
 * Run directly: node packages/dsh-chamber-client-ui-sidebar/test/shared/boot-gap-signature.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gapSignature } from '../../src/shared/derive.ts'
import type { ServerBootGap } from '../../src/shared/aggregate-store.ts'

/** The documented shape, plus payload fields the type does not know yet. */
const asGap = (value: Record<string, unknown>): ServerBootGap => value as unknown as ServerBootGap

test('an absent gap has no signature', () => {
  assert.equal(gapSignature(undefined), null)
})

test('"no payload" is one thing: absent, null, empty array and empty string all encode to nothing', () => {
  const base = gapSignature(asGap({ kind: 'required-services-missing' }))
  for (const empty of [{ services: undefined }, { services: null }, { services: [] }, { services: '' }]) {
    assert.equal(gapSignature(asGap({ kind: 'required-services-missing', ...empty })), base, JSON.stringify(empty))
  }
})

test('array order is preserved (roster order is meaningful)', () => {
  const ab = gapSignature(asGap({ kind: 'required-services-missing', services: ['a', 'b'] }))
  const ba = gapSignature(asGap({ kind: 'required-services-missing', services: ['b', 'a'] }))
  assert.notEqual(ab, ba)
})

test('field order is normalized', () => {
  const one = gapSignature(asGap({ kind: 'deferred-registration-failed', failedIds: ['x'], services: ['y'] }))
  const other = gapSignature(asGap({ services: ['y'], failedIds: ['x'], kind: 'deferred-registration-failed' }))
  assert.equal(one, other)
})

test('every payload field takes part — a field added later cannot freeze a subscription', () => {
  const before = gapSignature(asGap({ kind: 'deferred-registration-failed', failedIds: ['x'] }))
  const after = gapSignature(asGap({ kind: 'deferred-registration-failed', failedIds: ['x'], replacedBy: ['z'] }))
  assert.notEqual(before, after)
  assert.notEqual(gapSignature(asGap({ kind: 'graph-unavailable' })), before)
})
