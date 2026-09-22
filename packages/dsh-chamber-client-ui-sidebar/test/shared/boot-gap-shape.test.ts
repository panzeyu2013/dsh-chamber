/**
 * The shared settled-boot gap -> copy-shape projection. It carries the part the
 * sidebar and the connections section would otherwise duplicate: which kind selects
 * which sentence, and which structured params survive.
 *
 * Run directly: node packages/dsh-chamber-client-ui-sidebar/test/shared/boot-gap-shape.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootGapShape } from '../../src/shared/boot-gap-shape.ts'
import type { ServerBootGap } from '../../src/shared/aggregate-store.ts'

const asGap = (value: Record<string, unknown>): ServerBootGap => value as unknown as ServerBootGap

test('kind-only gaps pass their key straight through', () => {
  assert.deepEqual(bootGapShape(asGap({ kind: 'graph-unavailable' })), { key: 'graph-unavailable' })
  assert.deepEqual(bootGapShape(asGap({ kind: 'local-graph-not-injected' })), { key: 'local-graph-not-injected' })
})

test('required-services-missing joins the roster, and an empty payload degrades to generic', () => {
  assert.deepEqual(
    bootGapShape(asGap({ kind: 'required-services-missing', services: ['a', 'b'] })),
    { key: 'required-services-missing', services: 'a, b' },
  )
  for (const empty of [{ services: [] }, { services: undefined }, { services: null }]) {
    assert.deepEqual(bootGapShape(asGap({ kind: 'required-services-missing', ...empty })), { key: 'generic' }, JSON.stringify(empty))
  }
})

test('deferred-registration-failed counts the ids, and an empty payload degrades to generic', () => {
  assert.deepEqual(
    bootGapShape(asGap({ kind: 'deferred-registration-failed', failedIds: ['x', 'y', 'z'] })),
    { key: 'deferred-registration-failed', failed: 3 },
  )
  for (const empty of [{ failedIds: [] }, { failedIds: undefined }, { failedIds: null }]) {
    assert.deepEqual(bootGapShape(asGap({ kind: 'deferred-registration-failed', ...empty })), { key: 'generic' }, JSON.stringify(empty))
  }
})

test('the shape carries no sentence: consumers own their own dictionary keys', () => {
  const shape = bootGapShape(asGap({ kind: 'graph-unavailable' }))
  assert.deepEqual(Object.keys(shape), ['key'])
})
