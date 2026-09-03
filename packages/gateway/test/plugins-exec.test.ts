/**
 * plugins-exec tests (design 21 §6.3 executor core; plan Phase 4.3): env
 * discipline, bounded runDshPluginMutation outcomes (exit/timeout/spawn
 * error), and the serial worker (order, cap, dup fast-fail, blocked/probe
 * gates, preImage backups, dispose). Plain node:test; fake spawn injection —
 * no real dsh CLI is ever spawned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { SpawnOptions } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ERROR_DUPLICATE_PENDING,
  ERROR_RESTARTED_DURING_MUTATION,
  ERROR_RUNTIME_BUSY,
  ERROR_STARTING,
  ERROR_TIMED_OUT,
  OUTPUT_TRUNCATION_MARKER,
  PLUGIN_QUEUE_CAP,
  createPluginsExec,
  runDshPluginMutation,
  scrubInstallEnv,
  truncateOutputTail,
} from '../src/plugins-exec.ts'
import type { EnqueueResult, OnOpTerminal, SpawnFn, SpawnedChild, SpawnedProcessStream } from '../src/plugins-exec.ts'
import { backupDirFor, createPluginsJournal, thirdPartyRoot } from '../src/plugins-journal.ts'
import type { JournalLogger } from '../src/plugins-journal.ts'

const silent: JournalLogger = { log() {}, warn() {} }
const posix = process.platform !== 'win32'
const mode = (path: string): number => statSync(path).mode & 0o777

async function waitFor(condition: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

class FakeStream extends EventEmitter {
  emitChunk(chunk: string): void {
    this.emit('data', Buffer.from(chunk, 'utf8'))
  }
}

class FakeChild implements SpawnedChild {
  pid: number
  stdout: SpawnedProcessStream = new FakeStream()
  stderr: SpawnedProcessStream = new FakeStream()
  readonly signals: NodeJS.Signals[] = []
  readonly killTimes: number[] = []
  closeOnKill = false
  private readonly emitter = new EventEmitter()

  constructor(pid: number) {
    this.pid = pid
  }

  once(event: 'error' | 'close', listener: (...args: any[]) => void): void {
    this.emitter.once(event, listener as (...args: any[]) => void)
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    const resolved = (signal as NodeJS.Signals | undefined) ?? 'SIGTERM'
    this.signals.push(resolved)
    this.killTimes.push(Date.now())
    if (this.closeOnKill) queueMicrotask(() => this.close(null, resolved))
    return true
  }

  stderrLine(line: string): void {
    ;(this.stderr as FakeStream).emitChunk(`${line}\n`)
  }

  stdoutLine(line: string): void {
    ;(this.stdout as FakeStream).emitChunk(`${line}\n`)
  }

  error(error: Error): void {
    this.emitter.emit('error', error)
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emitter.emit('close', code, signal)
  }
}

interface SpawnCall {
  command: string
  args: string[]
  options: SpawnOptions
  child: FakeChild
}

function makeSpawnHarness(): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild(9000 + calls.length)
    calls.push({ command, args, options, child })
    return child
  }
  return { spawn, calls }
}

interface ExecHarness {
  stateDir: string
  profileDir: string
  journal: ReturnType<typeof createPluginsJournal>
  exec: ReturnType<typeof createPluginsExec>
  harness: ReturnType<typeof makeSpawnHarness>
  manifestText: string
  lockText: string | null
}

function makeExecHarness(
  t: { after(fn: () => void): void },
  options: {
    statusProbe?: () => string
    canRun?: () => boolean
    canRunWaitMaxMs?: number
    canRunPollMs?: number
    withLock?: boolean
    timeoutMs?: number
    logger?: JournalLogger
    onTerminal?: OnOpTerminal
    cliLaunch?: () => { argvPrefix: string[]; cwd?: string } | null
  } = {},
): ExecHarness {
  const stateDir = mkdtempSync(join(tmpdir(), 'plugins-exec-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const profileDir = join(stateDir, 'dsh-home', 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const manifest = { name: 'web', version: '0.0.0', dependencies: { alpha: '^1.0.0' } }
  const manifestText = JSON.stringify(manifest, undefined, 2)
  writeFileSync(join(profileDir, 'package.json'), manifestText, 'utf8')
  let lockText: string | null = null
  if (options.withLock === true) {
    lockText = "lockfileVersion: '9.0'\n\npackages: {}\n"
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), lockText, 'utf8')
  }
  const journal = createPluginsJournal(stateDir, silent)
  const harness = makeSpawnHarness()
  const exec = createPluginsExec({
    stateDir,
    dshCliPath: '/managed/dsh/bin/dsh',
    journal,
    statusProbe: options.statusProbe ?? (() => 'ready'),
    logger: options.logger ?? silent,
    spawn: harness.spawn,
    timeoutMs: options.timeoutMs,
    canRun: options.canRun ?? (() => true),
    ...(options.canRunWaitMaxMs === undefined ? {} : { canRunWaitMaxMs: options.canRunWaitMaxMs }),
    ...(options.canRunPollMs === undefined ? {} : { canRunPollMs: options.canRunPollMs }),
    ...(options.onTerminal === undefined ? {} : { onTerminal: options.onTerminal }),
    ...(options.cliLaunch === undefined ? {} : { cliLaunch: options.cliLaunch }),
  })
  return { stateDir, profileDir, journal, exec, harness, manifestText, lockText }
}

async function enqueueOk(exec: { enqueue(input: unknown): Promise<EnqueueResult> }, input: unknown): Promise<string> {
  const result = await exec.enqueue(input as never)
  assert.ok(result.ok, `enqueue must succeed: ${JSON.stringify(result)}`)
  return (result as { ok: true; opId: string }).opId
}

// ---------------------------------------------------------------------------
// Pure env discipline + capture helpers
// ---------------------------------------------------------------------------

test('scrubInstallEnv is a WHITELIST: only PATH/proxies survive; every ambient var is dropped, pins always apply', () => {
  const source: Record<string, string | undefined> = {
    PATH: '/usr/bin:/bin',
    HTTP_PROXY: 'http://proxy:3128',
    https_proxy: 'http://proxy:3128',
    NO_PROXY: '*.local',
    no_proxy: '127.0.0.1',
    // Everything below must NEVER cross into install children: gateway
    // control vars, npm token carriers, operator HOME/XDG, and any other
    // ambient secret a lifecycle script or pnpm could read (design 21 §6.3
    // whitelist discipline — a denylist cannot enumerate every carrier).
    DSH_GATEWAY_TOKEN: 'secret-token',
    dsh_gateway_inner: 'x',
    npm_config_registry: 'https://evil.example',
    NPM_CONFIG_USERCONFIG: '/operator/.npmrc',
    NPM_TOKEN: 'npm-secret',
    Npm_Config_Registry: 'case-insensitive-drop',
    NODE_AUTH_TOKEN: 'registry-token',
    GITHUB_TOKEN: 'gh-token',
    SSH_AUTH_SOCK: '/operator/agent.sock',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    HOME: '/operator/home',
    XDG_CONFIG_HOME: '/operator/.config',
    KEEP_ME: 'kept',
    UNSET_VAR: undefined,
  }
  const pins = {
    DSH_HOME: '/state/dsh-home',
    HOME: '/state/chamber-plugins/third-party/.pnpm-home',
    XDG_CACHE_HOME: '/state/chamber-plugins/third-party/.pnpm-cache',
    XDG_CONFIG_HOME: '/state/chamber-plugins/third-party/.pnpm-xdg',
    NPM_CONFIG_USERCONFIG: '/state/chamber-plugins/third-party/.npmrc-empty',
  }
  const result = scrubInstallEnv(source, pins)

  assert.equal(result.PATH, '/usr/bin:/bin')
  assert.equal(result.HTTP_PROXY, 'http://proxy:3128')
  assert.equal(result.https_proxy, 'http://proxy:3128')
  assert.equal(result.NO_PROXY, '*.local')
  assert.equal(result.no_proxy, '127.0.0.1')
  // A whitelist keeps ONLY the proxy family: KEEP_ME is ambient and must
  // fall (unlike the pre-fix denylist, which passed it through).
  for (const key of ['DSH_GATEWAY_TOKEN', 'dsh_gateway_inner', 'npm_config_registry', 'NPM_TOKEN',
    'Npm_Config_Registry', 'NODE_AUTH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY',
    'KEEP_ME']) {
    assert.equal(Object.hasOwn(result, key), false, `${key} must be dropped by the whitelist`)
  }
  assert.equal(result.HOME, '/state/chamber-plugins/third-party/.pnpm-home', 'pin overrides/restores a dropped name')
  assert.equal(result.DSH_HOME, '/state/dsh-home')
  assert.equal(result.XDG_CACHE_HOME, '/state/chamber-plugins/third-party/.pnpm-cache')
  assert.equal(result.XDG_CONFIG_HOME, '/state/chamber-plugins/third-party/.pnpm-xdg')
  assert.equal(result.NPM_CONFIG_USERCONFIG, '/state/chamber-plugins/third-party/.npmrc-empty', 'pin restores the pinned name')
  assert.equal(result.UNSET_VAR, undefined)
})

test('truncateOutputTail keeps the tail and marks truncation', () => {
  assert.deepEqual(truncateOutputTail('short', 64), { value: 'short', truncated: false })
  const bounded = truncateOutputTail('abcdefghij', 4)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.value, `${OUTPUT_TRUNCATION_MARKER}ghij`)
  assert.ok(OUTPUT_TRUNCATION_MARKER.includes('truncated'))
})

// ---------------------------------------------------------------------------
// runDshPluginMutation outcomes (injected spawn only)
// ---------------------------------------------------------------------------

test('runDshPluginMutation: exit 0 is ok and forwards argv/env to the spawn seam', async () => {
  const harness = makeSpawnHarness()
  const env = { PATH: '/usr/bin', DSH_HOME: '/state/dsh-home' }
  const mutation = runDshPluginMutation({
    dshCliPath: '/managed/dsh',
    argv: ['plugin', '--profile', 'web', 'add', 'pkg@^1'],
    env,
    spawn: harness.spawn,
    timeoutMs: 1000,
  })
  harness.calls[0]!.child.close(0)
  assert.deepEqual(await mutation, { ok: true })
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0]!.command, '/managed/dsh')
  assert.deepEqual(harness.calls[0]!.args, ['plugin', '--profile', 'web', 'add', 'pkg@^1'])
  assert.deepEqual(harness.calls[0]!.options.env, env)
  assert.deepEqual(harness.calls[0]!.options.stdio, ['ignore', 'pipe', 'pipe'])
  if (posix) assert.equal(harness.calls[0]!.options.detached, true)
})

test('runDshPluginMutation: non-zero exit surfaces the sanitized last stderr line, falling back to stdout', async () => {
  // stderr present → last non-empty stderr line wins.
  const harness1 = makeSpawnHarness()
  const mutation1 = runDshPluginMutation({
    dshCliPath: 'dsh', argv: [], env: {}, spawn: harness1.spawn, timeoutMs: 1000,
    sanitize: text => text, // raw: exact line assertions
  })
  harness1.calls[0]!.child.stderrLine('line one')
  harness1.calls[0]!.child.stderrLine('line two')
  harness1.calls[0]!.child.stdoutLine('ignored stdout')
  harness1.calls[0]!.child.close(7)
  assert.deepEqual(await mutation1, { ok: false, error: 'line two' })

  // Empty stderr → stdout's last line.
  const harness2 = makeSpawnHarness()
  const mutation2 = runDshPluginMutation({
    dshCliPath: 'dsh', argv: [], env: {}, spawn: harness2.spawn, timeoutMs: 1000,
    sanitize: text => text,
  })
  harness2.calls[0]!.child.stdoutLine('stdout says this failed')
  harness2.calls[0]!.child.close(7)
  assert.deepEqual(await mutation2, { ok: false, error: 'stdout says this failed' })

  // No output at all → honest exit-code message.
  const harness3 = makeSpawnHarness()
  const mutation3 = runDshPluginMutation({ dshCliPath: 'dsh', argv: [], env: {}, spawn: harness3.spawn, timeoutMs: 1000 })
  harness3.calls[0]!.child.close(7)
  const result3 = await mutation3
  assert.ok(!result3.ok)
  assert.ok(result3.error.includes('exited with code 7'), result3.error)
})

test('runDshPluginMutation: bounded tail capture keeps the last line under tiny limits', async () => {
  const harness = makeSpawnHarness()
  const mutation = runDshPluginMutation({
    dshCliPath: 'dsh', argv: [], env: {}, spawn: harness.spawn, timeoutMs: 1000,
    stdoutLimit: 32, stderrLimit: 32, sanitize: text => text,
  })
  const child = harness.calls[0]!.child
  child.stderrLine('y'.repeat(500))
  child.stderrLine('boom-line')
  child.close(7)
  const result = await mutation
  assert.ok(!result.ok)
  assert.equal(result.error, 'boom-line', 'the error line survives head-truncation')
})

test('runDshPluginMutation: default sanitize redacts absolute paths; custom sanitize is applied', async () => {
  // Default sanitize (shared-core path redaction).
  const harness1 = makeSpawnHarness()
  const mutation1 = runDshPluginMutation({
    dshCliPath: '/private/tmp/dsh', argv: [], env: {}, spawn: harness1.spawn, timeoutMs: 1000,
  })
  harness1.calls[0]!.child.stderrLine('pnpm error at /private/tmp/state/dsh-home/npm-secret-file')
  harness1.calls[0]!.child.close(7)
  const result1 = await mutation1
  assert.ok(!result1.ok)
  assert.equal(result1.error.includes('/private/tmp/state'), false, 'absolute paths must not leak: ' + result1.error)

  // Explicit custom sanitize.
  const harness2 = makeSpawnHarness()
  const mutation2 = runDshPluginMutation({
    dshCliPath: 'dsh', argv: [], env: {}, spawn: harness2.spawn, timeoutMs: 1000,
    sanitize: text => text.replaceAll('secret', 'XXX'),
  })
  harness2.calls[0]!.child.stderrLine('token secret leaked')
  harness2.calls[0]!.child.close(1)
  const result2 = await mutation2
  assert.ok(!result2.ok)
  assert.equal(result2.error, 'token XXX leaked')
})

test('runDshPluginMutation: timeout SIGTERMs then SIGKILLs and reports the timeout error', async () => {
  const harness = makeSpawnHarness()
  const mutation = runDshPluginMutation({
    dshCliPath: 'dsh', argv: [], env: {}, spawn: harness.spawn, timeoutMs: 60,
  })
  const child = harness.calls[0]!.child
  const result = await mutation
  assert.deepEqual(result, { ok: false, error: ERROR_TIMED_OUT })
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.ok(child.killTimes[1]! - child.killTimes[0]! >= 900, 'SIGKILL follows after the SIGTERM grace window')
})

test('runDshPluginMutation: spawn error event and synchronous spawn throw are reported sanitized', async () => {
  const harness1 = makeSpawnHarness()
  const mutation1 = runDshPluginMutation({ dshCliPath: 'dsh', argv: [], env: {}, spawn: harness1.spawn, timeoutMs: 1000 })
  harness1.calls[0]!.child.error(Object.assign(new Error('spawn /no/such/dsh ENOENT'), { code: 'ENOENT' }))
  const result1 = await mutation1
  assert.ok(!result1.ok)
  assert.ok(result1.error.includes('ENOENT'), result1.error)
  assert.equal(result1.error.includes('/no/such/dsh'), false, 'spawn error paths are sanitized: ' + result1.error)

  const throwing: SpawnFn = () => {
    throw Object.assign(new Error('spawn /blocked/dsh ENOENT'), { code: 'ENOENT' })
  }
  const result2 = await runDshPluginMutation({ dshCliPath: 'dsh', argv: [], env: {}, spawn: throwing, timeoutMs: 1000 })
  assert.ok(!result2.ok)
  assert.ok(result2.error.includes('ENOENT'), result2.error)
  assert.equal(result2.error.includes('/blocked/dsh'), false)
})

// ---------------------------------------------------------------------------
// Executor worker
// ---------------------------------------------------------------------------

test('worker runs ops serially with fixed argv per kind and journal terminals in order', async t => {
  const h = makeExecHarness(t, { withLock: true })
  const opAdd = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-add', spec: 'pkg-add@^1.2.3', initiator: 'desk-1' })
  assert.equal(h.harness.calls.length, 1, 'first op spawns immediately')
  assert.deepEqual(h.harness.calls[0]!.args, ['plugin', '--profile', 'web', 'add', 'pkg-add@^1.2.3'])
  assert.equal(h.exec.workerBusy(), true)

  const opRemove = await enqueueOk(h.exec, { kind: 'remove', name: 'pkg-remove' })
  const opMat = await enqueueOk(h.exec, { kind: 'materialize', name: 'pkg-mat', spec: 'file:/upload/pkg-mat-1.tgz' })
  assert.equal(h.harness.calls.length, 1, 'worker is serial: nothing spawned while op 1 runs')
  assert.equal(h.exec.workerBusy(), true)

  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.harness.calls.length === 2, 'second spawn')
  assert.deepEqual(h.harness.calls[1]!.args, ['plugin', '--profile', 'web', 'remove', 'pkg-remove'])
  h.harness.calls[1]!.child.close(0)
  await waitFor(() => h.harness.calls.length === 3, 'third spawn')
  assert.deepEqual(h.harness.calls[2]!.args, ['plugin', '--profile', 'web', 'add', 'file:/upload/pkg-mat-1.tgz'])
  h.harness.calls[2]!.child.close(0)

  await waitFor(() => h.journal.recent().every(op => op.status !== 'pending'), 'all ops terminal')
  await waitFor(() => h.exec.workerBusy() === false, 'worker idle')
  const recent = h.journal.recent()
  assert.deepEqual(
    recent.map(op => [op.name, op.status]),
    [['pkg-mat', 'ok'], ['pkg-remove', 'ok'], ['pkg-add', 'ok']],
  )
  assert.equal(recent[2]!.initiator, 'desk-1')
  assert.equal(recent[2]!.preImage, opAdd)
  assert.equal(recent[1]!.preImage, opRemove)
  assert.equal(recent[0]!.preImage, opMat)
  assert.equal(h.harness.calls.every(call => call.options.env?.DSH_HOME === join(h.stateDir, 'dsh-home')), true)
})

test('preImage backup files (package.json + pnpm-lock.yaml) exist before the mutation spawns, content preserved', async t => {
  const h = makeExecHarness(t, { withLock: true })
  const opId = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-bak', spec: 'pkg-bak@1' })
  // Spawn already happened (worker is synchronous up to the spawn), so the
  // backup must be complete before any mutation could start.
  const backupDir = backupDirFor(h.stateDir, opId)
  assert.equal(existsSync(backupDir), true)
  assert.equal(readFileSync(join(backupDir, 'package.json'), 'utf8'), h.manifestText, 'pre-mutation manifest content preserved')
  assert.equal(readFileSync(join(backupDir, 'pnpm-lock.yaml'), 'utf8'), h.lockText, 'pre-mutation lockfile content preserved')
  if (posix) {
    assert.equal(mode(backupDir), 0o700)
    assert.equal(mode(join(backupDir, 'package.json')), 0o600)
  }
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'ok', 'op ok')
  assert.equal(h.journal.recent()[0]!.preImage, opId)
})

test('env discipline reaches the spawn: pins applied, DSH_GATEWAY_*/npm_* stripped, private dirs created', async t => {
  // Pre-existing hostile env vars must never reach the child.
  const keys = ['DSH_GATEWAY_TOKEN', 'dsh_gateway_inner', 'npm_config_registry', 'NPM_TOKEN']
  for (const key of keys) process.env[key] = `poison-${key}`
  t.after(() => {
    for (const key of keys) delete process.env[key]
  })

  const h = makeExecHarness(t)
  await enqueueOk(h.exec, { kind: 'install', name: 'pkg-env', spec: 'pkg-env@1' })
  const captured = h.harness.calls[0]!.options.env!
  const thirdParty = thirdPartyRoot(h.stateDir)

  assert.equal(captured.DSH_HOME, join(h.stateDir, 'dsh-home'))
  assert.equal(captured.HOME, join(thirdParty, '.pnpm-home'))
  assert.equal(captured.XDG_CACHE_HOME, join(thirdParty, '.pnpm-cache'))
  assert.equal(captured.XDG_CONFIG_HOME, join(thirdParty, '.pnpm-xdg'))
  assert.equal(captured.NPM_CONFIG_USERCONFIG, join(thirdParty, '.npmrc-empty'))
  for (const key of keys) {
    assert.equal(Object.hasOwn(captured, key), false, `${key} must be stripped from the child env`)
  }
  if (posix) {
    assert.equal(mode(join(thirdParty, '.pnpm-home')), 0o700)
    assert.equal(mode(join(thirdParty, '.pnpm-cache')), 0o700)
    assert.equal(mode(join(thirdParty, '.pnpm-xdg')), 0o700)
    assert.equal(mode(join(thirdParty, '.npmrc-empty')), 0o600)
  }
  assert.equal(readFileSync(join(thirdParty, '.npmrc-empty'), 'utf8'), '', 'NPM_CONFIG_USERCONFIG points at an empty file')

  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'ok', 'op ok')
})

