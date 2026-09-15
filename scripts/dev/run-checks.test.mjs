/**
 * Unit tests for the single gate entry.
 *
 * The runner's failure modes are quiet ones: an unknown mode that exits 0, a
 * mode whose steps vanished during a rename, or a `--list` call that executes
 * something anyway. Each is pinned here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODES, pnpmInvocation, requestedMode, runMode } from './run-checks.mjs'

test('every mode resolves to at least one step', () => {
  for (const [mode, steps] of Object.entries(MODES)) {
    assert.ok(steps.length > 0, `${mode} must list at least one step`)
  }
})

test('no mode lists the same step twice', () => {
  for (const [mode, steps] of Object.entries(MODES)) {
    assert.equal(new Set(steps).size, steps.length, `${mode} repeats a step`)
  }
})

test('mode names are recognised and unknown names are rejected', () => {
  assert.equal(requestedMode(['tests']), 'tests')
  assert.equal(requestedMode(['--list', 'static']), 'static')
  assert.equal(requestedMode(['nonsense']), undefined)
  assert.equal(requestedMode(['--list']), undefined)
})

test('an unknown mode reports a failure instead of a silent pass', () => {
  const { failed, ran } = runMode('nope', { log: () => {} })
  assert.deepEqual(failed, ['mode nope has no steps'])
  assert.equal(ran, 0)
})

test('listing a mode runs nothing', () => {
  const lines = []
  const { failed, ran } = runMode('static', { list: true, log: line => lines.push(line) })
  assert.deepEqual(failed, [])
  assert.equal(ran, 0)
  assert.equal(lines.length, MODES.static.length + 1)
})

test('the pnpm invocation always names an executable', () => {
  const invocation = pnpmInvocation()
  assert.ok(invocation.command.length > 0)
  assert.ok(Array.isArray(invocation.prefix))
})

test('the full mode is the union of the narrower modes', () => {
  const union = new Set([...MODES.static, ...MODES.typecheck, ...MODES.tests])
  for (const step of union) assert.ok(MODES.full.includes(step), `full is missing ${step}`)
})
