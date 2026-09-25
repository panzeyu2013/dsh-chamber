/**
 * Protocol-layer unit tests (no real dsh, no fixed ports): pending-table
 * settle-once races, timeout policy (incl. caller-signal-only), rpcId echo
 * validation, generation abort propagation (connection_offline), unknown-code
 * business error passthrough — plus the v4 host-management behaviors that
 * have no stronger duplicate elsewhere (health failure counting → degraded →
 * threshold restart) and the Unix-only detached-group reclamation / pid-ledger
 * attempts. User restarts, spawn/ready and the stop race live in
 * host-lifecycle/restart-local.test.ts, host-lifecycle/local-connection.test.ts
 * and api/manager-api.test.ts; the health-driven restart-exhausted window is
 * restart-local.test.ts:575-639. The dsh wire is mocked.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  call,
  MAX_UNARY_RESPONSE_BYTES,
  RpcBusinessError,
  RpcTransportError,
  pendingStats,
} from '../../src/dsh-client.ts'
import type { SpawnedDsh } from '../../src/local-connection.ts'
import { seedDshHomeDefaults } from '../../src/local-host-seeding.ts'

import {
  DEFAULT_DSH_START_PORT,
  DSH_WRITER_QUIESCENCE_UNKNOWN_CODE,
  managedProcessGroupAlive,
  spawnDsh,
  terminateChild,
} from '../../src/spawn-dsh.ts'
import { writePidRecord } from '../../src/pid-record.ts'
import { runReaper } from '../../src/reaper.ts'
import { absentConnection, jsonResponse, mockIdentityProbe, quietLogger, waitFor } from '../support/utils.ts'

const HOST = `http://127.0.0.1:${DEFAULT_DSH_START_PORT}`

function deferred<T = unknown>() {
  let resolve!: (value?: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = value => res(value as T)
    reject = rej
  })
  return { promise, resolve, reject }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}


/** Echo the client-request rpcId and serve the given body. */
function echoFetch(body: any): typeof globalThis.fetch {
  return async (_url, init) => {
    const sent = JSON.parse(init!.body as string)
    return jsonResponse({ type: 'server-response', rpcId: sent.rpcId, result: body })
  }
}

