/**
 * Zero-test guard for the dsh-runtime test manifest (scripts/test.mjs),
 * ported from packages/desktop/scripts/test.mjs:207-223 in S5
 * (review/windows FIX C). The Windows CI leg is where a listed file that
 * silently stopped running tests used to stay green (review/windows
 * 05-ci-verification-coverage.md F6), so the guard is pinned here.
 *
 * Assertions:
 *  ① parseReportedTestCount reads the LAST node:test summary (spec `ℹ tests N`
 *     and TAP `# tests N`); no summary = null, `tests 0` = 0;
 *  ② the runner loop really fails on null/0 after the exit-code check, and the
 *     CLI stays inside an import guard (source lock — the guard must not be a
 *     disconnected pure function).
 *
 * Run directly: node --experimental-strip-types --test packages/dsh-runtime/test/windows/test-runner-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseReportedTestCount } from '../../scripts/test.mjs'

const RUNNER_SOURCE = readFileSync(new URL('../../scripts/test.mjs', import.meta.url), 'utf8')

test('① parseReportedTestCount reads the last node:test summary (spec and TAP)', () => {
  assert.equal(parseReportedTestCount('ℹ tests 3\nℹ pass 3\n'), 3)
  assert.equal(parseReportedTestCount('# tests 2\n# pass 2\n'), 2)
  assert.equal(parseReportedTestCount('# tests 0\n'), 0)
  assert.equal(parseReportedTestCount('console.log only\n'), null)
  // A child that spawned its own runner prints its summary first; this file's
  // last block is the one that counts.
  assert.equal(parseReportedTestCount('ℹ tests 9\nℹ pass 9\nℹ tests 2\nℹ pass 2\n'), 2)
})

test('② the zero-test verdict is wired into the runner loop behind an import guard', () => {
  assert.match(
    RUNNER_SOURCE,
    /const reported = parseReportedTestCount\(/,
    'the guard must call the parser on real child output, not only export it',
  )
  assert.match(
    RUNNER_SOURCE,
    /if \(reported === null \|\| reported === 0\) \{[\s\S]*?process\.exit\(1\)/,
    'a missing summary or tests 0 must fail the run',
  )
  assert.match(
    RUNNER_SOURCE,
    /const isMain = process\.argv\[1\] !== undefined && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/,
    'the CLI must sit inside an import guard (importing the manifest for this test must not run the suite)',
  )
})
