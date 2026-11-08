/**
 * Negative controls for the Swift test-corpus pin (run-swift-tests.mjs).
 *
 * The pin exists so that deleting, renaming or emptying a Swift test file can no
 * longer stay green — a failure mode that is silent by nature. Each criterion
 * therefore gets a direct control here (the corpus facts are injected, no real
 * files are touched), plus one check that the committed manifest still matches
 * the real macos/Tests tree.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeSwiftTestCorpus, swiftTestCorpusProblems } from './run-swift-tests.mjs'

const listed = [
  'macos/Tests/DSHChamberTests/AlphaTests.swift',
  'macos/Tests/DSHChamberTests/BetaTests.swift',
]
const corpus = (over = {}) => ({
  listed,
  onDisk: listed,
  testFunctions: () => 3,
  zeroAllowlist: [],
  ...over,
})

test('swift corpus pin: a clean corpus has no problems', () => {
  assert.deepEqual(swiftTestCorpusProblems(corpus()), [])
})

test('swift corpus pin: a listed file that vanished is red', () => {
  const problems = swiftTestCorpusProblems(corpus({ onDisk: [listed[0]] }))
  assert.ok(problems.some((p) => /but the file is gone/.test(p)), problems.join('\n'))
})

test('swift corpus pin: a listed file emptied of XCTest cases is red', () => {
  const problems = swiftTestCorpusProblems(corpus({ testFunctions: (file) => (file === listed[1] ? 0 : 3) }))
  // 被删空的登记文件会同时命中「登记文件无用例」与「盘上 *Tests.swift 无用例」两条判据。
  assert.ok(problems.some((p) => /listed but carries no XCTest case/.test(p)), problems.join('\n'))
})

test('swift corpus pin: an unlisted on-disk *Tests.swift with no case is red', () => {
  const problems = swiftTestCorpusProblems(corpus({
    onDisk: [...listed, 'macos/Tests/DSHChamberTests/GammaTests.swift'],
    testFunctions: (file) => (file.endsWith('GammaTests.swift') ? 0 : 3),
  }))
  assert.ok(problems.some((p) => /every on-disk \*Tests\.swift must keep at least one/.test(p)), problems.join('\n'))
})

test('swift corpus pin: a duplicate manifest entry is red', () => {
  const problems = swiftTestCorpusProblems(corpus({ listed: [listed[0], listed[0]] }))
  assert.ok(problems.some((p) => /lists .* twice/.test(p)), problems.join('\n'))
})

test('swift corpus pin: stale or reasonless allowlist entries are red', () => {
  const gone = swiftTestCorpusProblems(corpus({ zeroAllowlist: [{ file: 'macos/Tests/GoneTests.swift', reason: 'x' }] }))
  assert.match(gone.join('\n'), /the file is gone — drop the entry/)
  const recovered = swiftTestCorpusProblems(corpus({ zeroAllowlist: [{ file: listed[0], reason: 'x' }] }))
  assert.match(recovered.join('\n'), /it now carries cases — drop the stale entry/)
  const reasonless = swiftTestCorpusProblems(corpus({
    zeroAllowlist: [{ file: listed[0], reason: '' }],
    testFunctions: (file) => (file === listed[0] ? 0 : 3),
  }))
  assert.match(reasonless.join('\n'), /needs a reason/)
})

test('swift corpus pin: an empty corpus is red', () => {
  const problems = swiftTestCorpusProblems(corpus({ listed: [], onDisk: [], testFunctions: () => 0 }))
  assert.ok(problems.some((p) => /has no \.swift test file at all/.test(p)), problems.join('\n'))
})

test('swift corpus pin: the committed manifest matches the real macos/Tests tree', () => {
  const report = judgeSwiftTestCorpus()
  assert.ok(report !== null, 'macos/Tests must exist in this checkout')
  assert.deepEqual(report.problems, [], report.problems.join('\n'))
  assert.ok(report.files > 0, 'the on-disk corpus must not be empty')
  assert.ok(report.listed > 0, 'the committed manifest must not be empty')
})