test('worker waits out a closed execution window and runs the op when it opens (canRun false → true)', async t => {
  let gate = false
  const h = makeExecHarness(t, {
    canRun: () => gate,
    canRunWaitMaxMs: 2000,
    canRunPollMs: 10,
  })
  const opId = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-gated' })
  // The dequeue gate is closed: the op is held (pending), never spawned and
  // never blocked while the window may still open.
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(h.journal.recent()[0]?.status, 'pending', 'a closed window parks the op, it is not dropped')
  assert.equal(h.harness.calls.length, 0, 'no spawn while the runtime gate refuses')
  assert.equal(h.exec.workerBusy(), true, 'the parked dequeue keeps the worker occupied (serial queue)')

  gate = true
  await waitFor(() => h.harness.calls.length === 1, 'the window opens → the parked op spawns')
  assert.equal(h.journal.recent()[0]?.id, opId, 'the SAME op runs once the window opens')
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'ok', 'op ok')
})

test('worker blocks the op only after the execution-window wait cap; the queue then continues', async t => {
  let gate = false
  const h = makeExecHarness(t, {
    canRun: () => gate,
    canRunWaitMaxMs: 80,
    canRunPollMs: 10,
  })
  const opBlocked = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-gated' })
  await waitFor(() => h.journal.recent()[0]?.status === 'blocked', 'op blocked after the wait cap')
  assert.equal(h.journal.recent()[0]?.error, ERROR_RUNTIME_BUSY)
  assert.equal(h.harness.calls.length, 0, 'no spawn while the runtime gate refuses')

  gate = true
  const opRun = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-gated-2' })
  assert.equal(h.harness.calls.length, 1)
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'ok', 'op ok')
  assert.equal(h.journal.recent()[0]!.id, opRun)
  assert.equal(h.journal.recent().find(op => op.id === opBlocked)?.status, 'blocked')
})

