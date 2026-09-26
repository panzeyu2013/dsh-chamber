/**
 * Bundled-pnpm PATH provision (design 02 §3.1): the wrapper's script shape on both
 * platforms, the host-PATH probe (which mirrors the child's own command lookup),
 * idempotent materialization, and the decision `withPnpmShim` makes for one managed
 * host env. The end-to-end proof that the provision reaches a real child lives in
 * spawn-dsh.test.ts.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  PNPM_SHIM_DIR,
  ensurePnpmShim,
  pathProvidesPnpm,
  pnpmShimScript,
  posixQuote,
  withPnpmShim,
} from '../../src/pnpm-shim.ts'

const quiet = () => {}

/** Scratch root cleaned with the test context. Deliberately local: the shared
 *  support helper pulls the whole control-plane index, and this unit file must stay
 *  runnable as a plain `node <file>` probe of the provision itself. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-shim-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A fake bundled pnpm entry: prints its argv so the wrapper's forwarding is observable. */
function writeFakePnpmEntry(root: string): string {
  const entry = join(root, 'pnpm.cjs')
  writeFileSync(entry, "console.log('FAKE_PNPM ' + process.argv.slice(2).join('|'))\n")
  return entry
}

test('pnpmShimScript: POSIX wrapper quotes every word and exports the node env', () => {
  const script = pnpmShimScript({
    platform: 'darwin',
    nodeFile: '/Applications/dsh chamber.app/sidecar/node',
    nodeArgs: ['--expose-internals'],
    nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    pnpmEntry: "/sidecar/pnpm's dir/pnpm.cjs",
  })
  const lines = script.split('\n')
  assert.equal(lines[0], '#!/bin/sh')
  assert.equal(lines.includes("export ELECTRON_RUN_AS_NODE='1'"), true)
  // Hardcoded, never assembled from posixQuote: a broken quoting function must fail here.
  assert.equal(
    lines.includes(
      `exec '/Applications/dsh chamber.app/sidecar/node' '--expose-internals' '/sidecar/pnpm'\\''s dir/pnpm.cjs' "$@"`,
    ),
    true,
  )
  assert.equal(posixQuote("a'b"), "'a'\\''b'")
})

test('pnpmShimScript: the Windows wrapper forwards %* and escapes percent signs', () => {
  const script = pnpmShimScript({
    platform: 'win32',
    nodeFile: 'C:\\dsh chamber\\electron.exe',
    nodeArgs: ['--expose-internals'],
    nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    pnpmEntry: 'C:\\dsh chamber\\100%\\pnpm.cjs',
  })
  const lines = script.split('\r\n')
  assert.equal(lines[0], '@echo off')
  assert.equal(lines.includes('set "ELECTRON_RUN_AS_NODE=1"'), true)
  assert.equal(
    lines.includes('"C:\\dsh chamber\\electron.exe" "--expose-internals" "C:\\dsh chamber\\100%%\\pnpm.cjs" %*'),
    true,
  )
})

test('pathProvidesPnpm: first hit wins, entries resolve against the child cwd, PATHEXT drives Windows names', () => {
  const probed: string[] = []
  const executable = (file: string) => {
    probed.push(file)
    return file === join('/child', 'a', 'pnpm') || file === join('/child', 'b', 'pnpm')
  }
  assert.equal(pathProvidesPnpm('a:b', 'darwin', executable, { cwd: '/child' }), join('/child', 'a', 'pnpm'))
  assert.equal(probed.includes(join('/child', 'b', 'pnpm')), false, 'the scan stops at the first hit')
  probed.length = 0
  // An empty entry means the child cwd; an unset PATH contributes nothing at all.
  assert.equal(pathProvidesPnpm('', 'darwin', executable, { cwd: '/child' }), null)
  assert.equal(probed[0], join('/child', 'pnpm'))
  assert.equal(pathProvidesPnpm(undefined, 'darwin', executable), null)
  assert.equal(probed.length, 1, 'an unset PATH probes nothing')
  probed.length = 0
  // Windows: PATHEXT order, quoted entries unwrapped.
  assert.equal(pathProvidesPnpm('"/opt/tools"', 'win32', file => file === join('/opt/tools', 'pnpm.CMD'), { pathExt: '.EXE;.CMD', cwd: '/' }), join('/opt/tools', 'pnpm.CMD'))
  assert.equal(probed.length, 0)
})

test('pathProvidesPnpm: a Windows App Execution Alias (stat EACCES) counts as a hit', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pnpm-alias-'))
  const tools = join(root, 'WindowsApps')
  const alias = join(tools, 'pnpm.EXE')
  mkdirSync(tools)
  writeFileSync(alias, '')
  chmodSync(tools, 0o000)
  t.after(() => {
    chmodSync(tools, 0o755)
    rmSync(root, { recursive: true, force: true })
  })
  assert.equal(pathProvidesPnpm(tools, 'win32', () => false, { pathExt: '.EXE', cwd: root }), alias)
  assert.equal(pathProvidesPnpm(tools, 'darwin', () => false, { cwd: root }), null, 'POSIX does not treat EACCES as executable')
})

