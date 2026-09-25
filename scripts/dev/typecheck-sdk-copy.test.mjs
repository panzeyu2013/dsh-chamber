/**
 * The shared SDK-copy typecheck engine (scripts/dev/typecheck-sdk-copy.mjs).
 *
 * The two gate scripts it replaced had no tests: their diagnostic parsing and
 * the owned/vendor/unexpected split is exactly where a silently-wrong filter
 * would hide (filtering one path too many turns a real failure green).
 *
 * Run directly: node scripts/dev/typecheck-sdk-copy.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateProject, inside, parseTypecheckOutput } from './typecheck-sdk-copy.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const OWNED = join(ROOT, 'packages', 'dsh-client-connection')
const VENDOR = join(ROOT, 'vendor', 'harness-checkout', 'packages', 'dsh-session', 'src', 'index.ts')

test('inside(): a path is inside its own root, never inside a sibling with the same prefix', () => {
  assert.equal(inside(join(OWNED, 'src', 'a.ts'), OWNED), true)
  assert.equal(inside(OWNED, OWNED), true)
  assert.equal(inside(join(ROOT, 'packages', 'dsh-client-connection-extra', 'a.ts'), OWNED), false)
  assert.equal(inside(join(ROOT, 'packages', 'dsh-api-gateway', 'a.ts'), OWNED), false)
  assert.equal(inside('/somewhere/else.ts', OWNED), false)
})

test('parseTypecheckOutput(): diagnostics keep their continuation lines, other output is infrastructure', () => {
  const output = [
    'packages/dsh-client-connection/src/a.ts(3,7): error TS2322: Type is wrong.',
    '  Type \'string\' is not assignable to type \'number\'.',
    'vendor/harness-checkout/packages/dsh-session/src/index.ts(9,1): error TS2304: Cannot find name.',
    '',
    'error TS5058: The specified path does not exist.',
    'Some unrelated compiler line',
  ].join('\n')
  const { diagnostics, infrastructure } = parseTypecheckOutput(output)
  assert.equal(diagnostics.length, 3)
  assert.equal(diagnostics[0].path, join(OWNED, 'src', 'a.ts'))
  assert.equal(diagnostics[0].lines.length, 2)
  assert.equal(diagnostics[1].path, VENDOR)
  assert.equal(diagnostics[2].path, undefined)
  assert.deepEqual(infrastructure, ['Some unrelated compiler line'])
})

test('evaluateProject(): vendor diagnostics are filtered, everything owned is fatal', () => {
  const vendorOnly = evaluateProject({ status: 1, stdout: 'vendor/harness-checkout/x.ts(1,1): error TS1: v\n', stderr: '' }, OWNED)
  assert.equal(vendorOnly.crashed, false)
  assert.equal(vendorOnly.ok, true)
  assert.equal(vendorOnly.vendor.length, 1)
  assert.equal(vendorOnly.owned.length, 0)

  const owned = evaluateProject({ status: 1, stdout: '', stderr: 'packages/dsh-client-connection/src/a.ts(1,1): error TS1: o\n' }, OWNED)
  assert.equal(owned.ok, false)
  assert.equal(owned.owned.length, 1)
})

test('evaluateProject(): a non-crashed verdict carries diagnostics (red-path readers never TypeError)', () => {
  // runTypecheckProgram prints outcome.diagnostics on the non-zero/no-diagnostic
  // path; the non-crashed shape once omitted it, so a red gate crashed instead
  // of printing the compiler output.
  const vendorOnly = evaluateProject({ status: 1, stdout: 'vendor/harness-checkout/x.ts(1,1): error TS1: v\n', stderr: '' }, OWNED)
  assert.equal(vendorOnly.diagnostics.length, 1)
  const owned = evaluateProject({ status: 1, stdout: 'packages/dsh-client-connection/src/a.ts(1,1): error TS1: o\n', stderr: '' }, OWNED)
  assert.equal(owned.diagnostics.length, 1)
})

test('evaluateProject(): an unrelated path, a global diagnostic and infrastructure lines all fail the gate', () => {
  const unrelated = evaluateProject({ status: 1, stdout: 'packages/dsh-api-gateway/src/a.ts(1,1): error TS1: x\n', stderr: '' }, OWNED)
  assert.equal(unrelated.ok, false)
  assert.equal(unrelated.unexpected.length, 1)

  const global = evaluateProject({ status: 1, stdout: 'error TS5058: The specified path does not exist.\n', stderr: '' }, OWNED)
  assert.equal(global.ok, false)
  assert.equal(global.unexpected.length, 1)

  const infrastructure = evaluateProject({ status: 0, stdout: 'not a diagnostic\n', stderr: '' }, OWNED)
  assert.equal(infrastructure.ok, false)
  assert.deepEqual(infrastructure.infrastructure, ['not a diagnostic'])
})

test('evaluateProject(): a non-zero exit with no parsed diagnostic and a spawn crash both fail', () => {
  const silent = evaluateProject({ status: 2, stdout: '', stderr: '' }, OWNED)
  assert.equal(silent.ok, false)

  const crashed = evaluateProject({ status: null, error: new Error('ENOENT tsc'), signal: null, stdout: '', stderr: '' }, OWNED)
  assert.equal(crashed.crashed, true)
  assert.equal(crashed.ok, false)
  assert.match(crashed.reason.message, /ENOENT tsc/u)  // reason is the Error itself
})