test('a throwing canRun gate is treated as closed: the op waits and blocks after the cap, never a mutation failure', async t => {
  const h = makeExecHarness(t, {
    canRun: () => { throw new Error('window probe exploded') },
    canRunWaitMaxMs: 60,
    canRunPollMs: 10,
  })
  const opId = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-gate-throw' })
  await waitFor(() => h.journal.recent()[0]?.status === 'blocked', 'throwing gate blocks after the cap')
  assert.equal(h.journal.recent()[0]?.error, ERROR_RUNTIME_BUSY)
  assert.equal(h.journal.recent()[0]?.id, opId)
  assert.equal(h.harness.calls.length, 0, 'never spawned under a throwing gate')
})

test('dispose interrupts an execution-window wait and blocks the parked op as shut down', async t => {
  const h = makeExecHarness(t, {
    canRun: () => false,
    canRunWaitMaxMs: 120_000,
    canRunPollMs: 10,
  })
  await enqueueOk(h.exec, { kind: 'install', name: 'pkg-parked' })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(h.journal.recent()[0]?.status, 'pending', 'op parked in the window wait')
  const disposal = h.exec.dispose()
  await disposal
  assert.equal(h.exec.workerBusy(), false)
  const parked = h.journal.recent()[0]!
  assert.equal(parked.status, 'blocked')
  assert.match(parked.error ?? '', /shut down/)
  assert.equal(h.harness.calls.length, 0, 'a parked op never spawns')
})

