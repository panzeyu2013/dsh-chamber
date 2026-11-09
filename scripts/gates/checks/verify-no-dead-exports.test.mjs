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
  CLIENT_SEAM_SKIPS,
  RUNTIME_LOADED_CLIENT_SEAMS,
  clientSeamCoverage,
  clientSeamVerdict,
  collectImports,
  deadExports,
  discoverClientPlugins,
  extractRuntimeExports,
  parseIndexModules,
  staleExemptions,
  testOnlyExports,
} from './verify-no-dead-exports.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

test('the gate self-test runs clean (exemption seams and retired write-face names have a negative control)', () => {
  // Without this the gate's own --self-test has no automated caller: ENTRYLESS_SEAMS and
  // RETIRED_PLUGIN_WRITE_FACE_NAMES would silently stop being exercised.
  const result = spawnSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), './verify-no-dead-exports.mjs'), '--self-test'],
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

test('parse: type-only re-export faces are erased, value re-exports and modules stay judged', () => {
  const parsed = parseIndexModules(
    "export * from './star.ts'\n" +
    "export { used, type Face } from './value.ts'\n" +
    "export type { OnlyType } from './type.ts'\n",
  )
  assert.equal(parsed.length, 3)
  assert.deepEqual(parsed[1], { module: './value.ts', names: ['used'] })
  // The type-only group keeps its module so a missing target is still red, but
  // declares no runtime name the gate could judge.
  assert.deepEqual(parsed[2], { module: './type.ts', names: [] })
})

test('client seams: an unimported public export is reported, the registered ABI names are exempt, a stale ABI entry is flagged', () => {
  const entry = [{ package: 'pkg', file: 'packages/pkg/src/client/index.ts', names: ['apply', 'inject', 'used', 'orphan'] }]
  const subpaths = [{ package: 'pkg', file: 'packages/pkg/src/client/extra.ts', names: ['subUsed', 'subOrphan'] }]
  const verdict = clientSeamVerdict(entry, subpaths, new Set(['used', 'subUsed']), ['apply', 'inject'])
  assert.deepEqual(verdict.dead.map((item) => item.name).sort(), ['orphan', 'subOrphan'])
  assert.equal(verdict.checked, 6)
  assert.deepEqual(verdict.staleAbi, [])
  // The loader ABI names have no static importer by design; an ABI name that gains
  // one (or leaves the client entry) means the exemption no longer holds.
  assert.deepEqual(clientSeamVerdict(entry, subpaths, new Set(['used', 'subUsed', 'apply']), ['apply', 'inject']).staleAbi, ['apply'])
  assert.deepEqual(clientSeamVerdict(entry, subpaths, new Set(['used', 'subUsed', 'apply', 'inject']), ['missing']).staleAbi, ['missing'])
})

test('client seams: coverage reports an unregistered plugin, a zombie row and a judged+skipped conflict', () => {
  const discovered = [{ name: 'judged' }, { name: 'skipped' }, { name: 'newcomer' }]
  const coverage = clientSeamCoverage(
    discovered,
    [{ package: 'judged', reason: 'registered', abi: ['apply'] }, { package: 'gone', reason: 'stale', abi: ['apply'] }],
    { skipped: 'recorded skip reason' },
  )
  assert.deepEqual(coverage.unregistered, ['newcomer'])
  assert.deepEqual(coverage.zombies, ['gone'])
  assert.deepEqual(coverage.conflicts, [])
  assert.deepEqual(clientSeamCoverage(discovered, [{ package: 'skipped', reason: 'x', abi: [] }], { skipped: 'both' }).conflicts, ['skipped'])
  // A manifest that declares dsh.client without a resolvable ./client export is a
  // broken convention, not a coverable seam: it must not be forced into the table.
  const broken = [{ name: 'broken', clientEntry: null }, { name: 'judged', clientEntry: '/x/src/client/index.ts' }]
  const brokenCoverage = clientSeamCoverage(broken, [{ package: 'judged', reason: 'x', abi: [] }, { package: 'broken', reason: 'x', abi: [] }], {})
  assert.deepEqual(brokenCoverage.unregistered, [])
  assert.deepEqual(brokenCoverage.zombies, ['broken'])
})

test('the real client-plugin discovery is covered by the seam table', () => {
  const discovered = discoverClientPlugins()
  assert.ok(discovered.length >= 8, 'the discovery must find every client-plugin package: ' + String(discovered.length))
  for (const plugin of discovered) {
    assert.ok(plugin.clientEntry.startsWith(plugin.dir + '/'), plugin.name + ': the ./client export must resolve inside the package')
    assert.ok(plugin.subpaths.every((entry) => entry.subpath.startsWith('./') && entry.file.startsWith(plugin.dir + '/')), plugin.name + ': subpaths are package-relative source entries')
  }
  const judged = new Set(RUNTIME_LOADED_CLIENT_SEAMS.map((entry) => entry.package))
  for (const plugin of discovered.filter((entry) => judged.has(entry.name))) {
    assert.ok(plugin.clientEntry.endsWith('/client/index.ts'), plugin.name + ': a judged seam is a source entry (src/client/index.ts)')
    assert.ok(!(plugin.name in CLIENT_SEAM_SKIPS), plugin.name + ': one row must own the package')
  }
  const coverage = clientSeamCoverage(discovered)
  assert.deepEqual(coverage.unregistered, [], 'a client-plugin package without a seam row would be silently unjudged')
  assert.deepEqual(coverage.zombies, [], 'a seam row that no longer matches a package is a stale exemption')
  assert.deepEqual(coverage.conflicts, [])
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
