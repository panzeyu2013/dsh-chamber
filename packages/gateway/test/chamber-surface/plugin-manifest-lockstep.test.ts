/**
 * Cross-backend readManifest lockstep (design 21 §3 「单一定义」): the gateway
 * read projection must be exactly the wire read algorithm applied to the bytes
 * it acquired — parse (fault-classified) + the shared mask ruler — with no
 * gateway-local parse/version/mask re-implementation left.
 *
 * Run directly: node packages/gateway/test/chamber-surface/plugin-manifest-lockstep.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_MATERIALIZED_VALUE_MASK } from '@dsh-chamber/control-plane'
import {
  isMaterializedValue,
  maskMaterializedDependencies,
  parsePluginManifest,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
import { createChamberInstalled, INSTALLED_PROFILE_DIR, MATERIALIZED_VALUE_MASK } from '../../src/plugins-installed.ts'

const MANIFEST = JSON.stringify({
  dependencies: {
    'registry-pkg': '^2.1.0',
    'tilde-range': '~1.2.0',
    'file-pkg': 'file:../local-pkg',
    'case-pkg': 'FILE:/abs/local-pkg',
    'link-pkg': 'link:./local-pkg',
    'rel-pkg': '../sibling',
    'home-pkg': '~/home-pkg',
    'win-pkg': 'C:\\win-pkg',
    'dot-name': '.foo',
  },
  dsh: { profile: { bundles: ['registry-pkg', 5] } },
})

function scratch(t: { after(fn: () => void): void }): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-manifest-lockstep-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  mkdirSync(join(stateDir, 'dsh-home', INSTALLED_PROFILE_DIR), { recursive: true })
  writeFileSync(join(stateDir, 'dsh-home', INSTALLED_PROFILE_DIR, 'package.json'), MANIFEST)
  return stateDir
}

test('gateway projection === wire parse + wire mask, byte for byte', t => {
  const stateDir = scratch(t)
  const projection = createChamberInstalled(stateDir).read()
  assert.equal(projection.ok, true)
  if (!projection.ok) return
  const parsed = parsePluginManifest(MANIFEST)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(projection.dependencies, maskMaterializedDependencies(parsed.dependencies))
  // `bundles` is not projected; it feeds the SERVER-side role classifier — the wire
  // walk still decides the row role (a drop here would show up as third-party).
  assert.equal(projection.rows.find(row => row.name === 'registry-pkg')?.role, 'layer')
  // Spot-check the matrix through the shared ruler, not just by equality with
  // itself: registry values stay verbatim, every path form is masked.
  for (const name of ['registry-pkg', 'tilde-range', 'dot-name']) {
    assert.equal(projection.dependencies[name], parsed.dependencies[name], name)
  }
  for (const name of ['file-pkg', 'case-pkg', 'link-pkg', 'rel-pkg', 'home-pkg', 'win-pkg']) {
    assert.equal(projection.dependencies[name], MATERIALIZED_VALUE_MASK, name)
  }
  assert.equal(isMaterializedValue('C:\\win-pkg'), true)
})

test('gateway source consumes the wire face and keeps no local parse/mask/version branch', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/plugins-installed.ts', import.meta.url)), 'utf8')
  assert.match(source, /from '@dsh-chamber\/dsh-chamber-wire\/plugin-manifest'/, 'the read algorithm must be imported from the single source')
  assert.doesNotMatch(source, /function isMaskableValue/, 'the local masking predicate was replaced by the shared ruler')
  assert.doesNotMatch(source, /JSON\.parse\(text\)/, 'the local manifest parse was replaced by parsePluginManifest')
})

test('mask lockstep: wire === control-plane re-export === gateway export', () => {
  assert.equal(MATERIALIZED_VALUE_MASK, PLUGIN_MATERIALIZED_VALUE_MASK)
  assert.equal(PLUGIN_MATERIALIZED_VALUE_MASK, 'file:<hidden>')
})
