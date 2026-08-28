/**
 * Local-connection lifecycle race tests (2026 audit H2/M13): a health-probe
 * verdict landing during/after stop() must never resurrect the connection,
 * a spawn failure landing after stop() must never flip stopped → error, and
 * a catalog persist failure must never block the in-memory state machine.
 * Pure-Node: injectable spawnDsh/describeCapabilities/catalog, no real dsh.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalConnection } from '../src/local-connection.ts'
import { DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'
import type { CatalogLike, DescribeCapabilitiesFn, SpawnedDsh } from '../src/local-connection.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-local-conn-'))
}

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function fakeCatalog(): CatalogLike {
  return {
    getConnection: () => ({ connectionId: 'local' }),
    upsertConnection: () => {},
  }
}

const healthyDescribe: DescribeCapabilitiesFn = async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() })

test('H2: a health-probe failure landing during stop() never resurrects the connection', async () => {
  const stateDir = tempDir()
  let spawns = 0
  let probeStarted = false
  let rejectProbe: ((error: Error) => void) | null = null
  const probeGate = new Promise<never>((_resolve, reject) => { rejectProbe = reject })
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return { child: { on: () => {}, exitCode: null }, port: DEFAULT_DSH_START_PORT, stop: async () => {} }
  }
  const describeCapabilities: DescribeCapabilitiesFn = async (_baseUrl, options) => {
    // Honor the generation abort at entry; an already-in-flight probe stays
    // gated so the test controls exactly when the late verdict lands.
    if (options?.generationSignal?.aborted) throw new Error('probe aborted by generation')
    probeStarted = true
    await probeGate
    throw new Error('late probe failure')
  }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    catalog: fakeCatalog(),
    logger: silentLogger,
    options: { healthIntervalMs: 25, healthProbeTimeoutMs: 500, healthResultCacheMs: 0 },
    deps: { spawnDsh, describeCapabilities },
  })
  try {
    await local.start()
    assert.equal(local.getState(), 'ready')
    // The periodic probe is now in flight (gated).
    await waitUntil(() => probeStarted)
    // stop() aborts the generation AND waits for the in-flight verdict.
    const stopPromise = local.stop()
    await tick()
    rejectProbe!(new Error('late probe failure'))
    await stopPromise
    await tick(30)
    assert.equal(local.getState(), 'stopped', 'the late failure must not resurrect the connection')
    assert.equal(spawns, 1, 'no second spawn may happen after stop')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('H2: a spawn failure landing after stop() must not flip stopped → error', async () => {
  const stateDir = tempDir()
  let spawns = 0
  let rejectSpawn: ((error: Error) => void) | null = null
  const spawnGate = new Promise<never>((_resolve, reject) => { rejectSpawn = reject })
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    await spawnGate
    throw new Error('spawn failed (disk full)')
  }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    catalog: fakeCatalog(),
    logger: silentLogger,
    deps: { spawnDsh, describeCapabilities: healthyDescribe },
  })
  try {
    const startPromise = local.start()
    await waitUntil(() => spawns === 1)
    await local.stop()
    assert.equal(local.getState(), 'stopped')
    // The spawn now fails — AFTER stop() already completed and reset `stopping`.
    rejectSpawn!(new Error('spawn failed (disk full)'))
    const row = await startPromise
    assert.equal(local.getState(), 'stopped', 'the late spawn failure must not flip the state to error')
    assert.equal(row?.connectionId, 'local')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('M13: a catalog persist failure never blocks the state machine', async () => {
  const stateDir = tempDir()
  let persistFailures = 0
  const failingCatalog: CatalogLike = {
    getConnection: () => ({ connectionId: 'local' }),
    upsertConnection: () => {
      persistFailures += 1
      throw new Error('disk full')
    },
  }
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    return { child: { on: () => {}, exitCode: null }, port: DEFAULT_DSH_START_PORT, stop: async () => {} }
  }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    catalog: failingCatalog,
    logger: silentLogger,
    deps: { spawnDsh, describeCapabilities: healthyDescribe },
  })
  try {
    const row = await local.start()
    assert.equal(local.getState(), 'ready', 'the state machine advances despite the persist failure')
    assert.equal(row?.connectionId, 'local')
    assert.ok(persistFailures >= 2, 'persist failures happened and were swallowed (starting + ready)')
    await local.stop()
    assert.equal(local.getState(), 'stopped')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})
