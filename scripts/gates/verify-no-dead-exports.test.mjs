/**
 * Unit lock for the dead-export gate (G-H).
 *
 * The gate itself is a static step; this file is its negative control and its
 * parser guard: a fabricated module list with an orphan must be reported, an
 * exemption must silence exactly that orphan, a stale exemption must be flagged,
 * and the real index parser must see a non-trivial surface. Without this, a gate
 * whose resolver silently matched everything would read as a clean surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectImports,
  deadExports,
  extractRuntimeExports,
  parseIndexModules,
  staleExemptions,
} from './verify-no-dead-exports.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('negative control: an orphan export is reported, used ones are not', () => {
  const modules = [
    { file: 'src/a.ts', names: ['used', 'orphan'] },
    { file: 'src/b.ts', names: ['alsoUsed'] },
  ]
  const verdict = deadExports(modules, new Set(['used', 'alsoUsed']))
  assert.deepEqual(verdict.dead, [{ name: 'orphan', file: 'src/a.ts' }])
  assert.equal(verdict.checked, 3)
})

test('an exemption silences exactly the orphan, and a stale exemption is flagged', () => {
  const modules = [{ file: 'src/a.ts', names: ['used', 'orphan'] }]
  const exempted = deadExports(modules, new Set(['used']), [{ name: 'orphan', reason: 'scheduled' }])
  assert.deepEqual(exempted.dead, [])
  assert.deepEqual(staleExemptions(modules, new Set(['used', 'orphan']), [{ name: 'orphan', reason: 'scheduled' }]), [
    { name: 'orphan', reason: 'scheduled' },
  ])
})

test('the real index and its modules parse into a non-trivial surface', () => {
  const indexText = readFileSync(join(REPO_ROOT, 'packages', 'dsh-stream-state', 'src', 'index.ts'), 'utf8')
  const modules = parseIndexModules(indexText)
  assert.ok(modules.length >= 10, 'the index must re-export every module: ' + String(modules.length))
  const names = modules.reduce((sum, entry) => {
    const file = join(REPO_ROOT, 'packages', 'dsh-stream-state', 'src', String(entry).replace(/^\.\//u, ''))
    return sum + extractRuntimeExports(readFileSync(file, 'utf8')).length
  }, 0)
  assert.ok(names >= 30, 'the parsed runtime surface must be non-trivial: ' + String(names))
})

test('import parsing understands type-only and aliased named imports', () => {
  const imports = collectImports(
    "import { reduceCarrier, CARRIER_ENV as ENV, type CarrierState } from '@dsh-chamber/dsh-stream-state'\n" +
    "import type { SetLedgerView } from '@dsh-chamber/dsh-stream-state'\n",
  )
  assert.deepEqual(imports, [
    { source: '@dsh-chamber/dsh-stream-state', names: ['reduceCarrier', 'CARRIER_ENV', 'CarrierState'] },
    { source: '@dsh-chamber/dsh-stream-state', names: ['SetLedgerView'] },
  ])
})