test('ensurePnpmShim: materializes an executable wrapper and rewrites it only when the inputs change', t => {
  const root = tempDir(t)
  const entry = writeFakePnpmEntry(root)
  const dir = ensurePnpmShim({ root, pnpmEntry: entry, nodeFile: process.execPath })
  assert.equal(dir, join(root, PNPM_SHIM_DIR))
  const file = join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  assert.equal(readFileSync(file, 'utf8').includes(entry), true)
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o755)
    // The inode is the witness: an atomic rewrite publishes a NEW file, so an
    // unchanged inode proves the identical wrapper was not rewritten.
    const inode = statSync(file).ino
    ensurePnpmShim({ root, pnpmEntry: entry, nodeFile: process.execPath })
    assert.equal(statSync(file).ino, inode, 'identical content+mode is not rewritten')
    // A wrapper whose content survived but whose mode drifted is repaired.
    chmodSync(file, 0o644)
    ensurePnpmShim({ root, pnpmEntry: entry, nodeFile: process.execPath })
    assert.equal(statSync(file).mode & 0o777, 0o755)
    // A changed node/pnpm pair yields new content (the app may move between runs).
    ensurePnpmShim({ root, pnpmEntry: entry, nodeFile: join(root, 'other-node') })
    assert.equal(readFileSync(file, 'utf8').includes('other-node'), true)
    assert.notEqual(statSync(file).ino, inode)
  }
})

test('ensurePnpmShim: a pre-existing loose wrapper directory is tightened to 0700', { skip: process.platform === 'win32' }, t => {
  const root = tempDir(t)
  const dir = join(root, PNPM_SHIM_DIR)
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o777)
  ensurePnpmShim({ root, pnpmEntry: writeFakePnpmEntry(root), nodeFile: process.execPath })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
})

test('withPnpmShim: a host PATH without pnpm gets the bundled launcher prepended, and it executes', t => {
  const root = tempDir(t)
  const stateDir = join(root, 'state')
  const entry = writeFakePnpmEntry(root)
  const logs: string[] = []
  const env = withPnpmShim({ PATH: '/usr/bin:/bin', DSH_HOME: root }, {
    stateDir, pnpmEntry: entry, nodeFile: process.execPath, log: line => logs.push(line),
  })
  const dir = join(stateDir, PNPM_SHIM_DIR)
  assert.equal(env.PATH, dir + delimiter + '/usr/bin:/bin')
  assert.equal(env.DSH_HOME, root, 'unrelated env entries survive')
  assert.match(logs[0] ?? '', /prepended the bundled launcher/u)
  if (process.platform !== 'win32') {
    // The wrapper is real: it runs the fake entry through the bundled node and forwards argv.
    const output = execFileSync(join(dir, 'pnpm'), ['add', 'a b'], { env, encoding: 'utf8' })
    assert.equal(output.trim(), 'FAKE_PNPM add|a b')
  }
})

test('withPnpmShim: a host PATH that already resolves pnpm is left byte-identical', t => {
  const root = tempDir(t)
  const bindir = join(root, 'user-bin')
  mkdirSync(bindir)
  const name = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  writeFileSync(join(bindir, name), process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 })
  const before = { PATH: bindir }
  const logs: string[] = []
  const after = withPnpmShim(before, {
    stateDir: join(root, 'state'), pnpmEntry: writeFakePnpmEntry(root), nodeFile: process.execPath,
    log: line => logs.push(line),
  })
  assert.equal(after, before, 'the caller env object is returned untouched')
  assert.match(logs[0] ?? '', /already provides/u)
  assert.equal(existsSync(join(root, 'state', PNPM_SHIM_DIR)), false, 'nothing is materialized for a satisfied host')
})

