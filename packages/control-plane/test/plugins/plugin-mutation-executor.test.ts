/**
 * plugin-mutation-executor tests (design 21 §6.3 executor core): the env
 * whitelist discipline (with the canonical dsh-runtime INSTALL_ENV_WHITELIST —
 * the single source this package deliberately takes as a parameter) and the
 * bounded runPluginMutation outcomes (exit/timeout/spawn error/argv+cwd).
 * Plain node:test; injected spawn — no real child is ever spawned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { SpawnOptions } from 'node:child_process'
import { INSTALL_ENV_WHITELIST } from '../../../dsh-runtime/src/runtime-installer.ts'
import {
  ERROR_MUTATION_TIMED_OUT,
  runPluginMutation,
  scrubMutationEnv,
  type MutationChild,
  type MutationProcessStream,
  type MutationSpawnFn,
} from '../../src/plugin-mutation-executor.ts'

class FakeStream extends EventEmitter {
  emitChunk(chunk: string): void {
    this.emit('data', Buffer.from(chunk, 'utf8'))
  }
}

class FakeChild implements MutationChild {
  pid: number
  stdout: MutationProcessStream = new FakeStream()
  stderr: MutationProcessStream = new FakeStream()
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

function makeSpawnHarness(): { spawn: MutationSpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawn: MutationSpawnFn = (command, args, options) => {
    const child = new FakeChild(9000 + calls.length)
    calls.push({ command, args, options, child })
    return child
  }
  return { spawn, calls }
}

const identity = (text: string): string => text

test('scrubMutationEnv is a WHITELIST: only PATH/proxies survive; every ambient var is dropped, pins always apply', () => {
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
    XDG_CACHE_HOME: '/state/chamber-plugins/third-party/.pnpm-cache',
    XDG_CONFIG_HOME: '/state/chamber-plugins/third-party/.pnpm-xdg',
    NPM_CONFIG_USERCONFIG: '/state/chamber-plugins/third-party/.npmrc-empty',
    npm_config_userconfig: '/state/chamber-plugins/third-party/.npmrc-empty',
  }
  const result = scrubMutationEnv(source, pins, INSTALL_ENV_WHITELIST)

  assert.equal(result.PATH, '/usr/bin:/bin')
  assert.equal(result.HTTP_PROXY, 'http://proxy:3128')
  assert.equal(result.https_proxy, 'http://proxy:3128')
  assert.equal(result.NO_PROXY, '*.local')
  assert.equal(result.no_proxy, '127.0.0.1')
  // A whitelist keeps ONLY the proxy family: KEEP_ME is ambient and must fall.
  for (const key of ['DSH_GATEWAY_TOKEN', 'dsh_gateway_inner', 'npm_config_registry', 'NPM_TOKEN',
    'Npm_Config_Registry', 'NODE_AUTH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY',
    'KEEP_ME']) {
    assert.equal(Object.hasOwn(result, key), false, `${key} must be dropped by the whitelist`)
  }
  // HOME is dropped and NOT restored: pinning HOME would move pnpm's default
  // store away from the store the managed profile was provisioned against
  // (pnpm 11 refuses every mutation on that mismatch — design 21 §6.3 ⑨).
  assert.equal(Object.hasOwn(result, 'HOME'), false, 'HOME must stay absent so pnpm falls back to the passwd home store')
  assert.equal(result.DSH_HOME, '/state/dsh-home')
  assert.equal(result.XDG_CACHE_HOME, '/state/chamber-plugins/third-party/.pnpm-cache')
  assert.equal(result.XDG_CONFIG_HOME, '/state/chamber-plugins/third-party/.pnpm-xdg')
  assert.equal(result.NPM_CONFIG_USERCONFIG, '/state/chamber-plugins/third-party/.npmrc-empty', 'upper-case pin restores the pinned name')
  assert.equal(result.npm_config_userconfig, '/state/chamber-plugins/third-party/.npmrc-empty', 'lower-case pin restores the pinned name (pnpm 11 reads either casing)')
  assert.equal(result.UNSET_VAR, undefined)
})

test('runPluginMutation: exit 0 is ok and forwards argv/env to the spawn seam', async () => {
  const harness = makeSpawnHarness()
  const env = { PATH: '/usr/bin', DSH_HOME: '/state/dsh-home' }
  const mutation = runPluginMutation({
    command: '/managed/dsh',
    argv: ['plugin', '--profile', 'web', 'add', 'pkg@^1'],
    env,
    spawn: harness.spawn,
    timeoutMs: 1000,
    sanitize: identity,
  })
  harness.calls[0]!.child.close(0)
  assert.deepEqual(await mutation, { ok: true })
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0]!.command, '/managed/dsh')
  assert.deepEqual(harness.calls[0]!.args, ['plugin', '--profile', 'web', 'add', 'pkg@^1'])
  assert.deepEqual(harness.calls[0]!.options.env, env)
  assert.deepEqual(harness.calls[0]!.options.stdio, ['ignore', 'pipe', 'pipe'])
  if (process.platform !== 'win32') assert.equal(harness.calls[0]!.options.detached, true)
})

test('runPluginMutation: non-zero exit surfaces the sanitized last stderr line, falling back to stdout', async () => {
  const harness1 = makeSpawnHarness()
  const mutation1 = runPluginMutation({
    command: 'dsh', argv: [], env: {}, spawn: harness1.spawn, timeoutMs: 1000, sanitize: identity,
  })
  harness1.calls[0]!.child.stderrLine('line one')
  harness1.calls[0]!.child.stderrLine('line two')
  harness1.calls[0]!.child.stdoutLine('ignored stdout')
  harness1.calls[0]!.child.close(7)
  assert.deepEqual(await mutation1, { ok: false, error: 'line two' })

  const harness2 = makeSpawnHarness()
  const mutation2 = runPluginMutation({
    command: 'dsh', argv: [], env: {}, spawn: harness2.spawn, timeoutMs: 1000, sanitize: identity,
  })
  harness2.calls[0]!.child.stdoutLine('stdout says this failed')
  harness2.calls[0]!.child.close(7)
  assert.deepEqual(await mutation2, { ok: false, error: 'stdout says this failed' })

  const harness3 = makeSpawnHarness()
  const mutation3 = runPluginMutation({ command: 'dsh', argv: [], env: {}, spawn: harness3.spawn, timeoutMs: 1000, sanitize: identity })
  harness3.calls[0]!.child.close(7)
  const result3 = await mutation3
  assert.ok(!result3.ok)
  assert.ok(result3.error.includes('exited with code 7'), result3.error)
})

test('runPluginMutation: bounded tail capture keeps the last line under tiny limits', async () => {
  const harness = makeSpawnHarness()
  const mutation = runPluginMutation({
    command: 'dsh', argv: [], env: {}, spawn: harness.spawn, timeoutMs: 1000,
    stdoutLimit: 32, stderrLimit: 32, sanitize: identity,
  })
  const child = harness.calls[0]!.child
  child.stderrLine('y'.repeat(500))
  child.stderrLine('boom-line')
  child.close(7)
  const result = await mutation
  assert.ok(!result.ok)
  assert.equal(result.error, 'boom-line', 'the error line survives head-truncation')
})

test('runPluginMutation: custom sanitize is applied to every failure shape', async () => {
  const harness = makeSpawnHarness()
  const mutation = runPluginMutation({
    command: 'dsh', argv: [], env: {}, spawn: harness.spawn, timeoutMs: 1000,
    sanitize: text => text.replaceAll('secret', 'XXX'),
  })
  harness.calls[0]!.child.stderrLine('token secret leaked')
  harness.calls[0]!.child.close(1)
  const result = await mutation
  assert.ok(!result.ok)
  assert.equal(result.error, 'token XXX leaked')
})

test('runPluginMutation: timeout SIGTERMs then SIGKILLs and reports the timeout error', async () => {
  const harness = makeSpawnHarness()
  const mutation = runPluginMutation({
    command: 'dsh', argv: [], env: {}, spawn: harness.spawn, timeoutMs: 60, sanitize: identity,
  })
  const child = harness.calls[0]!.child
  const result = await mutation
  assert.deepEqual(result, { ok: false, error: ERROR_MUTATION_TIMED_OUT })
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.ok(child.killTimes[1]! - child.killTimes[0]! >= 900, 'SIGKILL follows after the SIGTERM grace window')
})

test('runPluginMutation: spawn error event and synchronous spawn throw are reported sanitized', async () => {
  const harness1 = makeSpawnHarness()
  const mutation1 = runPluginMutation({ command: 'dsh', argv: [], env: {}, spawn: harness1.spawn, timeoutMs: 1000, sanitize: identity })
  harness1.calls[0]!.child.error(Object.assign(new Error('spawn /no/such/dsh ENOENT'), { code: 'ENOENT' }))
  const result1 = await mutation1
  assert.ok(!result1.ok)
  assert.ok(result1.error.includes('ENOENT'), result1.error)
  assert.ok(result1.error.includes('/no/such/dsh'), 'the sanitizer is the CALLER policy; with identity the path survives')

  const throwing: MutationSpawnFn = () => {
    throw Object.assign(new Error('spawn /blocked/dsh ENOENT'), { code: 'ENOENT' })
  }
  const result2 = await runPluginMutation({ command: 'dsh', argv: [], env: {}, spawn: throwing, timeoutMs: 1000, sanitize: identity })
  assert.ok(!result2.ok)
  assert.ok(result2.error.includes('ENOENT'), result2.error)
})

test('runPluginMutation splices argvPrefix between the executable and argv and honors cwd', async () => {
  const harness = makeSpawnHarness()
  const mutation = runPluginMutation({
    command: '/managed/node',
    argvPrefix: ['--expose-internals', '/managed/dsh/lib/bin.js'],
    argv: ['plugin', '--profile', 'web', 'add', 'pkg@1'],
    env: { PATH: '/usr/bin' },
    cwd: '/managed/dsh',
    spawn: harness.spawn,
    timeoutMs: 1000,
    sanitize: identity,
  })
  harness.calls[0]!.child.close(0)
  assert.deepEqual(await mutation, { ok: true })
  assert.equal(harness.calls[0]!.command, '/managed/node')
  assert.deepEqual(harness.calls[0]!.args, ['--expose-internals', '/managed/dsh/lib/bin.js', 'plugin', '--profile', 'web', 'add', 'pkg@1'])
  assert.equal(harness.calls[0]!.options.cwd, '/managed/dsh')
})

test('runPluginMutation: the injected childExecutor seam is used instead of the built-in spawn', async () => {
  const harness = makeSpawnHarness()
  const seen: Array<{ command: string; args: string[]; timeoutMs: number }> = []
  const result = await runPluginMutation({
    command: '/managed/dsh',
    argv: ['plugin', '--profile', 'web', 'remove', 'pkg'],
    env: { PATH: '/usr/bin' },
    spawn: harness.spawn,
    timeoutMs: 1234,
    sanitize: identity,
    childExecutor: async execution => {
      seen.push({ command: execution.command, args: execution.args, timeoutMs: execution.timeoutMs })
      return { code: 0, signal: null, stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(seen, [{ command: '/managed/dsh', args: ['plugin', '--profile', 'web', 'remove', 'pkg'], timeoutMs: 1234 }])
  assert.equal(harness.calls.length, 0, 'the built-in spawn is bypassed')
})
