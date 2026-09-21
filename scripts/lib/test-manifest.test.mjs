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
import { collectEntries, emptyManifestProblems, parseExecutedTestCount } from './test-manifest.mjs'

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
  assert.match(source, /const problems = emptyManifestProblems\(groups\)/u)
  assert.match(source, /ran no test body/u)
})
