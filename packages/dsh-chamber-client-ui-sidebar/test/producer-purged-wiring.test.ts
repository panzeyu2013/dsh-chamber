import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveInstanceListFace } from '../src/client/instance-list-face.ts'

/**
 * Producer wiring contract (design 24 §12). The sidebar producer lives in
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
 *
 * 2026-12: the ctx-service read guard (`instance-list-face.ts`) is the one
 * part of this glue that IS node-testable, so its behaviour is exercised here
 * directly (warn + skip, never a silent no-op) beside the source-text lock
 * that the producer still routes both faces through it.
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

/**
 * 2026-12 review P2: the producer obtained `ctx.sessions.list` /
 * `ctx.workspaces.list` through a bare cast — on a boot whose sessions or
 * workspaces client exposes no `list` observable (or whose service proxy
 * throws), the effect died on the first snapshot read, or worse, registered
 * producers that could never report. The faces are now resolved through a
 * guarded reader that WARNS and skips the whole producer registration
 * (the `refresh()` discipline in the same effect: never a silent no-op).
 */
test('guard: a service without `list` warns once and yields no face', () => {
  const warnings = captureWarnings(() => {
    const face = resolveInstanceListFace<{ ids: readonly string[] }>(
      'local', 'sessions', () => ({ refresh: () => undefined }))
    assert.equal(face, undefined, 'a service without a list observable must not resolve')
  })
  assert.equal(warnings.length, 1, 'exactly one loud warning')
  assert.match(warnings[0] ?? '', /sessions\.list/)
  assert.match(warnings[0] ?? '', /local/)
  assert.match(warnings[0] ?? '', /skip/i)
})

test('guard: a throwing service read warns instead of propagating', () => {
  const warnings = captureWarnings(() => {
    const face = resolveInstanceListFace('local', 'workspaces', () => {
      throw new Error('service not provided')
    })
    assert.equal(face, undefined)
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /workspaces\.list/)
  assert.match(warnings[0] ?? '', /service not provided/)
})

test('guard: a half-built list face (no subscribe) is rejected, not returned', () => {
  const warnings = captureWarnings(() => {
    const face = resolveInstanceListFace('gateway-a', 'sessions', () => ({ list: { getSnapshot: () => ({}) } }))
    assert.equal(face, undefined)
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /gateway-a/)
})

test('guard: a well-formed list face is returned unchanged (no wrapping)', () => {
  const source = { getSnapshot: () => ({ ids: [] }), subscribe: () => () => undefined }
  const warnings = captureWarnings(() => {
    assert.equal(resolveInstanceListFace('local', 'sessions', () => ({ list: source })), source)
  })
  assert.deepEqual(warnings, [])
})

test('wiring: both faces are read through the guard and the producer skips before registering', () => {
  assert.match(flat,
    /const sessionsList = resolveInstanceListFace<SessionListState>\( ?chamberInstanceId, 'sessions', \(\) => ctx\.sessions\)/)
  assert.match(flat,
    /const workspacesList = resolveInstanceListFace<WorkspaceSnapshot>\( ?chamberInstanceId, 'workspaces', \(\) => ctx\.workspaces\)/)
  // The bare casts are gone: a missing face can no longer reach the producer.
  assert.doesNotMatch(flat, /ctx\.sessions as unknown as \{ list: ObservableSnapshot<SessionListState> \}\)\.list/)
  assert.doesNotMatch(flat, /ctx\.workspaces as unknown as \{ list: ObservableSnapshot<WorkspaceSnapshot> \}\)\.list/)
  // Ordering: the skip must land BEFORE any producer is registered, or a
  // skipped run would still claim (and never fulfil) the report slot.
  const skipAt = flat.indexOf('if (sessionsList === undefined || workspacesList === undefined) return () => {}')
  const producerAt = flat.indexOf('chamberBridge.registerInstanceRuntimeProducer')
  assert.ok(skipAt !== -1, 'the producer must bail out when a list face is missing')
  assert.ok(producerAt !== -1, 'the runtime-facts producer registration must exist')
  assert.ok(skipAt < producerAt, 'the guard must run before registerInstanceRuntimeProducer')
})

/**
 * Run `body` with `console.warn` captured.
 * @param body - the assertions to run.
 * @returns every warning line, in order.
 */
function captureWarnings(body: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    body()
  } finally {
    console.warn = original
  }
  return warnings
}