test('starting/restarting probe states refuse the spawn after the preImage backup (failed, not blocked)', async t => {
  let state = 'starting'
  const h = makeExecHarness(t, { statusProbe: () => state })
  const opStart = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-starting' })
  await waitFor(() => h.journal.recent()[0]?.status === 'failed', 'starting op failed')
  assert.equal(h.journal.recent()[0]?.error, ERROR_STARTING)
  assert.equal(h.journal.recent()[0]?.preImage, opStart, 'backup precedes the probe refusal (write order ② before ③)')
  assert.equal(existsSync(backupDirFor(h.stateDir, opStart)), true)
  assert.equal(h.harness.calls.length, 0)

  state = 'restarting'
  await enqueueOk(h.exec, { kind: 'remove', name: 'pkg-restarting' })
  await waitFor(() => h.journal.recent()[0]?.status === 'failed', 'restarting op failed')
  assert.equal(h.journal.recent()[0]?.error, ERROR_STARTING)
  assert.equal(h.harness.calls.length, 0, 'never spawned during restart')

  state = 'ready'
  await enqueueOk(h.exec, { kind: 'install', name: 'pkg-ready' })
  assert.equal(h.harness.calls.length, 1)
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'ok', 'ready op ok')
})

test('post-mutation re-check: instance (re)started during the mutation is failed, never recorded ok', async t => {
  let state = 'ready'
  const h = makeExecHarness(t, { statusProbe: () => state })
  // Probe sequence: the pre-check sees 'ready' and spawns; the instance then
  // (re)starts mid-mutation (e.g. a health-cycle restart), so the exit-0
  // spawn must NOT be recorded ok.
  const opFlip = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-flip', spec: 'pkg-flip@1' })
  assert.equal(h.harness.calls.length, 1, 'pre-check ready → spawn happens')
  state = 'starting'
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'failed', 'flipped op failed')
  const flipped = h.journal.recent()[0]!
  assert.equal(flipped.error, ERROR_RESTARTED_DURING_MUTATION)
  assert.equal(flipped.preImage, opFlip, 'preImage is retained for state verification/rollback')
  assert.equal(h.harness.calls.length, 1)
  assert.equal(h.exec.workerBusy(), false)

  // 'restarting' on the post-check is refused the same way.
  state = 'ready'
  const opRestarting = await enqueueOk(h.exec, { kind: 'remove', name: 'pkg-flip-remove' })
  assert.equal(h.harness.calls.length, 2)
  state = 'restarting'
  h.harness.calls[1]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'failed', 'restarting flip failed')
  assert.equal(h.journal.recent()[0]!.error, ERROR_RESTARTED_DURING_MUTATION)
  assert.equal(h.journal.recent()[0]!.id, opRestarting)

  // A real mutation failure is reported as such — the re-check never masks
  // the actual error with the restart message.
  state = 'ready'
  await enqueueOk(h.exec, { kind: 'install', name: 'pkg-real-fail' })
  assert.equal(h.harness.calls.length, 3)
  state = 'starting'
  h.harness.calls[2]!.child.stderrLine('registry 500 on purpose')
  h.harness.calls[2]!.child.close(7)
  await waitFor(() => h.journal.recent()[0]?.status === 'failed', 'real failure recorded')
  assert.equal(h.journal.recent()[0]!.error, 'registry 500 on purpose')

  // Once the instance is back in the window the queue continues normally.
  state = 'ready'
  await enqueueOk(h.exec, { kind: 'install', name: 'pkg-after-flip' })
  assert.equal(h.harness.calls.length, 4)
  h.harness.calls[3]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'ok', 'queue continues after flip')
})

