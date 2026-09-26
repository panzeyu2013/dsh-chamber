/**
 * Spawn lifecycle tests: every failed spawnAttempt path must converge on the
 * production cleanup — terminateAndProveQuiet (process-group kill → prove
 * quiescence → pid-record removal; design 02 §3.3: 注销只在确认进程已退出后) —
 * so no untracked detached process can leak. The child-output forwarding
 * contract is exercised through the REAL spawn path — raw bytes preserved for
 * line splitting/redaction and a bounded incomplete-line carry — never through
 * a standalone formatter (none exists).
 * Pure-Node with a fake dsh entry; no real dsh. Ports come from an ephemeral
 * bind so the suite does not depend on 17510+ being free on the developer machine.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  probePortBusy,
  resolveSpawnCwd,
  spawnDsh,
  DEFAULT_DSH_START_PORT,
  DSH_SPAWN_ATTEMPTS_EXHAUSTED_CODE,
  DshSpawnExhaustedError,
  MAX_CHILD_OUTPUT_CHUNK_BYTES,
  MAX_SPAWN_ATTEMPTS,
} from '../../src/spawn-dsh.ts'
import { readPidRecord, writePidRecord } from '../../src/pid-record.ts'
import { authCookieFor, clearAuthCookie, exchangeLaunchToken } from '../../src/browser-auth-cookie.ts'
import { FAKE_DSH_PREAMBLE, freeDshPortBase, reapSpawned, spawnHost } from '../support/spawn-fixtures.ts'
import { skipSymlinksUnavailable, tempDir } from '../support/utils.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

/**
 * Bootstrap budget for the tests whose fake host ANSWERS: the readiness line and
 * the 303 exchange complete in milliseconds, so this value only bounds a wedged
 * child. A tight budget (200–500 ms) made those tests machine-speed dependent —
 * a slow runner can outrun it while spawning the child, so the spawn failed with
 * the browser-auth error and (before the finally-reap below) left the fake host
 * running: that is how CI's `test:control-plane` went red (spawn-dsh.test.ts
 * reported as ETIMEDOUT with the real assertion detail lost to the per-file kill).
 * Tests that EXPECT the bootstrap to expire (failure/legacy-fallback paths) keep
 * their own short budget.
 */
const ANSWERING_AUTH_BOOTSTRAP_MS = 10_000


/**
 * The upstream browser-auth cookie NAME for one request authority
 * (harness `packages/client/connection/src/browser-auth.ts` cookieName):
 * `dsh-auth-` + base64url(sha256(authority)), authority = the request Host.
 * Written per the upstream algorithm here — never copied from what the
 * spawn code happens to produce — so a rename or a different authority
 * source upstream turns these tests red instead of silently agreeing.
 */
function browserAuthCookieName(authority: string): string {
  return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
}

/**
 * The same algorithm as it runs INSIDE the fake dsh child (a plain CJS
 * script): the host mints its cookie from the Host header it actually
 * received, exactly like the real BrowserAuth.authorizeIndex does.
 */

/**
 * The answering fake host for the PATH-provision cases: an optional prelude (the
 * child's PATH marker), the launch-token line, the 303 exchange and the identity
 * probe with the minted cookie — the canonical ready path.
 */
