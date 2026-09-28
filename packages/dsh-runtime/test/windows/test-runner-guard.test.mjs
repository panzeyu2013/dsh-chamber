/**
 * Zero-test guard for the dsh-runtime test manifest (scripts/test.mjs):
 * a listed file that silently stopped running tests must fail the leg.
 *
 * The manifest only owns its tables; the verdict comes from the shared engine
 * (scripts/lib/test-manifest.mjs) and this manifest selects the REGISTERED-level
 * guard: a fully platform-skipped listed file (e.g. a win32-only integration
 * test on a POSIX leg) legitimately has a summary with tests > 0 while executing
 * no body, so it must stay green there — while a child that never entered
 * node:test stays red.
 *
 * This file owns the package-specific SOURCE lock only:
 *  ① the manifest really asks the shared runner for that guard and the win32
 *     leg, keeps the CLI inside an import guard, and never spawns children
 *     itself.
 *
 * The shared verdict/parser cases that used to be duplicated verbatim in every
 * package guard (parseReportedTotals last-block semantics, the registered-level
 * verdict) are owned by ONE test now: scripts/lib/test-manifest.test.mjs.
 *
 * Run directly: node --experimental-strip-types --test packages/dsh-runtime/test/windows/test-runner-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const RUNNER_SOURCE = readFileSync(new URL('../../scripts/test.mjs', import.meta.url), 'utf8')

test('① the manifest asks for that guard on the shared runner, behind an import guard', () => {
  assert.match(RUNNER_SOURCE, /guard: 'registered'/, 'the registered-level verdict is this manifest contract')
  assert.ok(RUNNER_SOURCE.includes('platformFiles: { win32: WIN32_FILES }'), 'the win32 leg must be wired')
  assert.match(
    RUNNER_SOURCE,
    /const isMain = process\.argv\[1\] !== undefined && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/,
    'the CLI must sit inside an import guard',
  )
  assert.ok(!RUNNER_SOURCE.includes('spawnSync'), 'the local spawn loop must be gone')
})
