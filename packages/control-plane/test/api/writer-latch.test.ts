/**
 * Writer-quiescence latch recovery (design 02 §3.4 / 04 §3.2).
 *
 * The startup scan opens the latch only when nothing is kept and no probe
 * failed. A record that merely BECOMES stale afterwards — the orphaned
 * managed host exited, or the ps identity probe was unavailable at startup —
 * must not keep the latch closed for the whole plane lifecycle: that state
 * answers every POST /api/connections with 409 connection_busy, leaves the
 * in-app 启动/停止 buttons doing nothing, and the documented recovery is
 * "restart the app".
 *
 * Covered here: the re-proof a refused start performs (the recovery that needs
 * no user action), the structured 409 detail, the read-only diagnosis, and the
 * explicit 清理并接管 action (takeover scan + start, and its refusal when a
 * writer whose control plane is still alive remains).
 *
 * The writer scan itself is scripted through createControlPlane's `reaper`
 * seam, so these tests pin the LATCH behavior; reaper's own verdicts and the
 * takeover proofs are covered by reaper.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlPlane } from '../../src/index.ts'
import type { SpawnedDsh } from '../../src/local-connection.ts'
import { DSH_WRITER_QUIESCENCE_UNKNOWN_CODE } from '../../src/spawn-dsh.ts'
import { fakeWire, fetchJson, waitFor } from '../support/utils.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

interface ScanScript {
  kept?: number
  reclaimed?: number
  errors?: string[]
  entries?: Array<{ name: string; status: string; pid: number | null; reason: string; takeOverAvailable: boolean }>
}

/** A plane whose writer scans consume `scans` in order (the first is startup). */
async function makePlane(scans: ScanScript[]) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-latch-'))
  const wire = fakeWire()
  const calls: Array<{ takeover: boolean }> = []
  const reaper = async (options: { takeover?: boolean; onEntry?: (o: unknown) => void }) => {
    const script = scans.shift() ?? { kept: 0, reclaimed: 0, errors: [] }
    calls.push({ takeover: options.takeover === true })
    for (const entry of script.entries ?? []) options.onEntry?.(entry)
    return { reclaimed: script.reclaimed ?? 0, kept: script.kept ?? 0, errors: script.errors ?? [] }
  }
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    reaper: reaper as never,
    localConnectionDeps: { spawnDsh: wire.spawnDsh, probeHostIdentity: wire.probeHostIdentity },
  })
  try {
    await plane.start()
  } catch (error) {
    rmSync(stateDir, { recursive: true, force: true })
    throw error
  }
  return {
    plane,
    wire,
    calls,
    stateDir,
    base: `http://127.0.0.1:${plane.port}`,
    dispose: () => { rmSync(stateDir, { recursive: true, force: true }) },
  }
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const blockedEntry = {
  name: '4242.json', status: 'kept', pid: 4242, reason: 'identity-unverified', takeOverAvailable: true,
}

test('writer latch: a start re-proves quiescence and recovers once the orphan is gone', async () => {
  // startup: blocked by a record whose owner died since; the refused start
  // re-proves and finds the record gone → the instance starts with no user
  // action and without an app restart.
  const holder = await makePlane([{ kept: 1, entries: [blockedEntry] }, { reclaimed: 1 }])
  try {
    const { status, body } = await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(holder.calls.length, 2, 'the refused start performs exactly one re-proof scan')
    assert.deepEqual(holder.calls.map(call => call.takeover), [false, false],
      'the automatic re-proof never takes over')
    assert.equal(holder.wire.spawns, 1, 'the recovered start spawned the instance')
  } finally {
    await holder.plane.stop()
    holder.dispose()
  }
})

test('writer latch: a still-blocked start answers 409 with the structured blockers', async () => {
  const holder = await makePlane([{ kept: 1, entries: [blockedEntry] }, { kept: 1, entries: [blockedEntry] }])
  try {
    const { status, body } = await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(status, 409)
    assert.equal(body.code, 'connection_busy')
    assert.match(body.error, /pid 4242 \(identity-unverified\)/)
    assert.deepEqual(body.detail, { writers: [blockedEntry], errors: [], sticky: false })
    assert.equal(holder.wire.spawns, 0, 'a blocked plane must never spawn')
  } finally {
    await holder.plane.stop()
    holder.dispose()
  }
})

