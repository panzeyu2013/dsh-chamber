/**
 * Desktop login-shell environment (login-shell-env.ts; rc.2 parity, design 02
 * §3.1 sibling).
 *
 * Pure halves (marker parsing, protected-namespace merge) plus the real probe
 * path with stand-in shells: early completion is the success contract; a
 * timed-out / marker-less candidate is killed as a process group and the next
 * candidate answers; the probe environment keys never leak into the merge; a
 * successful probe is not killed; non-ASCII values survive the chunked read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOGIN_SHELL_ENV_BEGIN,
  LOGIN_SHELL_ENV_END,
  LOGIN_SHELL_TIMEOUT_ENV,
  PROBE_ENV,
  __resetLoginShellEnvironmentOnceForTests,
  loginShellCandidates,
  mergeLoginShellEnvironment,
  parseLoginShellEnvironment,
  readLoginShellEnvironment,
  readLoginShellEnvironmentOnce,
} from '../../src/login-shell-env.ts'

const BASE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/user',
  DSH_HOME: '/state/dsh',
  ELECTRON_RUN_AS_NODE: '1',
  PWD: '/from/parent',
  CHAMBER_UNICODE: '路径/目录/ünïcode',
}

/** A stand-in "successful login shell": prints the markers and its own env. */
function goodShell(dir: string): string {
  const file = join(dir, 'good.sh')
  writeFileSync(file, [
    '#!/bin/sh',
    "printf %s '" + LOGIN_SHELL_ENV_BEGIN + "'",
    'env -0',
    "printf %s '" + LOGIN_SHELL_ENV_END + "'",
    '',
  ].join('\n'))
  chmodSync(file, 0o755)
  return file
}

/** A stand-in shell that never answers (killed by the budget). */
function stuckShell(dir: string): string {
  const file = join(dir, 'stuck.sh')
  writeFileSync(file, '#!/bin/sh\nsleep 30\n')
  chmodSync(file, 0o755)
  return file
}

/** A stand-in shell that answers without the closing marker. */
function chattyShell(dir: string): string {
  const file = join(dir, 'chatty.sh')
  writeFileSync(file, '#!/bin/sh\necho not-the-probe\n')
  chmodSync(file, 0o755)
  return file
}

test('loginShellCandidates: account shell first, POSIX fallbacks, no duplicates', () => {
  assert.deepEqual(loginShellCandidates('darwin', '/opt/homebrew/bin/zsh'),
    ['/opt/homebrew/bin/zsh', '/bin/zsh', '/bin/bash', '/bin/sh'])
  assert.deepEqual(loginShellCandidates('linux', '/bin/zsh'), ['/bin/zsh', '/bin/bash', '/bin/sh'])
  assert.deepEqual(loginShellCandidates('linux', null), ['/bin/zsh', '/bin/bash', '/bin/sh'])
  assert.deepEqual(loginShellCandidates('win32', 'C:\\Windows\\System32\\cmd.exe'), [])
})

test('parseLoginShellEnvironment: marker-delimited NUL pairs, incomplete payload is null', () => {
  const stdout = `prompt noise${LOGIN_SHELL_ENV_BEGIN}A=1\u0000B=two=equals\u0000C=\u0000\u0000${LOGIN_SHELL_ENV_END}trailing`
  assert.deepEqual(parseLoginShellEnvironment(stdout), { A: '1', B: 'two=equals', C: '' })
  assert.equal(parseLoginShellEnvironment(`${LOGIN_SHELL_ENV_BEGIN}A=1\u0000`), null)
  assert.equal(parseLoginShellEnvironment('no markers at all'), null)
})

test('mergeLoginShellEnvironment: shell values win, probe keys/namespaces/probe vars never do', () => {
  const merged = mergeLoginShellEnvironment(BASE, {
    PATH: '/opt/homebrew/bin:/usr/bin',
    HOME: '/home/user',
    DSH_HOME: '/hijacked',
    ELECTRON_RUN_AS_NODE: '',
    PWD: '/hijacked',
    SHLVL: '9',
    _: '/usr/bin/env',
    HTTP_PROXY: 'http://proxy.local:8080',
    ...PROBE_ENV,
  })
  assert.equal(merged.PATH, '/opt/homebrew/bin:/usr/bin', 'shell PATH replaces the launchd one')
  assert.equal(merged.HTTP_PROXY, 'http://proxy.local:8080', 'proxy from the startup files wins')
  assert.equal(merged.DSH_HOME, '/state/dsh', 'a startup file must not move the host home')
  assert.equal(merged.ELECTRON_RUN_AS_NODE, '1', 'the Electron runtime marker stays inherited')
  assert.equal(merged.PWD, '/from/parent', 'probe-session variables stay inherited')
  for (const key of Object.keys(PROBE_ENV)) {
    assert.equal(merged[key], undefined, `the probe key ${key} must never reach the host environment`)
  }
})

