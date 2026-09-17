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
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findSwiftTestScript,
  findUnwiredSwiftTests,
  findUnwiredTests,
  parseSwiftTestTargets,
  swiftWiringProblems,
  TEST_FILE_PATTERN,
  UNWIRED_ALLOWLIST,
} from './verify-test-wiring.mjs'

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

// ---------------------------------------------------------------------------
// macOS/Swift corpus (G24): Package.swift testTarget ↔ files ↔ gate entry
// ---------------------------------------------------------------------------

test('parseSwiftTestTargets: default Tests/<name> path and explicit path', () => {
  const targets = parseSwiftTestTargets(`
        .testTarget(
            name: "DSHChamberPocTests",
            dependencies: ["DSHChamberPoc"]
        ),
        .testTarget(
            name: "HelperTests",
            path: "Tests/Custom",
            dependencies: []
        )
`)
  assert.deepEqual(targets, [
    { name: 'DSHChamberPocTests', path: 'Tests/DSHChamberPocTests' },
    { name: 'HelperTests', path: 'Tests/Custom' },
  ])
  assert.deepEqual(parseSwiftTestTargets('no test targets here'), [])
})

test('findUnwiredSwiftTests: files outside the testTarget path or without func test* are unwired', () => {
  const targets = [{ name: 'T', path: 'macos/Tests/T' }]
  const files = {
    'macos/Tests/T/GoodTests.swift': 'final class GoodTests: XCTestCase {\n    func testA() {}\n}\n',
    'macos/Tests/T/Helper.swift': 'func helper() {}\n',
    'macos/Tests/Stray/StrayTests.swift': 'final class StrayTests: XCTestCase {\n    func testB() {}\n}\n',
  }
  const verdict = findUnwiredSwiftTests({
    testFiles: Object.keys(files),
    targets,
    readFile: file => files[file] ?? null,
  })
  assert.deepEqual(verdict.unwired, [
    {
      path: 'macos/Tests/T/Helper.swift',
      reason: 'no func test* declaration (XCTest would not discover it)',
    },
    {
      path: 'macos/Tests/Stray/StrayTests.swift',
      reason: 'not under a Package.swift testTarget path (never compiled)',
    },
  ])
  assert.equal(verdict.corpusSize, 3)
  assert.deepEqual(verdict.missingTargets, [])
})

test('findUnwiredSwiftTests: a declared testTarget with no files is reported (empty corpus)', () => {
  const verdict = findUnwiredSwiftTests({
    testFiles: ['macos/Tests/T/GoodTests.swift'],
    targets: [{ name: 'T', path: 'macos/Tests/T' }, { name: 'Gone', path: 'macos/Tests/Gone' }],
    readFile: () => 'func testA() {}',
  })
  assert.deepEqual(verdict.missingTargets, ['macos/Tests/Gone'])
})

test('findUnwiredSwiftTests: an allowlisted helper without func test* stays accepted', () => {
  const verdict = findUnwiredSwiftTests({
    testFiles: ['macos/Tests/T/Helper.swift'],
    targets: [{ name: 'T', path: 'macos/Tests/T' }],
    readFile: () => 'func helper() {}',
    allowlist: [{ path: 'macos/Tests/T/Helper.swift', reason: 'shared XCTest fixture, driven by GoodTests.swift' }],
  })
  assert.deepEqual(verdict.unwired, [])
  assert.deepEqual(verdict.allowlisted, ['macos/Tests/T/Helper.swift'])
})

test('findSwiftTestScript + swiftWiringProblems: manifest ↔ run-checks lockstep', () => {
  const script = findSwiftTestScript({ scripts: { 'test:swift': 'node scripts/gates/run-swift-tests.mjs' } })
  assert.deepEqual(script, { name: 'test:swift', command: 'node scripts/gates/run-swift-tests.mjs' })
  assert.equal(findSwiftTestScript({ scripts: { test: 'node x.test.mjs' } }), null)
  assert.deepEqual(swiftWiringProblems({ script, runChecksText: "const MACOS_CHECKS = ['test:swift']" }), [])
  assert.match(
    swiftWiringProblems({ script: null, runChecksText: '' })[0],
    /root package.json has no script that runs the Swift suite/,
  )
  assert.match(
    swiftWiringProblems({ script, runChecksText: "['test:other']" })[0],
    /does not reference the Swift-suite script 'test:swift'/,
  )
})

test('the shipped Swift corpus, manifest script and gate entry stay in lockstep', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const script = findSwiftTestScript(manifest)
  assert.ok(script !== null, 'root package.json must expose a swift test script')
  assert.deepEqual(
    swiftWiringProblems({
      script,
      runChecksText: readFileSync(join(repoRoot, 'scripts/gates/run-checks.mjs'), 'utf8'),
    }),
    [],
  )
  const targets = parseSwiftTestTargets(readFileSync(join(repoRoot, 'macos/Package.swift'), 'utf8'))
  assert.deepEqual(targets.map(target => target.name), ['DSHChamberPocTests'])
})