test('writer latch: the diagnosis route reports the last scan read-only', async () => {
  const holder = await makePlane([
    { kept: 1, entries: [blockedEntry] },   // startup
    { kept: 1, entries: [blockedEntry] },   // the refused start's re-proof
  ])
  try {
    const rejected = await fetchJson(holder.base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(rejected.status, 409)
    const scans = holder.calls.length
    const { status, body } = await fetchJson(holder.base, '/api/connections/local/writers')
    assert.equal(status, 200)
    assert.equal(body.quiescent, false)
    assert.deepEqual(body.writers, [blockedEntry])
    assert.deepEqual(body.errors, [])
    assert.equal(holder.calls.length, scans, 'the diagnosis read must not re-scan')
  } finally {
    await holder.plane.stop()
    holder.dispose()
  }
})

test('writer latch: 清理并接管 takes over and starts, and reports what it cleared', async () => {
  const holder = await makePlane([
    { kept: 1, entries: [blockedEntry] },                                     // startup
    { reclaimed: 1, entries: [{ ...blockedEntry, status: 'reclaimed', reason: 'takeover-reclaimed' }] }, // takeover
  ])
  try {
    const { status, body } = await fetchJson(holder.base, '/api/connections/local/reclaim', { method: 'POST' })
    assert.equal(status, 200, JSON.stringify(body))
    assert.deepEqual(body.reclaimed, [4242])
    assert.equal(body.spawned, true)
    assert.equal(body.connection.id, 'local')
    assert.deepEqual(holder.calls.map(call => call.takeover), [false, true],
      'only the explicit action runs the takeover scan')
    assert.equal(holder.wire.spawns, 1)
  } finally {
    await holder.plane.stop()
    holder.dispose()
  }
})

test('writer latch: 清理并接管 refuses while a writer whose owner is alive remains', async () => {
  const liveForeign = { ...blockedEntry, reason: 'live-foreign-writer', takeOverAvailable: false }
  const holder = await makePlane([
    { kept: 1, entries: [liveForeign] },   // startup
    { kept: 1, entries: [liveForeign] },   // takeover: nothing it may touch
    { kept: 1, entries: [liveForeign] },   // the start's own re-proof
  ])
  try {
    const { status, body } = await fetchJson(holder.base, '/api/connections/local/reclaim', { method: 'POST' })
    assert.equal(status, 409)
    assert.equal(body.code, 'connection_busy')
    assert.deepEqual(body.detail.writers, [liveForeign])
    assert.equal(holder.wire.spawns, 0)
  } finally {
    await holder.plane.stop()
    holder.dispose()
  }
})

// ---------------------------------------------------------------------------
// v2 A slice — the exit-proof contract on the assembled plane. A writer-unknown retire
// is a fail-closed terminal state: it latches the plane, keeps the suspect named in the
// diagnosis, never publishes restart-exhausted, and surfaces as typed REST failures.
// ---------------------------------------------------------------------------

/** A coded writer-quiescence-unknown error shaped like the spawn layer's (pid attached). */
function codedWriterUnknown(pid: number): Error & { code: string; pid: number } {
  return Object.assign(new Error('process group termination could not be proven'), {
    code: DSH_WRITER_QUIESCENCE_UNKNOWN_CODE,
    pid,
  })
}

/** A fake managed host whose exit listener can be fired and whose stop is scripted. */
function planeChild(port: number, pid: number, stop: () => Promise<void>): {
  spawned: SpawnedDsh
  fireExit: (code: number | null, sig: string | null) => void
} {
  const emitter = new EventEmitter()
  const child = Object.assign(emitter, { exitCode: null as number | null, signalCode: null as string | null })
  const spawned: SpawnedDsh = { child, port, pid, stop }
  return {
    spawned,
    fireExit: (code, sig) => {
      child.exitCode = code
      emitter.emit('exit', code, sig)
    },
  }
}

test('writer latch: an unproven stop() rejects with its typed error, latches, and answers 409/409+detail', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-stop-proof-'))
  const coded = codedWriterUnknown(4242)
  let spawns = 0
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    hostGraphPackageSourceDir: join(stateDir, 'missing-graph-package'),
    hostGitWorktreePackageSourceDir: join(stateDir, 'missing-git-package'),
    localConnectionDeps: {
      spawnDsh: async () => {
        spawns += 1
        return planeChild(17510, 4242, async () => { throw coded }).spawned
      },
      probeHostIdentity: async () => true,
    },
  })
  try {
    await plane.start()
    await plane.startLocal()
    assert.equal(plane.connectionState, 'ready')

    const failure = await plane.stopLocal().then(() => null, (error: unknown) => error)
    assert.equal(failure, coded, 'stopLocal surfaces the SAME typed writer-unknown error')
    assert.equal(plane.connectionState, 'error', 'an unproven writer never reports stopped')
    assert.equal(plane.localWritersQuiescent, false, 'the writer latch is sticky after an unproven stop')
    assert.equal(plane.localProcessAlive, true, 'the retained suspect counts as possibly alive')

    const base = `http://127.0.0.1:${plane.port}`
    const rejected = await fetchJson(base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.code, 'connection_busy')
    assert.equal(spawns, 1, 'a refused start never spawns behind the latch')

    const deleted = await fetchJson(base, '/api/connections/local', { method: 'DELETE' })
    assert.equal(deleted.status, 409, 'DELETE maps the writer-unknown to a coded 409, never a masked 500')
    assert.equal(deleted.body.code, DSH_WRITER_QUIESCENCE_UNKNOWN_CODE)
    assert.equal(deleted.body.detail?.pid, 4242, 'the 409 carries the suspect identity')
  } finally {
    // The contract says stop() fails while the writer is unproven; the cleanup swallows it.
    await plane.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('writer latch: an exhausted restart with an unproven retire stays error and freezes the spawn count', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-exhaust-proof-'))
  const children: Array<ReturnType<typeof planeChild>> = []
  let spawns = 0
  const coded = codedWriterUnknown(77002)
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: silentLogger,
    hostGraphPackageSourceDir: join(stateDir, 'missing-graph-package'),
    hostGitWorktreePackageSourceDir: join(stateDir, 'missing-git-package'),
    localConnectionOptions: { healthIntervalMs: 0, maxRestartsInWindow: 1 },
    localConnectionDeps: {
      spawnDsh: async () => {
        spawns += 1
        const child = planeChild(17510 + spawns, 77000 + spawns, spawns === 2 ? async () => { throw coded } : async () => {})
        children.push(child)
        return child.spawned
      },
      probeHostIdentity: async () => true,
    },
  })
  try {
    await plane.start()
    await plane.startLocal()
    children[0]!.fireExit(1, null)
    await waitFor(() => spawns === 2 && plane.connectionState === 'ready', 3000, 'ready after the first restart')
    children[1]!.fireExit(1, null)
    await waitFor(() => plane.connectionState === 'error', 3000, 'error after the unproven exhaustion retire')

    assert.notEqual(plane.connectionState, 'restart-exhausted', 'restart-exhausted follows a PROVEN retire only')
    assert.equal(spawns, 2, 'the unproven retire never respawns')
    assert.equal(plane.localWritersQuiescent, false)

    const base = `http://127.0.0.1:${plane.port}`
    const health = await fetchJson(base, '/health')
    assert.equal(health.body.dsh.status, 'error', '/health never shows "starting" for a terminal writer failure')

    const rejected = await fetchJson(base, '/api/connections', postJson({ kind: 'local' }))
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.code, 'connection_busy')
    assert.equal(spawns, 2, 'the refused start never spawns')

    const diagnosis = await fetchJson(base, '/api/connections/local/writers')
    assert.equal(diagnosis.status, 200)
    assert.equal(diagnosis.body.quiescent, false)
    assert.equal(diagnosis.body.writers[0]?.pid, 77002, 'the suspect pid is named in the diagnosis')
    assert.equal(diagnosis.body.writers[0]?.reason, 'residual-group')
  } finally {
    await plane.stop().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true })
  }
})