test('readLoginShellEnvironment: a real POSIX shell completes at the closing marker', async () => {
  const result = await readLoginShellEnvironment({ ...BASE, LOGIN_ENV_PROBE: 'kept' }, { shells: ['/bin/sh'], timeoutMs: 5_000 })
  assert.deepEqual(result.failures, [], 'a real /bin/sh answers the probe')
  assert.equal(result.environment.LOGIN_ENV_PROBE, 'kept', 'inherited values survive the merge')
  assert.equal(result.environment.DSH_HOME, '/state/dsh')
  assert.equal(typeof result.environment.PATH, 'string')
})

test('readLoginShellEnvironment: stand-in shell answers; probe keys are stripped and UTF-8 survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chamber-login-shell-'))
  try {
    const good = goodShell(dir)
    const result = await readLoginShellEnvironment(BASE, { shells: [good], timeoutMs: 5_000 })
    assert.deepEqual(result.failures, [])
    assert.equal(result.environment.CHAMBER_UNICODE, BASE.CHAMBER_UNICODE, 'a non-ASCII value is decoded intact')
    for (const key of Object.keys(PROBE_ENV)) {
      assert.equal(result.environment[key], undefined, `the probe key ${key} must not leak`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLoginShellEnvironment: a stuck candidate is killed and the next one answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chamber-login-shell-'))
  try {
    const started = Date.now()
    const result = await readLoginShellEnvironment(BASE, { shells: [stuckShell(dir), goodShell(dir)], timeoutMs: 2_000 })
    assert.equal(result.failures.length, 1, 'the stuck shell is reported')
    assert.match(result.failures[0]!.reason, /timed out/)
    assert.ok(Date.now() - started < 10_000, 'the budget, not the sleep, bounds the read')
    assert.equal(result.environment.DSH_HOME, BASE.DSH_HOME, 'the fallback candidate answered (protected names stay)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLoginShellEnvironment: a marker-less candidate falls back; all failing returns base', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chamber-login-shell-'))
  try {
    const fallback = await readLoginShellEnvironment(BASE, { shells: [chattyShell(dir), goodShell(dir)], timeoutMs: 2_000 })
    assert.equal(fallback.failures.length, 1)
    assert.match(fallback.failures[0]!.reason, /closing marker missing/)
    assert.equal(fallback.environment.DSH_HOME, BASE.DSH_HOME, 'the fallback shell answered')
    const none = await readLoginShellEnvironment(BASE, { shells: [chattyShell(dir)], timeoutMs: 2_000 })
    assert.deepEqual(none.environment, { ...BASE }, 'no candidate answering returns the inherited environment unchanged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLoginShellEnvironment: an already-aborted signal reports aborted and spawns nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chamber-login-shell-'))
  try {
    const controller = new AbortController()
    controller.abort()
    const result = await readLoginShellEnvironment(BASE, { shells: [goodShell(dir)], signal: controller.signal, timeoutMs: 2_000 })
    assert.deepEqual(result.environment, { ...BASE })
    assert.deepEqual(result.failures.map(f => f.reason), ['aborted'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLoginShellEnvironment: Windows skips the read even with explicit shells', async () => {
  const result = await readLoginShellEnvironment(BASE, { platform: 'win32', shells: ['/bin/sh'] })
  assert.deepEqual(result, { environment: { ...BASE }, failures: [] })
})

test('readLoginShellEnvironment: an invalid timeout override is a loud configuration error', async () => {
  await assert.rejects(
    () => readLoginShellEnvironment({ ...BASE, [LOGIN_SHELL_TIMEOUT_ENV]: '10' }, { shells: ['/bin/sh'] }),
    /must be an integer from 1000 through 2147483647/,
  )
})

test('readLoginShellEnvironmentOnce: the process-lifetime memo keeps the first answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chamber-login-shell-'))
  try {
    __resetLoginShellEnvironmentOnceForTests()
    const first = await readLoginShellEnvironmentOnce(BASE, { shells: [goodShell(dir)], timeoutMs: 2_000 })
    const second = await readLoginShellEnvironmentOnce(BASE, { shells: [stuckShell(dir)], timeoutMs: 50 })
    assert.deepEqual(second, first, 'later calls share the first read')
  } finally {
    __resetLoginShellEnvironmentOnceForTests()
    rmSync(dir, { recursive: true, force: true })
  }
})
