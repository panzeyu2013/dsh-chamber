/**
 * Zero-test guard for the control-plane test manifest (scripts/test.mjs):
 * the Windows CI leg is where a listed file can silently stop running tests
 * yet stay green.
 *
 * The manifest only owns its tables; the
 * verdict comes from the shared engine (scripts/lib/test-manifest.mjs) and this
 * manifest selects the REGISTERED-level guard: a fully platform-skipped listed
 * file (e.g. a win32-only integration test on a POSIX leg) legitimately has a
 * summary with tests > 0 while executing no body, so it must stay green there —
 * while a child that never entered node:test stays red.
 *
 * Assertions:
 *  ① parseReportedTotals reads the LAST node:test summary (spec and TAP);
 *     no summary = null, tests 0 = 0;
 *  ② the registered-level verdict tolerates an all-skipped file but refuses
 *     no-summary / tests 0;
 *  ③ source lock: the manifest really asks for that guard and the platform leg,
 *     keeps the CLI inside an import guard, and never spawns children
 *     itself.
 *  ④ the per-file timeout bound (120 s: a blocking regression must not hold the
 *     whole suite on open(2)) is still requested.
 *
 * Run directly: node --experimental-strip-types --test packages/control-plane/test/windows/test-runner-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateChildRun, parseReportedTotals } from '../../../../scripts/lib/test-manifest.mjs'

const RUNNER_SOURCE = readFileSync(new URL('../../scripts/test.mjs', import.meta.url), 'utf8')

test('① parseReportedTotals reads the last node:test summary (spec and TAP)', () => {
  assert.equal(parseReportedTotals('ℹ tests 3\nℹ pass 3\n').tests, 3)
  assert.equal(parseReportedTotals('# tests 2\n# pass 2\n').tests, 2)
  assert.equal(parseReportedTotals('# tests 0\n').tests, 0)
  assert.equal(parseReportedTotals('console.log only\n').tests, null)
  // A child that spawned its own runner prints its summary first; this file's
  // last block is the one that counts.
  assert.equal(parseReportedTotals('ℹ tests 9\nℹ pass 9\nℹ tests 2\nℹ pass 2\n').tests, 2)
})

test('② the registered-level verdict: all-skipped stays green, no-summary / tests 0 stay red', () => {
  const allSkipped = { status: 0, signal: null, stdout: 'ℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ skipped 2\n' }
  assert.equal(
    evaluateChildRun('a.test.ts', allSkipped, [], { guard: 'registered' }).ok,
    true,
    'a fully platform-skipped listed file must stay green on this leg',
  )
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: '' }, [], { guard: 'registered' }).ok, false)
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: 'ℹ tests 0\n' }, [], { guard: 'registered' }).ok, false)
})

test('③ the manifest asks for that guard on the shared runner, behind an import guard', () => {
  assert.match(RUNNER_SOURCE, /guard: 'registered'/, 'the registered-level verdict is this manifest contract')
  assert.ok(RUNNER_SOURCE.includes('platformFiles: { win32: WIN32_FILES }'), 'the win32 leg must be wired')
  assert.match(
    RUNNER_SOURCE,
    /const isMain = process\.argv\[1\] !== undefined && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/,
    'the CLI must sit inside an import guard',
  )
  assert.ok(!RUNNER_SOURCE.includes('spawnSync'), 'the local spawn loop must be gone')
  assert.match(RUNNER_SOURCE, /timeoutMs: 120_000/, 'the per-file timeout bound must stay')
})
