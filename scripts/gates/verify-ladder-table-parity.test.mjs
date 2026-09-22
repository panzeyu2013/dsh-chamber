/**
 * Unit lock for the ladder-table parity gate (G-G).
 *
 * The gate itself is a static step; this file proves its comparison can fail (a
 * negative control for the instrumentation), that a retired constant is quiet
 * rather than noisy, and that the object-field reader reads the real config
 * defaults. Without it, a gate whose comparison silently did nothing would read
 * as "every value is locked".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LOCKSTEP,
  compareLockstep,
  readConstant,
  readObjectField,
} from './verify-ladder-table-parity.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TABLES = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'dsh-stream-state', 'tables.json'), 'utf8'))

/** The gate's dotted-path semantics, re-applied to the already-parsed JSON. */
function readTable(path) {
  let node = TABLES
  for (const key of path.split('.')) {
    if (node === undefined || node === null || !(key in node)) return undefined
    node = node[key]
  }
  return node
}

const RESOLVE = {
  table: readTable,
  constant: readConstant,
  objectField: readObjectField,
}

test('the real lockstep list has no mismatch today', () => {
  const verdict = compareLockstep(LOCKSTEP, RESOLVE)
  assert.deepEqual(verdict.lines, [])
  assert.equal(verdict.failures, 0)
  assert.ok(LOCKSTEP.length >= 6, 'the guard list keeps the retired mobile copies: ' + String(LOCKSTEP.length))
  assert.equal(verdict.checked + verdict.retired, LOCKSTEP.length, 'every guard entry resolves as found or retired')
})

test('negative control: a wrong expectation is flagged', () => {
  const verdict = compareLockstep(
    [{
      table: 'tables.handshakeTimeoutMs',
      source: 'packages/dsh-stream-state/src/tables.ts',
      name: 'HANDSHAKE_TIMEOUT_MS',
    }],
    { ...RESOLVE, table: () => 1 },
  )
  assert.equal(verdict.failures, 1)
  assert.match(verdict.lines[0] ?? '', /HANDSHAKE_TIMEOUT_MS/)
})

test('retirement is quiet: a vanished declaration is not a failure', () => {
  const verdict = compareLockstep(
    [{ table: 'tables.silentTeardownMinMs', source: 'packages/dsh-stream-state/src/tables.ts', name: 'DEFINITELY_NOT_A_CONSTANT' }],
    { ...RESOLVE, table: () => 15000 },
  )
  assert.equal(verdict.failures, 0)
  assert.equal(verdict.retired, 1)
})

test('the object-field reader reads the real config defaults', () => {
  const field = readObjectField(
    'packages/dsh-stream-state/src/tables.ts',
    'PRESENTATION_THRESHOLDS',
    'surfaceMaxHoldMs',
  )
  assert.deepEqual(field, { state: 'found', value: 70000 })
  const missing = readObjectField(
    'packages/dsh-stream-state/src/tables.ts',
    'PRESENTATION_THRESHOLDS',
    'noSuchField',
  )
  assert.equal(missing.state, 'retired')
})