test('queue caps at 8 and duplicates fast-fail while pending, then succeed after terminal', async t => {
  const h = makeExecHarness(t)
  // One held-running op + queued ops up to the cap.
  const first = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-hold' })
  assert.equal(h.harness.calls.length, 1)
  const queued: string[] = []
  for (let i = 0; i < PLUGIN_QUEUE_CAP - 1; i += 1) {
    queued.push(await enqueueOk(h.exec, { kind: 'install', name: `pkg-queue-${i}` }))
  }
  const full = await h.exec.enqueue({ kind: 'install', name: 'pkg-overflow' })
  assert.ok(!full.ok)
  if (!full.ok) {
    assert.equal(full.code, 'queue_full')
    assert.ok(full.error.includes('full'), full.error)
  }

  // Duplicate fast-fail while the same kind+name is pending/running (checked
  // before the cap: the dup contract wins even on a full queue).
  const dup = await h.exec.enqueue({ kind: 'install', name: 'pkg-hold' })
  assert.ok(!dup.ok)
  if (!dup.ok) {
    assert.equal(dup.code, 'queue_busy')
    assert.equal(dup.error, ERROR_DUPLICATE_PENDING)
  }
  // At the cap a different-kind op is refused too: the queue depth is shared.
  const atCap = await h.exec.enqueue({ kind: 'remove', name: 'pkg-hold' })
  assert.ok(!atCap.ok)
  if (!atCap.ok) assert.equal(atCap.code, 'queue_full')

  // Drain: every queued op runs and terminates ok (8 live ops total).
  for (let index = 0; index < PLUGIN_QUEUE_CAP; index += 1) {
    await waitFor(() => h.harness.calls[index] !== undefined, `spawn ${index}`)
    h.harness.calls[index]!.child.close(0)
  }
  await waitFor(() => h.journal.recent().every(op => op.status !== 'pending'), 'all terminal')
  assert.equal(h.journal.recent().filter(op => op.status === 'ok').length, PLUGIN_QUEUE_CAP)
  assert.equal(h.journal.recent().some(op => op.id === first), true)

  // After terminal, the same kind+name may be enqueued again.
  const retry = await h.exec.enqueue({ kind: 'install', name: 'pkg-hold' })
  assert.ok(retry.ok)
  h.harness.calls[PLUGIN_QUEUE_CAP]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'ok', 'retry ok')
})

