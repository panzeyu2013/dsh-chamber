/**
 * Unit lock for scripts/lib/test-manifest.mjs — the shared package test runner.
 *
 * The negative cases are the point: a child that exits 0 without executing a
 * node:test body, a manifest that lists nothing, and an empty group must all be
 * refused; only real pass/fail/skip corpora count as executed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  collectEntries, emptyManifestProblems, evaluateChildRun, parseExecutedTestCount, parseReportedTotals, selectManifest,
} from './test-manifest.mjs'

test('parseExecutedTestCount: spec summary counts executed bodies (pass + fail)', () => {
  const output = '\nℹ tests 7\nℹ suites 0\nℹ pass 6\nℹ fail 1\nℹ skipped 0\n'
  assert.equal(parseExecutedTestCount(output), 7)
})

test('parseExecutedTestCount: a zero-body child is null (never a green run)', () => {
  assert.equal(parseExecutedTestCount(''), null, 'no summary at all')
  assert.equal(parseExecutedTestCount('hello\n'), null, 'unrelated output only')
  assert.equal(parseExecutedTestCount('ℹ tests 0\nℹ pass 0\nℹ fail 0\n'), null, 'explicit zero tests')
  assert.equal(parseExecutedTestCount('ℹ tests 3\nℹ pass 0\nℹ fail 0\nℹ skipped 3\n'), null, 'all skipped')
})

test('parseExecutedTestCount: the TAP summary form is recognized', () => {
  assert.equal(parseExecutedTestCount('# tests 4\n# pass 3\n# fail 1\n'), 4)
})

test('parseExecutedTestCount: only the LAST summary block decides (nested runner transcript)', () => {
  const output = 'ℹ tests 9\nℹ pass 9\nℹ fail 0\nchild re-ran:\nℹ tests 2\nℹ pass 1\nℹ fail 1\n'
  assert.equal(parseExecutedTestCount(output), 2)
})

test('collectEntries: normalizes paths and { file, nodeArgs } entries in declaration order', () => {
  const entries = collectEntries({
    first: ['a.test.ts'],
    second: [{ file: 'b.test.ts', nodeArgs: ['--import', './loader.mjs'] }, 'c.test.ts'],
  })
  assert.deepEqual(entries, [
    { group: 'first', file: 'a.test.ts', nodeArgs: [] },
    { group: 'second', file: 'b.test.ts', nodeArgs: ['--import', './loader.mjs'] },
    { group: 'second', file: 'c.test.ts', nodeArgs: [] },
  ])
})

test('emptyManifestProblems: a manifest that would run zero children is a defect', () => {
  assert.deepEqual(emptyManifestProblems({}), ['the manifest declares no groups at all'])
  assert.deepEqual(emptyManifestProblems({ core: [] }), ["group 'core' lists zero test files"])
  assert.deepEqual(emptyManifestProblems({ core: ['a.test.ts'] }), [])
})

test('the zero-case guard is WIRED into the runner, not just exported', () => {
  const source = readFileSync(fileURLToPath(new URL('./test-manifest.mjs', import.meta.url)), 'utf8')
  assert.match(source, /const problems = emptyManifestProblems\(runGroups\)/u)
  assert.match(source, /const verdict = evaluateChildRun\(entry.file, result, zeroTestAllowlist, \{ requireNoSkips: noSkips, guard \}\)/u)
})

test('parseReportedTotals: the LAST summary block, nulls when the child never reported', () => {
  assert.deepEqual(parseReportedTotals(''), { tests: null, pass: null, fail: null, skipped: null })
  assert.deepEqual(
    parseReportedTotals('ℹ tests 3\nℹ pass 2\nℹ fail 1\nℹ skipped 0\n'),
    { tests: 3, pass: 2, fail: 1, skipped: 0 },
  )
  // A nested runner transcript: only the last block decides.
  assert.deepEqual(
    parseReportedTotals('ℹ tests 9\nℹ pass 9\nℹ fail 0\nℹ skipped 0\nℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ skipped 2\n'),
    { tests: 2, pass: 0, fail: 0, skipped: 2 },
  )
  assert.deepEqual(parseReportedTotals('# tests 4\n# pass 4\n# fail 0\n# skipped 0\n'), { tests: 4, pass: 4, fail: 0, skipped: 0 })
})

test('evaluateChildRun: spawn failure, non-zero exit and no executed body are all red', () => {
  assert.equal(evaluateChildRun('a.test.ts', { status: null, signal: null, error: new Error('ENOENT') }).ok, false)
  assert.match(evaluateChildRun('a.test.ts', { status: null, signal: null, error: new Error('ENOENT') }).reason, /ENOENT/u)
  assert.equal(evaluateChildRun('a.test.ts', { status: 1, signal: null, stdout: '', stderr: '' }).ok, false)
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: '', stderr: '' }).ok, false, 'no summary')
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n' }).ok, false, 'tests 0')
  assert.equal(
    evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: 'ℹ tests 3\nℹ pass 0\nℹ fail 0\nℹ skipped 3\n' }).ok,
    false,
    'all skipped (the 2026-12 hole the old count guard had)',
  )
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: 'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\n' }).ok, true)
})

test('evaluateChildRun: the allowlist is an explicit exception, requireNoSkips is the macOS-leg discipline', () => {
  const zeroBody = { status: 0, signal: null, stdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n' }
  assert.equal(evaluateChildRun('a.test.ts', zeroBody, [{ file: 'a.test.ts', reason: 'documented' }]).ok, true)
  assert.equal(evaluateChildRun('b.test.ts', zeroBody, [{ file: 'a.test.ts', reason: 'documented' }]).ok, false)
  const skipped = { status: 0, signal: null, stdout: 'ℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ skipped 1\n' }
  assert.equal(evaluateChildRun('a.test.ts', skipped).ok, true, 'a partial skip is fine on the default leg')
  assert.equal(evaluateChildRun('a.test.ts', skipped, [], { requireNoSkips: true }).ok, false, 'the macOS leg must not skip')
})

test('selectManifest: platform legs are looked up in GROUPS (nodeArgs inherited), unknown files refused', () => {
  const groups = { core: ['a.test.ts'], args: [{ file: 'w.test.ts', nodeArgs: ['--import', './l.mjs'] }] }
  const platformFiles = { win32: ['w.test.ts'], macos: ['m.test.ts'] }
  assert.deepEqual(selectManifest({ groups, platformFiles, argv: [] }), { groups, leg: undefined })
  assert.deepEqual(selectManifest({ groups, platformFiles, argv: ['--win32'] }), {
    groups: { win32: [{ group: 'win32', file: 'w.test.ts', nodeArgs: ['--import', './l.mjs'] }] },
    leg: 'win32',
  })
  // The macOS file is not in GROUPS: the leg must be refused, not silently run anyway.
  assert.match(selectManifest({ groups, platformFiles, argv: ['--macos'] }).error, /outside GROUPS.*m\.test\.ts/u)
  assert.match(selectManifest({ groups, platformFiles, argv: ['--win32', '--macos'] }).error, /mutually exclusive/u)
  // A package without a leg keeps running its full manifest even when the flag is present.
  assert.deepEqual(selectManifest({ groups, platformFiles: {}, argv: ['--win32'] }), { groups, leg: undefined })
  // Some legs are standalone sets (files the general manifest deliberately does
  // not list, e.g. desktop's darwin-only lock/packaging suites); that must be an
  // explicit opt-in so the strict refusal stays the default.
  const standalone = selectManifest({ groups, platformFiles: { macos: ['m.test.ts'] }, argv: ['--macos'], allowPlatformFilesOutsideGroups: true })
  assert.equal(standalone.leg, 'macos')
  assert.deepEqual(standalone.groups.macos, [{ group: 'macos', file: 'm.test.ts', nodeArgs: [] }])
})

test('evaluateChildRun: guard "registered" keeps a fully platform-skipped file green, but tests 0 is still red', () => {
  const allSkipped = { status: 0, signal: null, stdout: 'ℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ skipped 2\n' }
  assert.equal(evaluateChildRun('a.test.ts', allSkipped).ok, false, 'the default executed-body guard refuses it')
  assert.equal(evaluateChildRun('a.test.ts', allSkipped, [], { guard: 'registered' }).ok, true)
  const zero = { status: 0, signal: null, stdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n' }
  assert.equal(evaluateChildRun('a.test.ts', zero, [], { guard: 'registered' }).ok, false, 'tests 0 stays red')
  assert.equal(evaluateChildRun('a.test.ts', { status: 0, signal: null, stdout: '' }, [], { guard: 'registered' }).ok, false, 'no summary stays red')
})

test('the per-file timeout is wired into the spawn, not just accepted as an option', () => {
  const source = readFileSync(fileURLToPath(new URL('./test-manifest.mjs', import.meta.url)), 'utf8')
  assert.match(source, /timeout: timeoutMs/u)
})
