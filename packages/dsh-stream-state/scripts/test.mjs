/**
 * @dsh-chamber/dsh-stream-state test manifest - authoritative file list for this
 * package test script.
 *
 * Runner semantics (a missing listed file, the zero-test verdict, first-failure
 * stop, the bounded parallel pool, the dump mode the global tests gate reads)
 * are the shared engine's: scripts/lib/test-manifest.mjs. This file owns only
 * the data tables and the per-file --experimental-strip-types argument.
 *
 * Why strip-types only: this package's sources are erasable-syntax pure TypeScript
 * (no parameter properties, no enums, no decorators), so production and tests run
 * the same way - node --experimental-strip-types - and any accidental
 * non-erasable syntax fails here instead of at bundle time.
 *
 * Why no dependencies: the reducers are clockless and effect-free. Everything
 * that waits (deadlines, retries, single-flight) belongs to the executor
 * (dsh-stream-state/async-op); anything that needs
 * a real socket, DOM or React belongs to the consumer. If a change makes a file
 * here import a runtime module, that change is a design error, not a build error.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const GROUPS = {
  // wiring: the declared lifecycle faces (event/effect literals) must each have a
  // producer or executor - a union member nothing performs is a dead promise. G-A.
  wiring: [
    'test/wiring/emission-coverage.test.ts',
  ],
  // forensics: the bounded resident tail buffer every export path drains.
  forensics: [
    'test/forensics/forensics.test.ts',
  ],
  // carrier: the single-owner carrier lifecycle reducer + its throttle tables.
  carrier: [
    'test/carrier/carrier-lifecycle.test.ts',
  ],
  // invariants: implementation-independent properties every reducer must hold
  // for ANY event sequence (full-function totality, action idempotence, rebuild
  // window bound, no-exitless-spinner bound).
  invariants: [
    'test/invariants/reducer-invariants.test.ts',
    // G-B: NaN / Inf / rollback fuzz over every waiting decision - an unusable
    // clock may only hold, never release and never produce a 0 ms deadline.
    'test/invariants/time-discipline.test.ts',
    // G-C: the rolling ledgers are pruned to the window their readers use.
    'test/invariants/ledger-bounds.test.ts',
  ],
  // equivalence: the action normalizer used by scripts/refactor/equivalence.mjs
  // to compare an old wiring against a new one without false-red on wording.
  equivalence: [
    'test/equivalence/action-normalizer.test.ts',
  ],
  // refactor: the differential harness (vector replay + DIVERGENCE ledger
  // cross-check) and its legacy reference adapter.
  refactor: [
    'test/refactor/differential-harness.test.ts',
  ],
  // tables: the TS literals <-> tables.json lockstep (the JSON is what the Swift
  // mirror reads; the literals are what the browser module uses).
  tables: [
    'test/tables/tables-parity.test.ts',
  ],
  // source: the per-source lifecycle reducer that consolidates the App's six
  // ledgers + three loose fields into one incarnation-keyed object.
  source: [
    'test/source/source-lifecycle.test.ts',
    // the per-source container (incarnation keying + the ref projections the
    // App reads, one ledger at a time).
    'test/source/source-container.test.ts',
    // session-authority: the single running-bit truth reducer + its scenario corpus.
    'test/authority/session-authority.test.ts',
    // the prewarm ledgers' events (Set-shaped ledgers need methods, not views).
    'test/source/source-prewarm-ledger.test.ts',
    // G-D: one source id has one live incarnation - stale events are dropped and
    // the projections never merge two generations of the same id.
    'test/source/incarnation-fence.test.ts',
  ],
  // presentation: the single veil/reveal decision that replaces four
  // independent timers and computes the total bound in one place.
  presentation: [
    'test/presentation/presentation-arbiter.test.ts',
    // G-E: a held veil carries a finite absolute releaseAtMonoMs, and
    // planVeilTimer refuses to arm a 0 ms timer for a held frame.
    'test/presentation/veil-release.test.ts',
  ],
  // ladder: the unified recovery-ladder engine that all four ladders
  // (liveness / reconcile / stream-health / mobile stall) become instances of.
  ladder: [
    'test/ladder/ladder-engine.test.ts',
  ],
  // delivery: the identity spine (SessionRunId) and the ONE delivery ladder that
  // every stall family feeds; the efficacy table records what each tier resets.
  delivery: [
    'test/delivery/delivery-evidence.test.ts',
  ],
  // injection: the cross-shell fault harness (frame-stop / append-silent /
  // break-streams) and the carrier open-leg decorator it drives.
  injection: [
    'test/injection/injection.test.ts',
  ],
  // incident: the one resident incident ring every shell writes into and reads
  // back through a single global view.
  incident: [
    'test/incident/incident.test.ts',
  ],
  // async-op: deadline / retry pacing / bounded wait / single-flight with an
  // injected scheduler - the five hand-written waiting shapes, once.
  asyncOp: [
    'test/async-op/async-op.test.ts',
  ],
  // metrics: the measurement tool's own guard - a baseline that can measure
  // nothing would make every "the numbers went down" claim meaningless.
  metrics: [
    'test/metrics/metrics-tool.test.ts',
  ],
}
/** Every listed file is erasable-syntax TypeScript: strip types explicitly. */
const withStripTypes = entry => (typeof entry === 'string'
  ? { file: entry, nodeArgs: ['--experimental-strip-types'] }
  : { ...entry, nodeArgs: ['--experimental-strip-types', ...(entry.nodeArgs ?? [])] })

function main() {
  runTestManifest({
    label: 'dsh-stream-state',
    packageRoot: PACKAGE_ROOT,
    groups: Object.fromEntries(Object.entries(GROUPS).map(([group, files]) => [group, files.map(withStripTypes)])),
  })
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
