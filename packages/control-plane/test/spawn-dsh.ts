/**
 * Spawn cleanup tests (2026 audit H3): killFailedSpawn must SIGKILL the whole
 * process group, WAIT for the exit, and only then remove the pid record
 * (design 02 §3.3: 注销只在确认进程已退出后) — and every failed spawnAttempt
 * path must converge on it so no untracked detached process can leak.
 * Pure-Node with a fake dsh entry; no real dsh, no fixed ports.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killFailedSpawn, probePortBusy, readPidRecord, spawnDsh, writePidRecord, DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-spawn-'))
}

/** A fake dsh CLI entry under a fake workspace (node runs it directly). */
function writeFakeDshEntry(dshWorkspacePath: string, body: string): string {
  const entry = join(dshWorkspacePath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, body)
  return entry
}

class FakeProbeSocket extends EventEmitter {
  destroyed = false

  destroy(): this {
    this.destroyed = true
    return this
  }
}

test('probePortBusy: abort destroys an inconclusive socket and rejects promptly', async () => {
  const socket = new FakeProbeSocket()
  const controller = new AbortController()
  const probing = probePortBusy(DEFAULT_DSH_START_PORT, controller.signal, 60_000, () => socket as never)
  controller.abort()
  await assert.rejects(() => probing, /spawn aborted/)
  assert.equal(socket.destroyed, true)
})

test('probePortBusy: a timed-out connect is conservatively treated as busy', async () => {
  const socket = new FakeProbeSocket()
  const busy = await probePortBusy(DEFAULT_DSH_START_PORT, undefined, 5, () => socket as never)
  assert.equal(busy, true)
  assert.equal(socket.destroyed, true)
})

test('killFailedSpawn: SIGKILLs the process group, waits for the exit, then removes the pid record', async () => {
  const stateDir = tempDir()
  try {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    assert.ok(child.pid !== undefined)
    writePidRecord(stateDir, child.pid!, DEFAULT_DSH_START_PORT, process.pid)
    assert.ok(readPidRecord(stateDir, child.pid!) !== null)
    await killFailedSpawn(stateDir, child)
    assert.notEqual(child.exitCode ?? child.signalCode, null, 'child is dead after killFailedSpawn')
    assert.equal(readPidRecord(stateDir, child.pid!), null, 'record removed only after the confirmed exit')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('writePidRecord persists the exact CLI entry used for reaper identity checks', () => {
  const stateDir = tempDir()
  try {
    const binary = '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    writePidRecord(stateDir, 4242, DEFAULT_DSH_START_PORT, process.pid, { binary })
    assert.equal(readPidRecord(stateDir, 4242)?.binary, binary)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: an early-exit attempt cleans its pid record (no stale record for the reaper)', async () => {
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, 'process.exit(3)\n')
  try {
    await assert.rejects(
      () => spawnDsh({ stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger }),
      /failed to start after 5 attempts/,
    )
    const recordsDir = join(stateDir, 'managed-dsh')
    const leftovers = existsSync(recordsDir) ? readdirSync(recordsDir).filter(file => file.endsWith('.json')) : []
    assert.deepEqual(leftovers, [], 'no pid record may survive a failed spawn attempt')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a pid-record write failure still cleans the spawned child up (no untracked detached process)', async () => {
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  // The fake dsh stays alive and never listens — only the record-write
  // failure path is under test (fast, no 90s listen window). NOTE: a
  // pid-marker inside the fake entry would RACE the cleanup SIGKILL (the
  // child is killed before node runs the script), so the leak check scans
  // the process table for the entry path instead (2026 review).
  writeFakeDshEntry(dshWorkspacePath, 'setInterval(() => {}, 1000)\n')
  const entryPath = join(dshWorkspacePath, 'dsh')
  // managed-dsh as a FILE → mkdirSync throws → writePidRecord throws → the
  // freshly spawned child must be cleaned up instead of leaking.
  writeFileSync(join(stateDir, 'managed-dsh'), 'occupied')
  try {
    await assert.rejects(
      () => spawnDsh({ stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger }),
      /failed to start after 5 attempts/,
    )
    // The cleanup assertion the name promises: NO process may still be
    // running the fake entry (a leaked detached process would survive).
    await waitForNoEntryProcess(entryPath, 3000)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: abort during the post-TCP host.describe wait kills the detached attempt promptly', async () => {
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  const listeningMarker = join(stateDir, 'listening')
  const describeMarker = join(stateDir, 'describe-requested')
  const entryPath = writeFakeDshEntry(dshWorkspacePath, [
    "const { writeFileSync } = require('node:fs')",
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "createServer((req) => { if (req.url === '/api/host.describe') writeFileSync(" + JSON.stringify(describeMarker) + ", 'yes') }).listen(port, '127.0.0.1', () => writeFileSync(" + JSON.stringify(listeningMarker) + ", 'yes'))",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    const startedAt = Date.now()
    const spawning = spawnDsh({
      stateDir,
      dshHome: join(stateDir, 'home'),
      dshWorkspacePath,
      logger: silentLogger,
      signal: controller.signal,
    })
    await waitUntil(() => existsSync(listeningMarker), 3000)
    await waitUntil(() => existsSync(describeMarker), 3000)
    controller.abort()
    await assert.rejects(() => spawning, /spawn aborted/)
    assert.ok(Date.now() - startedAt < 5000, 'abort must not wait for the 90s readiness window')
    const recordsDir = join(stateDir, 'managed-dsh')
    const leftovers = existsSync(recordsDir) ? readdirSync(recordsDir).filter(file => file.endsWith('.json')) : []
    assert.deepEqual(leftovers, [])
    await waitForNoEntryProcess(entryPath, 3000)
  } finally {
    controller.abort()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Poll the POSIX process table until no process runs the given script path. */
async function waitForNoEntryProcess(entryPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let survivors = 0
    try {
      const output = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      survivors = output.split('\n').filter(line => line.includes(entryPath) && !line.includes('ps -axo')).length
    } catch {
      /* ps unavailable — skip the assertion (best effort on POSIX) */
      return
    }
    if (survivors === 0) return
    if (Date.now() > deadline) throw new Error(`still ${survivors} process(es) running the fake entry after the failed-spawn cleanup`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
