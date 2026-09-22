/**
 * /chamber/runtime registry, status projection and install/startup gates:
 * registry origin validation, offline caches, disk limits and status facts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import { recordRuntimeFailure, writeCurrentPointer } from '@dsh-chamber/dsh-runtime'
import {
  silentLogger,
  TEST_BUILTIN_VERSION,
  config,
  fakePlane,
  makeValidTree,
  writeOverrideRow,
  runtimeManager,
} from '../support/runtime-routes-harness.ts'

test('registry origin validation lives in the manager (bad origin rejected)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-registry-'))
  try {
    const manager = runtimeManager(stateDir, fakePlane())
    await assert.rejects(manager.setRegistry('not a url'), /invalid registry origin/)
    const good = await manager.setRegistry('https://registry.npmmirror.com')
    assert.equal(good.origin, 'https://registry.npmmirror.com')
    assert.equal(manager.getRegistry().origin, 'https://registry.npmmirror.com')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('corrupt registry configuration fails loud, preserves evidence, and never falls back to npmjs', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-registry-corrupt-'))
  try {
    const manager = runtimeManager(stateDir, fakePlane())
    assert.equal(manager.getRegistry().origin, 'https://registry.npmjs.org', 'only a genuinely missing file uses the default')
    const file = join(stateDir, 'dsh-runtime', 'registry.json')
    writeFileSync(file, '{broken-json', { mode: 0o600 })
    const projected = await manager.status()
    assert.equal(projected.registry, null)
    assert.match(projected.registryError ?? '', /corrupt/)
    assert.ok(!existsSync(file), 'the corrupt primary file is quarantined')
    const evidence = readdirSync(join(stateDir, 'dsh-runtime')).find(name => name.startsWith('registry.json.corrupt-'))
    assert.ok(evidence)
    assert.equal(readFileSync(join(stateDir, 'dsh-runtime', evidence!), 'utf8'), '{broken-json')
    assert.throws(() => manager.getRegistry(), /remains quarantined/,
      'quarantine evidence prevents a silent default on subsequent reads')
    assert.deepEqual(await manager.setRegistry('https://registry.npmmirror.com'), { origin: 'https://registry.npmmirror.com' })
    assert.equal(manager.getRegistry().origin, 'https://registry.npmmirror.com')
    assert.ok(existsSync(join(stateDir, 'dsh-runtime', evidence!)), 'recovery never destroys the preserved corrupt bytes')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('quarantining a hard-linked registry never chmods or rewrites the external inode', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-registry-hardlink-'))
  try {
    const manager = runtimeManager(stateDir, fakePlane())
    const external = join(stateDir, 'external-registry-bytes')
    writeFileSync(external, '{"origin":"https://registry.npmjs.org"}')
    chmodSync(external, 0o644)
    linkSync(external, join(stateDir, 'dsh-runtime', 'registry.json'))
    const status = await manager.status()
    assert.match(status.registryError ?? '', /corrupt/)
    assert.equal(readFileSync(external, 'utf8'), '{"origin":"https://registry.npmjs.org"}')
    assert.equal(statSync(external).mode & 0o777, 0o644,
      'quarantine must not chmod a multiply-linked inode outside its evidence entry')
    assert.ok(readdirSync(join(stateDir, 'dsh-runtime')).some(name => name.startsWith('registry.json.corrupt-')))
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('offline version listing retains every valid local cache tree', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-offline-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    let fetches = 0
    const manager = runtimeManager(stateDir, fakePlane(), {
      fetchMetadata: async () => { fetches += 1; throw new Error('registry offline') },
    })
    const result = await manager.listVersions() as {
      versions: Array<{ version: string; cached: boolean }>
      removableVersions: string[]
      removableVersionsError: string | null
      error: string
    }
    assert.match(result.error, /registry offline/)
    assert.deepEqual(
      result.versions.filter(entry => entry.version === '1.0.0' || entry.version === '2.0.0')
        .map(entry => [entry.version, entry.cached]),
      [['1.0.0', true], ['2.0.0', true]],
    )
    assert.equal(result.versions.find(entry => entry.version === TEST_BUILTIN_VERSION)?.cached, false,
      'the active builtin anchor stays visible but is not mislabeled as an installed cache tree')
    // 3.5 (2026-12 review): the removable-candidates read has its OWN projection
    // field, so a ledger read failure can never be read as "no candidates" (and
    // it stays distinguishable from the registry error above).
    assert.deepEqual(result.removableVersions, ['2.0.0', '1.0.0'],
      'every valid non-protected tree is a cleanup candidate, newest first')
    assert.equal(result.removableVersionsError, null, 'the healthy ledger projects no error')
    assert.equal((await manager.select(TEST_BUILTIN_VERSION)).accepted, true,
      'selecting the active builtin row is a no-op')
    assert.equal(fetches, 1, 'the builtin no-op never performs another offline registry request')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('fresh installs fail closed at the logical disk soft limit while cached versions remain selectable', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-quota-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const sparse = join(stateDir, 'dsh-runtime', '.pnpm-store', 'logical-10-gib')
    mkdirSync(dirname(sparse), { recursive: true })
    writeFileSync(sparse, '')
    truncateSync(sparse, 10 * 1024 ** 3)
    let fetches = 0
    const manager = runtimeManager(stateDir, fakePlane(), {
      fetchMetadata: async () => { fetches += 1; throw new Error('must not fetch above quota') },
    })
    await assert.rejects(manager.select('2.0.0'), (error: unknown) =>
      (error as { code?: string }).code === 'runtime_disk_limit')
    assert.equal(fetches, 0, 'quota is checked before registry/network work')
    assert.equal((await manager.select('1.0.0')).accepted, true,
      'cached recovery/switching remains available above the soft limit')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('status projects effective override selection plus snapshot, failure, and gateway-layout disk facts', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-status-full-'))
  try {
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '2.0.0')
    writeOverrideRow(stateDir, { chosenVersion: '2.0.0', pending: null, lastOutcome: 'applied', restoreOutcome: 'complete' })
    const snapshotAt = Date.now()
    const snapshotFile = join(stateDir, 'dsh-runtime', 'snapshots', `2.0.0-${snapshotAt}`, 'data')
    mkdirSync(dirname(snapshotFile), { recursive: true })
    writeFileSync(snapshotFile, 'snapshot-bytes')
    const restoreBackup = join(stateDir, 'dsh-home.old-123', 'data')
    mkdirSync(dirname(restoreBackup), { recursive: true })
    writeFileSync(restoreBackup, 'gateway-restore-backup')
    recordRuntimeFailure(stateDir, { version: '3.0.0', phase: 'install', error: 'registry install failed' })
    const manager = runtimeManager(stateDir, fakePlane())
    const status = await manager.status()
    assert.equal(status.kind, 'dsh-chamber-gateway-runtime')
    assert.equal(status.activeVersion, '2.0.0')
    assert.equal(status.builtinVersion, TEST_BUILTIN_VERSION)
    assert.equal(status.currentVersion, '2.0.0')
    assert.equal(status.selectedVersion, '2.0.0')
    assert.equal(status.hasOverride, true)
    assert.equal(status.source, 'user-selected')
    assert.equal(status.restoreOutcome, 'complete')
    assert.equal(status.snapshotCount, 1)
    assert.equal(status.latestSnapshotAt, new Date(snapshotAt).toISOString())
    assert.equal(status.snapshotError, null)
    assert.equal(status.restoreInProgress, false)
    assert.equal(status.preRollbackCount, 0)
    assert.equal(status.preRollbackLatestName, null)
    assert.equal(status.failure?.version, '3.0.0')
    assert.equal(status.failure?.reason, 'registry install failed')
    assert.ok((status.diskUsage?.snapshotBytes ?? 0) > 0)
    assert.ok((status.diskUsage?.restoreBackupBytes ?? 0) > 0,
      'gateway sibling dsh-home.old backups are included in disk accounting')
    assert.equal(status.diskError, null)
    assert.equal(status.diskLimitBytes, 10 * 1024 ** 3)
    assert.equal(status.diskLimitExceeded, false)
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('status reads the real version from an effective env workspace', async () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-status-env-'))
  const envAnchor = join(stateDir, 'env-anchor')
  try {
    const pkg = join(envAnchor, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '4.5.6' }))
    process.env.DSH_GATEWAY_DSH_PATH = envAnchor
    const manager = runtimeManager(stateDir, fakePlane())
    const status = await manager.status()
    assert.equal(status.activeVersion, '4.5.6')
    assert.equal(status.source, 'env')
    assert.equal(status.builtinVersion, TEST_BUILTIN_VERSION)
    await manager.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('registry source changes are fenced while an install is in flight', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-registry-fence-'))
  let rejectFetch!: (error: Error) => void
  try {
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      fetchMetadata: async () => new Promise((_, reject) => { rejectFetch = reject }),
    })
    const install = manager.select('2.0.0')
    assert.equal(manager.mutationInProgress(), true, 'the full install window is single-flight')
    assert.equal(manager.activationInProgress(), false, 'install must not quarantine the already-active runtime')
    const installing = await manager.status()
    assert.equal(installing.phase, 'installing')
    assert.equal(installing.connectionState, 'ready')
    assert.equal(installing.activeVersion, TEST_BUILTIN_VERSION, 'the current runtime stays authoritative while downloading')
    await assert.rejects(
      manager.setRegistry('https://registry.npmmirror.com'),
      (error: unknown) => (error as { code?: string }).code === 'runtime_busy',
    )
    rejectFetch(new Error('test install cancelled'))
    await assert.rejects(install, /test install cancelled/)
    assert.equal(manager.mutationInProgress(), false)
    assert.equal((await manager.status()).phase, 'idle')
    assert.equal(manager.getRegistry().origin, 'https://registry.npmjs.org')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('startup transaction with no pending switches nothing and does not block', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-startup-'))
  try {
    const manager = runtimeManager(stateDir, fakePlane())
    const result = await manager.startupTransaction()
    assert.equal(result.blockedReason, null)
    assert.equal((await manager.status()).phase, 'idle')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('select→apply semantics: apply without a selection rejects; rollback rejects an invalid target', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-semantics-'))
  try {
    const manager = runtimeManager(stateDir, fakePlane())
    await assert.rejects(manager.apply(), /no runtime version selected/)
    await assert.rejects(manager.rollback('9.9.9'), /no valid version tree/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