test('dispose stops acceptance, kills the in-flight child, blocks queued ops and waits for the worker', async t => {
  const h = makeExecHarness(t)
  const inFlight = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-inflight' })
  await enqueueOk(h.exec, { kind: 'remove', name: 'pkg-queued' })
  assert.equal(h.exec.workerBusy(), true)
  const child = h.harness.calls[0]!.child
  child.closeOnKill = true

  const disposal = h.exec.dispose()
  await disposal
  assert.deepEqual(child.signals, ['SIGTERM'], 'in-flight child is SIGTERMed on dispose')
  assert.equal(h.exec.workerBusy(), false)

  const recent = h.journal.recent()
  const inFlightOp = recent.find(op => op.id === inFlight)
  assert.equal(inFlightOp?.status, 'failed')
  const inFlightError = inFlightOp?.error ?? ''
  assert.ok(inFlightError.includes('terminated by SIGTERM'), inFlightError)
  const queuedOp = recent.find(op => op.name === 'pkg-queued')
  assert.equal(queuedOp?.status, 'blocked')
  const queuedError = queuedOp?.error ?? ''
  assert.ok(queuedError.includes('shut down'), queuedError)
  assert.equal(h.harness.calls.length, 1, 'queued op never spawned')

  const after = await h.exec.enqueue({ kind: 'install', name: 'pkg-late' })
  assert.ok(!after.ok)
  if (!after.ok) assert.equal(after.code, 'queue_busy')
})

