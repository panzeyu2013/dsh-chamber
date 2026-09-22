/**
 * Source-registry wiring (P4) - the App's lifecycle store is a single-generation
 * registry, and events no longer recompute the ownership fingerprint.
 *
 * The package's G-D gate pins the registry contract; this file pins the WIRING:
 * the roster refresh is the one place a fingerprint change is observed (it calls
 * reincarnate), a dispatch reads the stored epoch instead of re-deriving the
 * fingerprint, retirement prunes the registry, and the retired keyed-record API
 * (incarnationKey/retainSources) has no call site left.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, '..', '..', 'src', 'App.tsx'), 'utf8')

test('the ledger store is a SourceRegistry, not a keyed state map', () => {
  assert.ok(APP.includes('useRef<SourceRegistry>({})'), 'the store must be the single-generation registry')
  assert.equal(APP.includes('useRef<Record<string, SourceLifecycleState>>'), false, 'the keyed map must be gone')
})

test('a fingerprint change is observed once, at the roster refresh', () => {
  assert.match(APP, /sourceLedgerStoreRef\.current = reincarnate\(/, 'the roster refresh must reincarnate the generation')
  const reincarnations = APP.split('reincarnate(').length - 1
  assert.ok(reincarnations >= 3, 'local + each accepted source (and the lazy guard) must register: ' + String(reincarnations))
})

test('a dispatch reads the stored epoch instead of recomputing the fingerprint', () => {
  assert.ok(APP.includes('epochOf(registry, viewId)'), 'the dispatch must read the entry epoch')
  assert.ok(APP.includes('capturedEpoch ?? epochOf(registry, viewId)'), 'a captured epoch must win over the live one')
  // The fingerprint capture survives ONLY inside the lazy unregistered branch.
  const lazy = APP.indexOf('epoch === undefined')
  const capture = APP.indexOf('.capture(viewId)?.fingerprint')
  assert.ok(lazy !== -1 && capture > lazy, 'the fingerprint read must sit inside the unregistered-source guard')
})

test('retirement prunes the registry with the live-id set', () => {
  assert.ok(APP.includes('retainSourceIds(sourceLedgerStoreRef.current, liveSourceIds)'), 'retireSources must drop retired generations')
  assert.equal(APP.includes('incarnationKey('), false, 'the keyed-record API must have no call site')
  assert.equal(APP.includes('retainSources('), false, 'the old sweep must have no call site')
  assert.equal(APP.includes('SourceLifecycleState'), false, 'the old per-record type must not appear in the App')
})
