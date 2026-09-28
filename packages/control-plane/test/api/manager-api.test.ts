/**
 * Management REST surface tests (v4): /health, /api/connections idempotent
 * create, DELETE semantics (404/stopped), PATCH label/accentColor, kind
 * gating — against a real HTTP server on an ephemeral port. The dsh host is
 * never spawned: createControlPlane's localConnectionDeps seam injects a
 * fake spawn (immediate ready) and a healthy describe probe.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { createControlPlane } from '../../src/index.ts'
import { CATALOG_FILE } from '../../src/catalog.ts'
import { DshSpawnExhaustedError, MAX_SPAWN_ATTEMPTS } from '../../src/spawn-dsh.ts'
import type { SpawnedDsh } from '../../src/local-connection.ts'
import { DEFAULT_DSH_START_PORT, DSH_WRITER_QUIESCENCE_UNKNOWN_CODE } from '../../src/spawn-dsh.ts'
import { fakeWire, fetchJson } from '../support/utils.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

async function makePlane(stateDirOverride?: string, corsOrigins: string[] = []) {
  const stateDir = stateDirOverride ?? mkdtempSync(join(tmpdir(), 'dsh-chamber-manager-'))
  const wire = fakeWire()
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    corsOrigins,
    localConnectionDeps: { spawnDsh: wire.spawnDsh, probeHostIdentity: wire.probeHostIdentity },
  })
  try {
    await plane.start()
    return { plane, stateDir, wire, base: `http://127.0.0.1:${plane.port}` }
  } catch (error) {
    rmSync(stateDir, { recursive: true, force: true })
    throw error
  }
}

test('createControlPlane hands the bundled pnpm entry to the managed spawn (design 02 §3.1)', async () => {
  // The original bug was exactly "the bundled pnpm never reaches the host": losing
  // pnpmEntry anywhere between the plane options and spawnDsh must fail here.
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-pnpm-entry-'))
  const entry = '/tmp/dsh-chamber-bundled/pnpm/bin/pnpm.cjs'
  const seen: Array<string | null | undefined> = []
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    pnpmEntry: entry,
    localConnectionDeps: {
      spawnDsh: async (options): Promise<SpawnedDsh> => {
        seen.push(options.pnpmEntry)
        return { child: { on() {}, exitCode: null }, port: DEFAULT_DSH_START_PORT, stop: async () => {} }
      },
      probeHostIdentity: async () => true,
    },
  })
  try {
    await plane.start()
    await plane.startLocal()
    assert.deepEqual(seen, [entry])
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

function rawUpgrade(port: number, origin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(
        'GET /api/i/local/api/remote.mux HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port}\r\n`
        + `Origin: ${origin}\r\n`
        + 'Connection: Upgrade\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Sec-WebSocket-Key: dGVzdC1rZXk=\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + '\r\n',
      )
    })
    socket.on('data', chunk => { response += chunk })
    socket.on('end', () => resolve(response))
    socket.on('error', reject)
  })
}

function rawHttp(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`GET /api/connections HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    socket.on('data', chunk => { response += chunk })
    socket.on('end', () => resolve(response))
    socket.on('error', reject)
  })
}

test('health + connections: idempotent create, ready projection, no double spawn', async () => {
  const holder = await makePlane()
  try {
    const health = await fetchJson(holder.base, '/health')
    assert.equal(health.status, 200)
    assert.equal(health.body.ok, true)
    assert.equal(health.body.dsh.status, 'stopped')

    const created = await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(created.status, 200)
    assert.equal(created.body.connection.id, 'local')
    assert.equal(created.body.connection.status, 'ready')
    assert.equal(created.body.connection.dshPort, DEFAULT_DSH_START_PORT)
    assert.equal(created.body.spawned, true)
    const catalogAfterCreate = JSON.parse(readFileSync(join(holder.stateDir, CATALOG_FILE), 'utf8'))
    assert.deepEqual(catalogAfterCreate.connections, [{ connectionId: 'local', kind: 'local' }])
    const catalogRevision = catalogAfterCreate.revision

    // Idempotent: a running instance never respawns.
    const again = await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(again.status, 200)
    assert.equal(again.body.spawned, false)
    assert.equal(again.body.connection.dshPort, DEFAULT_DSH_START_PORT)
    assert.equal(holder.wire.spawns, 1)
    assert.equal(
      JSON.parse(readFileSync(join(holder.stateDir, CATALOG_FILE), 'utf8')).revision,
      catalogRevision,
      'idempotent live-state projection must not revise catalog.json',
    )

    const read = await fetchJson(holder.base, '/api/connections')
    assert.equal(read.status, 200)
    assert.equal(read.body.connection.id, 'local')
    assert.equal(read.body.connection.status, 'ready')

    const health1 = await fetchJson(holder.base, '/health')
    assert.equal(health1.body.dsh.status, 'ready')
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('HEAD /health is the no-body twin of GET (monitoring probes answer 200)', async () => {
  const holder = await makePlane()
  try {
    const response = await fetch(`${holder.base}/health`, { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json')
    assert.equal(await response.text(), '', 'HEAD carries no body')
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('candidate quarantine hides ready/port until the activation verdict opens exposure', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-quarantine-'))
  const wire = fakeWire()
  let exposed = false
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    canExposeLocal: () => exposed,
    localConnectionDeps: { spawnDsh: wire.spawnDsh, probeHostIdentity: wire.probeHostIdentity },
  })
  try {
    await plane.start()
    await plane.startLocal()
    const base = `http://127.0.0.1:${plane.port}`
    const quarantined = await fetchJson(base, '/api/connections')
    assert.equal(quarantined.body.connection.status, 'starting')
    assert.equal(quarantined.body.connection.dshPort, undefined)
    const health = await fetchJson(base, '/health')
    assert.equal(health.body.dsh.status, 'starting')
    assert.equal(health.body.dsh.port, 0)
    const proxyResponse = await fetchJson(base, '/api/i/local/api/session/list')
    assert.equal(proxyResponse.status, 503)
    assert.equal(proxyResponse.body.code, 'instance_unavailable')
    // The 'local' host-log alias is the same internal fact: quarantined reads
    // must 503 loudly, never leak the candidate port / ready line.
    const logsResponse = await fetchJson(base, '/api/host/logs')
    assert.equal(logsResponse.status, 503)
    assert.equal(logsResponse.body.code, 'quarantined')

    exposed = true
    plane.refreshLocalExposure()
    const exposedHealth = await fetchJson(base, '/health')
    assert.equal(exposedHealth.body.dsh.status, 'ready')
    assert.equal(exposedHealth.body.dsh.port, 17510)
    const accepted = await fetchJson(base, '/api/connections')
    assert.equal(accepted.body.connection.status, 'ready')
    assert.equal(accepted.body.connection.dshPort, 17510)
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('candidate quarantine also hides internal error state, port, and detail before verdict', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-quarantine-error-'))
  let spawns = 0
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
  })
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    canExposeLocal: () => false,
    localConnectionDeps: {
      spawnDsh: async (): Promise<SpawnedDsh> => {
        spawns += 1
        if (spawns > 1) {
          const failure = new Error('candidate failed at /private/runtime-secret on port 17510') as Error & { code: string }
          failure.code = DSH_WRITER_QUIESCENCE_UNKNOWN_CODE
          throw failure
        }
        return {
          child,
          port: 17510,
          stop: async () => { child.exitCode = 1 },
        }
      },
      probeHostIdentity: async () => true,
    },
  })
  try {
    await plane.start()
    await plane.startLocal()
    const errored = new Promise<void>(resolve => {
      const unsubscribe = plane.onLocalStateChange(snapshot => {
        if (snapshot.status !== 'error') return
        unsubscribe()
        resolve()
      })
    })
    child.exitCode = 1
    child.emit('exit', 1, null)
    await errored
    assert.equal(plane.connectionState, 'error')

    const base = `http://127.0.0.1:${plane.port}`
    const connections = await fetchJson(base, '/api/connections')
    assert.equal(connections.body.connection.status, 'starting')
    assert.equal(connections.body.connection.dshPort, undefined)
    assert.equal(connections.body.connection.error, undefined)
    assert.ok(!JSON.stringify(connections.body).includes('runtime-secret'))
    assert.ok(!JSON.stringify(connections.body).includes('17510'))

    const health = await fetchJson(base, '/health')
    assert.deepEqual(health.body.dsh, { status: 'starting', port: 0 })
    assert.ok(!JSON.stringify(health.body).includes('runtime-secret'))
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an exhausted start (every candidate port occupied) is a visible /health failure with the concrete reason', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-start-exhausted-'))
  const holders: Array<ReturnType<typeof createServer>> = []
  const freePort = (): Promise<number> => new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.on('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolvePort(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
  // The global file pool runs this file next to every other package's tests, so
  // another process can steal a reserved port between the probe and the bind.
  // Retrying the whole contiguous range with a fresh base turns that scheduler
  // race into a retry instead of a false exhausted-start verdict.
  let base = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    base = await freePort()
    try {
      for (let offset = 0; offset < MAX_SPAWN_ATTEMPTS; offset++) {
        const holder = createServer()
        await new Promise<void>((resolveListen, rejectListen) => {
          holder.once('error', rejectListen)
          holder.listen(base + offset, '127.0.0.1', () => resolveListen())
        })
        holders.push(holder)
      }
      break
    } catch (error) {
      for (const held of holders.splice(0)) held.close()
      // Retry only the cross-process race that no atomic contiguous-range
      // reservation can avoid. EACCES/EADDRNOTAVAIL are real failures: surfacing
      // them immediately is what keeps this loop from masking an environment bug.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 4) throw error
    }
  }
  // The plane uses the REAL spawnDsh: the failure under test is the real
  // exhausted-retry error, not an injected string.
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    canExposeLocal: () => false,
    dshPortBase: base,
  })
  try {
    await plane.start()
    await assert.rejects(plane.startLocal(), (error: unknown) => {
      assert.ok(error instanceof DshSpawnExhaustedError)
      assert.match(error.message, new RegExp(`port ${base} is already in use`))
      assert.ok(!error.message.includes('undefined'))
      return true
    })

    const origin = `http://127.0.0.1:${plane.port}`
    // The visible terminal: with the exposure latch still closed (the desktop's
    // runtime probe never opened it) /health must report the failure + reason,
    // not "starting" forever.
    const health = await fetchJson(origin, '/health')
    assert.equal(health.body.dsh.status, 'error')
    assert.equal(health.body.dsh.port, 0)
    assert.match(health.body.dsh.error, new RegExp(`port ${base} is already in use`))
    const connections = await fetchJson(origin, '/api/connections')
    assert.equal(connections.body.connection.status, 'error')
    assert.match(connections.body.connection.error, /already in use/)

  } finally {
    await plane.stop()
    await Promise.all(holders.map(holder => new Promise<void>(resolveClose => holder.close(() => resolveClose()))))
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runtime start gate blocks every spawn entry and workspace resolver is read per restart', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-runtime-gate-'))
  let blocked = true
  let workspace = '/runtime/0.1.0'
  const spawnedFrom: string[] = []
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    getDshWorkspacePath: () => workspace,
    canStartLocal: () => blocked ? { ok: false, reason: 'runtime apply in progress' } : { ok: true },
    localConnectionDeps: {
      spawnDsh: async (options): Promise<SpawnedDsh> => {
        spawnedFrom.push(options.dshWorkspacePath)
        return { child: { on: () => {}, exitCode: null }, port: 17510, stop: async () => {} }
      },
      probeHostIdentity: async () => true,
    },
  })
  try {
    await plane.start()
    const base = `http://127.0.0.1:${plane.port}`
    const rejected = await fetchJson(base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.code, 'connection_busy')
    await assert.rejects(plane.startLocal(), /runtime apply in progress/)
    assert.deepEqual(spawnedFrom, [])

    blocked = false
    await plane.startLocal()
    assert.deepEqual(spawnedFrom, ['/runtime/0.1.0'])
    assert.equal(plane.localDshPort, 17510)
    await plane.stopLocal()

    workspace = '/runtime/0.2.0'
    await plane.startLocal()
    assert.deepEqual(spawnedFrom, ['/runtime/0.1.0', '/runtime/0.2.0'])
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runtime gate plus stop invalidates a queued start before every DSH_HOME seed and spawn', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-runtime-fence-'))
  const graphSource = join(stateDir, 'host-graph-source')
  mkdirSync(join(graphSource, 'dist'), { recursive: true })
  writeFileSync(join(graphSource, 'package.json'), JSON.stringify({ name: '@dsh-chamber/dsh-chamber-seed-client-graph' }))
  writeFileSync(join(graphSource, 'dist', 'index.js'), 'export const graph = true\n')

  let blocked = false
  let spawns = 0
  let releaseCheckpoint!: () => void
  let announceCheckpoint!: () => void
  const checkpointReached = new Promise<void>(resolve => { announceCheckpoint = resolve })
  const checkpointRelease = new Promise<void>(resolve => { releaseCheckpoint = resolve })
  const plane = createControlPlane({
    port: 0,
    stateDir,
    dshWorkspacePath: '/runtime/0.1.0',
    hostGraphPackageSourceDir: graphSource,
    hostGitWorktreePackageSourceDir: join(stateDir, 'missing-git-package'),
    logger: silentLogger,
    canStartLocal: () => blocked ? { ok: false, reason: 'runtime snapshot in progress' } : { ok: true },
    localConnectionDeps: {
      beforeSpawnCheckpoint: async kind => {
        if (kind !== 'start') return
        announceCheckpoint()
        await checkpointRelease
      },
      spawnDsh: async (): Promise<SpawnedDsh> => {
        spawns += 1
        return { child: { on: () => {}, exitCode: null }, port: 17510, stop: async () => {} }
      },
      probeHostIdentity: async () => true,
    },
  })
  try {
    await plane.start()
    const pendingStart = plane.startLocal()
    await checkpointReached

    // The request already passed the management-entry gate. Closing the
    // runtime gate and stopLocal() must invalidate its captured lifecycle
    // epoch before the suspended request is allowed to continue.
    blocked = true
    const pendingStop = plane.stopLocal()
    releaseCheckpoint()
    await Promise.all([
      assert.rejects(pendingStart, /invalidated by stop|runtime snapshot in progress/),
      pendingStop,
    ])

    assert.equal(spawns, 0)
    assert.equal(existsSync(join(stateDir, 'dsh-home', 'settings.yaml')), false, 'default locale was not seeded')
    assert.equal(
      existsSync(join(stateDir, 'dsh-home', 'profiles', 'web', 'node_modules', '@dsh-chamber', 'dsh-chamber-seed-client-graph')),
      false,
      'host package was not seeded',
    )
    assert.equal(plane.connectionState, 'stopped')
  } finally {
    releaseCheckpoint?.()
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stopLocal waits for and reclaims an inside-spawn start before reporting writer quiescence', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-spawn-owner-fence-'))
  let blocked = false
  let announceSpawn!: () => void
  let releaseSpawn!: (spawned: SpawnedDsh) => void
  const spawnEntered = new Promise<void>(resolve => { announceSpawn = resolve })
  const spawnRelease = new Promise<SpawnedDsh>(resolve => { releaseSpawn = resolve })
  let spawnSignal: AbortSignal | undefined
  let staleChildStops = 0
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    canStartLocal: () => blocked ? { ok: false, reason: 'runtime snapshot in progress' } : { ok: true },
    hostGraphPackageSourceDir: join(stateDir, 'missing-graph-package'),
    hostGitWorktreePackageSourceDir: join(stateDir, 'missing-git-package'),
    localConnectionDeps: {
      spawnDsh: async options => {
        spawnSignal = options.signal
        announceSpawn()
        return spawnRelease
      },
      probeHostIdentity: async () => true,
    },
  })
  try {
    await plane.start()
    const pendingStart = plane.startLocal()
    await spawnEntered

    blocked = true
    let stopResolved = false
    const pendingStop = plane.stopLocal().then(() => { stopResolved = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(spawnSignal?.aborted, true, 'stop aborts the readiness owner')
    assert.equal(stopResolved, false, 'stop cannot report quiescence while spawn still owns a possible writer')

    releaseSpawn({
      child: { on: () => {}, exitCode: null },
      port: 17510,
      stop: async () => { staleChildStops += 1 },
    })
    await Promise.all([pendingStart, pendingStop])
    assert.equal(staleChildStops, 1, 'the stale spawned child is reclaimed before stop resolves')
    assert.equal(plane.connectionState, 'stopped')
    assert.equal(plane.localProcessAlive, false)
  } finally {
    releaseSpawn?.({
      child: { on: () => {}, exitCode: 1 },
      port: 17510,
      stop: async () => {},
    })
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('unknown residual writer permanently closes the plane start latch until restart reaping', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-writer-latch-'))
  let spawnCalls = 0
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    hostGraphPackageSourceDir: join(stateDir, 'missing-graph-package'),
    hostGitWorktreePackageSourceDir: join(stateDir, 'missing-git-package'),
    localConnectionDeps: {
      spawnDsh: async () => {
        spawnCalls += 1
        const failure = new Error('process group cleanup could not be proven') as Error & { code: string }
        failure.code = DSH_WRITER_QUIESCENCE_UNKNOWN_CODE
        throw failure
      },
      probeHostIdentity: async () => true,
    },
  })
  try {
    await plane.start()
    assert.equal(plane.localWritersQuiescent, true, 'startup reaper initially proved a clean state')
    await assert.rejects(plane.startLocal(), /could not be proven/)
    assert.equal(spawnCalls, 1)
    assert.equal(plane.localWritersQuiescent, false, 'unknown termination closes the durable in-process latch')

    await assert.rejects(plane.startLocal(), /writer quiescence is not proven/)
    assert.equal(spawnCalls, 1, 'a later manual start is rejected before seed or spawn')

    const base = `http://127.0.0.1:${plane.port}`
    const rejected = await fetchJson(base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.code, 'connection_busy')
    assert.equal(spawnCalls, 1)
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('startup reaper preserves corrupt/invalid writer ledgers and keeps the writer latch closed', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-corrupt-writer-ledger-'))
  const ledgerDir = join(stateDir, 'managed-dsh')
  const corruptLedger = join(ledgerDir, '41001.json')
  const invalidPidLedger = join(ledgerDir, '41002.json')
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(corruptLedger, '{ truncated')
  writeFileSync(invalidPidLedger, JSON.stringify({ pid: 'not-a-pid', port: 17510 }))

  const holder = await makePlane(stateDir)
  try {
    assert.equal(holder.plane.localWritersQuiescent, false)
    assert.equal(existsSync(corruptLedger), true, 'corrupt ledger is durable recovery evidence')
    assert.equal(existsSync(invalidPidLedger), true, 'invalid-PID ledger is durable recovery evidence')

    const rejected = await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.code, 'connection_busy')
    assert.equal(holder.wire.spawns, 0)
  } finally {
    await holder.plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('POST kind gate: only local; non-local answers 400 connection_kind_unsupported', async () => {
  const holder = await makePlane()
  try {
    const rejected = await fetchJson(holder.base, '/api/connections', postJson({ kind: 'ssh' }))
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.code, 'connection_kind_unsupported')
    assert.equal(holder.wire.spawns, 0)

    const badLabel = await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local', label: '' }))
    assert.equal(badLabel.status, 400)
    assert.equal(badLabel.body.code, 'connection_invalid_input')
    assert.equal(holder.wire.spawns, 0)
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('browser-origin fence rejects hostile simple POST and WebSocket before side effects/proxying', async () => {
  const holder = await makePlane()
  try {
    const rejected = await fetchJson(holder.base, '/api/connections', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ kind: 'local' }),
    })
    assert.equal(rejected.status, 403)
    assert.equal(rejected.body.code, 'origin_forbidden')
    assert.equal(holder.wire.spawns, 0)

    const opaque = await fetchJson(holder.base, '/api/connections', {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'text/plain' },
      body: JSON.stringify({ kind: 'local' }),
    })
    assert.equal(opaque.status, 403)
    assert.equal(opaque.body.code, 'origin_forbidden')
    assert.equal(holder.wire.spawns, 0, 'opaque origin is rejected before side effects')

    const upgrade = await rawUpgrade(holder.plane.port!, 'https://evil.example')
    assert.match(upgrade, /^HTTP\/1\.1 403 Forbidden/)
    assert.match(upgrade, /origin_forbidden/)
    const opaqueUpgrade = await rawUpgrade(holder.plane.port!, 'null')
    assert.match(opaqueUpgrade, /^HTTP\/1\.1 403 Forbidden/)
    assert.match(opaqueUpgrade, /origin_forbidden/)
    const otherLoopback = await rawUpgrade(holder.plane.port!, 'http://127.0.0.1:5173')
    assert.match(otherLoopback, /^HTTP\/1\.1 403 Forbidden/)
    assert.match(otherLoopback, /origin_forbidden/)
    const sameOrigin = await rawUpgrade(holder.plane.port!, `http://127.0.0.1:${holder.plane.port}`)
    assert.doesNotMatch(sameOrigin, /^HTTP\/1\.1 403 Forbidden/)
    const originWithPath = await rawUpgrade(holder.plane.port!, `http://127.0.0.1:${holder.plane.port}/spoof`)
    assert.match(originWithPath, /^HTTP\/1\.1 403 Forbidden/)
    const rebound = await rawHttp(holder.plane.port!, 'attacker.example')
    assert.match(rebound, /^HTTP\/1\.1 403 Forbidden/)
    assert.match(rebound, /origin_forbidden/)
    const hostWithUserInfo = await rawHttp(holder.plane.port!, `attacker@127.0.0.1:${holder.plane.port}`)
    assert.match(hostWithUserInfo, /^HTTP\/1\.1 403 Forbidden/)
    assert.equal(holder.wire.spawns, 0)
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('browser-origin fence admits only explicitly allowlisted cross-origin development servers', async () => {
  const allowedOrigin = 'http://127.0.0.1:5173'
  const holder = await makePlane(undefined, [allowedOrigin])
  try {
    const allowed = await fetchJson(holder.base, '/health', {
      headers: { origin: allowedOrigin },
    })
    assert.equal(allowed.status, 200)
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('PATCH label/accentColor persists and survives a plane restart', async () => {
  const holder = await makePlane()
  const label = 'My dsh'
  const accentColor = '#2ecc71'
  try {
    await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local', label: 'first' }))

    const patched = await fetchJson(holder.base, '/api/connections/local', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, accentColor }),
    })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.connection.label, label)
    assert.equal(patched.body.connection.accentColor, accentColor)

    const read = await fetchJson(holder.base, '/api/connections')
    assert.equal(read.body.connection.label, label)
    assert.equal(read.body.connection.accentColor, accentColor)

    const invalid = await fetchJson(holder.base, '/api/connections/local', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accentColor: 42 }),
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.code, 'connection_invalid_input')

    const missing = await fetchJson(holder.base, '/api/connections/nope', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    })
    assert.equal(missing.status, 404)
    await holder.plane.stop()

    // Persistence check: a fresh plane over the SAME state dir keeps the
    // user-editable fields (label/accentColor) while runtime projections
    // reset (status/dshPort come from the live host, never the file).
    const second = await makePlane(holder.stateDir)
    try {
      const readAfter = await fetchJson(second.base, '/api/connections')
      assert.equal(readAfter.status, 200)
      assert.equal(readAfter.body.connection.label, label)
      assert.equal(readAfter.body.connection.accentColor, accentColor)
      assert.equal(readAfter.body.connection.status, 'stopped')
    } finally {
      await second.plane.stop()
    }
  } finally {
    await holder.plane.stop().catch(() => {})
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('DELETE stops the instance, keeps the row, and 404s for unknown ids', async () => {
  const holder = await makePlane()
  try {
    await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local' }))
    const deleted = await fetchJson(holder.base, '/api/connections/local', { method: 'DELETE' })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.stopped, true)

    const read = await fetchJson(holder.base, '/api/connections')
    assert.equal(read.status, 200)
    assert.equal(read.body.connection.status, 'stopped')
    assert.equal(read.body.connection.dshPort, undefined)

    const unknown = await fetchJson(holder.base, '/api/connections/ssh-1', { method: 'DELETE' })
    assert.equal(unknown.status, 404)

    // Stop is idempotent: a stopped instance answers 200 again.
    const again = await fetchJson(holder.base, '/api/connections/local', { method: 'DELETE' })
    assert.equal(again.status, 200)
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('unknown management paths answer 404 not_found', async () => {
  const holder = await makePlane()
  try {
    for (const path of [
      '/api/projects', '/api/sessions', '/api/events', '/api/projects/capabilities', '/api/session/x/message',
      // Route segment-count violations: extra segments on
      // exact-length routes must not reach the handler.
      '/health/x', '/api/host/logs/extra',
    ]) {
      const response = await fetchJson(holder.base, path)
      assert.equal(response.status, 404, `${path} should be 404`)
    }
    for (const path of ['/api/connections/local/extra']) {
      const del = await fetchJson(holder.base, path, { method: 'DELETE' })
      assert.equal(del.status, 404, `${path} DELETE should be 404`)
      const patch = await fetchJson(holder.base, path, { method: 'PATCH', body: JSON.stringify({ label: 'x' }) })
      assert.equal(patch.status, 404, `${path} PATCH should be 404`)
    }
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('host-logs answers 404 without the hostLogs dependency and 400 invalid_argument on bad params', async () => {
  const holder = await makePlane()
  try {
    const missing = await fetchJson(holder.base, '/api/host/logs')
    assert.equal(missing.status, 404, 'no hostLogs dep → not_found')

    const bad = [
      '/api/host/logs?limit=0',
      '/api/host/logs?limit=-1',
      '/api/host/logs?offset=-1',
      '/api/host/logs?port=0',
      '/api/host/logs?port=70000',
    ]
    for (const path of bad) {
      const response = await fetchJson(holder.base, path)
      assert.equal(response.status, 400, `${path} should be 400`)
      assert.equal(response.body.code, 'invalid_argument', `${path} should carry the code`)
    }
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('DELETE during an in-flight start does not resurrect the connection (2026-08 review: stop-race guard)', async () => {
  // A slow spawn (resolves only on demand) + a stop issued mid-spawn: the
  // epoch guard in startImpl must tear the late spawn down, NOT adopt it, and
  // DELETE must not report success until that owner is quiescent.
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-stoprace-'))
  // Object property (not a captured let): TS 7 narrows closure-mutated `let`
  // bindings to `never`, making the release call untypeable.
  const spawnControl: { release: (() => void) | null } = { release: null }
  let teardownCount = 0
  const wire = {
    spawnDsh: async (): Promise<SpawnedDsh> => {
      await new Promise<void>(resolve => { spawnControl.release = resolve })
      return {
        child: { on: () => {}, exitCode: null },
        port: DEFAULT_DSH_START_PORT,
        stop: async () => { teardownCount += 1 },
      }
    },
    probeHostIdentity: async () => true,
  }
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    localConnectionDeps: { spawnDsh: wire.spawnDsh, probeHostIdentity: wire.probeHostIdentity },
  })
  try {
    await plane.start()
    const base = `http://127.0.0.1:${plane.port}`
    // Start in flight (spawn pending).
    const startP = fetch(`${base}/api/connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'local' }),
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    // Stop while the spawn is still pending.
    const deleteRequest = fetch(`${base}/api/connections/local`, { method: 'DELETE' })
    // A truthful DELETE cannot acknowledge `stopped` while the owner of a
    // deliberately non-cooperative spawn may still return a detached child.
    // Give the handler one turn and prove that it remains in flight until the
    // cancelled generation has completed its own cleanup.
    let deleteSettled = false
    void deleteRequest.finally(() => { deleteSettled = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(deleteSettled, false)
    // Let the pending spawn resolve — the guard must tear it down, not adopt;
    // DELETE may return success only after that teardown has finished.
    spawnControl.release!()
    const del = await deleteRequest
    assert.equal(del.status, 200)
    await startP
    const after = await fetchJson(base, '/api/connections')
    assert.equal(after.body.connection.status, 'stopped', 'late spawn must not resurrect the connection')
    assert.equal(teardownCount, 1, 'the late spawn must be torn down, not leaked')
  } finally {
    const release = spawnControl.release
    if (release !== null) release()
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
