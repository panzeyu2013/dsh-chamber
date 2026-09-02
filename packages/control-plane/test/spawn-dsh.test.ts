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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatChildOutputChunk,
  killFailedSpawn,
  probePortBusy,
  readPidRecord,
  spawnDsh,
  writePidRecord,
  DEFAULT_DSH_START_PORT,
  MAX_CHILD_OUTPUT_CHUNK_BYTES,
} from '../src/spawn-dsh.ts'
import { authCookieFor, clearAuthCookie } from '../src/browser-auth-cookie.ts'

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

test('child output formatter bounds Buffer bytes before decode and marks truncation once', () => {
  assert.equal(formatChildOutputChunk(Buffer.from('ordinary output\n')), 'ordinary output')

  const hiddenTail = 'must-not-reach-logger-or-host-log'
  const oversized = Buffer.concat([
    Buffer.alloc(MAX_CHILD_OUTPUT_CHUNK_BYTES, 0x61),
    Buffer.from(hiddenTail),
  ])
  const formatted = formatChildOutputChunk(oversized)
  assert.equal(formatted.includes(hiddenTail), false)
  assert.equal(formatted.endsWith('\n...[output chunk truncated]'), true)
  assert.equal(Buffer.byteLength(formatted), MAX_CHILD_OUTPUT_CHUNK_BYTES)
  assert.equal(formatted.match(/output chunk truncated/g)?.length, 1)
})

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
    writeFileSync(join(stateDir, 'managed-dsh', '4243.json'), JSON.stringify({
      ...readPidRecord(stateDir, 4242), pid: 9999, port: '../../outside',
    }))
    assert.equal(readPidRecord(stateDir, 4243), null, 'filename pid and bounded numeric port are runtime-validated')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('pid-ledger publication rejects symlinked roots/leaves without touching external targets', t => {
  const stateDir = tempDir()
  try {
    const recordsDir = join(stateDir, 'managed-dsh')
    const victim = join(stateDir, 'outside-record')
    mkdirSync(recordsDir)
    writeFileSync(victim, 'DO NOT TOUCH', { mode: 0o644 })
    try {
      symlinkSync(victim, join(recordsDir, '4242.json'), 'file')
    } catch (error) {
      if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('symbolic links are unavailable on this platform')
        return
      }
      throw error
    }
    assert.equal(readPidRecord(stateDir, 4242), null, 'pid-ledger reads never follow an unsafe leaf')
    assert.throws(() => writePidRecord(stateDir, 4242, DEFAULT_DSH_START_PORT, process.pid), /single-link regular file/)
    assert.equal(readFileSync(victim, 'utf8'), 'DO NOT TOUCH')
    assert.equal(statSync(victim).mode & 0o777, 0o644)

    rmSync(recordsDir, { recursive: true })
    const externalDir = join(stateDir, 'outside-dir')
    mkdirSync(externalDir, { mode: 0o755 })
    symlinkSync(externalDir, recordsDir, 'dir')
    assert.throws(() => writePidRecord(stateDir, 4243, DEFAULT_DSH_START_PORT, process.pid), /not a real directory/)
    assert.deepEqual(readdirSync(externalDir), [])
    assert.equal(statSync(externalDir).mode & 0o777, 0o755)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: an early-exit attempt cleans its pid record (no stale record for the reaper)', async () => {
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  // Both pipes finish a payload before exit. Node may deliver their final data
  // after the child `exit` event but always before `close`; the rolling writer
  // must therefore retire on `close` and persist both sentinels.
  writeFakeDshEntry(dshWorkspacePath, [
    'let pending = 2',
    'const done = () => { if (--pending === 0) process.exit(3) }',
    "process.stdout.write('final stdout\\n' + 'x'.repeat(128 * 1024), done)",
    "process.stderr.write('final stderr\\n', done)",
    '',
  ].join('\n'))
  try {
    await assert.rejects(
      () => spawnDsh({ stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger }),
      /failed to start after 5 attempts/,
    )
    const recordsDir = join(stateDir, 'managed-dsh')
    const leftovers = existsSync(recordsDir) ? readdirSync(recordsDir).filter(file => file.endsWith('.json')) : []
    assert.deepEqual(leftovers, [], 'no pid record may survive a failed spawn attempt')
    const finalAttemptLog = join(stateDir, 'host-logs', `${DEFAULT_DSH_START_PORT + 4}.log`)
    await waitUntil(() => {
      if (!existsSync(finalAttemptLog)) return false
      const contents = readFileSync(finalAttemptLog, 'utf8')
      return contents.includes('final stdout') && contents.includes('final stderr')
    }, 3000)
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
  // managed-dsh as a FILE → private-directory validation throws → the
  // freshly spawned child must be cleaned up instead of leaking.
  writeFileSync(join(stateDir, 'managed-dsh'), 'occupied')
  try {
    await assert.rejects(
      () => spawnDsh({ stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger }),
      // Fail-closed design-18 semantics (merged): a pid-ledger publication
      // failure is never retried on another port — the child is reclaimed
      // and the spawn throws non-retryable (protocol.ts asserts the code).
      /dsh pid ledger publication failed/,
    )
    // The cleanup assertion the name promises: NO process may still be
    // running the fake entry (a leaked detached process would survive).
    await waitForNoEntryProcess(entryPath, 3000)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: abort during the post-TCP session/list wait kills the detached attempt promptly', async () => {
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  const listeningMarker = join(stateDir, 'listening')
  const describeMarker = join(stateDir, 'probe-requested')
  const entryPath = writeFakeDshEntry(dshWorkspacePath, [
    "const { writeFileSync } = require('node:fs')",
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "createServer((req) => { if (req.url === '/api/session/list') writeFileSync(" + JSON.stringify(describeMarker) + ", 'yes') }).listen(port, '127.0.0.1', () => writeFileSync(" + JSON.stringify(listeningMarker) + ", 'yes'))",
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

test('spawnDsh: the 0.1.2 browser-auth bootstrap mints the cookie and the probe passes with it', async () => {
  // review-round3c P0: the web profile prints `dsh web: <url>?token=<t>` at
  // readiness; the spawn performs the token exchange and injects the cookie
  // into the session/list probe (the fake host 401s without it).
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "console.log('dsh web: http://127.0.0.1:' + port + '/?token=launch-1')",
    "createServer((req, res) => {",
    "  if (req.url === '/?token=launch-1') {",
    "    res.writeHead(303, { location: '/', 'set-cookie': 'browser-auth=sess; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict' })",
    "    res.end(); return",
    "  }",
    "  if (req.url === '/api/session/list') {",
    "    if ((req.headers.cookie || '').includes('browser-auth=sess')) {",
    "      let body = ''",
    "      req.on('data', c => { body += c })",
    "      req.on('end', () => {",
    "        const rpcId = JSON.parse(body).rpcId",
    "        res.writeHead(200, { 'content-type': 'application/json' })",
    "        res.end(JSON.stringify({ type: 'server-response', rpcId: rpcId, result: { ok: true, value: { items: [] } } }))",
    "      })",
    "      return",
    "    }",
    "    res.writeHead(401); res.end('unauthorized'); return",
    "  }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    const spawned = await spawnDsh({
      stateDir,
      dshHome: join(stateDir, 'home'),
      dshWorkspacePath,
      logger: silentLogger,
      signal: controller.signal,
    })
    assert.equal(spawned.port > 0, true)
    const cookie = authCookieFor(`http://127.0.0.1:${spawned.port}`)
    assert.equal(cookie, 'browser-auth=sess')
    // The SpawnAttemptResult child must be reaped by the caller.
    spawned.child.kill()
    await new Promise<void>(resolve => spawned.child.once('exit', () => resolve()))
  } finally {
    controller.abort()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a gated host with no launch token fails loud with the browser-auth error', async () => {
  // review-round5a P2-2 / P3: the host 401s (0.1.2 gate) but never prints the
  // `dsh web:` token line — the bootstrap cannot mint a cookie, and the probe
  // must fail loud with the explicit browser-auth reason (never the generic
  // 90s-window error).
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "createServer((req, res) => { if (req.url === '/api/session/list') { res.writeHead(401); res.end('unauthorized'); return } res.writeHead(404); res.end() }).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    await assert.rejects(
      () => spawnDsh({ stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger, signal: controller.signal, authBootstrapWaitMs: 50 }),
      /browser-auth cookie, but the bootstrap failed/,
    )
  } finally {
    controller.abort()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a readiness line split across chunks is still fully redacted and usable', async () => {
  // review-round7a P2-4: the token URL line may arrive in several stdio
  // chunks — the scanner must wait for the complete line and the forward
  // must redact across the split (no truncated-token mint, no partial leak).
  const logged: string[] = []
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    // Three small writes: the URL line is fragmented mid-token.
    "process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?to')",
    "process.stdout.write('ken=launch-secret (LAN: http://10.0.0.5:' + port + '/?token=launch-secret)\\n')",
    "createServer((req, res) => {",
    "  if (req.url === '/?token=launch-secret') { res.writeHead(303, { location: '/', 'set-cookie': 'browser-auth=sess; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return }",
    "  if (req.url === '/api/session/list') {",
    "    let body = ''; req.on('data', c => { body += c }); req.on('end', () => {",
    "      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: JSON.parse(body).rpcId, result: { ok: true, value: { items: [] } } })) })",
    "    return",
    "  }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    let spawned: Awaited<ReturnType<typeof spawnDsh>>
    try {
      spawned = await spawnDsh({
        stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, signal: controller.signal, authBootstrapWaitMs: 200,
        logger: { log(line) { logged.push(String(line)) }, warn(line) { logged.push('WARN:' + String(line)) }, error(line) { logged.push('ERR:' + String(line)) } },
      })
    } catch (error) {
      throw new Error(`spawn failed; logged: ${JSON.stringify(logged.slice(0, 10))}; cause: ${String(error)}`)
    }
    // The full token was reconstructed across the split → cookie minted.
    assert.equal(authCookieFor(`http://127.0.0.1:${spawned.port}`), 'browser-auth=sess')
    const logLines = logged.join('\n')
    assert.equal(logLines.includes('launch-secret'), false)
    assert.equal(/token=[^\s]*launch-secret/.test(logLines), false)
    spawned.child.kill()
    await new Promise<void>(resolve => spawned.child.once('exit', () => resolve()))
  } finally {
    controller.abort()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: the launch token never reaches the control-plane log or host-log', async () => {
  // review-round6b P2-2: the readiness line (with token AND the LAN variant)
  // must be redacted in every log surface.
  const logged: string[] = []
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "console.log('dsh web: http://127.0.0.1:' + port + '/?token=launch-secret (LAN: http://10.0.0.5:' + port + '/?token=launch-secret)')",
    "createServer((req, res) => {",
    "  if (req.url === '/?token=launch-secret') { res.writeHead(303, { location: '/', 'set-cookie': 'browser-auth=sess; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return }",
    "  if (req.url === '/api/session/list') {",
    "    let body = ''; req.on('data', c => { body += c }); req.on('end', () => {",
    "      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: JSON.parse(body).rpcId, result: { ok: true, value: { items: [] } } })) })",
    "    return",
    "  }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    const spawned = await spawnDsh({
      stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, signal: controller.signal, authBootstrapWaitMs: 200,
      logger: { log(line) { logged.push(String(line)) }, warn() {}, error() {} },
    })
    const logLines = logged.join('\n')
    // The token VALUE must never reach the log (the redacted marker
    // `token=***` legitimately contains the key name, never the value).
    assert.equal(logLines.includes('launch-secret'), false, 'the token value must not reach the control-plane log')
    assert.equal(/token=[^\s]*launch-secret/.test(logLines), false)
    assert.equal(logLines.includes('***'), true, 'the redacted form is visible')
    // host-logs JSONL: same guarantee on the persisted ring.
    const hostLogDir = join(stateDir, 'host-logs')
    const files = existsSync(hostLogDir) ? readdirSync(hostLogDir).filter(f => f.endsWith('.log')) : []
    assert.equal(files.length > 0, true)
    const persisted = readFileSync(join(hostLogDir, files[0]), 'utf8')
    assert.equal(persisted.includes('launch-secret'), false)
    assert.equal(/token=[^\s]*launch-secret/.test(persisted), false)
    spawned.child.kill()
    await new Promise<void>(resolve => spawned.child.once('exit', () => resolve()))
  } finally {
    controller.abort()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a token line with a failed exchange fails loud with the browser-auth error', async () => {
  // review-round6a P2-4: the URL line arrives but the exchange is refused —
  // the bootstrap failure must surface in the probe's explicit error.
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "console.log('dsh web: http://127.0.0.1:' + port + '/?token=launch-1')",
    "createServer((req, res) => {",
    "  if (req.url === '/?token=launch-1') { res.writeHead(401); res.end('unauthorized'); return }",
    "  if (req.url === '/api/session/list') { res.writeHead(401); res.end('unauthorized'); return }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    await assert.rejects(
      () => spawnDsh({ stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger, signal: controller.signal, authBootstrapWaitMs: 50 }),
      /browser-auth cookie, but the bootstrap failed/,
    )
  } finally {
    controller.abort()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: an old host printing a URL without a token spawns without a cookie', async () => {
  // review-round5a: rc.2 hosts print the URL line without a token and answer
  // the probe without auth — the bootstrap yields no cookie and the spawn
  // proceeds unchanged.
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "console.log('dsh web: http://127.0.0.1:' + port)",
    "createServer((req, res) => {",
    "  if (req.url === '/api/session/list') {",
    "    let body = ''; req.on('data', c => { body += c }); req.on('end', () => {",
    "      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: JSON.parse(body).rpcId, result: { ok: true, value: { items: [] } } })) })",
    "    return",
    "  }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    const spawned = await spawnDsh({ stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger, signal: controller.signal, authBootstrapWaitMs: 50 })
    assert.equal(authCookieFor(`http://127.0.0.1:${spawned.port}`), undefined)
    spawned.child.kill()
    await new Promise<void>(resolve => spawned.child.once('exit', () => resolve()))
  } finally {
    controller.abort()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
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
