/**
 * Unit tests for the workflow YAML scalar gate.
 *
 * The gate exists because the other workflow checks read text: it has to reject
 * the plain scalar that GitHub's parser rejects, and accept the neighbouring
 * shapes that are perfectly legal (quoted values, block scalars, comments).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findInvalidPlainScalars, workflowFiles } from './verify-workflow-yaml-scalars.mjs'
test('a colon+space inside a step name is reported', () => {
  const findings = findInvalidPlainScalars('      - name: Package unit tests (single entry: runtime / desktop)\n')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].key, 'name')
  assert.match(findings[0].reason, /colon \+ space/u)
})
test('a run value with an unquoted colon+space is reported', () => {
  const findings = findInvalidPlainScalars('        run: echo hello: world\n')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].key, 'run')
})
test('quoted values, block scalars and comments are accepted', () => {
  const text = [
    '      - name: "Single entry: runtime"',
    "      - name: 'Single entry: quoted'",
    '        run: |',
    '          echo hello: world',
    '      # a comment with a colon: inside is not a value',
    '        if: steps.classify.outputs.code == \'true\'',
  ].join('\n')
  assert.deepEqual(findInvalidPlainScalars(text), [])
})
test('a value ending with a colon is reported', () => {
  const findings = findInvalidPlainScalars('        with:\n')
  assert.deepEqual(findings, [])
  const dangling = findInvalidPlainScalars('        shell: bash:\n')
  assert.equal(dangling.length, 1)
  assert.match(dangling[0].reason, /ends with/u)
})
test('the repository workflows expose at least the two edited files', () => {
  const names = workflowFiles().map(path => path.split('/').pop())
  assert.ok(names.includes('ci.yml'))
  assert.ok(names.includes('release.yml'))
})
