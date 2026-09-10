/**
 * Writer-quiescence latch recovery (2026-09-10, design 02 §3.4 / 04 §3.2).
 *
 * The startup scan opens the latch only when nothing is kept and no probe
 * failed. Before this revision a record that merely BECAME stale afterwards —
 * the orphaned managed host exited, or the ps identity probe was unavailable
 * at startup — kept the latch closed for the whole plane lifecycle: every
 * POST /api/connections answered 409 connection_busy, the in-app 启动/停止
 * buttons did nothing, and the documented recovery was "restart the app".
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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlPlane } from '../src/index.ts'
import { fakeWire, fetchJson } from './utils.ts'

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