// ---------------------------------------------------------------------------
// onTerminal hook + per-op cliLaunch (plan Phase 4.4 wiring seams)
// ---------------------------------------------------------------------------

test('onTerminal fires once per op with the recorded op and status, after the journal terminal', async t => {
  const terminals: Array<{ id: string; name: string; status: string }> = []
  const h = makeExecHarness(t, {
    onTerminal: (op, terminalStatus) => {
      terminals.push({ id: op.id, name: op.name, status: terminalStatus })
    },
  })
  const opId = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-term', spec: 'pkg-term@1' })
  assert.equal(terminals.length, 0, 'no terminal before the child closes')
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => terminals.length === 1, 'ok terminal hook')
  assert.equal(terminals[0]!.id, opId)
  assert.equal(terminals[0]!.name, 'pkg-term')
  assert.equal(terminals[0]!.status, 'ok')
  // The hook fires AFTER the journal terminal state was recorded.
  assert.equal(h.journal.recent().find(op => op.id === opId)?.status, 'ok')

  // A failing mutation reports failed with the journal already terminal.
  await enqueueOk(h.exec, { kind: 'remove', name: 'pkg-term-fail' })
  h.harness.calls[1]!.child.close(3)
  await waitFor(() => terminals.length === 2, 'failed terminal hook')
  assert.equal(terminals[1]!.status, 'failed')
  assert.equal(h.journal.recent()[0]!.status, 'failed')
})

test('onTerminal fires for dispose-blocked ops (queued blocked, in-flight failed) with terminals recorded', async t => {
  const terminals: Array<{ id: string; status: string }> = []
  const h = makeExecHarness(t, {
    onTerminal: (op, terminalStatus) => {
      terminals.push({ id: op.id, status: terminalStatus })
    },
  })
  const inFlight = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-disp-term' })
  const queued = await enqueueOk(h.exec, { kind: 'remove', name: 'pkg-disp-queued' })
  assert.equal(terminals.length, 0)
  h.harness.calls[0]!.child.closeOnKill = true
  await h.exec.dispose()
  await waitFor(() => terminals.length === 2, 'dispose terminals')
  const byId = new Map(terminals.map(entry => [entry.id, entry.status]))
  assert.equal(byId.get(inFlight), 'failed', 'in-flight child kill lands failed')
  assert.equal(byId.get(queued), 'blocked', 'queued op lands blocked')
  assert.equal(h.journal.recent().find(op => op.id === queued)?.status, 'blocked')
  assert.equal(h.journal.recent().find(op => op.id === inFlight)?.status, 'failed')
  // Exactly one terminal per op.
  assert.equal(terminals.length, 2)
})

test('runDshPluginMutation splices argvPrefix between the executable and argv and honors cwd', async () => {
  const harness = makeSpawnHarness()
  const mutation = runDshPluginMutation({
    dshCliPath: '/managed/node',
    argvPrefix: ['--expose-internals', '/managed/dsh/lib/bin.js'],
    argv: ['plugin', '--profile', 'web', 'add', 'pkg@1'],
    env: { PATH: '/usr/bin' },
    cwd: '/managed/dsh',
    spawn: harness.spawn,
    timeoutMs: 1000,
  })
  harness.calls[0]!.child.close(0)
  assert.deepEqual(await mutation, { ok: true })
  assert.equal(harness.calls[0]!.command, '/managed/node')
  assert.deepEqual(harness.calls[0]!.args, ['--expose-internals', '/managed/dsh/lib/bin.js', 'plugin', '--profile', 'web', 'add', 'pkg@1'])
  assert.equal(harness.calls[0]!.options.cwd, '/managed/dsh')
})

test('cliLaunch per-op resolution reaches the spawn (second op sees a switched workspace)', async t => {
  let entry = '/ws-a/node_modules/@deepseek-ai/dsh/lib/bin.js'
  const h = makeExecHarness(t, {
    cliLaunch: () => ({ argvPrefix: [entry], cwd: '/ws-a' }),
  })
  await enqueueOk(h.exec, { kind: 'install', name: 'pkg-switch', spec: 'pkg-switch@1' })
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'ok', 'first op ok')

  // Simulate a runtime version switch between ops: the next spawn must use
  // the NEW entry even though the executor predates the switch.
  entry = '/ws-b/node_modules/@deepseek-ai/dsh/lib/bin.js'
  await enqueueOk(h.exec, { kind: 'remove', name: 'pkg-switch' })
  assert.equal(h.harness.calls.length, 2)
  assert.deepEqual(h.harness.calls[1]!.args, ['/ws-b/node_modules/@deepseek-ai/dsh/lib/bin.js', 'plugin', '--profile', 'web', 'remove', 'pkg-switch'])
  h.harness.calls[1]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'ok', 'second op ok')
})

