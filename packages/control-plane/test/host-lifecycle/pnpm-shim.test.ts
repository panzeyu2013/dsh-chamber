/**
 * Managed-host PATH provision: the bundled pnpm (design 02 §3.1) and the `node` command
 * a worktree service spawns (P5b-0). Covers the wrapper script shape on both platforms,
 * the host-PATH probe (which mirrors the child's own command lookup), idempotent
 * materialization, and the decisions `withPnpmShim` / `withNodePath` make for one
 * managed host env. The end-to-end proof that the provisions reach a real child lives in
 * spawn-dsh.test.ts.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  NODE_COMMAND,
  NODE_SHIM_DIR,
  PNPM_SHIM_DIR,
  ensureNodeShim,
  ensurePnpmShim,
  nodeShimScript,
  pathProvidesPnpm,
  pnpmShimScript,
  posixQuote,
  withNodePath,
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
    nodeFile: '/Applications/dsh chamber.app/sidecar/dsh-chamber-helper',
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
      `exec '/Applications/dsh chamber.app/sidecar/dsh-chamber-helper' '--expose-internals' '/sidecar/pnpm'\\''s dir/pnpm.cjs' "$@"`,
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
  // Entries are resolved with the HOST's path rules (in production the probed platform
  // IS the host: the managed host is local), so the expectations are built the same
  // way — a literal '/child' would gain the runner's drive letter on Windows.
  const cwd = resolve(tmpdir(), 'pnpm-probe-child')
  const first = join(cwd, 'a')
  const second = join(cwd, 'b')
  const probed: string[] = []
  const executable = (file: string) => {
    probed.push(file)
    return file === join(first, 'pnpm') || file === join(second, 'pnpm')
  }
  assert.equal(pathProvidesPnpm('a:b', 'darwin', executable, { cwd }), join(first, 'pnpm'))
  assert.equal(probed.includes(join(second, 'pnpm')), false, 'the scan stops at the first hit')
  probed.length = 0
  // An empty entry means the child cwd; an unset PATH contributes nothing at all.
  assert.equal(pathProvidesPnpm('', 'darwin', executable, { cwd }), null)
  assert.equal(probed[0], join(cwd, 'pnpm'))
  assert.equal(pathProvidesPnpm(undefined, 'darwin', executable), null)
  assert.equal(probed.length, 1, 'an unset PATH probes nothing')
  probed.length = 0
  // Windows: PATHEXT order, quoted entries unwrapped.
  const tools = resolve(tmpdir(), 'pnpm-probe-tools')
  assert.equal(pathProvidesPnpm(`"${tools}"`, 'win32', file => file === join(tools, 'pnpm.CMD'), { pathExt: '.EXE;.CMD', cwd }), join(tools, 'pnpm.CMD'))
  assert.equal(probed.length, 0)
})

// chmod(000) cannot produce EACCES for uid 0 (root/container runs), so the alias probe
// never takes the code path this case exists for. Unrunnable there rather than failing —
// the same uid-agnostic discipline as log-file's EPERM case.
test('pathProvidesPnpm: a Windows App Execution Alias (stat EACCES) counts as a hit', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
}, t => {
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
    // The mtime is the witness: an identical content+mode pair must not be written at
    // all, so a pinned stamp survives. (An inode comparison cannot carry this proof —
    // Linux reuses the just-freed inode number for the replacement file.)
    const pinned = new Date(2001, 0, 1)
    utimesSync(file, pinned, pinned)
    ensurePnpmShim({ root, pnpmEntry: entry, nodeFile: process.execPath })
    assert.equal(statSync(file).mtimeMs, pinned.getTime(), 'identical content+mode is not rewritten')
    // A wrapper whose content survived but whose mode drifted is repaired.
    chmodSync(file, 0o644)
    ensurePnpmShim({ root, pnpmEntry: entry, nodeFile: process.execPath })
    assert.equal(statSync(file).mode & 0o777, 0o755)
    // A changed node/pnpm pair yields new content (the app may move between runs),
    // published as a NEW file: the handle opened before the rewrite keeps reading the
    // old inode, which an in-place rewrite would have mutated under it.
    const before = openSync(file, 'r')
    try {
      ensurePnpmShim({ root, pnpmEntry: entry, nodeFile: join(root, 'other-node') })
      assert.equal(readFileSync(file, 'utf8').includes('other-node'), true)
      assert.equal(readFileSync(before, 'utf8').includes('other-node'), false, 'a changed pair publishes a new wrapper file')
    } finally {
      closeSync(before)
    }
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
  // The fixture's case must match the PATHEXT below: the probe is honest about
  // PATHEXT, so on a case-SENSITIVE host a lowercase name is correctly missed.
  writeFileSync(join(bindir, 'pnpm.CMD'), '@echo off\r\n', { mode: 0o755 })
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

// Windows treats Path and PATH as ONE environment variable, so a second spelling as
// a decoy is a POSIX-only scenario (the platform-simulated win32 cases are covered by
// the PATH-key-spelling test below).
test('withPnpmShim: a POSIX stray Path never masks the real PATH', { skip: process.platform === 'win32' }, t => {
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
  assert.equal(env.PATH?.startsWith(join(root, 'state', PNPM_SHIM_DIR) + delimiter), true)
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
  type ShimOptions = Parameters<typeof withPnpmShim>[1]
  // Every case overrides the entry; the other options stay partial so the table reads as "what differs".
  type ShimOverrides = Pick<ShimOptions, 'pnpmEntry'> & Partial<Omit<ShimOptions, 'pnpmEntry'>>
  const cases: { label: string; options: ShimOverrides; pattern: RegExp }[] = [
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

// ---------------------------------------------------------------------------
// P5b-0: the managed-host `node` provision
//
// The upstream worktree service's nodeCommand is ONE string (bundle default 'node'),
// with no args/env channel. Handing it the control plane's own executable is wrong under
// Electron (that is the app binary, not a node), so the shim makes the literal string
// resolve instead — and the config never carries a machine path.
// ---------------------------------------------------------------------------

test('nodeShimScript: POSIX wrapper exports the node env and forwards every argument', () => {
  const script = nodeShimScript({
    platform: 'darwin',
    nodeFile: '/Applications/dsh chamber.app/Contents/MacOS/dsh-chamber',
    nodeArgs: ['--expose-internals'],
    nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
  })
  const lines = script.split('\n')
  assert.equal(lines[0], '#!/bin/sh')
  assert.equal(lines.includes("export ELECTRON_RUN_AS_NODE='1'"), true,
    'Electron mode is what turns the app binary into a node')
  assert.equal(
    lines.includes(`exec '/Applications/dsh chamber.app/Contents/MacOS/dsh-chamber' '--expose-internals' "$@"`),
    true,
    'no script operand: argv is forwarded verbatim (the worktree service passes -e …)',
  )
})

test('nodeShimScript: the Windows wrapper forwards %* and escapes percent signs', () => {
  const script = nodeShimScript({
    platform: 'win32',
    nodeFile: 'C:\\Apps\\dsh-chamber.exe',
    nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
  })
  const lines = script.split('\r\n')
  assert.equal(lines[0], '@echo off')
  assert.equal(lines.includes('set "ELECTRON_RUN_AS_NODE=1"'), true)
  assert.equal(lines.includes('"C:\\Apps\\dsh-chamber.exe" %*'), true)
})

test('ensureNodeShim: materializes in its own directory, idempotently (content + mode pinned)', t => {
  const root = tempDir(t)
  const dir = ensureNodeShim({ root, nodeFile: '/opt/runtime/node' })
  assert.equal(dir, join(root, NODE_SHIM_DIR))
  const file = join(dir, process.platform === 'win32' ? 'node.cmd' : 'node')
  assert.equal(readFileSync(file, 'utf8').includes('/opt/runtime/node'), true)
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o755)
    const pinned = new Date(2001, 0, 1)
    utimesSync(file, pinned, pinned)
    ensureNodeShim({ root, nodeFile: '/opt/runtime/node' })
    assert.equal(statSync(file).mtimeMs, pinned.getTime(), 'identical content+mode is not rewritten')
    chmodSync(file, 0o644)
    ensureNodeShim({ root, nodeFile: '/opt/runtime/node' })
    assert.equal(statSync(file).mode & 0o777, 0o755, 'a drifted mode is repaired')
  }
  // The two wrappers coexist: node provisioning never removes the pnpm wrapper.
  ensurePnpmShim({ root, pnpmEntry: writeFakePnpmEntry(root), nodeFile: process.execPath })
  assert.equal(existsSync(join(dir, process.platform === 'win32' ? 'node.cmd' : 'node')), true)
})

test('withNodePath: a host PATH without node gets the wrapper prepended, and it executes', t => {
  const root = tempDir(t)
  const stateDir = join(root, 'state')
  const logs: string[] = []
  const provision = withNodePath({ PATH: '/usr/bin:/bin', DSH_HOME: root }, {
    stateDir, nodeFile: process.execPath, log: line => logs.push(line),
  })
  const dir = join(stateDir, NODE_SHIM_DIR)
  assert.equal(provision.source, 'path-shim')
  assert.equal(provision.nodeCommand, NODE_COMMAND, 'the config keeps the command NAME, never a path')
  assert.equal(provision.env.PATH, dir + delimiter + '/usr/bin:/bin')
  assert.equal(provision.env.DSH_HOME, root, 'unrelated env entries survive')
  assert.match(logs[0] ?? '', /node wrapper/u)
  if (process.platform !== 'win32') {
    // The wrapper is real: it runs the resolved node and forwards argv.
    const output = execFileSync(join(dir, 'node'), ['--version'], { env: provision.env, encoding: 'utf8' })
    assert.match(output.trim(), /^v\d+/u)
  }
})

test('withNodePath: a host PATH that already resolves node is left byte-identical', t => {
  const root = tempDir(t)
  const bindir = join(root, 'user-bin')
  mkdirSync(bindir)
  writeFileSync(join(bindir, process.platform === 'win32' ? 'node.cmd' : 'node'), '#!/bin/sh\n', { mode: 0o755 })
  const before = { PATH: bindir }
  const logs: string[] = []
  const provision = withNodePath(before, {
    stateDir: join(root, 'state'), nodeFile: process.execPath, log: line => logs.push(line),
  })
  assert.equal(provision.env, before, 'the caller env object is returned untouched')
  assert.equal(provision.source, 'host-path')
  assert.match(logs[0] ?? '', /already provides/u)
  assert.equal(existsSync(join(root, 'state', PNPM_SHIM_DIR)), false, 'nothing is materialized for a satisfied host')
})

test('withNodePath: an already-prepended shim directory is not duplicated', t => {
  const root = tempDir(t)
  const stateDir = join(root, 'state')
  const dir = join(stateDir, NODE_SHIM_DIR)
  const before = { PATH: dir + delimiter + '/usr/bin' }
  const provision = withNodePath(before, { stateDir, nodeFile: process.execPath })
  assert.equal(provision.source, 'path-shim')
  assert.equal(provision.env, before, 'the node shim directory may already be first')
})

test('withNodePath: an impossible shim falls back to a plain node DIRECTORY, never a command path', t => {
  const root = tempDir(t)
  const bindir = join(root, 'plain-bin')
  mkdirSync(bindir)
  const plain = join(bindir, 'node')
  writeFileSync(plain, '#!/bin/sh\n', { mode: 0o755 })
  const provision = withNodePath({ PATH: '/usr/bin' }, {
    stateDir: join(root, 'state'),
    nodeFile: process.execPath,
    resolvePlainNode: () => plain,
    ensureShim: () => { throw new Error('read-only state root') },
  })
  assert.equal(provision.source, 'plain-node-directory')
  assert.equal(provision.nodeCommand, NODE_COMMAND)
  assert.equal(provision.executable, plain)
  assert.equal(provision.env.PATH, bindir + delimiter + '/usr/bin', 'the plain node directory joins PATH')
  assert.ok(!provision.diagnostic.includes(`nodeCommand '${plain}'`), 'the plain path never becomes the command name')
})

test('withNodePath: no real node yields the loud node-unavailable diagnostic and leaves PATH alone', t => {
  const root = tempDir(t)
  const before = { PATH: '/usr/bin' }
  const logs: string[] = []
  const provision = withNodePath(before, {
    stateDir: join(root, 'state'),
    nodeFile: process.execPath,
    resolvePlainNode: () => null,
    ensureShim: () => { throw new Error('read-only state root') },
    log: line => logs.push(line),
  })
  assert.equal(provision.source, 'unavailable')
  assert.equal(provision.env, before)
  assert.equal(provision.nodeCommand, NODE_COMMAND)
  assert.match(provision.diagnostic, /^node-unavailable: /u)
  assert.equal(provision.diagnostic.includes('\n'), false, 'one log line, not a stack trace')
  assert.ok(logs.includes(provision.diagnostic), 'the diagnostic is not a silent return value')
})

test('withNodePath: an unusable resolved node file skips the wrapper write and stays diagnosable', t => {
  const root = tempDir(t)
  let writes = 0
  const before = { PATH: '/usr/bin' }
  const provision = withNodePath(before, {
    stateDir: join(root, 'state'),
    nodeFile: join(root, 'absent-node'),
    resolvePlainNode: () => null,
    ensureShim: input => { writes += 1; return ensureNodeShim(input) },
  })
  assert.equal(writes, 0, 'a non-file node never reaches the wrapper writer')
  assert.equal(provision.source, 'unavailable')
  assert.equal(provision.env, before)
})

test('withNodePath: keeps the Windows PATH key spelling and its delimiter', t => {
  const root = tempDir(t)
  const entry = join(root, 'state', NODE_SHIM_DIR)
  const provision = withNodePath({ Path: 'C:\\Windows' }, {
    stateDir: join(root, 'state'), nodeFile: process.execPath, platform: 'win32', log: quiet,
  })
  assert.equal(provision.source, 'path-shim')
  assert.equal(provision.env.PATH, undefined, 'no second PATH key is invented')
  assert.equal(provision.env.Path, entry + ';C:\\Windows')
  assert.equal(existsSync(join(entry, 'node.cmd')), true)
})

test('withNodePath: a throwing log sink cannot fail the spawn', t => {
  const root = tempDir(t)
  const provision = withNodePath({ PATH: '/usr/bin' }, {
    stateDir: join(root, 'state'), nodeFile: process.execPath,
    log: () => { throw new Error('sink exploded') },
  })
  assert.equal(provision.source, 'path-shim', 'the provision itself is unaffected by the sink')
  assert.equal(
    existsSync(join(root, 'state', NODE_SHIM_DIR, process.platform === 'win32' ? 'node.cmd' : 'node')),
    true,
  )
})

test('withNodePath: a stale wrapper inside the node shim dir is rewritten, not accepted as the user toolchain', t => {
  const root = tempDir(t)
  const stateDir = join(root, 'state')
  const nodeDir = join(stateDir, NODE_SHIM_DIR)
  withNodePath({ PATH: '/usr/bin' }, { stateDir, nodeFile: process.execPath })
  // A later spawn sees the same node shim directory on PATH. The probe excludes that
  // directory, so a moved app / changed runtime rewrites the absolute path.
  const newNode = join(root, 'runtime-2', 'node')
  mkdirSync(join(root, 'runtime-2'), { recursive: true })
  writeFileSync(newNode, '#!/bin/sh\n', { mode: 0o755 })
  const withStale = { PATH: nodeDir + delimiter + '/usr/bin' }
  const node = withNodePath(withStale, { stateDir, nodeFile: newNode })
  const nodeWrapper = join(nodeDir, process.platform === 'win32' ? 'node.cmd' : 'node')
  assert.equal(readFileSync(nodeWrapper, 'utf8').includes(newNode), true, 'the stale node wrapper is rewritten')
  assert.equal(node.source, 'path-shim')
  assert.equal(node.env.PATH, withStale.PATH, 'the node shim entry is not duplicated when it is already first')
})
