/**
 * The page's link-projection reading (client-core/link-projection.ts): the ONE owner
 * of "is this source ready for page-channel traffic" and "which generation is it".
 * Integer/locale-agnostic: an old shim without `link` must read as healthy epoch 0.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkEpochOf, linkReady } from '../../../dsh-chamber-client-core/src/link-projection.ts'

test('linkReady: only ready & not down is ready; suspect still forwards', () => {
  assert.equal(linkReady(undefined), false)
  assert.equal(linkReady({ phase: 'connecting' }), false)
  assert.equal(linkReady({ phase: 'degraded' }), false)
  assert.equal(linkReady({ phase: 'ready' }), true, 'an old shim without a link field is healthy')
  assert.equal(linkReady({ phase: 'ready', link: { state: 'healthy' } }), true)
  assert.equal(linkReady({ phase: 'ready', link: { state: 'suspect' } }), true, 'suspect forwards (design 27 I3)')
  assert.equal(linkReady({ phase: 'ready', link: { state: 'down' } }), false, 'down parks the page channel')
  // Hostile projections never throw.
  assert.equal(linkReady(null as never), false)
  assert.equal(linkReady({ phase: 'ready', link: null } as never), true)
})

test('linkEpochOf: absent/non-numeric generations read as 0', () => {
  assert.equal(linkEpochOf(undefined), 0)
  assert.equal(linkEpochOf({ phase: 'ready' }), 0)
  assert.equal(linkEpochOf({ phase: 'ready', link: { linkEpoch: 7 } }), 7)
  assert.equal(linkEpochOf({ phase: 'ready', link: { linkEpoch: 0 } }), 0)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '7', null]) {
    assert.equal(linkEpochOf({ phase: 'ready', link: { linkEpoch: bad } } as never), 0, String(bad))
  }
})
