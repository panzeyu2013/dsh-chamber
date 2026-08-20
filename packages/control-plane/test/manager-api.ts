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
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { createControlPlane } from '../src/index.ts'
import { createApi } from '../src/api.ts'
import type { SpawnedDsh } from '../src/local-connection.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

/** A fake spawn: immediate ready on a fixed port; counts spawn attempts. */
function fakeWire() {
  let spawns = 0
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return {
      child: { on: () => {}, exitCode: null },
      port: 17510,
      stop: async () => {},
    }
  }
  const describeCapabilities = async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() })
  return { spawnDsh, describeCapabilities, get spawns() { return spawns } }
}

async function makePlane(stateDirOverride?: string, corsOrigins: string[] = []) {
  const stateDir = stateDirOverride ?? mkdtempSync(join(tmpdir(), 'dsh-chamber-manager-'))
  const wire = fakeWire()
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    corsOrigins,
    localConnectionDeps: { spawnDsh: wire.spawnDsh, describeCapabilities: wire.describeCapabilities },
  })
  try {
    await plane.start()
    return { plane, stateDir, wire, base: `http://127.0.0.1:${plane.port}` }
  } catch (error) {
    rmSync(stateDir, { recursive: true, force: true })
    throw error
  }
}

async function fetchJson(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let body: any = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = null
  }
  return { status: response.status, body }
}

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
        'GET /api/i/local/api/events.mux HTTP/1.1\r\n'
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
    assert.equal(created.body.connection.dshPort, 17510)
    assert.equal(created.body.spawned, true)

    // Idempotent: a running instance never respawns.
    const again = await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(again.status, 200)
    assert.equal(again.body.spawned, false)
    assert.equal(again.body.connection.dshPort, 17510)
    assert.equal(holder.wire.spawns, 1)

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
    for (const path of ['/api/projects', '/api/sessions', '/api/events', '/api/projects/capabilities', '/api/session/x/message']) {
      const response = await fetchJson(holder.base, path)
      assert.equal(response.status, 404, `${path} should be 404`)
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

test('health-events streams the current snapshot and pushes every transition', async () => {
  const holder = await makePlane()
  try {
    const response = await fetch(`${holder.base}/api/host/health-events`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const nextFrame = async (): Promise<any> => {
      for (;;) {
        const double = buffer.indexOf('\n\n')
        if (double !== -1) {
          const frame = buffer.slice(0, double)
          buffer = buffer.slice(double + 2)
          return JSON.parse(frame.replace(/^data: /, ''))
        }
        const { done, value } = await reader.read()
        if (done) throw new Error('stream ended before the expected frame')
        buffer += decoder.decode(value, { stream: true })
      }
    }

    // The subscribe snapshot arrives first, no polling involved.
    const snapshot = await nextFrame()
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.dsh.status, 'stopped')

    // Starting the instance pushes each transition over the same stream.
    const start = await fetch(`${holder.base}/api/connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'local' }),
    })
    assert.equal(start.status, 200)
    const starting = await nextFrame()
    assert.equal(starting.dsh.status, 'starting')
    const ready = await nextFrame()
    assert.equal(ready.dsh.status, 'ready')
    assert.equal(ready.dsh.port, 17510)

    await reader.cancel()
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('health-events: write backpressure drains in order and bounded overflow releases the subscription', async () => {
  const reqEvents = new EventEmitter()
  const resEvents = new EventEmitter()
  const writes: string[] = []
  let writeCalls = 0
  let endCalls = 0
  let unsubscribeCalls = 0
  let healthListener: ((snapshot: { status: string; port: number | null; error: string | null }) => void) | null = null

  const req = {
    url: '/api/host/health-events',
    method: 'GET',
    headers: { host: '127.0.0.1:17500' },
    async *[Symbol.asyncIterator]() {},
    on: reqEvents.on.bind(reqEvents),
    once: reqEvents.once.bind(reqEvents),
    off: reqEvents.off.bind(reqEvents),
    removeListener: reqEvents.removeListener.bind(reqEvents),
  }
  const res = {
    headersSent: false,
    writeHead() { this.headersSent = true },
    write(chunk: unknown) {
      writes.push(String(chunk))
      writeCalls += 1
      return writeCalls !== 1 && writeCalls !== 3
    },
    end() { endCalls += 1 },
    destroy() {},
    setHeader() {},
    on: resEvents.on.bind(resEvents),
    once: resEvents.once.bind(resEvents),
    removeListener: resEvents.removeListener.bind(resEvents),
  }
  const api = createApi({
    logger: silentLogger,
    getHealth: () => ({ ok: true, dsh: { status: 'stopped', port: 0 } }),
    subscribeHealthEvents: (listener) => {
      healthListener = listener
      return () => { unsubscribeCalls += 1 }
    },
    getConnectionRow: () => null,
    startConnection: async () => ({ connection: null, spawned: false }),
    updateConnectionProfile: async () => null,
    stopConnection: async () => {},
  })

  await api.handle(req, res)
  assert.equal(writes.length, 1, 'the initial frame is accepted even when write reports backpressure')
  assert.equal(endCalls, 0, 'backpressure is not a dead connection')
  assert.equal(unsubscribeCalls, 0)

  healthListener!({ status: 'starting', port: null, error: null })
  assert.equal(writes.length, 1, 'subsequent state waits in the bounded queue')
  resEvents.emit('drain')
  assert.equal(writes.length, 2)
  assert.match(writes[1], /"status":"starting"/)

  healthListener!({ status: 'ready', port: 17510, error: null })
  assert.equal(writes.length, 3, 'a later false write enters backpressure again')
  assert.equal(resEvents.listenerCount('drain'), 1)
  for (let i = 0; i < 32; i += 1) {
    healthListener!({ status: `queued-${i}`, port: null, error: null })
  }
  assert.equal(endCalls, 0, 'the documented bounded queue itself is accepted')
  healthListener!({ status: 'overflow', port: null, error: null })
  assert.equal(unsubscribeCalls, 1, 'overflow disconnects the slow subscriber')
  assert.equal(endCalls, 1, 'overflow ends the SSE response once')
  assert.equal(resEvents.listenerCount('drain'), 0, 'teardown removes the pending drain listener')

  reqEvents.emit('close')
  assert.equal(unsubscribeCalls, 1, 'a later close cannot clean up twice')
  assert.equal(endCalls, 1)
  healthListener!({ status: 'after-teardown', port: 17510, error: null })
  assert.equal(writes.length, 3, 'a detached listener cannot write again')
})

test('health-events: a disconnected client unsubscribes and others keep streaming', async () => {
  const holder = await makePlane()
  try {
    const makeFrameReader = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      let buffer = ''
      return async (): Promise<any> => {
        for (;;) {
          const double = buffer.indexOf('\n\n')
          if (double !== -1) {
            const frame = buffer.slice(0, double)
            buffer = buffer.slice(double + 2)
            return JSON.parse(frame.replace(/^data: /, ''))
          }
          const { done, value } = await reader.read()
          if (done) throw new Error('stream ended before the expected frame')
          buffer += new TextDecoder().decode(value, { stream: true })
        }
      }
    }

    // Two concurrent subscribers both get the snapshot.
    const a = await fetch(`${holder.base}/api/host/health-events`)
    const b = await fetch(`${holder.base}/api/host/health-events`)
    const readerA = a.body!.getReader()
    const readerB = b.body!.getReader()
    const nextA = makeFrameReader(readerA)
    const nextB = makeFrameReader(readerB)
    assert.equal((await nextA()).dsh.status, 'stopped')
    assert.equal((await nextB()).dsh.status, 'stopped')

    // Subscriber A disappears abruptly; a transition must not throw and B
    // must still receive it (the detached listener is gone — no leak).
    await readerA.cancel()
    const start = await fetch(`${holder.base}/api/connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'local' }),
    })
    assert.equal(start.status, 200)
    assert.equal((await nextB()).dsh.status, 'starting')
    assert.equal((await nextB()).dsh.status, 'ready')

    await readerB.cancel()
  } finally {
    await holder.plane.stop()
    rmSync(holder.stateDir, { recursive: true, force: true })
  }
})

test('DELETE during an in-flight start does not resurrect the connection (2026-08 review: stop-race guard)', async () => {
  // A slow spawn (resolves only on demand) + a stop issued mid-spawn: the
  // epoch guard in startImpl must tear the late spawn down, NOT adopt it —
  // otherwise quitting during a pre-spawn leaves a detached dsh orphan that
  // resurrects the connection state after stop() returned.
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
        port: 17510,
        stop: async () => { teardownCount += 1 },
      }
    },
    describeCapabilities: async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() }),
  }
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    localConnectionDeps: { spawnDsh: wire.spawnDsh, describeCapabilities: wire.describeCapabilities },
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
    const del = await fetch(`${base}/api/connections/local`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    const mid = await fetchJson(base, '/api/connections')
    assert.equal(mid.body.connection.status, 'stopped')
    // Let the pending spawn resolve — the guard must tear it down, not adopt.
    spawnControl.release!()
    await startP
    await new Promise(resolve => setTimeout(resolve, 30))
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
