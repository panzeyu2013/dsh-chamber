/**
 * plugins-exec tests (design 21 §6.3 executor core): the serial worker (order,
 * cap, dup fast-fail, blocked/probe gates, preImage backups, dispose) plus the
 * gateway's own error-text sanitizer. The restricted child runner itself
 * (env whitelist + bounded output + timeout kill) is the control-plane single
 * implementation and is tested in
 * packages/control-plane/test/plugins/plugin-mutation-executor.test.ts.
 * Plain node:test; fake spawn injection — no real dsh CLI is ever spawned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  ERROR_FAMILY_DRIFT,
  ERROR_RESTARTED_DURING_MUTATION,
  ERROR_RUNTIME_BUSY,
  ERROR_STARTING,
  PLUGIN_QUEUE_CAP,
  createPluginsExec,
  defaultSanitize,
} from '../../src/plugins-exec.ts'
import type { EnqueueResult, OnOpTerminal } from '../../src/plugins-exec.ts'
import { backupDirFor, createPluginsJournal, thirdPartyRoot } from '../../src/plugins-journal.ts'
import { PNPM_SHIM_DIR } from '../../src/pnpm-entry.ts'
import type { JournalLogger } from '../../src/plugins-journal.ts'
import { makeSpawnHarness, waitFor } from '../support/plugins-tasks-fixtures.ts'

const silent: JournalLogger = { log() {}, warn() {} }
const posix = process.platform !== 'win32'
const mode = (path: string): number => statSync(path).mode & 0o777

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
    runtimeFacts?: () => { path: string; version: string | null } | null
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
    ...(options.runtimeFacts === undefined ? {} : { runtimeFacts: options.runtimeFacts }),
  })
  // A failed assertion must fail FAST. FakeChild only emits 'close' when the
  // test closes it (`kill()` emits only with closeOnKill), so a test that throws
  // before closing its child leaves the worker — and the whole `node --test`
  // process — waiting forever. Close every fake child first (a second close
  // is a no-op), then dispose the executor.
  t.after(() => {
    for (const call of harness.calls) call.child.close(0)
    void exec.dispose()
  })
  return { stateDir, profileDir, journal, exec, harness, manifestText, lockText }
}

async function enqueueOk(exec: { enqueue(input: unknown): Promise<EnqueueResult> }, input: unknown): Promise<string> {
  const result = await exec.enqueue(input as never)
  assert.ok(result.ok, `enqueue must succeed: ${JSON.stringify(result)}`)
  return (result as { ok: true; opId: string }).opId
}

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
  const thirdParty = thirdPartyRoot(h.stateDir)
  const shimDir = join(thirdParty, PNPM_SHIM_DIR)
  // Premises that make the PATH assertion below meaningful: neither the
  // ambient PATH nor the state dir carries the shim before an op runs.
  assert.equal((process.env.PATH ?? '').includes(shimDir), false, 'the shim dir is never inherited from the ambient PATH')
  assert.equal(existsSync(shimDir), false, 'nothing creates the shim before an op runs')
  await enqueueOk(h.exec, { kind: 'install', name: 'pkg-env', spec: 'pkg-env@1' })
  const captured = h.harness.calls[0]!.options.env!

  assert.equal(captured.DSH_HOME, join(h.stateDir, 'dsh-home'))
  // HOME stays absent (store alignment with the provisioned profile — the
  // pnpm default store must never move, design 21 §6.3 ⑨).
  assert.equal(Object.hasOwn(captured, 'HOME'), false, 'HOME is never pinned into the mutation env')
  assert.equal(captured.XDG_CACHE_HOME, join(thirdParty, '.pnpm-cache'))
  assert.equal(captured.XDG_CONFIG_HOME, join(thirdParty, '.pnpm-xdg'))
  assert.equal(captured.NPM_CONFIG_USERCONFIG, join(thirdParty, '.npmrc-empty'))
  assert.equal(captured.npm_config_userconfig, join(thirdParty, '.npmrc-empty'), 'lower-case casing pinned too')
  for (const key of keys) {
    assert.equal(Object.hasOwn(captured, key), false, `${key} must be stripped from the child env`)
  }
  if (posix) {
    assert.equal(mode(join(thirdParty, '.pnpm-cache')), 0o700)
    assert.equal(mode(join(thirdParty, '.pnpm-xdg')), 0o700)
    assert.equal(mode(join(thirdParty, '.npmrc-empty')), 0o600)
    assert.equal(existsSync(join(thirdParty, '.pnpm-home')), false, '.pnpm-home is no longer created (store alignment, §10 ⑨)')
  }
  assert.equal(readFileSync(join(thirdParty, '.npmrc-empty'), 'utf8'), '', 'NPM_CONFIG_USERCONFIG points at an empty file')

  // The child PATH starts with the gateway's own pnpm shim: `dsh plugin`
  // forwards to a literal `pnpm` on PATH, and a host provisioned with npm
  // alone must still be able to seed/mutate the managed profile. Without
  // this the op answers 127 "pnpm not found on PATH".
  assert.ok(captured.PATH?.startsWith(shimDir), `child PATH must start with the pnpm shim (${String(captured.PATH)})`)
  assert.ok(existsSync(join(shimDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')), 'the shim executable exists')
  assert.match(readFileSync(join(shimDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), 'utf8'), /pnpm\.cjs/)

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

test('post-install family verification: a cross-generation shadow promoted into the profile fails the op loudly', async t => {
  // A runtime workspace whose lockfile closure IS the family F (the core trio +
  // a filler), plus an opt-in name that must NOT be F.
  const workspace = mkdtempSync(join(tmpdir(), 'plugins-exec-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const family = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-session']
  writeFileSync(join(workspace, 'pnpm-lock.yaml'),
    ['lockfileVersion: \'9.0\'', 'packages:', ...family.map(entry => `  '${entry}@0.5.0':`)].join('\n'))
  const h = makeExecHarness(t, { runtimeFacts: () => ({ path: workspace, version: '0.5.0' }) })
  // The spawn fake "installs": promote a family copy of a DIFFERENT generation
  // into the profile's top-level node_modules (what a shadow dependency does).
  mkdirSync(join(h.profileDir, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true })
  writeFileSync(join(h.profileDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '9.9.9' }))
  await enqueueOk(h.exec, { kind: 'install', name: 'shadow-pkg', spec: 'shadow-pkg@1' })
  assert.equal(h.harness.calls.length, 1)
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status === 'failed', 'family drift fails the op')
  const op = h.journal.recent()[0]!
  assert.equal(typeof op.error, 'string', 'the failed op carries its error text')
  const failureText = op.error ?? ''
  assert.match(failureText, new RegExp(ERROR_FAMILY_DRIFT))
  // The finding's NAME survives sanitization (a scoped name is path-shaped and
  // would otherwise be redacted) and the preImage is retained.
  assert.match(failureText, /@deepseek-ai\/dsh-base/)
  assert.equal(op.preImage, op.id)
})

/** A runtime workspace whose facts come from the TREE enumeration (no lockfile):
 *  a name with `null` gets NO package.json, so the resolution has no version
 *  fact for it (the generation-arm fallback case). */
