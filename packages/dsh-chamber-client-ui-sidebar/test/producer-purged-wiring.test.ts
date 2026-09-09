import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Producer wiring contract (design 24 §21). The sidebar producer lives in
 * `src/client/index.ts`, which imports React and CSS modules and therefore
 * cannot be imported by a node test; the stateful half is covered by
 * `purged-tracker.test.ts`, but the GLUE that calls it (observe → filter →
 * runtime-facts filter → dispose) has no other guard. This source-text
 * contract pins the glue, the same way `dsh-chamber-client-ui-git`'s
 * slot-contract test pins its registration text.
 *
 * It guards WIRING, not semantics: a green run proves the calls still exist
 * in the expected shape, not that the behaviour is right. The 2026-09 reviews
 * found both a detached-method BLOCKER and seven wiring mutations that a pure
 * unit suite could not see; the method-call assertion below is the regression
 * guard for the BLOCKER.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/client/index.ts', import.meta.url)),
  'utf8',
)

/** Collapse whitespace so assertions survive formatting churn. */
const flat = SOURCE.replace(/\s+/g, ' ')

test('wiring: the official refresh is invoked as a METHOD on the service object', () => {
  // `ClientSessions.refresh` reads `this.manager`; a detached call throws and
  // silently disables convergence (2026-09 review BLOCKER).
  assert.match(flat, /return Promise\.resolve\(service\.refresh\(\)\)/)
  assert.doesNotMatch(flat, /const refresh = \(ctx\.sessions as unknown as \{[^}]*\}\)\.refresh/)
})

test('wiring: the producer constructs the tracker with the real refresh probe', () => {
  assert.match(flat, /const purgedRows = createPurgeTracker\(\{/)
  assert.match(flat, /refresh: officialSessionRefresh,/)
  assert.match(flat, /listedSummaryIds,/)
})

test('wiring: the shrink is observed and the emitted snapshot is filtered', () => {
  assert.match(flat, /const armed = purgedRows\.observeArchive\(/)
  assert.match(flat, /const filteredSessions = purgedRows\.filter\(projected\.sessions\)/)
  // The filtered rows must feed the signature/report, not the raw projection.
  assert.match(flat, /instanceSnapshotSignature\(emitted\)/)
  assert.match(flat, /snapshotProducer\.report\(emitted\)/)
})

test('wiring: arming re-reports runtime facts in the same pass', () => {
  assert.match(flat, /if \(armed\.length > 0\) \{ \/\/[^]*?sync\(\)/)
})

test('wiring: tombstones are reconciled against the raw summary ids', () => {
  assert.match(flat, /purgedRows\.reconcile\(listedSummaryIds\(\)\)/)
})

test('wiring: runtime facts (sessions AND current) drop suppressed ids', () => {
  assert.match(flat, /const suppressed = purgedRows\.suppressed\(\)/)
  assert.match(flat, /for \(const id of suppressed\) delete report\.sessions\[id\]/)
  assert.match(flat, /report\.current !== undefined && suppressed\.has\(report\.current\)\) delete report\.current/)
})

test('wiring: the bridge request and the source teardown drive the tracker', () => {
  assert.match(flat, /if \(sourceId !== chamberInstanceId\) return \n?\s*purgedRows\.converge\(\)/)
  assert.match(flat, /purgedRows\.dispose\(\)/)
})

test('wiring: the tracker is given the authoritative probe and a release re-publisher', () => {
  assert.match(flat, /probe: authoritativeListedIds,/)
  assert.match(flat, /onRelease: \(\) => \{ sync\(\) \},/)
  // The probe must be the chamber's own unary client (fresh per call).
  assert.match(flat, /fetchInstanceSnapshot\(getInstanceClient\(chamberInstanceId\)\)/)
})

test('wiring: arming re-reports runtime facts inside the arm branch', () => {
  // Anchored: the sync() must sit inside `if (armed.length > 0) { … }`, not
  // merely appear somewhere later in the file.
  assert.match(flat, /if \(armed\.length > 0\) \{[^}]*sync\(\)/)
})
