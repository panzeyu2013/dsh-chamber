/**
 * Local-connection lifecycle race tests: a health-probe
 * verdict landing during/after stop() must never resurrect the connection,
 * and a spawn failure landing after stop() must never flip stopped → error.
 * Pure-Node: injectable spawnDsh/probeHostIdentity, no real dsh.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createLocalConnection, isServiceableLocalState } from '../../src/local-connection.ts'
import { CATALOG_FILE, createCatalog } from '../../src/catalog.ts'
import { DEFAULT_DSH_START_PORT, DSH_WRITER_QUIESCENCE_UNKNOWN_CODE } from '../../src/spawn-dsh.ts'
import { logPathFor } from '../../src/host-logs.ts'
import type { ProbeIdentityFn, SpawnedDsh } from '../../src/local-connection.ts'
import { tempDir } from '../support/utils.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const healthyProbe: ProbeIdentityFn = async () => true

test('local connection carries one captured control-plane UUID into the spawn owner', async () => {
  const stateDir = tempDir()
  const ownerInstanceId = '55555555-5555-4555-8555-555555555555'
  let observedOwner: string | undefined
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    logger: silentLogger,
    options: { ownerInstanceId },
    deps: {
      spawnDsh: async options => {
        observedOwner = options.ownerInstanceId
        return {
          child: { on: () => {}, exitCode: null, signalCode: null },
          port: DEFAULT_DSH_START_PORT,
          stop: async () => {},
        }
      },
      probeHostIdentity: healthyProbe,
    },
  })
  try {
    await local.start()
    assert.equal(observedOwner, ownerInstanceId)
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('isServiceableLocalState: ready and degraded only (design 02 §3.5)', () => {
  assert.equal(isServiceableLocalState('ready'), true)
  assert.equal(isServiceableLocalState('degraded'), true)
  for (const state of ['starting', 'restarting', 'stopped', 'error', 'restart-exhausted']) {
    assert.equal(isServiceableLocalState(state), false, state)
  }
})

test('start() on degraded is idempotent: a serving child is never torn down', async () => {
  const stateDir = tempDir()
  let spawns = 0
  let stops = 0
  let probeCalls = 0
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return { child: { on: () => {}, exitCode: null }, port: DEFAULT_DSH_START_PORT, stop: async () => { stops += 1 } }
  }
  const probeHostIdentity: ProbeIdentityFn = async () => {
    probeCalls += 1
    if (probeCalls === 1) return true
    throw new Error('health probe failed')
  }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    logger: silentLogger,
    options: {
      healthIntervalMs: 25,
      healthProbeTimeoutMs: 500,
      healthResultCacheMs: 0,
      failureThrottleMs: 0,
      restartFailureThreshold: 100,
    },
    deps: { spawnDsh, probeHostIdentity },
  })
  try {
    await local.start()
    assert.equal(local.getState(), 'ready')
    await waitUntil(() => local.getState() === 'degraded')
    const before = spawns
    const portBefore = local.getDshPort()
    await local.start()
    assert.equal(spawns, before, 'degraded still serves; start() must not respawn it')
    assert.equal(stops, 0, 'the serving child must not be torn down (a no-op must not stop it)')
    assert.equal(local.getDshPort(), portBefore, 'the serving port must survive an idempotent start')
    assert.equal(local.hasLiveProcess(), true, 'the serving child stays alive')
    assert.equal(local.getState(), 'degraded')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

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
  const probeHostIdentity: ProbeIdentityFn = async (_baseUrl, options) => {
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
    logger: silentLogger,
    options: { healthIntervalMs: 25, healthProbeTimeoutMs: 500, healthResultCacheMs: 0 },
    deps: { spawnDsh, probeHostIdentity },
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
    logger: silentLogger,
    deps: { spawnDsh, probeHostIdentity: healthyProbe },
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
    await startPromise
    assert.equal(local.getState(), 'stopped', 'the late spawn failure must not flip the state to error')
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
    logger: silentLogger,
    deps: { spawnDsh, probeHostIdentity: healthyProbe },
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
    logger: silentLogger,
    deps: { spawnDsh, probeHostIdentity: healthyProbe },
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
    logger: { log: line => { logged.push(String(line)) }, warn() {}, error() {} },
    deps: { spawnDsh, probeHostIdentity: healthyProbe },
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

test('two local PlaneHandles keep independent runtime state without revising shared catalog metadata', async () => {
  const stateDir = tempDir()
  const catalog = createCatalog({ stateDir, logger: silentLogger })
  catalog.load()
  catalog.upsertConnection({
    connectionId: 'local',
    kind: 'local',
    label: 'Shared local dsh',
    accentColor: '#123456',
  })
  const catalogPath = join(stateDir, CATALOG_FILE)
  const before = readFileSync(catalogPath, 'utf8')

  const localA = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws-a'),
    logger: silentLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => ({
        child: { on: () => {}, exitCode: null },
        port: DEFAULT_DSH_START_PORT,
        stop: async () => {},
      }),
      probeHostIdentity: healthyProbe,
    },
  })
  const localB = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws-b'),
    logger: silentLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => ({
        child: { on: () => {}, exitCode: null },
        port: DEFAULT_DSH_START_PORT + 1,
        stop: async () => {},
      }),
      probeHostIdentity: healthyProbe,
    },
  })
  try {
    await localA.start()
    await localB.start()
    assert.equal(localA.getState(), 'ready')
    assert.equal(localB.getState(), 'ready')
    assert.equal(localA.getDshPort(), DEFAULT_DSH_START_PORT)
    assert.equal(localB.getDshPort(), DEFAULT_DSH_START_PORT + 1)

    await localA.stop()
    assert.equal(localA.getState(), 'stopped')
    assert.equal(localB.getState(), 'ready', 'one plane transition must not overwrite another plane state')
    assert.equal(readFileSync(catalogPath, 'utf8'), before, 'runtime transitions must not write catalog.json')
    assert.deepEqual(catalog.getConnection('local'), {
      connectionId: 'local',
      kind: 'local',
      label: 'Shared local dsh',
      accentColor: '#123456',
    })
    assert.equal(JSON.parse(before).revision, 1)
  } finally {
    await localA.stop().catch(() => {})
    await localB.stop().catch(() => {})
    assert.equal(readFileSync(catalogPath, 'utf8'), before)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// v2 A slice — exit proof: ONE reclamation primitive for every lifecycle leg.
// A retire is proven only when SpawnedDsh.stop() resolves (the spawn layer's process
// group proof); an unproven retire keeps a suspect and must propagate a coded failure.
// ---------------------------------------------------------------------------

/** A coded writer-quiescence-unknown error shaped like the spawn layer's. */
function codedWriterUnknown(pid: number, message = 'process group termination could not be proven'): Error & { code: string; pid: number } {
  return Object.assign(new Error(message), { code: DSH_WRITER_QUIESCENCE_UNKNOWN_CODE, pid })
}

