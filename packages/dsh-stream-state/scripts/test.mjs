/**
 * @dsh-chamber/dsh-stream-state test manifest - authoritative file list for this
 * package test script.
 *
 * Every listed file runs as its own node child with inherited stdio; the first
 * failure ends the run. A listed file that does not exist is a failure, never a
 * silent skip. The zero-test guard fails a listed file that exits 0 without a
 * node:test summary line (a silently empty suite must not read as green).
 *
 * Why strip-types only: this package's sources are erasable-syntax pure TypeScript
 * (no parameter properties, no enums, no decorators), so production and tests run
 * the same way - node --experimental-strip-types - and any accidental
 * non-erasable syntax fails here instead of at bundle time.
 *
 * Why no dependencies: the reducers are clockless and effect-free. Everything
 * that waits (deadlines, retries, single-flight) belongs to the executor
 * (dsh-stream-state/async-op, node B6 of the refactor plan); anything that needs
 * a real socket, DOM or React belongs to the consumer. If a change makes a file
 * here import a runtime module, that change is a design error, not a build error.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const GROUPS = {
  // wiring: the declared lifecycle faces (event/effect literals) must each have a
  // producer or executor - a union member nothing performs is a dead promise. G-A.
  wiring: [
    'test/wiring/emission-coverage.test.ts',
  ],
  // forensics: the bounded resident tail buffer every export path drains (P5).
  forensics: [
    'test/forensics/forensics.test.ts',
  ],
  // carrier: the single-owner carrier lifecycle reducer + its throttle tables.
  carrier: [
    'test/carrier/carrier-lifecycle.test.ts',
  ],
  // invariants: implementation-independent properties every reducer must hold
  // for ANY event sequence (full-function totality, action idempotence, rebuild
  // window bound, no-exitless-spinner bound) - these are the acceptance gates
  // Phase B nodes are checked against.
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
  // refactor: the A1 differential harness (vector replay + DIVERGENCE ledger
  // cross-check) and its legacy reference adapter.
  refactor: [
    'test/refactor/differential-harness.test.ts',
  ],
  // tables: the TS literals <-> tables.json lockstep (the JSON is what the Swift
  // mirror reads; the literals are what the browser module uses).
  tables: [
    'test/tables/tables-parity.test.ts',
  ],
  // source: the per-source lifecycle reducer (B2 core) that replaces the App's six
  // ledgers + three loose fields with one incarnation-keyed object.
  source: [
    'test/source/source-lifecycle.test.ts',
    // B2: the per-source container (incarnation keying + the ref projections the
    // App migrates onto, one ledger at a time).
    'test/source/source-container.test.ts',
    // P1 session-authority: the single running-bit truth reducer + its scenario corpus
    // (it subsumes the retired authority-decision verdict branches).
    'test/authority/session-authority.test.ts',
    // B5: the shell's load state machine (the three real-machine defects + generation fence).
    'test/load-state/load-state.test.ts',
    // B2: the prewarm ledgers' events (Set-shaped ledgers need methods, not views).
    'test/source/source-prewarm-ledger.test.ts',
    // G-D: one source id has one live incarnation - stale events are dropped and
    // the projections never merge two generations of the same id.
    'test/source/incarnation-fence.test.ts',
  ],
  // presentation: the single veil/reveal decision (B3 core) that replaces four
  // independent timers and computes the total bound in one place.
  presentation: [
    'test/presentation/presentation-arbiter.test.ts',
    // G-E: a held veil carries a finite absolute releaseAtMonoMs, and
    // planVeilTimer refuses to arm a 0 ms timer for a held frame.
    'test/presentation/veil-release.test.ts',
  ],
  // ladder: the unified recovery-ladder engine (B4 core) that all four ladders
  // (liveness / reconcile / stream-health / mobile stall) become instances of.
  ladder: [
    'test/ladder/ladder-engine.test.ts',
  ],
  // async-op: deadline / retry pacing / bounded wait / single-flight with an
  // injected scheduler (B6 core) - the five hand-written waiting shapes, once.
  asyncOp: [
    'test/async-op/async-op.test.ts',
  ],
  // metrics: the B7 measurement tool's own guard - a baseline that can measure
  // nothing would make every "the numbers went down" claim meaningless.
  metrics: [
    'test/metrics/metrics-tool.test.ts',
  ],
}

/** node:test summary lines: spec (ℹ tests N) and TAP (# tests N). */
const SUMMARY_LINE = /^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)\s*$/gm

/**
 * Test bodies actually executed by the last node:test summary block
 * (pass + fail); null when nothing ran (no summary / tests 0 / all skipped).
 * Same contract as the renderer and desktop runners' D2b guard: a listed file
 * that exits 0 without running a test body must not read as green.
 */
export function parseExecutedTestCount(output) {
  let block = null
  for (const match of output.matchAll(SUMMARY_LINE)) {
    const key = match[1]
    if (block === null || key === 'tests') block = { tests: 0, pass: 0, fail: 0, skipped: 0 }
    block[key] = Number(match[2])
  }
  if (block === null || block.tests === 0) return null
  const executed = (block.pass ?? 0) + (block.fail ?? 0)
  return executed > 0 ? executed : null
}

function runOne(file) {
  const absolute = join(PACKAGE_ROOT, file)
  if (!existsSync(absolute)) {
    console.error(`[stream-state] listed test file is missing: ${file}`)
    process.exit(1)
  }
  const result = spawnSync(process.execPath, ['--experimental-strip-types', absolute], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (typeof result.stdout === 'string' && result.stdout !== '') process.stdout.write(result.stdout)
  if (typeof result.stderr === 'string' && result.stderr !== '') process.stderr.write(result.stderr)
  if (result.status !== 0) {
    console.error(`[stream-state] FAILED: ${file}`)
    process.exit(result.status ?? 1)
  }
  if (parseExecutedTestCount((result.stdout ?? '') + '\n' + (result.stderr ?? '')) === null) {
    console.error(`[stream-state] ${file} ran no test body - refusing to read as green`)
    process.exit(1)
  }
}

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
for (const [group, files] of Object.entries(GROUPS)) {
  if (only.length > 0 && !only.includes(group)) continue
  for (const entry of files) {
    const file = typeof entry === 'string' ? entry : entry.file
    runOne(file)
  }
}
console.log('[stream-state] all listed suites passed')
