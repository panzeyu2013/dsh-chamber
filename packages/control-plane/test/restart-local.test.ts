/**
 * restartLocal() transactional-restart tests (design 18 §9.3): the
 * user-triggered "restart dsh" primitive on the local connection adapter and
 * on PlaneHandle. No real dsh and no fixed ports — the spawn/describe wire is
 * mocked exactly like protocol.ts. Coverage:
 *
 * - user restart + automatic (health) restart share one single-flight spawn;
 * - a successful user restart clears the shared failure counter (degraded →
 *   ready);
 * - a second restartLocal during an in-flight restart returns the same promise;
 * - a failed user restart counts into the shared restart-exhausted window;
 * - a closed runtime gate (canStartLocal / canSpawn) rejects without spawning;
 * - restartLocal vs stop(): one rejects / the other waits, final state is
 *   consistent and nothing leaks;
 * - design 18 addendum D2 / test plan 8.2 (apply-now desktop host): the
 *   stopping window never treats a process death as "restart me" (R3 health
 *   interleave), a closed canSpawn gate rejects start()/restartLocal from
 *   stopped, and the shared restart window counts only triggerRestart —
 *   start() never consumes it, stop()/start() clears it, M=5 health restarts
 *   exhaust, and recovery is start().
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalConnection } from '../src/local-connection.ts'
import type { SpawnedDsh } from '../src/local-connection.ts'
import { createControlPlane } from '../src/index.ts'

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} }

/** A describe mock: healthy by default; `state.healthy` toggles failures. */
function mockDescribe() {
  const state = { healthy: true }
  return {
    state,
    describeCapabilities: async () => {
      if (!state.healthy) throw new Error('mock describe failure')
      return { value: { attachedSessions: 0 }, cachedAt: Date.now() }
    },
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => unknown, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${what} (${timeoutMs}ms)`)
}

/** A ready child on a fixed port; the exit listener is captured for death injection. */
function controllableChild(port: number, exitHook: { fire?: (code: number | null, sig: string | null) => void }): SpawnedDsh {
  return {
    child: {
      on: (event: string, listener: any) => {
        if (event === 'exit') exitHook.fire = listener
      },
      exitCode: null as number | null,
    },
    port,
    stop: async () => {},
  }
}

test('restartLocal merges into an in-flight automatic restart (single spawn, no stacking)', async () => {
  let spawnCalls = 0
  let announceRestart!: () => void
  let releaseRestart!: () => void
  const restartEntered = new Promise<void>(resolve => { announceRestart = resolve })
  const restartRelease = new Promise<void>(resolve => { releaseRestart = resolve })
  const exitHook: { fire?: (code: number | null, sig: string | null) => void } = {}

  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        if (spawnCalls === 1) return controllableChild(18001, exitHook)
        return { child: { on: () => {}, exitCode: null }, port: 18002, stop: async () => {} }
      },
      beforeSpawnCheckpoint: async (kind) => {
        if (kind === 'restart') {
          announceRestart()
          await restartRelease
        }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })

  try {
    await connection.start()
    assert.equal(connection.getState(), 'ready')

    // Process death → automatic restart enters the single-flight.
    exitHook.fire?.(1, null)
    await restartEntered
    assert.equal(connection.getState(), 'restarting')

    // A user restart during the automatic restart merges (no second respawn).
    const merged = connection.restartLocal()
    releaseRestart()
    await merged
    await waitFor(() => connection.getState() === 'ready', 3000, 'ready after merged restart')
    assert.equal(spawnCalls, 2, 'start + exactly one restart respawn')
  } finally {
    releaseRestart?.()
    await connection.stop()
  }
})

test('an automatic restart trigger suspends while a user restart is in flight (single spawn)', async () => {
  let spawnCalls = 0
  let announceRestart!: () => void
  let releaseRestart!: () => void
  const restartEntered = new Promise<void>(resolve => { announceRestart = resolve })
  const restartRelease = new Promise<void>(resolve => { releaseRestart = resolve })
  const exitHook: { fire?: (code: number | null, sig: string | null) => void } = {}

  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        if (spawnCalls === 1) return controllableChild(18101, exitHook)
        return { child: { on: () => {}, exitCode: null }, port: 18102, stop: async () => {} }
      },
      beforeSpawnCheckpoint: async (kind) => {
        if (kind === 'restart') {
          announceRestart()
          await restartRelease
        }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })

  try {
    await connection.start()
    const pending = connection.restartLocal()
    await restartEntered
    assert.equal(connection.getState(), 'restarting')

    // The automatic trigger (child exit) during the user restart is suppressed.
    exitHook.fire?.(1, null)
    releaseRestart()
    await pending
    await waitFor(() => connection.getState() === 'ready', 3000, 'ready after user restart')
    assert.equal(spawnCalls, 2, 'start + exactly one user-restart respawn; the automatic trigger did not stack')
  } finally {
    releaseRestart?.()
    await connection.stop()
  }
})

test('a successful user restart clears the failure counter (degraded → ready)', async () => {
  const describe = mockDescribe()
  let spawnCalls = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 100, healthProbeTimeoutMs: 1000, restartFailureThreshold: 100, failureThrottleMs: 0 },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        return { child: { on: () => {}, exitCode: null }, port: 18200 + spawnCalls, stop: async () => {} }
      },
      describeCapabilities: describe.describeCapabilities,
    },
  })

  try {
    await connection.start()
    assert.equal(connection.getState(), 'ready')

    // Drive one probe failure → degraded with a non-zero shared counter.
    describe.state.healthy = false
    await waitFor(() => connection.getState() === 'degraded', 3000, 'degraded state')
    assert.ok(connection.getConsecutiveFailures() >= 1, 'failure counter advanced')

    // A user restart clears the counter and returns to ready.
    describe.state.healthy = true
    const before = spawnCalls
    await connection.restartLocal()
    assert.equal(connection.getState(), 'ready')
    assert.equal(connection.getConsecutiveFailures(), 0)
    assert.ok(spawnCalls > before, 'a restart respawned the host')
  } finally {
    await connection.stop()
  }
})

test('a second restartLocal during an in-flight restart shares the same promise', async () => {
  let announceRestart!: () => void
  let releaseRestart!: () => void
  const restartEntered = new Promise<void>(resolve => { announceRestart = resolve })
  const restartRelease = new Promise<void>(resolve => { releaseRestart = resolve })
  let spawnCalls = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        return { child: { on: () => {}, exitCode: null }, port: 18300 + spawnCalls, stop: async () => {} }
      },
      beforeSpawnCheckpoint: async (kind) => {
        if (kind === 'restart') {
          announceRestart()
          await restartRelease
        }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })

  try {
    await connection.start()
    const first = connection.restartLocal()
    await restartEntered
    const second = connection.restartLocal()
    assert.equal(second, first, 'the second call returns the in-flight single-flight promise')
    releaseRestart()
    await first
    await second
    assert.equal(connection.getState(), 'ready')
    assert.equal(spawnCalls, 2, 'start + exactly one restart respawn')
  } finally {
    releaseRestart?.()
    await connection.stop()
  }
})

test('a failed user restart counts into the shared restart-exhausted window', async () => {
  let spawnCalls = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: {
      healthIntervalMs: 0,
      restartBackoffFloorMs: 5,
      restartBackoffCeilMs: 10,
      restartWindowMs: 60_000,
      maxRestartsInWindow: 3,
    },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        if (spawnCalls === 1) return { child: { on: () => {}, exitCode: null }, port: 18400, stop: async () => {} }
        throw new Error('injected restart spawn failure')
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })

  try {
    await connection.start()
    await connection.restartLocal()
    assert.equal(connection.getState(), 'restart-exhausted')
    assert.ok(spawnCalls >= 4, `start plus three failed restart attempts (saw ${spawnCalls})`)
  } finally {
    await connection.stop()
  }
})

test('restartLocal rejects under a closed spawn gate without spawning', async () => {
  let spawns = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { canSpawn: () => ({ ok: false, reason: 'applying dsh vY' }) },
    deps: {
      spawnDsh: async () => {
        spawns += 1
        return { child: { on: () => {}, exitCode: null }, port: 18500, stop: async () => {} }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })

  await assert.rejects(connection.restartLocal(), (error: unknown) =>
    (error as Error & { code?: string }).code === 'connection_busy'
    && /applying dsh vY/.test(String(error)))
  assert.equal(spawns, 0, 'no spawn behind a closed gate')
  assert.equal(connection.getState(), 'stopped')
  await connection.stop()
})

test('restartLocal rejects during an in-progress stop; final state stays stopped', async () => {
  let stopRelease!: () => void
  const stopGate = new Promise<void>(resolve => { stopRelease = resolve })
  let stopCalls = 0
  const child = {
    child: { on: () => {}, exitCode: null as number | null },
    port: 18600,
    stop: async () => { stopCalls += 1; await stopGate },
  }
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    deps: {
      spawnDsh: async () => child,
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })

  try {
    await connection.start()
    const pendingStop = connection.stop()
    await assert.rejects(connection.restartLocal(), (error: unknown) =>
      (error as Error & { code?: string }).code === 'connection_busy'
      && /invalidated by stop/.test(String(error)))
    stopRelease()
    await pendingStop
    assert.equal(connection.getState(), 'stopped')
    assert.equal(connection.hasLiveProcess(), false)
    // stop() runs its initial stop plus the defensive second look (both see
    // the still-alive child), so the terminator runs more than once.
    assert.ok(stopCalls >= 1, 'the child was stopped')
  } finally {
    stopRelease?.()
    await connection.stop()
  }
})

test('stop() reclaims an in-flight user restart without leaking a process', async () => {
  let announceRestart!: () => void
  let releaseRestartSpawn!: (spawned: SpawnedDsh) => void
  const restartEntered = new Promise<void>(resolve => { announceRestart = resolve })
  const restartSpawnRelease = new Promise<SpawnedDsh>(resolve => { releaseRestartSpawn = resolve })
  let spawnCalls = 0
  let staleStops = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        if (spawnCalls === 1) return { child: { on: () => {}, exitCode: null }, port: 18700, stop: async () => {} }
        announceRestart()
        return restartSpawnRelease
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })

  try {
    await connection.start()
    const pendingRestart = connection.restartLocal()
    await restartEntered

    const pendingStop = connection.stop()
    let stopResolved = false
    pendingStop.then(() => { stopResolved = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(stopResolved, false, 'stop waits for the in-flight restart owner')

    releaseRestartSpawn({ child: { on: () => {}, exitCode: null }, port: 18701, stop: async () => { staleStops += 1 } })
    await pendingStop
    await pendingRestart
    assert.equal(staleStops, 1, 'stop reclaimed the restart respawned child')
    assert.equal(connection.getState(), 'stopped')
    assert.equal(connection.hasLiveProcess(), false)
    assert.equal(spawnCalls, 2)
  } finally {
    releaseRestartSpawn?.({ child: { on: () => {}, exitCode: 1 }, port: 18701, stop: async () => {} })
    await connection.stop()
  }
})

// ---------------------------------------------------------------------------
// PlaneHandle.restartLocal(): the handle wiring + the canStartLocal gate.
// ---------------------------------------------------------------------------

test('createControlPlane.restartLocal rejects under a closed canStartLocal without spawning', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-restart-gate-'))
  let spawns = 0
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return { child: { on: () => {}, exitCode: null }, port: 17510, stop: async () => {} }
  }
  const describeCapabilities = async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() })
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: quietLogger,
    canStartLocal: () => ({ ok: false, reason: 'applying dsh vY' }),
    localConnectionDeps: { spawnDsh, describeCapabilities },
  })
  try {
    await plane.start()
    await assert.rejects(plane.restartLocal(), (error: unknown) =>
      (error as Error & { code?: string }).code === 'connection_busy'
      && /applying dsh vY/.test(String(error)))
    assert.equal(spawns, 0, 'no spawn behind a closed canStartLocal')
    assert.equal(plane.connectionState, 'stopped')
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restartLocal rejects while a start is in flight (no spawn, no backoff-window pollution)', async () => {
  let spawnCalls = 0
  let announceStart!: () => void
  let releaseStart!: () => void
  const startEntered = new Promise<void>(resolve => { announceStart = resolve })
  const startGate = new Promise<void>(resolve => { releaseStart = resolve })
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        return { child: { on: () => {}, exitCode: null }, port: 18010 + spawnCalls, stop: async () => {} }
      },
      beforeSpawnCheckpoint: async (kind) => {
        if (kind === 'start') {
          announceStart()
          await startGate
        }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  try {
    const startPromise = connection.start()
    await startEntered
    await assert.rejects(connection.restartLocal(), /start in progress/)
    assert.equal(spawnCalls, 0, 'restart must not spawn while start is in flight')
    releaseStart()
    await startPromise
    await waitFor(() => connection.getState() === 'ready', 3000, 'ready after start')
    assert.equal(spawnCalls, 1, 'exactly one start spawn')
    await connection.restartLocal()
    await waitFor(() => connection.getState() === 'ready', 3000, 'ready after restart')
    assert.equal(spawnCalls, 2, 'after readiness the restart respawns exactly once')
  } finally {
    releaseStart?.()
    await connection.stop()
  }
})

test('restartLocal rejects from error state (spawn failure) with the honest not-running code', async () => {
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => { throw new Error('mock spawn failure') },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  await assert.rejects(connection.start(), /mock spawn failure/)
  assert.equal(connection.getState(), 'error')
  await assert.rejects(connection.restartLocal(), /not running/)
  await connection.stop()
})

test('restartLocal rejects again once the shared window is exhausted (honest recover-with-start)', async () => {
  let spawnCalls = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 0, maxRestartsInWindow: 2 },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        return { child: { on: () => {}, exitCode: null }, port: 18040 + spawnCalls, stop: async () => {} }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  await connection.start()
  await connection.restartLocal()
  await connection.restartLocal()
  // The third attempt hits the M=2 window and settles into restart-exhausted
  // (resolved, not rejected — the CONTRACT says callers must read state).
  await connection.restartLocal()
  assert.equal(connection.getState(), 'restart-exhausted')
  await assert.rejects(connection.restartLocal(), /recover with start/)
  await connection.stop()
})

test('restart resolves the workspace thunk afresh (restart uses the current activation tree, not a stale path)', async () => {
  let workspace = '/tmp/tree-a'
  const seen: string[] = []
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: () => workspace,
    logger: quietLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async (opts: { dshWorkspacePath: string }) => {
        seen.push(opts.dshWorkspacePath)
        return { child: { on: () => {}, exitCode: null }, port: 18050 + seen.length, stop: async () => {} }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  await connection.start()
  assert.deepEqual(seen, ['/tmp/tree-a'])
  workspace = '/tmp/tree-b'
  await connection.restartLocal()
  assert.deepEqual(seen, ['/tmp/tree-a', '/tmp/tree-b'], 'restart must spawn the current tree')
  await connection.stop()
})

test('restartLocal rejects from stopped (never started) without spawning a ghost instance', async () => {
  let spawnCalls = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        return { child: { on: () => {}, exitCode: null }, port: 18020, stop: async () => {} }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  await assert.rejects(connection.restartLocal(), /not running/)
  assert.equal(spawnCalls, 0)
})

test('createControlPlane.restartLocal restarts the local host end-to-end', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-restart-happy-'))
  let spawns = 0
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return { child: { on: () => {}, exitCode: null }, port: 17510 + spawns, stop: async () => {} }
  }
  const describeCapabilities = async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() })
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: quietLogger,
    localConnectionDeps: { spawnDsh, describeCapabilities },
  })
  try {
    await plane.start()
    await plane.startLocal()
    assert.equal(plane.connectionState, 'ready')
    await plane.restartLocal()
    assert.equal(plane.connectionState, 'ready')
    assert.equal(plane.localProcessAlive, true)
    assert.equal(spawns, 2, 'start + one restart respawn')
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// design 18 addendum (apply-now desktop host) test plan 8.2 — health
// interleave, applying-window gates, and D2 restart-window ownership.
// ---------------------------------------------------------------------------

test('R3: a process-death exit during the stop() window is inert (no restart respawn), and after stop the restart path stays closed', async () => {
  let spawnCalls = 0
  let releaseStop!: () => void
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
  const exitHook: { fire?: (code: number | null, sig: string | null) => void } = {}
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { healthIntervalMs: 0 },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        return {
          child: {
            on: (event: string, listener: any) => { if (event === 'exit') exitHook.fire = listener },
            exitCode: null as number | null,
          },
          port: 18800,
          stop: async () => { await stopGate },
        }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  try {
    await connection.start()
    assert.equal(connection.getState(), 'ready')
    assert.equal(spawnCalls, 1)

    // The stop() window is open (child.stop gated). The stop sequence itself
    // SIGTERMs the child, so its death event arrives while stopping === true
    // — the "process death" restart trigger must be inert (state guard).
    const pendingStop = connection.stop()
    exitHook.fire?.(null, 'SIGTERM')
    releaseStop()
    await pendingStop
    assert.equal(connection.getState(), 'stopped')
    assert.equal(spawnCalls, 1, 'the exit during stopping must not trigger a restart respawn')

    // After stop completes state stays stopped; both the stale death event
    // and restartLocal are inert (triggerRestart early-exits on stopped).
    exitHook.fire?.(1, null)
    assert.equal(spawnCalls, 1, 'a stale death event after stop must not resurrect the connection')
    await assert.rejects(connection.restartLocal(), /not running/)
    assert.equal(spawnCalls, 1, 'restartLocal from stopped must not spawn')
  } finally {
    releaseStop?.()
    await connection.stop()
  }
})

test('a closed canSpawn gate (applying window) rejects start() and restartLocal with connection_busy, from stopped', async () => {
  let spawns = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: { canSpawn: () => ({ ok: false, reason: 'applying dsh vY' }) },
    deps: {
      spawnDsh: async () => {
        spawns += 1
        return { child: { on: () => {}, exitCode: null }, port: 18900, stop: async () => {} }
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  await assert.rejects(connection.start(), (error: unknown) =>
    (error as Error & { code?: string }).code === 'connection_busy'
    && /applying dsh vY/.test(String(error)))
  assert.equal(spawns, 0, 'start must not spawn behind a closed gate')
  assert.equal(connection.getState(), 'stopped')
  // From stopped the closed gate still outranks the not-running refusal.
  await assert.rejects(connection.restartLocal(), (error: unknown) =>
    (error as Error & { code?: string }).code === 'connection_busy'
    && /applying dsh vY/.test(String(error)))
  assert.equal(spawns, 0)
  await connection.stop()
})

test('createControlPlane.startLocal rejects connection_busy under a closed canStartLocal (applying window), from stopped', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-start-gate-'))
  let spawns = 0
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return { child: { on: () => {}, exitCode: null }, port: 17510, stop: async () => {} }
  }
  const describeCapabilities = async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() })
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: quietLogger,
    canStartLocal: () => ({ ok: false, reason: 'applying dsh vY' }),
    localConnectionDeps: { spawnDsh, describeCapabilities },
  })
  try {
    await plane.start()
    await assert.rejects(plane.startLocal(), (error: unknown) =>
      (error as Error & { code?: string }).code === 'connection_busy'
      && /applying dsh vY/.test(String(error)))
    assert.equal(spawns, 0, 'no spawn behind a closed canStartLocal')
    assert.equal(plane.connectionState, 'stopped')
    await assert.rejects(plane.restartLocal(), (error: unknown) =>
      (error as Error & { code?: string }).code === 'connection_busy'
      && /applying dsh vY/.test(String(error)))
    assert.equal(spawns, 0, 'restartLocal stays behind the same closed gate')
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('D2: the restart window counts only triggerRestart (start()/stop() never push into it; recovery consumes nothing) — M=5 exhausts, start() recovers', async () => {
  const hooks: Array<{ fire?: (code: number | null, sig: string | null) => void }> = []
  let spawnCalls = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: {
      healthIntervalMs: 0,
      restartBackoffFloorMs: 5,
      restartBackoffCeilMs: 10,
      restartWindowMs: 60_000,
      maxRestartsInWindow: 5,
    },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        const hook: { fire?: (code: number | null, sig: string | null) => void } = {}
        hooks.push(hook)
        return controllableChild(19000 + spawnCalls, hook)
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  try {
    await connection.start()
    assert.equal(connection.getState(), 'ready')
    assert.equal(spawnCalls, 1)

    // Five process-death health restarts each land back on ready. The state
    // alone is not a completion proof: attempts ≥ 2 await their backoff
    // BEFORE entering 'restarting', so the machine still reads 'ready' right
    // after the trigger fires. Wait for the spawn count to advance too.
    for (let i = 1; i <= 5; i += 1) {
      hooks[i - 1]?.fire?.(1, null)
      await waitFor(
        () => spawnCalls === i + 1 && connection.getState() === 'ready',
        3000,
        `ready after health restart ${i}`,
      )
    }
    assert.equal(spawnCalls, 6, 'start + five health-restart respawns')
    assert.equal(connection.getState(), 'ready')

    // The sixth death hits the M=5 window → restart-exhausted, no respawn.
    hooks[5]?.fire?.(1, null)
    await waitFor(() => connection.getState() === 'restart-exhausted', 3000, 'restart-exhausted after M=5 health restarts')
    assert.equal(spawnCalls, 6, 'the exhausted trigger must not respawn')

    // Recovery requires start(); restartLocal is refused while exhausted.
    await assert.rejects(connection.restartLocal(), /recover with start/)
    await connection.start()
    assert.equal(connection.getState(), 'ready')
    assert.equal(spawnCalls, 7, 'recovery start respawns once')

    // D2: a start() spawn never consumes the window — the cleared window is
    // empty, so one more death restarts immediately instead of exhausting.
    hooks[6]?.fire?.(1, null)
    await waitFor(
      () => spawnCalls === 8 && connection.getState() === 'ready',
      3000,
      'ready after post-recovery health restart',
    )
    assert.equal(spawnCalls, 8, 'the post-recovery health restart must still be allowed')
  } finally {
    await connection.stop()
  }
})

test('D2: restart counts do not survive a stop()/start() cycle (stop clears the window)', async () => {
  const hooks: Array<{ fire?: (code: number | null, sig: string | null) => void }> = []
  let spawnCalls = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    logger: quietLogger,
    options: {
      healthIntervalMs: 0,
      restartBackoffFloorMs: 5,
      restartBackoffCeilMs: 10,
      restartWindowMs: 60_000,
      maxRestartsInWindow: 5,
    },
    deps: {
      spawnDsh: async () => {
        spawnCalls += 1
        const hook: { fire?: (code: number | null, sig: string | null) => void } = {}
        hooks.push(hook)
        return controllableChild(19100 + spawnCalls, hook)
      },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  try {
    await connection.start()
    assert.equal(spawnCalls, 1)

    // Two health restarts count into the window (same spawn-count completion
    // proof as above — 'ready' alone can still be the pre-backoff state).
    hooks[0]?.fire?.(1, null)
    await waitFor(() => spawnCalls === 2 && connection.getState() === 'ready', 3000, 'ready after health restart 1')
    hooks[1]?.fire?.(1, null)
    await waitFor(() => spawnCalls === 3 && connection.getState() === 'ready', 3000, 'ready after health restart 2')
    assert.equal(spawnCalls, 3, 'start + two pre-stop health-restart respawns')

    // stop() clears the window; start() opens a fresh lifecycle.
    await connection.stop()
    assert.equal(connection.getState(), 'stopped')
    await connection.start()
    assert.equal(connection.getState(), 'ready')
    assert.equal(spawnCalls, 4, 'the post-stop start respawns once')

    // Five more health restarts are all fine (the window was reset by
    // stop/start). Had the two pre-stop counts survived, the 4th post-stop
    // death would already have exhausted.
    let hookIndex = 3
    for (let i = 1; i <= 5; i += 1) {
      hooks[hookIndex]?.fire?.(1, null)
      await waitFor(
        () => spawnCalls === 4 + i && connection.getState() === 'ready',
        3000,
        `ready after post-restart health restart ${i}`,
      )
      hookIndex += 1
    }
    assert.equal(spawnCalls, 9, 'start + 2 pre-stop + start + 5 post-stop respawns')

    // The sixth post-stop death hits the fresh M=5 window.
    hooks[8]?.fire?.(1, null)
    await waitFor(() => connection.getState() === 'restart-exhausted', 3000, 'restart-exhausted after a fresh window of M=5')
    assert.equal(spawnCalls, 9, 'the exhausted trigger must not respawn')
  } finally {
    await connection.stop()
  }
})