test('withPnpmShim: the Windows probe reads PATHEXT from the patched env, not from the control plane', t => {
  const root = tempDir(t)
  const bindir = join(root, 'user-bin')
  mkdirSync(bindir)
  writeFileSync(join(bindir, 'pnpm.cmd'), '@echo off\r\n', { mode: 0o755 })
  const originalPathExt = process.env.PATHEXT
  process.env.PATHEXT = '.CMD'
  try {
    // env.PATHEXT = '.EXE' -> the child would NOT find pnpm.cmd, so the wrapper must be injected.
    const injected = withPnpmShim({ Path: bindir, PATHEXT: '.EXE' }, {
      stateDir: join(root, 'state'), pnpmEntry: writeFakePnpmEntry(root), nodeFile: process.execPath,
      platform: 'win32', log: quiet,
    })
    assert.equal(injected.Path?.startsWith(join(root, 'state', PNPM_SHIM_DIR) + ';'), true)
    // env.PATHEXT = '.CMD' -> the child finds it and the env stays untouched.
    const before = { Path: bindir, PATHEXT: '.CMD' }
    assert.equal(withPnpmShim(before, {
      stateDir: join(root, 'state'), pnpmEntry: writeFakePnpmEntry(root), nodeFile: process.execPath,
      platform: 'win32', log: quiet,
    }), before)
  } finally {
    if (originalPathExt === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = originalPathExt
  }
})

test('withPnpmShim: a POSIX stray Path never masks the real PATH', t => {
  const root = tempDir(t)
  const entry = writeFakePnpmEntry(root)
  const before = { Path: join(root, 'decoy'), PATH: '/usr/bin' }
  const env = withPnpmShim(before, {
    stateDir: join(root, 'state'), pnpmEntry: entry, nodeFile: process.execPath, cwd: root, log: quiet,
  })
  assert.equal(env.Path, before.Path, 'the decoy variable is not touched')
  assert.equal(env.PATH, join(root, 'state', PNPM_SHIM_DIR) + delimiter + '/usr/bin')
})

test('withPnpmShim: a directory named pnpm is not a usable host pnpm', t => {
  const root = tempDir(t)
  const bindir = join(root, 'bin')
  mkdirSync(join(bindir, 'pnpm'), { recursive: true })
  const env = withPnpmShim({ PATH: bindir }, {
    stateDir: join(root, 'state'), pnpmEntry: writeFakePnpmEntry(root), nodeFile: process.execPath, log: quiet,
  })
  assert.equal(env.PATH.startsWith(join(root, 'state', PNPM_SHIM_DIR) + delimiter), true)
})

test('withPnpmShim: keeps the Windows PATH key spelling and its delimiter', t => {
  const root = tempDir(t)
  const env = withPnpmShim({ Path: 'C:\\Windows' }, {
    stateDir: join(root, 'state'), pnpmEntry: writeFakePnpmEntry(root), nodeFile: process.execPath,
    platform: 'win32', log: quiet,
  })
  assert.equal(env.PATH, undefined, 'no second PATH key is invented')
  assert.equal(env.Path, join(root, 'state', PNPM_SHIM_DIR) + ';C:\\Windows')
})

test('withPnpmShim: an unusable bundled entry or node leaves PATH alone and says why', t => {
  const root = tempDir(t)
  const entry = writeFakePnpmEntry(root)
  const cases: { label: string; options: Record<string, unknown>; pattern: RegExp }[] = [
    { label: 'missing entry', options: { pnpmEntry: join(root, 'absent.cjs') }, pattern: /unavailable/u },
    { label: 'empty entry', options: { pnpmEntry: '' }, pattern: /unavailable/u },
    { label: 'relative node', options: { pnpmEntry: entry, nodeFile: 'node' }, pattern: /unavailable/u },
    { label: 'directory entry', options: { pnpmEntry: root }, pattern: /unavailable/u },
  ]
  for (const { label, options, pattern } of cases) {
    const logs: string[] = []
    const before = { PATH: '/usr/bin' }
    const after = withPnpmShim(before, {
      stateDir: join(root, 'state'), nodeFile: process.execPath, log: line => logs.push(line), ...options,
    })
    assert.equal(after, before, label)
    assert.match(logs[0] ?? '', pattern, label)
  }
  // A wrapper that cannot be materialized (a file blocks the shim directory) is logged, never fatal.
  const blocked = join(root, 'blocked')
  mkdirSync(blocked, { recursive: true })
  writeFileSync(join(blocked, PNPM_SHIM_DIR), '')
  const blockedLogs: string[] = []
  const blockedEnv = withPnpmShim({ PATH: '/usr/bin' }, {
    stateDir: blocked, pnpmEntry: entry, nodeFile: process.execPath, log: line => blockedLogs.push(line),
  })
  assert.equal(blockedEnv.PATH, '/usr/bin')
  assert.match(blockedLogs[0] ?? '', /could not be prepared/u)
})

test('withPnpmShim: a throwing log sink cannot fail the spawn', t => {
  const root = tempDir(t)
  const before = { PATH: '/usr/bin' }
  const after = withPnpmShim(before, {
    stateDir: join(root, 'state'), pnpmEntry: writeFakePnpmEntry(root), nodeFile: process.execPath,
    log: () => { throw new Error('sink exploded') },
  })
  assert.equal(after.PATH, join(root, 'state', PNPM_SHIM_DIR) + delimiter + '/usr/bin')
})

test('withPnpmShim: no opted-in entry is a silent no-op (standalone and plain-node callers)', t => {
  const root = tempDir(t)
  const before = { PATH: '/usr/bin' }
  assert.equal(withPnpmShim(before, { stateDir: join(root, 'state'), pnpmEntry: null, nodeFile: process.execPath }), before)
  assert.equal(withPnpmShim(before, { stateDir: join(root, 'state'), pnpmEntry: undefined, nodeFile: process.execPath }), before)
  assert.equal(existsSync(join(root, 'state', PNPM_SHIM_DIR)), false)
})
