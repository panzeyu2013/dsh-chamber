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
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectImports,
  deadExports,
  extractRuntimeExports,
  parseIndexModules,
  staleExemptions,
  testOnlyExports,
} from './verify-no-dead-exports.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('the gate self-test runs clean (exemption seams and retired write-face names have a negative control)', () => {
  // Without this the gate's own --self-test has no automated caller: ENTRYLESS_SEAMS and
  // RETIRED_PLUGIN_WRITE_FACE_NAMES would silently stop being exercised.
  const result = spawnSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'verify-no-dead-exports.mjs'), '--self-test'],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /no-dead-exports self-test: ok/)
})

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

test('V1: a test-only export needs a reason, and the entry goes stale once production imports it', () => {
  const modules = [{ package: 'pkg', file: 'packages/pkg/src/index.ts', names: ['pinnedConstant', 'usedInProd'] }]
  const production = new Set(['usedInProd'])
  const tests = new Set(['pinnedConstant', 'usedInProd'])
  const unallowed = testOnlyExports(modules, production, tests, [])
  assert.deepEqual(unallowed.unallowed, [
    { name: 'pinnedConstant', file: 'packages/pkg/src/index.ts', package: 'pkg' },
  ])
  assert.equal(unallowed.checked, 1, 'a production-imported export is never a test-only case')
  const allowed = testOnlyExports(modules, production, tests, [
    { package: 'pkg', name: 'pinnedConstant', reason: 'pin constant asserted by the suite' },
  ])
  assert.deepEqual(allowed.unallowed, [])
  assert.equal(allowed.stale.length, 0)
  // The export gains a production importer: the allowlist entry now lies.
  const landed = testOnlyExports(modules, new Set(['pinnedConstant', 'usedInProd']), tests, [
    { package: 'pkg', name: 'pinnedConstant', reason: 'pin constant asserted by the suite' },
  ])
  assert.equal(landed.stale.length, 1)
  // No test names it either: that is the plain dead-export path, not test-only.
  assert.equal(testOnlyExports(modules, production, new Set(['usedInProd']), []).checked, 0)
})

test('the real index and its modules parse into a non-trivial surface', () => {
  const indexText = readFileSync(join(REPO_ROOT, 'packages', 'dsh-stream-state', 'src', 'index.ts'), 'utf8')
  const modules = parseIndexModules(indexText)
  assert.ok(modules.length >= 10, 'the index must re-export every module: ' + String(modules.length))
  const names = modules.reduce((sum, entry) => {
    // The index has two re-export shapes: `export * from './x.ts'` (a string) and
    // `export { ... } from './x.ts'` (a named-entry object).
    const module = typeof entry === 'string' ? entry : entry.module
    const file = join(REPO_ROOT, 'packages', 'dsh-stream-state', 'src', module.replace(/^\.\//u, ''))
    return sum + (typeof entry === 'string'
      ? extractRuntimeExports(readFileSync(file, 'utf8')).length
      : entry.names.length)
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
