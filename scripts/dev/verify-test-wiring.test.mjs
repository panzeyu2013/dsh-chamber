/**
 * Unit tests for the test-wiring gate.
 *
 * The gate's failure mode is "everything green while a test never runs", so the
 * cases below pin both directions: a wired file must pass in each of the three
 * wiring forms the repository uses, and an unreferenced file must fail — even
 * when another package happens to carry a same-named file.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findUnwiredTests, TEST_FILE_PATTERN, UNWIRED_ALLOWLIST } from './verify-test-wiring.mjs'

/** Build the wiring evidence shape the gate consumes. */
function evidenceOf({ root = '', packages = {} } = {}) {
  return { root, byPackage: new Map(Object.entries(packages)) }
}

test('pattern accepts the two test extensions and nothing else', () => {
  assert.equal(TEST_FILE_PATTERN.test('a.test.ts'), true)
  assert.equal(TEST_FILE_PATTERN.test('a.test.mjs'), true)
  assert.equal(TEST_FILE_PATTERN.test('a.spec.ts'), false)
  assert.equal(TEST_FILE_PATTERN.test('a.test.js'), false)
})

test('a package-relative basename in the owning package script counts as wired', () => {
  const verdict = findUnwiredTests({
    testFiles: ['packages/alpha/test/one.test.ts'],
    evidence: evidenceOf({ packages: { alpha: 'node test/one.test.ts' } }),
  })
  assert.deepEqual(verdict.unwired, [])
  assert.equal(verdict.corpusSize, 1)
})

test('a file list inside the package helper script counts as wired', () => {
  const verdict = findUnwiredTests({
    testFiles: ['packages/alpha/test/two.test.ts'],
    evidence: evidenceOf({ packages: { alpha: "const FILES = ['two.test.ts']" } }),
  })
  assert.deepEqual(verdict.unwired, [])
})

test('a root manifest reference wires a package test file', () => {
  const verdict = findUnwiredTests({
    testFiles: ['packages/alpha/test/smoke.test.ts'],
    evidence: evidenceOf({ root: 'node packages/alpha/test/smoke.test.ts' }),
  })
  assert.deepEqual(verdict.unwired, [])
})

test('an unreferenced file is reported even when another package has the same basename', () => {
  const verdict = findUnwiredTests({
    testFiles: ['packages/alpha/test/shared.test.ts', 'packages/beta/test/shared.test.ts'],
    evidence: evidenceOf({ packages: { alpha: 'node test/shared.test.ts', beta: 'node test/other.test.ts' } }),
  })
  assert.deepEqual(verdict.unwired, ['packages/beta/test/shared.test.ts'])
})

test('a repository-level test file needs a root reference, not a package reference', () => {
  const verdict = findUnwiredTests({
    testFiles: ['scripts/dev/gate.test.mjs'],
    evidence: evidenceOf({ root: 'node --test scripts/dev/other.test.mjs', packages: { alpha: 'gate.test.mjs' } }),
  })
  assert.deepEqual(verdict.unwired, ['scripts/dev/gate.test.mjs'])
})

test('an allowlisted file is accepted and reported separately', () => {
  const verdict = findUnwiredTests({
    testFiles: ['packages/alpha/test/parked.test.ts'],
    evidence: evidenceOf({ packages: { alpha: '' } }),
    allowlist: [{ path: 'packages/alpha/test/parked.test.ts', reason: 'driven by an external harness' }],
  })
  assert.deepEqual(verdict.unwired, [])
  assert.deepEqual(verdict.allowlisted, ['packages/alpha/test/parked.test.ts'])
})

test('the shipped allowlist stays empty unless a reviewer adds a justified entry', () => {
  for (const entry of UNWIRED_ALLOWLIST) {
    assert.ok(entry.reason.length >= 20, `${entry.path} needs a substantive reason`)
  }
})