/** A fetch mock that never resolves until aborted (honors the signal). */
function hangingFetch(onStarted?: () => void): typeof globalThis.fetch {
  return (_url, init) => new Promise<Response>((_resolve, reject) => {
    onStarted?.()
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
}

// ---------------------------------------------------------------------------
// dsh-client: pending table, timeout policy, echo validation, generation abort
// ---------------------------------------------------------------------------

test('call echoes the minted rpcId and resolves the narrow form', async () => {
  const originalFetch = globalThis.fetch
  let sent: any
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init!.body as string)
    return jsonResponse({ type: 'server-response', rpcId: sent.rpcId, result: { ok: true, value: { items: [] } } })
  }
  try {
    const response = await call(HOST, 'session/list', {})
    assert.equal(response.rpcId, sent.rpcId)
    assert.deepEqual(response.result.value, { items: [] })
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('call rejects an oversized runtime envelope under a fixed byte cap', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('x'.repeat(MAX_UNARY_RESPONSE_BYTES + 1), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  try {
    await assert.rejects(call(HOST, 'session/list', {}), error =>
      error instanceof RpcTransportError
      && error.code === 'response_too_large'
      && error.status === 200)
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pending settle-once: timeout wins a race against a late response', async () => {
  const originalFetch = globalThis.fetch
  const late = deferred()
  const settledBefore = pendingStats().settled
  globalThis.fetch = (_url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    late.promise.then(body => resolve(jsonResponse(body)))
  })
  try {
    const attempt = call(HOST, 'session/list', {}, { timeoutMs: 30 })
    await assert.rejects(attempt, error =>
      error instanceof RpcTransportError && error.code === 'request_timeout' && error.status === 0)
    // The response arrives after the timeout: the entry is already settled,
    // so the late path is a no-op — exactly one settle, table drained.
    late.resolve({ type: 'server-response', rpcId: 'late', result: { ok: true, value: {} } })
    await sleep(60)
    const stats = pendingStats()
    assert.equal(stats.size, 0)
    assert.equal(stats.settled - settledBefore, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('timeoutMs: null disables the timer (caller-signal-only policy)', async () => {
  const originalFetch = globalThis.fetch
  const started = deferred()
  globalThis.fetch = hangingFetch(() => started.resolve())
  try {
    const caller = new AbortController()
    const attempt = call(HOST, 'directoryPicker/pick', {}, { signal: caller.signal, timeoutMs: null })
    await started.promise
    caller.abort()
    await assert.rejects(attempt, error =>
      error instanceof RpcTransportError && error.code === 'aborted' && error.status === 0)
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rpcId echo mismatch is a protocol violation', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    type: 'server-response',
    rpcId: 'not-the-sent-id',
    result: { ok: true, value: {} },
  })
  try {
    await assert.rejects(call(HOST, 'session/list', {}), error =>
      error instanceof RpcTransportError && error.code === 'protocol_violation' && error.status === 200)
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generation abort settles the in-flight unary with connection_offline', async () => {
  const originalFetch = globalThis.fetch
  const started = deferred()
  const generation = new AbortController()
  const settledBefore = pendingStats().settled
  globalThis.fetch = hangingFetch(() => started.resolve())
  try {
    const attempt = call(HOST, 'session/prompt', { sessionId: 's1' }, {
      generationSignal: generation.signal,
      timeoutMs: null,
    })
    await started.promise
    generation.abort()
    await assert.rejects(attempt, error =>
      error instanceof RpcTransportError && error.code === 'connection_offline' && error.status === 0)
    assert.equal(pendingStats().size, 0)
    assert.equal(pendingStats().settled - settledBefore, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generation abort during response-body read is not misclassified as a protocol error', async () => {
  const originalFetch = globalThis.fetch
  const bodyStarted = deferred<void>()
  const generation = new AbortController()
  globalThis.fetch = async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyStarted.resolve()
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const attempt = call(HOST, 'session/list', {}, { generationSignal: generation.signal, timeoutMs: null })
    await bodyStarted.promise
    generation.abort()
    await assert.rejects(attempt, error =>
      error instanceof RpcTransportError && error.code === 'connection_offline' && error.status === 0)
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a body completing after generation abort is never accepted as a live response', async () => {
  const originalFetch = globalThis.fetch
  const bodyStarted = deferred<void>()
  const generation = new AbortController()
  let bodyController!: ReadableStreamDefaultController<Uint8Array>
  let rpcId = ''
  globalThis.fetch = async (_url, init) => {
    rpcId = JSON.parse(init!.body as string).rpcId
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        bodyStarted.resolve()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const attempt = call(HOST, 'session/list', {}, { generationSignal: generation.signal, timeoutMs: null })
    await bodyStarted.promise
    generation.abort()
    bodyController.enqueue(new TextEncoder().encode(JSON.stringify({
      type: 'server-response', rpcId, result: { ok: true, value: {} },
    })))
    bodyController.close()
    await assert.rejects(attempt, error =>
      error instanceof RpcTransportError && error.code === 'connection_offline' && error.status === 0)
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('unknown business error code passes through code/message/details verbatim', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = echoFetch({
    ok: false,
    error: { code: 'model-42-discontinued', message: 'newer host error', details: { model: 'm-42', hint: 'select another' } },
  })
  try {
    await assert.rejects(call(HOST, 'session/prompt', { sessionId: 's1' }), error => {
      assert.ok(error instanceof RpcBusinessError)
      assert.equal(error.code, 'model-42-discontinued')
      assert.equal(error.message, 'newer host error')
      assert.equal(error.details.model, 'm-42')
      assert.equal(error.details.hint, 'select another')
      return true
    })
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('malformed error branch degrades to unknown_rpc_code instead of dropping', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = echoFetch({ ok: false, error: 'not-an-object' })
  try {
    await assert.rejects(call(HOST, 'session/list', {}), error =>
      error instanceof RpcBusinessError && error.code === 'unknown_rpc_code')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// local-connection: health counting, process reclamation, pid ledger, home seed
// ---------------------------------------------------------------------------


/**
 * A dsh port base that is free right now. spawnDsh's default base (17510) is the
 * live chamber/control-plane range: when the developer machine is already
 * running instances there, every candidate port is taken and these tests die
 * with "failed to start after 5 attempts" instead of reaching the pid-ledger
 * path they actually assert. The ledger/termination contract is port-agnostic,
 * so bind an ephemeral port and hand it over explicitly.
 */
async function freeDshPortBase(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()
    server.on('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function idleDshWorkspace(root: string): string {
  const workspace = join(root, 'runtime')
  const binDir = join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'bin.js'), 'setInterval(() => {}, 1000)\n', 'utf8')
  return workspace
}

let spawnCounter = 0
/** A spawn mock that always succeeds on a fresh port. */
function mockSpawn(): Promise<SpawnedDsh> {
  spawnCounter += 1
  return Promise.resolve({
    child: { on: () => {}, exitCode: null },
    port: 17910 + spawnCounter,
    stop: async () => {},
  })
}

test('health failures count into degraded; success resets; threshold triggers a restart', async () => {
  const probe = mockIdentityProbe()
  const connection = absentConnection({
    options: { healthIntervalMs: 30, healthProbeTimeoutMs: 1000, restartFailureThreshold: 3, failureThrottleMs: 0 },
    deps: { spawnDsh: mockSpawn, probeHostIdentity: probe.probeHostIdentity },
  })
  await connection.start()
  assert.equal(connection.getState(), 'ready')

  // First failure → degraded, counter 1.
  probe.state.healthy = false
  await waitFor(() => connection.getState() === 'degraded', 3000, 'degraded state')
  assert.equal(connection.getConsecutiveFailures(), 1)

  // Success clears the counter and returns to ready.
  probe.state.healthy = true
  await waitFor(() => connection.getState() === 'ready', 3000, 'recovery to ready')
  assert.equal(connection.getConsecutiveFailures(), 0)

  // Three consecutive failures (threshold 3) trigger the restart sequence:
  // a fresh spawn lands the machine back on ready. The restart itself is
  // fast (no backoff on the first attempt), so observe the spawn side effect
  // rather than the transient 'restarting' state.
  probe.state.healthy = false
  const before = spawnCounter
  await waitFor(() => spawnCounter > before, 5000, 'restart spawn')
  await connection.stop()
  assert.equal(connection.getState(), 'stopped')
})


test('terminateChild waits past leader exit and kills a stubborn same-group descendant', {
  skip: process.platform === 'win32' ? 'Unix detached process-group contract' : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-chamber-process-group-'))
  const marker = join(root, 'descendant.pid')
  const descendantScript = [
    "const { writeFileSync } = require('node:fs')",
    "process.on('SIGTERM', () => {})",
    "writeFileSync(process.env.DSH_TEST_DESCENDANT_MARKER, String(process.pid))",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const leaderScript = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
    'child.unref()',
    'setInterval(() => {}, 1000)',
  ].join(';')
  const leader = spawn(process.execPath, ['-e', leaderScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DSH_TEST_DESCENDANT_MARKER: marker },
  })
  const leaderPid = leader.pid
  let descendantPid = 0
  let termination: Promise<void> | null = null
  try {
    assert.ok(leaderPid !== undefined && leaderPid > 0)
    await waitFor(() => existsSync(marker), 3_000, 'stubborn descendant readiness')
    descendantPid = Number(readFileSync(marker, 'utf8'))
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0)

    const leaderExited = new Promise<void>(resolve => leader.once('exit', () => resolve()))
    termination = terminateChild(leader, 750)
    await Promise.race([
      leaderExited,
      sleep(2_000).then(() => { throw new Error('leader did not exit after process-group SIGTERM') }),
    ])
    // The default-behaviour leader exited on TERM, while the descendant's
    // installed handler deliberately ignored it. Group liveness—not the
    // leader exit event—must keep terminateChild pending here.
    assert.equal(managedProcessGroupAlive(leader), true)
    assert.doesNotThrow(() => process.kill(descendantPid, 0))

    // Startup reaping must not erase the only ledger when the leader is gone
    // but the PGID still contains an unverifiable writer. Keeping the record
    // makes localWritersQuiescent fail closed.
    const ledgerDir = join(root, 'managed-dsh')
    const ledgerPath = join(ledgerDir, `${leaderPid}.json`)
    mkdirSync(ledgerDir, { recursive: true })
    writeFileSync(ledgerPath, JSON.stringify({ pid: leaderPid }))
    const reaped = await runReaper({ stateDir: root })
    assert.deepEqual(reaped, { reclaimed: 0, kept: 1, errors: [] })
    assert.equal(existsSync(ledgerPath), true)

    await termination
    assert.equal(managedProcessGroupAlive(leader), false)
    // Zombie reaping is async (init reaps the orphaned group) — bound the
    // ESRCH wait instead of asserting a single kill(0) shot.
    await waitFor(() => {
      try { process.kill(-leaderPid, 0); return false } catch (error) {
        // Rethrow anything that is not the expected reaping signal — only
        // ESRCH means the group is gone.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        return true
      }
    }, 2_000, 'leader process group reaped')
    await waitFor(() => {
      try { process.kill(descendantPid, 0); return false } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        return true
      }
    }, 2_000, 'descendant reaped')
  } finally {
    await termination?.catch(() => undefined)
    if (leaderPid !== undefined) {
      try { process.kill(-leaderPid, 'SIGKILL') } catch { /* already gone */ }
    }
    if (descendantPid > 0) {
      try { process.kill(descendantPid, 'SIGKILL') } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})


test('unproven attempt termination aborts port retries and preserves the pid ledger', {
  skip: process.platform === 'win32' ? 'Unix detached process-group contract' : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-chamber-residual-writer-'))
  const workspace = idleDshWorkspace(root)
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  const controller = new AbortController()
  let writerCalls = 0
  let childPid = 0
  try {
    await assert.rejects(spawnDsh({
      stateDir,
      dshHome: join(root, 'dsh-home'),
      dshWorkspacePath: workspace,
      dshPortBase: await freeDshPortBase(),
      logger: quietLogger,
      signal: controller.signal,
      pidRecordWriter(...args) {
        writerCalls += 1
        childPid = args[1]
        writePidRecord(...args)
        controller.abort()
      },
      terminateChildFn: async () => { throw new Error('simulated residual process group') },
    }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, DSH_WRITER_QUIESCENCE_UNKNOWN_CODE)
      return true
    })
    assert.equal(writerCalls, 1, 'unknown residual writer aborts the port retry loop')
    assert.ok(childPid > 0)
    assert.equal(existsSync(join(stateDir, 'managed-dsh', `${childPid}.json`)), true)
    assert.doesNotThrow(() => process.kill(-childPid, 0), 'injected failed termination leaves the test writer live')
  } finally {
    if (childPid > 0) {
      try { process.kill(-childPid, 'SIGKILL') } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})


test('seedDshHomeDefaults writes a zh locale default once and never touches an existing document', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-chamber-seed-'))
  try {
    const dshHome = join(root, 'dsh-home')
    mkdirSync(dshHome, { recursive: true })

    // First run: the seed lands and the document parses as locale.preference=zh.
    assert.equal(seedDshHomeDefaults(dshHome), true)
    assert.equal(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'), 'locale:\n  preference: zh\n')

    // Second call: idempotent, no rewrite.
    assert.equal(seedDshHomeDefaults(dshHome), false)
    assert.equal(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'), 'locale:\n  preference: zh\n')

    // dsh 0.1.7 moves the legacy document after importing it into the profile.
    // A later spawn must not recreate it and overwrite the user's current locale.
    rmSync(join(dshHome, 'settings.yaml'))
    writeFileSync(join(dshHome, 'settings.yaml.imported'), 'locale:\n  preference: zh\n')
    assert.equal(seedDshHomeDefaults(dshHome), false)
    assert.equal(existsSync(join(dshHome, 'settings.yaml')), false)

    // A user's own document is never touched.
    const custom = join(root, 'custom-home')
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'settings.yaml'), 'locale:\n  preference: en\n', { mode: 0o600 })
    assert.equal(seedDshHomeDefaults(custom), false)
    assert.equal(readFileSync(join(custom, 'settings.yaml'), 'utf8'), 'locale:\n  preference: en\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('seedDshHomeDefaults refuses a symlinked home and never writes through an existing settings leaf', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-chamber-seed-link-'))
  try {
    const outsideHome = join(root, 'outside-home')
    const linkedHome = join(root, 'linked-home')
    mkdirSync(outsideHome)
    symlinkSync(outsideHome, linkedHome, 'dir')
    assert.throws(() => seedDshHomeDefaults(linkedHome), /not a real directory/)
    assert.equal(existsSync(join(outsideHome, 'settings.yaml')), false)

    const realHome = join(root, 'real-home')
    const victim = join(root, 'settings-victim')
    mkdirSync(realHome)
    writeFileSync(victim, 'DO-NOT-TOUCH', { mode: 0o600 })
    symlinkSync(victim, join(realHome, 'settings.yaml'))
    assert.equal(seedDshHomeDefaults(realHome), false)
    assert.equal(readFileSync(victim, 'utf8'), 'DO-NOT-TOUCH')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