function isCodedWriterUnknown(error: unknown): boolean {
  return (error as { code?: string }).code === DSH_WRITER_QUIESCENCE_UNKNOWN_CODE
}

/** A fake spawned child whose exit listener is captured and whose stop is scripted. */
function controllableChild(
  port: number,
  fields: { pid?: number; stop?: () => Promise<void>; signalCode?: string | null } = {},
): { spawned: SpawnedDsh; hook: { fire?: (code: number | null, sig: string | null) => void } } {
  const hook: { fire?: (code: number | null, sig: string | null) => void } = {}
  const spawned: SpawnedDsh = {
    child: {
      on: (event: string, listener: any) => { if (event === 'exit') hook.fire = listener },
      exitCode: null,
      signalCode: fields.signalCode ?? null,
    },
    port,
    ...(fields.pid === undefined ? {} : { pid: fields.pid }),
    stop: fields.stop ?? (async () => {}),
  }
  return { spawned, hook }
}

test('a signal-killed leader is still retired through the group proof before the next spawn', async () => {
  const stateDir = tempDir()
  const hooks: Array<{ fire?: (code: number | null, sig: string | null) => void }> = []
  let spawns = 0
  let stops = 0
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    // Leader observed signal-killed: its detached group may still hold PTY/plugin descendants.
    const { spawned, hook } = controllableChild(DEFAULT_DSH_START_PORT + spawns, {
      signalCode: spawns === 1 ? 'SIGKILL' : null,
      stop: async () => { stops += 1 },
    })
    hooks.push(hook)
    return spawned
  }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    logger: silentLogger,
    options: { healthIntervalMs: 0 },
    deps: { spawnDsh, probeHostIdentity: healthyProbe },
  })
  try {
    await local.start()
    assert.equal(local.getState(), 'ready')
    hooks[0]?.fire?.(null, 'SIGKILL')
    await waitUntil(() => spawns === 2 && local.getState() === 'ready')
    assert.equal(stops, 1, 'a signal-killed leader must be routed to terminateChild, never skipped')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a stale probe settling after the next generation is ready cannot degrade or count into it', async () => {
  const stateDir = tempDir()
  const hooks: Array<{ fire?: (code: number | null, sig: string | null) => void }> = []
  let spawns = 0
  let probeCalls = 0
  let rejectStaleProbe: ((error: Error) => void) | null = null
  const staleGate = new Promise<never>((_resolve, reject) => { rejectStaleProbe = reject })
  const probeHostIdentity: ProbeIdentityFn = async (_baseUrl, options) => {
    probeCalls += 1
    if (probeCalls === 1) {
      // First-generation probe is deliberately non-cooperative (ignores the abort) so the
      // test controls exactly when its stale verdict lands.
      await staleGate
      throw new Error('stale probe failure')
    }
    if (options?.generationSignal?.aborted) throw new Error('probe aborted by generation')
    return true
  }
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    const { spawned, hook } = controllableChild(DEFAULT_DSH_START_PORT + spawns)
    hooks.push(hook)
    return spawned
  }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    logger: silentLogger,
    options: { healthIntervalMs: 15, healthProbeTimeoutMs: 1000, healthResultCacheMs: 0, failureThrottleMs: 0 },
    deps: { spawnDsh, probeHostIdentity },
  })
  try {
    await local.start()
    await waitUntil(() => probeCalls === 1)
    hooks[0]?.fire?.(1, null)
    await waitUntil(() => spawns === 2 && local.getState() === 'ready')
    const callsAtReady = probeCalls
    rejectStaleProbe!(new Error('late probe failure'))
    await tick(80)
    assert.equal(local.getState(), 'ready', 'a stale verdict must not degrade the new generation')
    assert.equal(local.getConsecutiveFailures(), 0, 'a stale verdict must not be counted')
    assert.ok(probeCalls > callsAtReady, 'the new generation probes for real, never through a stale cache')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stop() surfaces an interleaved restart retire-unknown instead of folding it into resolve', async () => {
  const stateDir = tempDir()
  const coded = codedWriterUnknown(5151)
  let spawns = 0
  let stopCalls = 0
  let rejectFirstRetire: ((error: Error) => void) | null = null
  const firstRetireGate = new Promise<never>((_resolve, reject) => { rejectFirstRetire = reject })
  const first = controllableChild(DEFAULT_DSH_START_PORT, {
    pid: 5151,
    stop: async () => {
      stopCalls += 1
      if (stopCalls === 1) await firstRetireGate
      throw coded
    },
  })
  const second = controllableChild(DEFAULT_DSH_START_PORT + 1, { pid: 5152 })
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return spawns === 1 ? first.spawned : second.spawned
  }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    logger: silentLogger,
    options: { healthIntervalMs: 0 },
    deps: { spawnDsh, probeHostIdentity: healthyProbe },
  })
  try {
    await local.start()
    const restarting = local.restartLocal()
    await waitUntil(() => stopCalls === 1)
    const stopping = local.stop()
    await tick()
    rejectFirstRetire!(new Error('injected retire failure'))
    await assert.rejects(restarting, isCodedWriterUnknown, 'the restart leg must not fold unknown into resolve')
    await assert.rejects(stopping, isCodedWriterUnknown, 'stop must surface the unknown writer to its caller')
    assert.equal(local.getState(), 'error', 'an unproven writer keeps the machine out of stopped')
    assert.equal(local.hasLiveProcess(), true, 'the retained suspect counts as possibly alive')
    assert.equal(spawns, 1, 'no new generation was adopted')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stop() rejects a childless writer-unknown instead of taking the no-child fast path', async () => {
  const stateDir = tempDir()
  const coded = codedWriterUnknown(4242)
  const spawnDsh = async (): Promise<SpawnedDsh> => { throw coded }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    logger: silentLogger,
    deps: { spawnDsh, probeHostIdentity: healthyProbe },
  })
  try {
    await assert.rejects(local.start(), isCodedWriterUnknown)
    assert.equal(local.getState(), 'error')
    assert.equal(local.hasLiveProcess(), true, 'an unproven writer may still be alive')
    assert.equal(local.getWriterSuspect()?.pid, 4242, 'the coded pid becomes the diagnostic suspect')
    await assert.rejects(local.stop(), isCodedWriterUnknown)
    assert.equal(local.getState(), 'error', 'stop must never claim stopped with an unproven writer')
    assert.equal(local.hasLiveProcess(), true)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a restart-window exhaustion with an unproven retire lands on error, never restart-exhausted', async () => {
  const stateDir = tempDir()
  const hooks: Array<{ fire?: (code: number | null, sig: string | null) => void }> = []
  let spawns = 0
  let latchCalls = 0
  const coded = codedWriterUnknown(77002)
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    const { spawned, hook } = controllableChild(DEFAULT_DSH_START_PORT + spawns, {
      pid: 77000 + spawns,
      stop: spawns === 2 ? async () => { throw coded } : async () => {},
    })
    hooks.push(hook)
    return spawned
  }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    logger: silentLogger,
    options: {
      healthIntervalMs: 0,
      maxRestartsInWindow: 1,
      onWriterQuiescenceUnknown: () => { latchCalls += 1 },
    },
    deps: { spawnDsh, probeHostIdentity: healthyProbe },
  })
  try {
    await local.start()
    hooks[0]?.fire?.(1, null)
    await waitUntil(() => spawns === 2 && local.getState() === 'ready')
    hooks[1]?.fire?.(1, null)
    await waitUntil(() => local.getState() === 'error')
    assert.notEqual(local.getState(), 'restart-exhausted', 'restart-exhausted follows a PROVEN retire only')
    assert.equal(latchCalls, 1, 'the unknown latches the owning plane exactly once')
    assert.equal(spawns, 2, 'the unproven retire never respawns')
    assert.match(String(local.getStartFailure()), /restart the app to re-prove writer quiescence/,
      '/health has a sanitized terminal reason instead of a hanging starting state')
    await assert.rejects(local.start(), isCodedWriterUnknown)
    assert.equal(spawns, 2, 'a refused start never spawns behind an unproven writer')
    await assert.rejects(local.stop(), isCodedWriterUnknown)
    assert.equal(local.getState(), 'error')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a late exit of a retired child never triggers a restart on the current generation', async () => {
  const stateDir = tempDir()
  const hooks: Array<{ fire?: (code: number | null, sig: string | null) => void }> = []
  let spawns = 0
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    const { spawned, hook } = controllableChild(DEFAULT_DSH_START_PORT + spawns)
    hooks.push(hook)
    return spawned
  }
  const local = createLocalConnection({
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath: join(stateDir, 'ws'),
    logger: silentLogger,
    options: { healthIntervalMs: 0 },
    deps: { spawnDsh, probeHostIdentity: healthyProbe },
  })
  try {
    await local.start()
    await local.restartLocal()
    assert.equal(spawns, 2)
    assert.equal(local.getState(), 'ready')
    // The retired child's exit listener may still exist on a structural fake without off();
    // the generation check makes its late death inert.
    hooks[0]?.fire?.(1, null)
    await tick(30)
    assert.equal(spawns, 2, 'a superseded generation exit must never schedule a restart')
    assert.equal(local.getState(), 'ready')
  } finally {
    await local.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})
