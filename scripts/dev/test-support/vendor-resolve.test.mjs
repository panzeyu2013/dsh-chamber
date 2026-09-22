/**
 * The shared test-only vendor resolve-hook factory
 * (scripts/dev/test-support/vendor-resolve.mjs).
 *
 * The three package loaders each exercise the hook only indirectly
 * (through a suite that also needs the mapped target to exist); this pins the
 * hook contract itself — short-circuit on a mapped specifier, honest fallthrough
 * otherwise, targets resolved against the LOADER file rather than the cwd.
 *
 * Run directly: node scripts/dev/test-support/vendor-resolve.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVendorResolve } from './vendor-resolve.mjs'

const BASE = 'file:///repo/scripts/dev/test-support/loader.mjs'

test('a mapped specifier short-circuits to the base-relative target URL', async () => {
  const resolve = createVendorResolve(new Map([['@x/mapped', './target.mjs']]), BASE)
  const result = await resolve('@x/mapped', {}, async () => { throw new Error('nextResolve must not be called') })
  assert.equal(result.url, 'file:///repo/scripts/dev/test-support/target.mjs')
  assert.equal(result.shortCircuit, true)
})

test('an unmapped specifier falls through to nextResolve with its arguments', async () => {
  const resolve = createVendorResolve(new Map([['@x/mapped', './target.mjs']]), BASE)
  const context = { parentURL: 'file:///repo/a.ts' }
  const seen = []
  const result = await resolve('node:fs', context, async (specifier, ctx) => {
    seen.push([specifier, ctx])
    return { url: 'node:fs', shortCircuit: true }
  })
  assert.deepEqual(seen, [['node:fs', context]])
  assert.equal(result.url, 'node:fs')
})

test('targets resolve against the loader file, not the process cwd', async () => {
  const resolve = createVendorResolve(
    new Map([['@x/m', '../../../../vendor/x/src/index.ts']]),
    'file:///repo/packages/a/test/support/loader.mjs',
  )
  const result = await resolve('@x/m', {}, async () => { throw new Error('unmapped') })
  assert.equal(result.url, 'file:///repo/vendor/x/src/index.ts')
})

test('the table is read once: later mutations do not affect the built hook', async () => {
  const entries = new Map([['@x/m', './one.mjs']])
  const resolve = createVendorResolve(entries, BASE)
  entries.set('@x/m', './two.mjs')
  const result = await resolve('@x/m', {}, async () => { throw new Error('unmapped') })
  assert.equal(result.url, 'file:///repo/scripts/dev/test-support/one.mjs')
})
