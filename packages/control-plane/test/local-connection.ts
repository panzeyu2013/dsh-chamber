/**
 * Local-connection lifecycle race tests (2026 audit H2/M13): a health-probe
 * verdict landing during/after stop() must never resurrect the connection,
 * a spawn failure landing after stop() must never flip stopped → error, and
 * a catalog persist failure must never block the in-memory state machine.
 * Pure-Node: injectable spawnDsh/describeCapabilities/catalog, no real dsh.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalConnection } from '../src/local-connection.ts'
import { DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'
import { logPathFor } from '../src/host-logs.ts'
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

test('H2: stop waits for a late spawn failure and must not publish error', async () => {
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
    const stopPromise = local.stop()
    await tick()
    // The aborted test seam is deliberately non-cooperative; stop waits for
    // its owner and the late failure remains inside the cancelled generation.
    rejectSpawn!(new Error('spawn failed (disk full)'))
    await stopPromise
    assert.equal(local.getState(), 'stopped')
    const row = await startPromise
    assert.equal(local.getState(), 'stopped', 'the late spawn failure must not flip the state to error')
    assert.equal(row?.connectionId, 'local')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('start → stop → start releases the cancelled first spawn and launches a fresh generation', async () => {
  const stateDir = tempDir()
  let spawns = 0
  const spawnDsh = async (options: { signal?: AbortSignal }): Promise<SpawnedDsh> => {
    spawns += 1
    if (spawns === 1) {
      await new Promise<never>((_resolve, reject) => {
        if (options.signal?.aborted) reject(new Error('spawn aborted'))
        else options.signal?.addEventListener('abort', () => reject(new Error('spawn aborted')), { once: true })
      })
    }
    return {
      child: { on: () => {}, exitCode: null, signalCode: null },
      port: DEFAULT_DSH_START_PORT,
      stop: async () => {},
    }
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
    const firstStart = local.start()
    await waitUntil(() => spawns === 1)
    await local.stop()
    await firstStart
    assert.equal(local.getState(), 'stopped')

    await local.start()
    assert.equal(spawns, 2, 'the second start must own a new spawn generation')
    assert.equal(local.getState(), 'ready')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stop waits for a non-cooperative old spawn to resolve and clean up its own child', async () => {
  const stateDir = tempDir()
  let spawns = 0
  let oldStops = 0
  let newStops = 0
  let resolveFirst: ((spawned: SpawnedDsh) => void) | null = null
  const firstGate = new Promise<SpawnedDsh>(resolve => { resolveFirst = resolve })
  const oldSpawn: SpawnedDsh = {
    child: { on: () => {}, exitCode: null, signalCode: null },
    port: DEFAULT_DSH_START_PORT + 1,
    stop: async () => { oldStops += 1 },
  }
  const newSpawn: SpawnedDsh = {
    child: { on: () => {}, exitCode: null, signalCode: null },
    port: DEFAULT_DSH_START_PORT + 2,
    stop: async () => { newStops += 1 },
  }
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return spawns === 1 ? firstGate : newSpawn
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
    const staleStart = local.start()
    await waitUntil(() => spawns === 1)
    const stopping = local.stop()
    // A truthful stop cannot complete until the owner of this unresolved
    // spawn has proved that no detached child remains.
    let stopSettled = false
    void stopping.finally(() => { stopSettled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(stopSettled, false)
    await assert.rejects(local.start(), /connection is stopping/)

    resolveFirst!(oldSpawn)
    await stopping
    await staleStart
    await local.start()
    assert.equal(local.getState(), 'ready')
    assert.equal(local.getDshPort(), newSpawn.port)

    assert.equal(oldStops, 1, 'the stale generation must terminate the child it produced')
    assert.equal(newStops, 0, 'the stale generation must not touch the fresh child')
    assert.equal(local.getState(), 'ready')
    assert.equal(local.getDshPort(), newSpawn.port)
    assert.equal(local.hasLiveProcess(), true)
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stop writes exactly one stopped lifecycle line to the managed-host log', async () => {
  const stateDir = tempDir()
  const logged: string[] = []
  const spawnDsh = async (): Promise<SpawnedDsh> => ({
    child: { on: () => {}, exitCode: null, signalCode: null },
    port: DEFAULT_DSH_START_PORT,
    stop: async () => {},
  })
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    catalog: fakeCatalog(),
    logger: { log: line => { logged.push(String(line)) }, warn() {}, error() {} },
    deps: { spawnDsh, describeCapabilities: healthyDescribe },
  })
  try {
    await local.start()
    await local.stop()
    await local.stop()
    const lines = readFileSync(logPathFor(stateDir, DEFAULT_DSH_START_PORT), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { line: string })
    assert.equal(
      lines.filter(entry => entry.line === '[control-plane] local connection → stopped').length,
      1,
    )
    assert.equal(logged.filter(line => line === 'local connection → stopped').length, 1)
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
