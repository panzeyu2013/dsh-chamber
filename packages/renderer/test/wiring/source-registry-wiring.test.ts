/**
 * Source-registry wiring (P4) - the App's lifecycle store is a single-generation
 * registry, and events no longer recompute the ownership fingerprint.
 *
 * The package's G-D gate pins the registry contract; this file pins the WIRING:
 * the roster refresh is the one place a fingerprint change is observed (it calls
 * reincarnate), a dispatch reads the stored epoch instead of re-deriving the
 * fingerprint, retirement prunes the registry, and the retired keyed-record API
 * (incarnationKey/retainSources) has no call site left. W3 adds one more wiring rule:
 * a delete-shaped ledger write for an unregistered source is DROPPED (never lazily
 * reincarnated into a phantom generation), and W5 removes the captured-epoch third
 * parameter from the dispatch surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  epochOf, reincarnate, retainSourceIds,
  type SourceIncarnation,
} from '../../../../packages/dsh-stream-state/src/index.ts'
import { appWiringFrame } from '../support/wiring-sources.ts'

// The lifecycle ledger lives in app-hooks/use-source-lifecycle.ts now; the lock reads the
// enumerated frame (App + every app-hook) so a further extraction cannot empty it.
const APP = appWiringFrame().text

test('the ledger store is a SourceRegistry, not a keyed state map', () => {
  assert.ok(APP.includes('useRef<SourceRegistry>({})'), 'the store must be the single-generation registry')
  assert.equal(APP.includes('useRef<Record<string, SourceLifecycleState>>'), false, 'the keyed map must be gone')
})

test('a fingerprint change is observed once, at the roster refresh', () => {
  assert.match(APP, /sourceLedgerStoreRef\.current = reincarnate\(/, 'the roster refresh must reincarnate the generation')
  const reincarnations = APP.split('reincarnate(').length - 1
  assert.ok(reincarnations >= 3, 'local + each accepted source (and the lazy guard) must register: ' + String(reincarnations))
})

test('a dispatch reads the stored epoch and never carries a captured one', () => {
  assert.ok(APP.includes('epochOf(registry, viewId)'), 'the dispatch must read the entry epoch')
  // W5: the captured-epoch third parameter is gone from the dispatch signature; the renderer
  // takes the current epoch at dispatch time and has no async capture point.
  assert.equal(APP.includes('capturedEpoch'), false, 'no dispatch may carry a captured epoch')
  assert.ok(
    APP.includes('export type LedgerLifecycleDispatch = (viewId: string, event: SourceEvent) => unknown'),
    'the ledger dispatch type must stay two-argument',
  )
  // The fingerprint capture survives ONLY inside the lazy unregistered branch, and a
  // delete-shaped write must be dropped BEFORE that branch (W3: no phantom generation).
  // Scope the ordering to the dispatch callback itself: the frame concatenates files, so a
  // frame-wide indexOf would compare positions across unrelated modules.
  const start = APP.indexOf('const dispatchLifecycle = useCallback(')
  const end = APP.indexOf('}, [])', start)
  assert.ok(start !== -1 && end > start, 'the dispatch callback must exist in the frame')
  const dispatch = APP.slice(start, end)
  const lazy = dispatch.indexOf('epoch === undefined')
  const deleteGuard = dispatch.indexOf('DELETE_EVENTS.has(event.kind)')
  const capture = dispatch.indexOf('.capture(viewId)?.fingerprint')
  assert.ok(lazy !== -1 && capture > lazy, 'the fingerprint read must sit inside the unregistered-source guard')
  assert.ok(deleteGuard > lazy && deleteGuard < capture, 'delete-shaped writes must be dropped before any lazy reincarnation')
})

test('the delete-shaped ledger writes are enumerated and dropped, not registered', () => {
  const start = APP.indexOf('const DELETE_EVENTS')
  const end = APP.indexOf('])', start)
  assert.ok(start !== -1 && end > start, 'DELETE_EVENTS must exist in the dispatch hook')
  const kinds = APP.slice(start, end)
  for (const kind of [
    'prewarmForgotten',
    'prewarmSuppressionForgotten',
    'harvestCleared',
    'retryForgotten',
    'abandonmentCleared',
  ]) {
    assert.ok(kinds.includes("'" + kind + "'"), kind + ' must be a detached ledger write')
  }
  assert.ok(
    APP.includes('if (DELETE_EVENTS.has(event.kind)) return undefined'),
    'an unregistered delete must be dropped, not reincarnated',
  )
})

test('retirement prunes the registry with the live-id set', () => {
  assert.ok(APP.includes('retainSourceIds(sourceLedgerStoreRef.current, liveSourceIds)'), 'retireSources must drop retired generations')
  // The WHOLE per-source ledger (field list single source) is pruned event-side too: a
  // same-id replacement must not inherit sessionListRefresh*/authoritativeArchiveSet.
  assert.ok(APP.includes('pruneSourceLedger(sourceLedger, liveSourceIds)'), 'retireSources must prune the ledger immediately')
  assert.equal(APP.includes('incarnationKey('), false, 'the keyed-record API must have no call site')
  assert.equal(APP.includes('retainSources('), false, 'the old sweep must have no call site')
  assert.equal(APP.includes('SourceLifecycleState'), false, 'the old per-record type must not appear in the App')
})

const AGED: SourceIncarnation = { sourceId: 'ssh-a', fingerprint: 'a'.repeat(64) }

test('retirement drops the generation so the registry keys are a subset of the live set', () => {
  const born = reincarnate({}, AGED)
  const kept = retainSourceIds(born, new Set(['local']))
  assert.deepEqual(Object.keys(kept), [], 'a retired source must leave the registry')
  for (const sourceId of Object.keys(kept)) assert.ok(new Set(['local']).has(sourceId))
})

test('a same-id replacement after retirement starts a fresh generation with its real proof', () => {
  const dropped = retainSourceIds(reincarnate({}, AGED), new Set(['local']))
  const replacement = reincarnate(dropped, { sourceId: AGED.sourceId, fingerprint: 'b'.repeat(64) })
  assert.equal(epochOf(replacement, AGED.sourceId), 1,
    'retirement drops the entry, so the replacement generation starts at 1 (no ghost epoch to reuse)')
  assert.equal(replacement[AGED.sourceId]?.incarnation.fingerprint, 'b'.repeat(64),
    'the replacement carries its real 64-hex proof, never the lazy sourceId fallback')
  const rebased = reincarnate(replacement, { sourceId: AGED.sourceId, fingerprint: 'c'.repeat(64) })
  assert.equal(epochOf(rebased, AGED.sourceId), 2, 'a fingerprint change inside one live generation bumps the epoch')
})
