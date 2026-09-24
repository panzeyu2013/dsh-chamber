/**
 * Unit lock for the god-file budget gate (G-B): negative controls for the
 * schema guard, the ratchet classifier and the CLI parser, plus a real-repo
 * check that the ratified table validates and currently classifies as exact.
 * Without this, a malformed entry (a missing \`lines\`) would read as "no
 * violation" and the ratchet would silently stop ratcheting.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyEntry, parseArgs, validateBudget } from './verify-file-budgets.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('a malformed entry is rejected instead of silently passing', () => {
  assert.deepEqual(validateBudget({ files: [{ path: 'a.ts', lines: 1, target: 0 }] }), [])
  const malformed = [
    { files: [{ path: 'a.ts', target: 0 }] },
    { files: [{ path: 'a.ts', lines: -1, target: 0 }] },
    { files: [{ path: 'a.ts', lines: 1.5, target: 0 }] },
    { files: [{ path: 'a.ts', lines: Number.NaN, target: 0 }] },
    { files: [{ path: 'a.ts', lines: 1, target: -1 }] },
    { files: [{ path: '', lines: 1, target: 0 }] },
    { files: [{ path: 'a.ts', lines: 1, target: 0 }, { path: 'a.ts', lines: 1, target: 0 }] },
    { files: 'nope' },
    { nope: true },
  ]
  for (const bad of malformed) {
    assert.ok(validateBudget(bad).length > 0, 'a malformed table must not validate: ' + JSON.stringify(bad))
  }
})

test('the ratchet classifier names every failure mode', () => {
  const entry = { path: 'a.ts', lines: 10, target: 4 }
  assert.equal(classifyEntry(entry, 11), 'grow')
  assert.equal(classifyEntry(entry, 10), 'ok')
  assert.equal(classifyEntry(entry, 9), 'shrink')
  assert.equal(classifyEntry(entry, null), 'missing')
})

test('an unknown argument is a usage error, never ignored', () => {
  assert.throws(() => parseArgs(['--self-test', '--nope']), /unknown argument/)
  assert.equal(parseArgs(['--report']).report, true)
  assert.equal(parseArgs([]).update, false)
})

test('the real ratified table validates and is exactly current', () => {
  const budget = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts/gates/file-budgets.json'), 'utf8'))
  assert.deepEqual(validateBudget(budget), [])
  for (const entry of budget.files) {
    const text = readFileSync(resolve(REPO_ROOT, entry.path), 'utf8')
    const actual = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    assert.equal(classifyEntry(entry, actual), 'ok', entry.path + ': run --update-budget in the same change that shrinks it')
  }
})