function writeTreeRuntimeWorkspace(
  t: { after(fn: () => void): void },
  tree: Record<string, string | null>,
): string {
  const workspace = mkdtempSync(join(tmpdir(), 'plugins-exec-tree-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  for (const [name, version] of Object.entries(tree)) {
    const dir = join(workspace, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    if (version !== null) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
  return workspace
}

/** A runtime workspace whose LOCKFILE pins the core trio at `generation` plus
 *  `extra` (name → pinned version); the version facts come from the closure. */
function writeLockfileRuntimeWorkspace(
  t: { after(fn: () => void): void },
  generation: string,
  extra: Record<string, string> = {},
): string {
  const workspace = mkdtempSync(join(tmpdir(), 'plugins-exec-lock-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  writeFileSync(join(workspace, 'pnpm-lock.yaml'),
    ['lockfileVersion: \'9.0\'', 'packages:',
      ...['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
        .map(entry => `  '${entry}@${generation}':`),
      ...Object.entries(extra).map(([name, version]) => `  '${name}@${version}':`),
    ].join('\n'))
  return workspace
}

/** Promote one family copy into the profile's top-level node_modules. */
function promoteIntoProfile(profileDir: string, name: string, version: string): void {
  mkdirSync(join(profileDir, 'node_modules', name), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
}

test('post-install family verification: the runtime version fact clears a re-scoped vendored copy the generation arm would flag', async t => {
  // The runtime pins @deepseek-ai/cosmokit at its own upstream version 1.8.3
  // while the instance GENERATION is 0.5.0. sameGeneration('1.8.3','0.5.0') is
  // false, so a generation-only comparison would fail this install; the version
  // fact (design 21 §6.11.3) is what makes the shipped copy legal.
  const workspace = writeLockfileRuntimeWorkspace(t, '0.5.0', { '@deepseek-ai/cosmokit': '1.8.3' })
  const h = makeExecHarness(t, { runtimeFacts: () => ({ path: workspace, version: '0.5.0' }) })
  promoteIntoProfile(h.profileDir, '@deepseek-ai/cosmokit', '1.8.3')
  await enqueueOk(h.exec, { kind: 'install', name: 'vendor-pkg', spec: 'vendor-pkg@1' })
  await waitFor(() => h.harness.calls.length === 1, 'spawn happened')
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status !== 'pending', 'op terminal')
  assert.equal(h.journal.recent()[0]?.status, 'ok',
    `the freshly pinned version is not drift: ${h.journal.recent()[0]?.error ?? ''}`)
})

test('post-install family verification: the version fact outranks a coincidental generation match and names the expected version', async t => {
  // The instance generation is 1.9.9 and the promoted copy is 1.9.9 too, so a
  // generation-only comparison would PASS — but the runtime provides 1.8.3 for
  // this name. Version first, then closure (design 21 §6.11.3): drift, loudly,
  // with the version-arm wording.
  const workspace = writeLockfileRuntimeWorkspace(t, '0.5.0', { '@deepseek-ai/cosmokit': '1.8.3' })
  const h = makeExecHarness(t, { runtimeFacts: () => ({ path: workspace, version: '1.9.9' }) })
  promoteIntoProfile(h.profileDir, '@deepseek-ai/cosmokit', '1.9.9')
  await enqueueOk(h.exec, { kind: 'install', name: 'vendor-shadow', spec: 'vendor-shadow@1' })
  await waitFor(() => h.harness.calls.length === 1, 'spawn happened')
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status !== 'pending', 'op terminal')
  const op = h.journal.recent()[0]!
  assert.equal(op.status, 'failed', 'a version-fact mismatch fails the op even when the generation matches')
  const failureText = op.error ?? ''
  assert.match(failureText, new RegExp(ERROR_FAMILY_DRIFT))
  assert.match(failureText, /@deepseek-ai\/cosmokit/)
  assert.match(failureText, /is not the version this instance runtime provides \(expected 1\.8\.3\)/,
    `the version-arm wording carries the runtime's version: ${failureText}`)
})

test('post-install family verification: a name with NO version fact falls back to the generation comparison', async t => {
  // Tree-sourced facts: the core trio is present but dsh-web-app ships no
  // version, so the resolution has no version fact for it. The same-generation
  // copy must still pass (the fallback is not a false positive).
  const workspace = writeTreeRuntimeWorkspace(t, {
    '@deepseek-ai/dsh': '0.5.0',
    '@deepseek-ai/dsh-base': '0.5.0',
    '@deepseek-ai/dsh-web-app': null,
  })
  const h = makeExecHarness(t, { runtimeFacts: () => ({ path: workspace, version: '0.5.0' }) })
  promoteIntoProfile(h.profileDir, '@deepseek-ai/dsh-web-app', '0.5.0')
  await enqueueOk(h.exec, { kind: 'install', name: 'fallback-pkg', spec: 'fallback-pkg@1' })
  await waitFor(() => h.harness.calls.length === 1, 'spawn happened')
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status !== 'pending', 'op terminal')
  assert.equal(h.journal.recent()[0]?.status, 'ok',
    `the same-generation copy is legal on the fallback arm: ${h.journal.recent()[0]?.error ?? ''}`)
})

test('post-install family verification: the generation fallback still fails a cross-generation copy and keeps its wording', async t => {
  const workspace = writeTreeRuntimeWorkspace(t, {
    '@deepseek-ai/dsh': '0.6.0',
    '@deepseek-ai/dsh-base': '0.6.0',
    '@deepseek-ai/dsh-web-app': null,
  })
  const h = makeExecHarness(t, { runtimeFacts: () => ({ path: workspace, version: '0.6.0' }) })
  promoteIntoProfile(h.profileDir, '@deepseek-ai/dsh-web-app', '0.5.0')
  await enqueueOk(h.exec, { kind: 'install', name: 'generation-shadow', spec: 'generation-shadow@1' })
  await waitFor(() => h.harness.calls.length === 1, 'spawn happened')
  h.harness.calls[0]!.child.close(0)
  await waitFor(() => h.journal.recent()[0]?.status !== 'pending', 'op terminal')
  const op = h.journal.recent()[0]!
  assert.equal(op.status, 'failed')
  const failureText = op.error ?? ''
  assert.match(failureText, new RegExp(ERROR_FAMILY_DRIFT))
  assert.match(failureText, /does not match the instance runtime generation \(0\.6\.0\)/,
    `the no-version-fact branch keeps the generation wording: ${failureText}`)
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
// onTerminal hook + per-op cliLaunch
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
// Lease-release on journal terminal failure, URL/secret redaction by the
// default sanitizer, and crash-orphan childPid journaling.
// ---------------------------------------------------------------------------

test('defaultSanitize redacts URL credentials + named secrets and byte-bounds the text', () => {
  const sanitized = defaultSanitize('pnpm error fetching https://user:super-secret@registry.example/pkg (token=abc123, password=hunter2)')
  assert.equal(sanitized.includes('super-secret'), false, 'URL userinfo must be redacted: ' + sanitized)
  assert.equal(sanitized.includes('abc123'), false, 'named token must be redacted: ' + sanitized)
  assert.equal(sanitized.includes('hunter2'), false, 'named password must be redacted: ' + sanitized)
  assert.ok(sanitized.includes('registry.example'), 'the URL origin survives for diagnosis')

  // Byte bound: a pathological single-line text is truncated at the cap.
  const bounded = defaultSanitize('x'.repeat(9000) + 'boom')
  assert.ok(bounded.length <= 2400, `sanitized text must be byte-bounded: ${bounded.length}`)
  assert.equal(bounded.includes('boom'), false, 'the tail beyond the bound is dropped')
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