// ---------------------------------------------------------------------------
// Fix regressions (design 21 review P1/P2): lease-release on journal
// terminal failure, URL/secret redaction by the default sanitizer, and
// crash-orphan childPid journaling.
// ---------------------------------------------------------------------------

test('default sanitize redacts URL credentials + named secrets and byte-bounds the error', async () => {
  const harness = makeSpawnHarness()
  const mutation = runDshPluginMutation({
    dshCliPath: '/managed/dsh', argv: [], env: {}, spawn: harness.spawn, timeoutMs: 1000,
  })
  harness.calls[0]!.child.stderrLine('pnpm error fetching https://user:super-secret@registry.example/pkg (token=abc123, password=hunter2)')
  harness.calls[0]!.child.close(7)
  const result = await mutation
  assert.ok(!result.ok)
  assert.equal(result.error.includes('super-secret'), false, 'URL userinfo must be redacted: ' + result.error)
  assert.equal(result.error.includes('abc123'), false, 'named token must be redacted: ' + result.error)
  assert.equal(result.error.includes('hunter2'), false, 'named password must be redacted: ' + result.error)
  assert.ok(result.error.includes('registry.example'), 'the URL origin survives for diagnosis')

  // Byte bound: a pathological single-line error is truncated to the cap.
  const harness2 = makeSpawnHarness()
  const mutation2 = runDshPluginMutation({
    dshCliPath: '/managed/dsh', argv: [], env: {}, spawn: harness2.spawn, timeoutMs: 1000,
  })
  harness2.calls[0]!.child.stderrLine(`${'x'.repeat(9000)}boom`)
  harness2.calls[0]!.child.close(1)
  const result2 = await mutation2
  assert.ok(!result2.ok)
  assert.ok((result2.error as string).length <= 2400, `error must be byte-bounded: ${(result2.error as string).length}`)
  assert.equal((result2.error as string).includes('boom'), false, 'the tail beyond the bound is dropped')
})

test('terminal hook STILL fires when the journal terminal write throws (lease must not outlive its op)', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'plugins-exec-throw-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const profileDir = join(stateDir, 'dsh-home', 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'web', version: '0.0.0', dependencies: {} }), 'utf8')
  const harness = makeSpawnHarness()
  const terminals: Array<{ id: string; status: string }> = []
  const failingJournal = {
    appendPending: () => 'op-throw',
    recordPreImage: () => { throw new Error('disk full') },
    markTerminal: (): never => { throw new Error('disk full') },
  }
  const exec = createPluginsExec({
    stateDir,
    dshCliPath: '/managed/dsh',
    journal: failingJournal as never,
    statusProbe: () => 'ready',
    logger: silent,
    spawn: harness.spawn,
    onTerminal: (op, status) => { terminals.push({ id: op.id, status }) },
  })
  const result = await exec.enqueue({ kind: 'install', name: 'pkg-throw', spec: 'pkg-throw@1' })
  assert.ok(result.ok)
  // The pre-mutation backup itself fails first (recordPreImage throws) —
  // complete() then runs with markTerminal throwing: the hook must still
  // fire exactly once with the synthesized record.
  await waitFor(() => terminals.length === 1, 'terminal hook on journal failure')
  assert.equal(terminals[0]!.id, 'op-throw')
  assert.equal(terminals[0]!.status, 'failed')
  assert.equal(terminals.length, 1, 'exactly one terminal')
  await exec.dispose()
})

test('terminal hook fires when the journal record was lost mid-op (markTerminal null)', async t => {
  const terminals: Array<{ id: string; status: string }> = []
  const h = makeExecHarness(t, {
    onTerminal: (op, terminalStatus) => {
      terminals.push({ id: op.id, status: terminalStatus })
    },
  })
  const opId = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-lost', spec: 'pkg-lost@1' })
  // Corrupt the journal file while the op is in flight: the next read
  // renames it aside and markTerminal answers null (the record is gone).
  writeFileSync(join(h.stateDir, 'chamber-plugins', 'third-party', 'journal.json'), 'not-json{', 'utf8')
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => terminals.length === 1, 'terminal hook on lost journal record')
  assert.equal(terminals[0]!.id, opId)
  assert.equal(terminals[0]!.status, 'ok', 'the mutation itself succeeded')
  assert.equal(h.journal.recent().some(op => op.id === opId), false, 'the lost record is not in the fresh journal')
})

test('the spawned child pid is journaled while pending and cleared at the terminal (crash-orphan reaping)', async t => {
  const h = makeExecHarness(t)
  const opId = await enqueueOk(h.exec, { kind: 'install', name: 'pkg-pid', spec: 'pkg-pid@1' })
  await waitFor(() => h.harness.calls.length === 1, 'mutation spawns')
  await waitFor(() => h.journal.recent().find(op => op.id === opId)?.childPid !== undefined, 'child pid journaled')
  assert.equal(h.journal.recent().find(op => op.id === opId)?.childPid, 9000, 'the spawn fake reports pid 9000')
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent().find(op => op.id === opId)?.status === 'ok', 'op ok')
  assert.equal(h.journal.recent().find(op => op.id === opId)?.childPid, undefined, 'terminal clears the child pid')
})