function answeringFakeHostBody(prelude: readonly string[]): string {
  return [
    ...prelude,
    ...FAKE_DSH_PREAMBLE,
    "console.log('dsh web: http://127.0.0.1:' + port + '/?token=launch-1')",
    "createServer((req, res) => {",
    "  if (req.url === '/?token=launch-1') {",
    "    res.writeHead(303, { location: '/', 'set-cookie': authCookieName(req.headers.host) + '=sess; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict' })",
    "    res.end(); return",
    "  }",
    "  if (req.url === '/api/session/canOpenWorkspacePath') {",
    "    if ((req.headers.cookie || '').includes(authCookieName(req.headers.host) + '=sess')) {",
    "      let body = ''",
    "      req.on('data', c => { body += c })",
    "      req.on('end', () => {",
    "        const rpcId = JSON.parse(body).rpcId",
    "        res.writeHead(200, { 'content-type': 'application/json' })",
    "        res.end(JSON.stringify({ type: 'server-response', rpcId: rpcId, result: { ok: true, value: true } }))",
    "      })",
    "      return",
    "    }",
    "    res.writeHead(401); res.end('unauthorized'); return",
    "  }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n')
}

/** One PATH-provision fixture: a fake host that records the PATH it actually
 *  received, plus the fake bundled pnpm entry handed to spawnDsh. */
function writePathRecordingHost(stateDir: string, dshWorkspacePath: string): { pathMarker: string; entry: string } {
  const pathMarker = join(stateDir, 'child-path')
  const entry = join(stateDir, 'fake-pnpm.cjs')
  writeFileSync(entry, '// fake bundled pnpm entry\n')
  writeFakeDshEntry(dshWorkspacePath, answeringFakeHostBody([
    "const { writeFileSync } = require('node:fs')",
    "writeFileSync(" + JSON.stringify(pathMarker) + ", process.env.PATH ?? '')",
  ]))
  return { pathMarker, entry }
}

/** Run body with the process PATH pinned (spawnDsh copies the process env). An
 *  originally-unset PATH is deleted again, never restored as the string
 *  "undefined"; these cases rely on node:test running this file's tests serially. */
async function withProcessPath<T>(pathValue: string, body: () => Promise<T>): Promise<T> {
  const original = process.env.PATH
  process.env.PATH = pathValue
  try {
    return await body()
  } finally {
    if (original === undefined) delete process.env.PATH
    else process.env.PATH = original
  }
}

/** A fake dsh CLI entry under a fake workspace (node runs it directly). */
function writeFakeDshEntry(dshWorkspacePath: string, body: string): string {
  const entry = join(dshWorkspacePath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, body)
  return entry
}

/** Whether @@child@@ is @@parent@@ itself or lives under it (textual path
 *  check; symlinked spellings are compared separately via realpathSync). */
function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

class FakeProbeSocket extends EventEmitter {
  destroyed = false

  destroy(): this {
    this.destroyed = true
    return this
  }
}

test('resolveSpawnCwd: the installed (replaceable) layout gets the stable managed home, the source layout keeps the workspace for tsx', () => {
  const workspace = join('app', 'vendor', 'dsh')
  const dshHome = join('state', 'dsh-home')
  // The installed runtime tree is replaced in place by an app update, so the
  // host must never be created with it as cwd (the shared worker
  // process.cwd() then fails every tool call with uv_cwd ENOENT).
  assert.equal(resolveSpawnCwd({ layout: 'installed', dshWorkspacePath: workspace, dshHome }), dshHome)
  // The source checkout is not install-replaceable and its `tsx/esm` loader is
  // resolved through the workspace's own node_modules.
  assert.equal(resolveSpawnCwd({ layout: 'source', dshWorkspacePath: workspace, dshHome }), workspace)
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

/** Bind and hold one loopback TCP port until the returned server is closed. */
function holdPort(port: number): Promise<ReturnType<typeof createNetServer>> {
  return new Promise((resolveHold, rejectHold) => {
    const server = createNetServer()
    server.once('error', rejectHold)
    server.listen(port, '127.0.0.1', () => resolveHold(server))
  })
}

/** Close every held server, then resolve. */
function releasePorts(holders: Array<ReturnType<typeof createNetServer>>): Promise<void> {
  return Promise.all(holders.map(server => new Promise<void>(resolveClose => { server.close(() => resolveClose()) }))).then(() => undefined)
}

/**
 * Hold a fully consecutive loopback port window of `count` ports, retrying
 * when a concurrently running process claims one of them between the ephemeral
 * probe and the bind (the window must be entirely ours for the busy test).
 */
async function holdSpawnWindow(count: number): Promise<{ base: number; holders: Array<ReturnType<typeof createNetServer>> }> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const base = await freeDshPortBase()
    const holders: Array<ReturnType<typeof createNetServer>> = []
    try {
      for (let offset = 0; offset < count; offset++) holders.push(await holdPort(base + offset))
      return { base, holders }
    } catch {
      await releasePorts(holders)
    }
  }
  throw new Error('could not reserve a consecutive loopback port window')
}

test('spawnDsh: an exhausted window records every occupied port with its concrete reason (F1)', async () => {
  const stateDir = tempDir()
  const { base, holders } = await holdSpawnWindow(MAX_SPAWN_ATTEMPTS)
  try {
    await assert.rejects(
      spawnDsh({ dshPortBase: base, stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath: join(stateDir, 'ws'), logger: silentLogger }),
      (error: unknown) => {
        assert.ok(error instanceof DshSpawnExhaustedError, 'a fully busy window must reject with the typed exhausted error')
        assert.equal(error.code, DSH_SPAWN_ATTEMPTS_EXHAUSTED_CODE)
        assert.equal(error.attempts.length, MAX_SPAWN_ATTEMPTS)
        assert.deepEqual(
          error.attempts.map(failure => failure.port),
          Array.from({ length: MAX_SPAWN_ATTEMPTS }, (_unused, offset) => base + offset),
        )
        assert.ok(error.attempts.every(failure => failure.kind === 'port-busy'), 'a skipped port is a typed failure, not a missing record')
        for (let offset = 0; offset < MAX_SPAWN_ATTEMPTS; offset++) {
          assert.match(error.message, new RegExp(`port ${base + offset} is already in use`))
        }
        assert.ok(error.message.includes(`failed to start after ${MAX_SPAWN_ATTEMPTS} attempts`))
        assert.ok(!error.message.includes('undefined'), 'the terminal message must never contain "undefined"')
        return true
      },
    )
  } finally {
    await releasePorts(holders)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: an early child exit records the exit code and the stderr digest (F1)', async () => {
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    "process.stderr.write('fatal: cannot bind the configured port\\n')",
    'setTimeout(() => process.exit(9), 50)',
    '',
  ].join('\n'))
  try {
    await assert.rejects(
      spawnDsh({ dshPortBase: await freeDshPortBase(), stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger }),
      (error: unknown) => {
        assert.ok(error instanceof DshSpawnExhaustedError)
        // The window is ephemeral: a concurrently active process can claim one
        // of the five ports between the pre-check and the attempt (that attempt
        // is then correctly typed 'port-busy'). The contract under test is that
        // the exit path IS recorded — so at least one attempt must be the typed
        // child-exit with its exit code and stderr digest.
        assert.ok(
          error.attempts.every(failure => failure.kind === 'child-exit' || failure.kind === 'port-busy'),
          'every attempt must be typed as the child-exit or port-busy cause it actually observed',
        )
        const exited = error.attempts.filter(failure => failure.kind === 'child-exit')
        assert.ok(exited.length > 0, 'at least one attempt must record the early child exit')
        assert.ok(exited.every(failure => failure.exitCode === 9), 'the child exit code must ride the failure record')
        assert.match(error.message, /child exited \(9\)/)
        assert.ok(error.message.includes('cannot bind the configured port'), 'the stderr digest must carry the child\'s own reason')
        assert.ok(!error.message.includes('undefined'))
        return true
      },
    )
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
      if (skipSymlinksUnavailable(error, t)) return
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
      async () => spawnDsh({ dshPortBase: await freeDshPortBase(), stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger }),
      /failed to start after 5 attempts/,
    )
    const recordsDir = join(stateDir, 'managed-dsh')
    const leftovers = existsSync(recordsDir) ? readdirSync(recordsDir).filter(file => file.endsWith('.json')) : []
    assert.deepEqual(leftovers, [], 'no pid record may survive a failed spawn attempt')
    // Attempt logs are named after the candidate port. The base is ephemeral here
    // (17510+ is the live app range, not a test constant), so locate the log by
    // content instead of recomputing a port number.
    const hostLogs = join(stateDir, 'host-logs')
    await waitUntil(() => {
      if (!existsSync(hostLogs)) return false
      return readdirSync(hostLogs).some(file => {
        const contents = readFileSync(join(hostLogs, file), 'utf8')
        return contents.includes('final stdout') && contents.includes('final stderr')
      })
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
  // the process table for the entry path instead.
  writeFakeDshEntry(dshWorkspacePath, 'setInterval(() => {}, 1000)\n')
  const entryPath = join(dshWorkspacePath, 'dsh')
  // managed-dsh as a FILE → private-directory validation throws → the
  // freshly spawned child must be cleaned up instead of leaking.
  writeFileSync(join(stateDir, 'managed-dsh'), 'occupied')
  try {
    await assert.rejects(
      async () => spawnDsh({ dshPortBase: await freeDshPortBase(), stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, logger: silentLogger }),
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

test('spawnDsh: abort during the post-TCP host-identity probe wait kills the detached attempt promptly', async () => {
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  const listeningMarker = join(stateDir, 'listening')
  const identityMarker = join(stateDir, 'identity-probe-requested')
  const entryPath = writeFakeDshEntry(dshWorkspacePath, [
    "const { writeFileSync } = require('node:fs')",
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    // The identity probe arrives and never answers (the host boots): the
    // abort must cut the wait short instead of grinding to the 90s window.
    "createServer((req) => { if (req.url === '/api/session/canOpenWorkspacePath') writeFileSync(" + JSON.stringify(identityMarker) + ", 'yes') }).listen(port, '127.0.0.1', () => writeFileSync(" + JSON.stringify(listeningMarker) + ", 'yes'))",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    const startedAt = Date.now()
    const spawning = spawnHost(stateDir, dshWorkspacePath, controller.signal)
    await waitUntil(() => existsSync(listeningMarker), 3000)
    await waitUntil(() => existsSync(identityMarker), 3000)
    controller.abort()
    // The rejection must surface the abort promptly. Depending on which
    // attempt slot the spawn landed on (occupied base ports are skipped), the
    // abort can arrive as the loop's clean 'spawn aborted' or wrapped around
    // the in-flight probe's AbortError — both are honest, prompt aborts.
    await assert.rejects(() => spawning, error => {
      const message = error instanceof Error ? error.message : String(error)
      return message.toLowerCase().includes('abort')
    })
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

test('spawnDsh: the installed layout runs the host with the stable managed home as cwd, never inside the replaceable runtime tree', async () => {
  // Packaged shape: the installed entry lives under <bundle>/vendor/dsh, the
  // directory an in-place app update replaces. The child must be created with
  // the managed dsh home as cwd so worker_threads' shared process.cwd() keeps
  // resolving (uv_cwd ENOENT otherwise).
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'vendor', 'dsh')
  const dshHome = join(stateDir, 'home')
  const childCwdMarker = join(stateDir, 'child-cwd')
  writeFakeDshEntry(dshWorkspacePath, [
    "const { writeFileSync } = require('node:fs')",
    "writeFileSync(" + JSON.stringify(childCwdMarker) + ", process.cwd())",
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "createServer((req, res) => {",
    "  if (req.url === '/api/session/canOpenWorkspacePath') {",
    "    let body = ''",
    "    req.on('data', c => { body += c })",
    "    req.on('end', () => {",
    "      const rpcId = JSON.parse(body).rpcId",
    "      res.writeHead(200, { 'content-type': 'application/json' })",
    "      res.end(JSON.stringify({ type: 'server-response', rpcId: rpcId, result: { ok: true, value: true } }))",
    "    })",
    "    return",
    "  }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    const spawned = await spawnHost(stateDir, dshWorkspacePath, controller.signal)
    const childCwd = readFileSync(childCwdMarker, 'utf8').trim()
    // getcwd(3) canonicalizes symlinks — on macOS a temp dir under /var comes
    // back as /private/var — so the textual containment check must compare
    // against canonical parents, never the spawn-time spelling.
    const canonicalWorkspace = realpathSync(dshWorkspacePath)
    const canonicalStateDir = realpathSync(stateDir)
    // The defect lock: cwd must not name (or live under) the runtime tree an
    // update replaces in place...
    assert.equal(isInsideOrEqual(childCwd, canonicalWorkspace), false, 'host cwd must not be the replaceable runtime tree')
    // ...and must be the stable control-plane-owned home the spawn created.
    assert.equal(isInsideOrEqual(childCwd, canonicalStateDir), true, 'host cwd must stay under the control-plane state root')
    assert.equal(realpathSync(childCwd), realpathSync(dshHome))
    await reapSpawned(spawned)
  } finally {
    controller.abort()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: the 0.1.2 browser-auth bootstrap mints the cookie and the host-identity probe passes with it', async () => {
  // The web profile prints `dsh web: <url>?token=<t>` at
  // readiness; the spawn performs the token exchange and injects the cookie
  // into the host-identity probe — session/canOpenWorkspacePath (the fake
  // host 401s the whole /api surface without it, the browser-auth gate).
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, answeringFakeHostBody([]))
  const controller = new AbortController()
  let spawned: Awaited<ReturnType<typeof spawnDsh>> | undefined
  try {
    spawned = await spawnHost(stateDir, dshWorkspacePath, controller.signal)
    assert.equal(spawned.port > 0, true)
    const cookie = authCookieFor(`http://127.0.0.1:${spawned.port}`)
    // The name is the authority-bound upstream name for THIS instance, not an
    // arbitrary fake: the exchange authority (127.0.0.1:<port>) is exactly the
    // authority the proxy later forwards as Host.
    assert.equal(cookie, `${browserAuthCookieName(`127.0.0.1:${spawned.port}`)}=sess`)
    // The SpawnAttemptResult child must be reaped by the caller.
    await reapSpawned(spawned)
  } finally {
    controller.abort()
    // A failed assertion must not leave the detached fake host running: the
    // child's pipes keep this test process alive, so the file would hang until
    // the manifest's per-file SIGKILL — and the failure detail dies with it.
    spawned?.child.kill()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a host PATH without pnpm reaches the child with the bundled launcher prepended', async () => {
  // Upstream's plugin manager spawns a literal `pnpm` out of the host env
  // (design 02 §3.1): the packaged pnpm is a node script no PATH lookup can find,
  // so the resolved entry is exposed through a generated wrapper — and only when
  // the host PATH resolves no pnpm of its own (the sibling case below).
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  const { pathMarker, entry } = writePathRecordingHost(stateDir, dshWorkspacePath)
  const emptyBin = join(stateDir, 'empty-bin')
  mkdirSync(emptyBin)
  const controller = new AbortController()
  let spawned: Awaited<ReturnType<typeof spawnDsh>> | undefined
  try {
    // spawnDsh copies the process env; pin a PATH that cannot resolve a pnpm so the
    // provision is what this test observes, not the developer machine's toolchain.
    spawned = await withProcessPath(emptyBin, () =>
      spawnHost(stateDir, dshWorkspacePath, controller.signal, { pnpmEntry: entry }))
    const shimDir = join(stateDir, 'pnpm-shim')
    assert.equal(readFileSync(pathMarker, 'utf8'), shimDir + delimiter + emptyBin)
    const shim = join(shimDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    assert.equal(readFileSync(shim, 'utf8').includes(entry), true, 'the wrapper targets the resolved entry')
    await reapSpawned(spawned)
  } finally {
    controller.abort()
    spawned?.child.kill()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a host PATH that already resolves pnpm is handed to the child untouched', async () => {
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  const { pathMarker, entry } = writePathRecordingHost(stateDir, dshWorkspacePath)
  const userBin = join(stateDir, 'user-bin')
  mkdirSync(userBin)
  writeFileSync(
    join(userBin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
    process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    { mode: 0o755 },
  )
  const controller = new AbortController()
  let spawned: Awaited<ReturnType<typeof spawnDsh>> | undefined
  try {
    spawned = await withProcessPath(userBin, () =>
      spawnHost(stateDir, dshWorkspacePath, controller.signal, { pnpmEntry: entry }))
    assert.equal(readFileSync(pathMarker, 'utf8'), userBin, 'the user toolchain is never shadowed')
    assert.equal(existsSync(join(stateDir, 'pnpm-shim')), false, 'nothing is materialized for a satisfied host')
    await reapSpawned(spawned)
  } finally {
    controller.abort()
    spawned?.child.kill()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a gated host with no launch token fails loud with the browser-auth error', async () => {
  // The host 401s (browser-auth gate) but never prints the
  // `dsh web:` token line — the bootstrap cannot mint a cookie, and the probe
  // must fail loud with the explicit browser-auth reason (never the generic
  // 90s-window error).
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    "const { createServer } = require('node:http')",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "createServer((req, res) => { if (req.url === '/api/session/canOpenWorkspacePath') { res.writeHead(401); res.end('unauthorized'); return } res.writeHead(404); res.end() }).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    await assert.rejects(
      async () => spawnHost(stateDir, dshWorkspacePath, controller.signal, { authBootstrapWaitMs: 50 }),
      /browser-auth cookie, but the bootstrap failed/,
    )
  } finally {
    controller.abort()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a 401 that arrives before the launch-token line re-arms the bounded wait instead of failing the attempt', async () => {
  // Wire ordering (harness client/connection + bundle/web-app): the /api
  // routes answer 401 as soon as the listener is up, while the
  // `dsh web: <url>?token=…` line is printed only after the loader settles.
  // The first bounded window therefore expires with no token at all; the
  // attempt must re-arm ONE fresh window inside the 90s listen budget instead
  // of throwing on the first 401. The fake host answers the FIRST
  // identity probe 401 after a delay that is well past the injected window,
  // and prints the token line only after that 401 is answered — the exact
  // ordering the re-arm exists for.
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  const authBootstrapWaitMs = 300
  const firstProbe401DelayMs = 700
  const tokenLineDelayAfter401Ms = 150
  writeFakeDshEntry(dshWorkspacePath, [
    ...FAKE_DSH_PREAMBLE,
    `const firstProbe401DelayMs = ${firstProbe401DelayMs}`,
    `const tokenLineDelayAfter401Ms = ${tokenLineDelayAfter401Ms}`,
    "let printedTokenLine = false",
    "const printTokenLine = () => {",
    "  if (printedTokenLine) return",
    "  printedTokenLine = true",
    "  process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=late-token\\n')",
    "}",
    "const server = createServer((req, res) => {",
    "  if (req.url === '/?token=late-token') {",
    "    res.writeHead(303, { location: '/', 'set-cookie': authCookieName(req.headers.host) + '=sess; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict' })",
    "    res.end(); return",
    "  }",
    "  if (req.url === '/api/session/canOpenWorkspacePath') {",
    "    if ((req.headers.cookie || '').includes(authCookieName(req.headers.host) + '=sess')) {",
    "      let body = ''; req.on('data', c => { body += c }); req.on('end', () => {",
    "        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: JSON.parse(body).rpcId, result: { ok: true, value: true } })) })",
    "      return",
    "    }",
    // The /api surface is up (401) long before the readiness line exists.
    "    setTimeout(() => { res.writeHead(401); res.end('unauthorized'); setTimeout(printTokenLine, tokenLineDelayAfter401Ms) }, firstProbe401DelayMs); return",
    "  }",
    "  res.writeHead(404); res.end()",
    "})",
    "server.listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  let spawned: Awaited<ReturnType<typeof spawnDsh>> | undefined
  try {
    spawned = await spawnHost(stateDir, dshWorkspacePath, controller.signal, { authBootstrapWaitMs })
    assert.equal(
      authCookieFor(`http://127.0.0.1:${spawned.port}`),
      `${browserAuthCookieName(`127.0.0.1:${spawned.port}`)}=sess`,
      'the late launch-token line is exchanged into the authority-bound cookie',
    )
    await reapSpawned(spawned)
  } finally {
    controller.abort()
    // A failed assertion must not leave the detached fake host running: the
    // child's pipes keep this test process alive, so the file would hang until
    // the manifest's per-file SIGKILL — and the failure detail dies with it.
    spawned?.child.kill()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a readiness line split across chunks is still fully redacted and usable', async () => {
  // The token URL line may arrive in several stdio
  // chunks — the scanner must wait for the complete line and the forward
  // must redact across the split (no truncated-token mint, no partial leak).
  const logged: string[] = []
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    ...FAKE_DSH_PREAMBLE,
    // Three small writes: the URL line is fragmented mid-token.
    "process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?to')",
    "process.stdout.write('ken=launch-secret (LAN: http://10.0.0.5:' + port + '/?token=launch-secret)\\n')",
    "createServer((req, res) => {",
    "  if (req.url === '/?token=launch-secret') { res.writeHead(303, { location: '/', 'set-cookie': authCookieName(req.headers.host) + '=sess; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return }",
    "  if (req.url === '/api/session/canOpenWorkspacePath') {",
    "    let body = ''; req.on('data', c => { body += c }); req.on('end', () => {",
    "      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: JSON.parse(body).rpcId, result: { ok: true, value: true } })) })",
    "    return",
    "  }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  // Hoisted out of the try: the finally below must be able to reap the child
  // even when an assertion threw (otherwise the file hangs to the per-file kill).
  let spawned: Awaited<ReturnType<typeof spawnDsh>> | undefined
  try {
    try {
      spawned = await spawnHost(stateDir, dshWorkspacePath, controller.signal, {
        authBootstrapWaitMs: ANSWERING_AUTH_BOOTSTRAP_MS,
        logger: { log(line: string) { logged.push(String(line)) }, warn(line: string) { logged.push('WARN:' + String(line)) }, error(line: string) { logged.push('ERR:' + String(line)) } },
      })
    } catch (error) {
      throw new Error(`spawn failed; logged: ${JSON.stringify(logged.slice(0, 10))}; cause: ${String(error)}`)
    }
    // The full token was reconstructed across the split → cookie minted.
    assert.equal(authCookieFor(`http://127.0.0.1:${spawned.port}`), `${browserAuthCookieName(`127.0.0.1:${spawned.port}`)}=sess`)
    const logLines = logged.join('\n')
    assert.equal(logLines.includes('launch-secret'), false)
    assert.equal(/token=[^\s]*launch-secret/.test(logLines), false)
    await reapSpawned(spawned)
  } finally {
    controller.abort()
    // A failed assertion must not leave the detached fake host running: the
    // child's pipes keep this test process alive, so the file would hang until
    // the manifest's per-file SIGKILL — and the failure detail dies with it.
    spawned?.child.kill()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: an oversized unterminated child chunk is bounded on the REAL forward path', async () => {
  // The bound lives on the incomplete-line carry of the real forwarding path
  // (raw chunks must reach the line splitter untrimmed, so no per-chunk
  // formatter can own this): a child that never emits a newline must not grow
  // the carry without limit, and the bytes dropped are the OLDEST, never the
  // newest. Complete lines are deliberately forwarded untruncated (the deleted
  // formatter's marker must never come back), so the observable proof is the
  // dropped head plus the surviving tail, not a line length. The newline is
  // written in a LATER event-loop turn so the oversized write is delivered
  // first. The readiness line flushed afterwards must still be parsed and its
  // token redacted.
  const logged: string[] = []
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  const droppedHead = 'must-not-reach-logger-or-host-log'
  const keptTail = 'tail-marker-survives'
  writeFakeDshEntry(dshWorkspacePath, [
    ...FAKE_DSH_PREAMBLE,
    // The oversized newline-less write lands first; the newline is written in a
    // LATER event-loop turn so the two writes cannot coalesce into one pipe
    // chunk (the carry bound is only observable when the newline arrives in a
    // later data event — that is the honest production semantics).
    `process.stdout.write('${droppedHead}' + 'a'.repeat(${MAX_CHILD_OUTPUT_CHUNK_BYTES}) + '${keptTail}')`,
    'setTimeout(() => {',
    "  process.stdout.write('\\n')",
    // The readiness line follows (same shape as the split-chunk test above).
    "  process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=launch-secret (LAN: http://10.0.0.5:' + port + '/?token=launch-secret)\\n')",
    "  createServer((req, res) => {",
    "    if (req.url === '/?token=launch-secret') { res.writeHead(303, { location: '/', 'set-cookie': authCookieName(req.headers.host) + '=sess; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return }",
    "    if (req.url === '/api/session/canOpenWorkspacePath') {",
    "      let body = ''; req.on('data', c => { body += c }); req.on('end', () => {",
    "        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: JSON.parse(body).rpcId, result: { ok: true, value: true } })) })",
    "      return",
    "    }",
    "    res.writeHead(404); res.end()",
    "  }).listen(port, '127.0.0.1')",
    '}, 100)',
    '',
  ].join('\n'))
  const controller = new AbortController()
  let spawned: Awaited<ReturnType<typeof spawnDsh>> | undefined
  try {
    try {
      spawned = await spawnHost(stateDir, dshWorkspacePath, controller.signal, {
        authBootstrapWaitMs: ANSWERING_AUTH_BOOTSTRAP_MS,
        logger: {
          log(line: string) { logged.push(String(line)) },
          warn(_line: string) {},
          error(_line: string) {},
        },
      })
    } catch (error) {
      throw new Error(`spawn failed; logged: ${JSON.stringify(logged.slice(0, 6))}; cause: ${String(error)}`)
    }
    const lines = logged.join('\n')
    assert.equal(lines.includes(droppedHead), false, 'the oldest bytes of the oversized carry must be dropped')
    assert.equal(lines.includes(keptTail), true, 'the newest bytes of the carry must survive')
    assert.equal(
      lines.includes('output chunk truncated'),
      false,
      'the raw path must never inject the deleted formatter truncation marker',
    )
    // The raw path still served the readiness line after the hostile chunk.
    assert.equal(authCookieFor(`http://127.0.0.1:${spawned.port}`), `${browserAuthCookieName(`127.0.0.1:${spawned.port}`)}=sess`)
    assert.equal(lines.includes('launch-secret'), false, 'the token still never reaches the log')
    await reapSpawned(spawned)
  } finally {
    controller.abort()
    // A failed assertion must not leave the detached fake host running (that
    // would hang the test child until the manifest's per-file timeout).
    spawned?.child.kill()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: the launch token never reaches the control-plane log or host-log', async () => {
  // The readiness line (with token AND the LAN variant)
  // must be redacted in every log surface.
  const logged: string[] = []
  const stateDir = tempDir()
  const dshWorkspacePath = join(stateDir, 'ws')
  writeFakeDshEntry(dshWorkspacePath, [
    ...FAKE_DSH_PREAMBLE,
    "console.log('dsh web: http://127.0.0.1:' + port + '/?token=launch-secret (LAN: http://10.0.0.5:' + port + '/?token=launch-secret)')",
    "createServer((req, res) => {",
    "  if (req.url === '/?token=launch-secret') { res.writeHead(303, { location: '/', 'set-cookie': authCookieName(req.headers.host) + '=sess; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return }",
    "  if (req.url === '/api/session/canOpenWorkspacePath') {",
    "    let body = ''; req.on('data', c => { body += c }); req.on('end', () => {",
    "      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: JSON.parse(body).rpcId, result: { ok: true, value: true } })) })",
    "    return",
    "  }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  let spawned: Awaited<ReturnType<typeof spawnDsh>> | undefined
  try {
    spawned = await spawnDsh({ dshPortBase: await freeDshPortBase(),
      stateDir, dshHome: join(stateDir, 'home'), dshWorkspacePath, signal: controller.signal, authBootstrapWaitMs: ANSWERING_AUTH_BOOTSTRAP_MS,
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
    await reapSpawned(spawned)
  } finally {
    controller.abort()
    // A failed assertion must not leave the detached fake host running: the
    // child's pipes keep this test process alive, so the file would hang until
    // the manifest's per-file SIGKILL — and the failure detail dies with it.
    spawned?.child.kill()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: a token line with a failed exchange fails loud with the browser-auth error', async () => {
  // The URL line arrives but the exchange is refused —
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
    "  if (req.url === '/api/session/canOpenWorkspacePath') { res.writeHead(401); res.end('unauthorized'); return }",
    "  res.writeHead(404); res.end()",
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const controller = new AbortController()
  try {
    await assert.rejects(
      async () => spawnHost(stateDir, dshWorkspacePath, controller.signal, { authBootstrapWaitMs: 50 }),
      /browser-auth cookie, but the bootstrap failed/,
    )
  } finally {
    controller.abort()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('spawnDsh: an old runtime tree (only session/list, no launch token) spawns via the legacy fallback without a cookie', async () => {
  // Old hosts print the URL line without a
  // token AND predate the session/canOpenWorkspacePath identity method: the
  // identity probe answers HTTP 404, probeHostIdentity falls back to the
  // legacy session/list probe, and the spawn proceeds without a cookie. The
  // fake host answers ONLY session/list, proving the 404-split readiness path.
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
  let spawned: Awaited<ReturnType<typeof spawnDsh>> | undefined
  try {
    spawned = await spawnHost(stateDir, dshWorkspacePath, controller.signal, { authBootstrapWaitMs: 50 })
    assert.equal(authCookieFor(`http://127.0.0.1:${spawned.port}`), undefined)
    await reapSpawned(spawned)
  } finally {
    controller.abort()
    // A failed assertion must not leave the detached fake host running: the
    // child's pipes keep this test process alive, so the file would hang until
    // the manifest's per-file SIGKILL — and the failure detail dies with it.
    spawned?.child.kill()
    clearAuthCookie(`http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Launch-token exchange states (browser-auth-cookie.ts). The exchange is the
// spawn bootstrap's only credential source, so its accept/reject states are
// asserted here next to the bootstrap tests. Upstream
// (packages/client/connection/src/browser-auth.ts authorizeIndex) answers a
// correct token with 303 + `location: '/'` + Set-Cookie and every other index
// request with a plain-text 401.
// ---------------------------------------------------------------------------

/** Answer one launch-token exchange exactly as `answer` says; null when no mint. */
async function exchangeAgainst(answer: (req: IncomingMessage, res: ServerResponse) => void): Promise<string | null> {
  const server = createServer(answer)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  try {
    return await exchangeLaunchToken(`http://127.0.0.1:${port}`, 'launch-1')
  } finally {
    server.close()
  }
}

test('exchangeLaunchToken mints only for the upstream 303 + location "/" answer', async () => {
  let minted = ''
  assert.equal(await exchangeAgainst((req, res) => {
    minted = `${browserAuthCookieName(String(req.headers.host))}=session-value`
    res.writeHead(303, {
      'cache-control': 'no-store',
      location: '/',
      'set-cookie': `${minted}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
    })
    res.end()
  }), minted)
  assert.equal(minted.startsWith('dsh-auth-'), true)

  // A 200 that merely carries Set-Cookie is not the exchange answer (a host
  // that serves the index for anyone must never hand this process a credential).
  assert.equal(await exchangeAgainst((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': `${browserAuthCookieName(String(req.headers.host))}=session-value; Path=/`,
    })
    res.end('<html></html>')
  }), null)

  // The upstream refusal (wrong or absent token) is a bare 401.
  assert.equal(await exchangeAgainst((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
  }), null)

  // 303 with a location that does not normalize to the clean index is not the mint.
  for (const location of ['/elsewhere', '/api/session/list', '::x', '']) {
    assert.equal(await exchangeAgainst((req, res) => {
      res.writeHead(303, {
        location,
        'set-cookie': `${browserAuthCookieName(String(req.headers.host))}=session-value; Path=/`,
      })
      res.end()
    }), null, `303 with location ${JSON.stringify(location)} must not mint a cookie`)
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
