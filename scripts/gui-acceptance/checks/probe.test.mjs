/**
 * Unit lock for the `--live` probe's registry resolution.
 *
 * The MX sweep (MX-1/MX-2) reads the desktop connection registry to decide which
 * remote sources to probe. That registry lives at the Electron userData
 * convention — the wrong file as soon as `--plane` points at another instance
 * (the toolbox's own `--dev` instance, a packaged payload under test), which is
 * what `--registry` exists for. `resolveRegistryFile` is the pure rule
 * (explicit path wins, otherwise the platform convention) and
 * `configuredSourceIds` stays the only reader — id/kind only, so hosts and
 * credentials can never enter a report.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configuredSourceIds, registryPath, resolveRegistryFile } from './probe.mjs'

test('resolveRegistryFile prefers the explicit path and falls back to the desktop convention', () => {
  assert.equal(
    resolveRegistryFile({ registryFile: '/tmp/isolated/ssh-instances.json', env: {}, home: '/home/x' }),
    '/tmp/isolated/ssh-instances.json',
    'an explicit --registry names the file the probed instance owns',
  )
  // An empty/falsey override is the same as no override: the convention holds.
  assert.equal(resolveRegistryFile({ registryFile: '', env: {}, home: '/home/x' }), registryPath({}, '/home/x'))
  assert.equal(resolveRegistryFile({ env: {}, home: '/home/x' }), registryPath({}, '/home/x'))
})

test('configuredSourceIds reads only the given file, id/kind only, and never throws', () => {
  assert.deepEqual(
    configuredSourceIds(join(tmpdir(), 'dsh-gui-acceptance-registry-that-does-not-exist.json')),
    [],
    'a missing registry is an empty sweep (--live on a fresh state root)',
  )
  const dir = mkdtempSync(join(tmpdir(), 'gui-acceptance-registry-'))
  try {
    const file = join(dir, 'ssh-instances.json')
    writeFileSync(file, JSON.stringify([
      { id: 'a', kind: 'gateway', host: 'secret.example', user: 'root', password: 'never-reported' },
      { id: 'b', kind: 'ssh' },
      { id: '', kind: 'ssh' },
      null,
    ]))
    assert.deepEqual(configuredSourceIds(file), ['gateway-a', 'ssh-b'],
      'ids are <kind>-<id>, sorted; incomplete rows are skipped')
    writeFileSync(file, 'not json')
    assert.deepEqual(configuredSourceIds(file), [], 'a corrupt registry is an empty sweep, never a throw')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
