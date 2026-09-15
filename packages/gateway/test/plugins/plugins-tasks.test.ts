/**
 * A1 orchestrator tests (design 21 §6.2/§6.3; plan Phase 4.2-4.5 wiring):
 * createChamberPluginTasks over REAL plugins-exec (injected fake spawn) +
 * real journal + real installed projection + a fake runtime manager whose
 * beginProfileWrite gate is controllable. Covers: the validation matrix,
 * the lease-ok flow (op journaled, spawn argv/env, lease released at the
 * executor terminal and re-acquirable), lease refusals → deferred intents
 * (persisted, drained on the next ok lease) vs never-deferred remove/
 * recovery, queue_full mapping, dispose, tasks/deferred projections and the
 * corrupt deferred-store aside discipline.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { INSTALLED_MANIFEST_MAX_BYTES, MATERIALIZED_VALUE_MASK } from '../../src/plugins-installed.ts'
import { createChamberPluginTasks, deferredIntentsFilePath } from '../../src/plugins-tasks.ts'
import type { GatewayRuntimeManagerLike, PluginTaskRefusalCode, PluginTaskSubmitResult } from '../../src/plugins-tasks.ts'
import { createChamberInstalled } from '../../src/plugins-installed.ts'
import { INSTALLED_PROFILE_DIR, MANAGED_DSH_HOME_DIR } from '../../src/plugins-installed.ts'
import { backupDirFor, createPluginsJournal, journalFilePath, thirdPartyRoot } from '../../src/plugins-journal.ts'
import type { ProfileWriteRefusalCode } from '../../src/runtime-manager.ts'
import type { JournalLogger } from '../../src/plugins-journal.ts'
import { writeManifestFixture, scratchDir, waitFor, makeSpawnHarness } from '../support/plugins-tasks-fixtures.ts'

const silent: JournalLogger = { log() {}, warn() {} }

/** Capturing logger: the data-loss fixes are only half-done unless the skip is
 *  LOUD (the audit's failure mode was a calm "removed N orphaned"). */
function makeCaptureLogger(): { logger: JournalLogger; logs: string[]; warns: string[] } {
  const logs: string[] = []
  const warns: string[] = []
  const joinArgs = (args: unknown[]): string => args.map(String).join(' ')
  return {
    logger: {
      log(...args: unknown[]) { logs.push(joinArgs(args)) },
      warn(...args: unknown[]) { warns.push(joinArgs(args)) },
    },
    logs,
    warns,
  }
}
const posix = process.platform !== 'win32'
const mode = (path: string): number => statSync(path).mode & 0o777

/** Fake runtime manager: a controllable profile-write lease gate over a real
 * workspace dir (the orchestrator resolves the CLI entry per spawn). */
class FakeManager implements GatewayRuntimeManagerLike {
  workspace: string
  granted = 0
  held = 0
  released = 0
  /** 每次 beginProfileWrite 尝试（含 queue_full 拒绝）的事件内时间戳——
   *  wave 排序断言的确定性锚（2026 flake 修复，见 wave 测试）。 */
  grantedAt: number[] = []
  refusal: { code: ProfileWriteRefusalCode; error: string } | null = null
  /** Runtime mutation execution window (canRun wiring; false = window open). */
  mutationBusy = false
  /** Effective runtime version the protected-set generation check consumes. */
  version: string | null = null

  constructor(workspace: string) {
    this.workspace = workspace
  }

  beginProfileWrite() {
    this.granted += 1
    this.grantedAt.push(Date.now())
    if (this.refusal !== null) {
      return { ok: false as const, code: this.refusal.code, error: this.refusal.error }
    }
    this.held += 1
    return {
      ok: true as const,
      release: () => {
        assert.ok(this.held > 0, 'lease underflow: release without a held lease')
        this.held -= 1
        this.released += 1
      },
    }
  }

  profileWriteInFlight(): boolean {
    return this.held > 0
  }

  mutationInFlight(): boolean {
    return this.mutationBusy
  }

  /** Corrupt/unavailable runtime facts window (design 18): resolveWorkspace
   *  throws, which the judgement reads as familySource 'unavailable'. */
  resolveThrows = false

  resolveWorkspace() {
    if (this.resolveThrows) throw new Error('runtime override metadata is corrupt')
    return { path: this.workspace, version: this.version, source: 'builtin' as const }
  }
}

interface TasksHarness {
  stateDir: string
  manager: FakeManager
  managerRef: { current: FakeManager | null }
  tasks: ReturnType<typeof createChamberPluginTasks>
  spawnCalls: ReturnType<typeof makeSpawnHarness>['calls']
  setManagerNull(): void
}

function makeHarness(t: { after(fn: () => void): void }, logger: JournalLogger = silent): TasksHarness {
  const stateDir = scratchDir(t, 'plugins-tasks-')
  // The managed profile manifest (the executor backs it up before spawning).
  writeManifestFixture(stateDir, {})
  // A runtime workspace whose installed dsh entry resolves.
  const workspace = scratchDir(t, 'plugins-tasks-ws-')
  mkdirSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  // Runtime-line family closure (F): the authoritative lockfile source the
  // protected-set derivation reads (design 21 §6.11.1). The pinned release
  // family contains the core names and NOTHING from the opt-in segment.
  const familyEntries = [
    '@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-session',
    ...Array.from({ length: 200 }, (_, i) => `@deepseek-ai/dsh-filler-${i}`),
  ]
  writeFileSync(
    join(workspace, 'pnpm-lock.yaml'),
    ['lockfileVersion: \'9.0\'', 'packages:', ...familyEntries.map(entry => `  '${entry}@0.1.5-rc.2':`)].join('\n'),
  )
  const manager = new FakeManager(workspace)
  manager.version = '0.1.5-rc.2'
  const managerRef: { current: FakeManager | null } = { current: manager }
  const spawn = makeSpawnHarness()
  const tasks = createChamberPluginTasks({
    stateDir,
    manager: () => managerRef.current,
    statusProbe: () => 'ready',
    logger,
    installed: createChamberInstalled(stateDir),
    spawn: spawn.spawn,
    timeoutMs: 1000,
  })
  return {
    stateDir,
    manager,
    managerRef,
    tasks,
    spawnCalls: spawn.calls,
    setManagerNull() {
      managerRef.current = null
    },
  }
}

async function submitResult(tasks: { submit(input: unknown): Promise<PluginTaskSubmitResult> }, input: unknown): Promise<PluginTaskSubmitResult> {
  return tasks.submit(input as never)
}

function installedName(stateDir: string, name: string): void {
  const manifestPath = join(stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies[name] = '^1.0.0'
  writeManifestFixture(stateDir, manifest.dependencies)
}

function assertRefusal(result: PluginTaskSubmitResult, code: PluginTaskRefusalCode): void {
  assert.ok(!result.ok, `expected refusal ${code}, got ${JSON.stringify(result)}`)
  if (!result.ok) assert.equal(result.code, code)
}

// ---------------------------------------------------------------------------
// Validation matrix
// ---------------------------------------------------------------------------

test('validation: protected names refuse across install/remove/materialize; opt-in layers install with the exact generation', async t => {
  const h = makeHarness(t)
  // Protected by P = B₀ ∪ S ∪ F, on BOTH op directions (design 21 §6.11.3 R1).
  for (const name of ['@deepseek-ai/dsh', '@dsh-chamber/dsh-chamber-seed-client-graph']) {
    const install = await submitResult(h.tasks, { kind: 'install', name, spec: `${name}@0.1.5-rc.2` })
    assertRefusal(install, 'protected')
    const remove = await submitResult(h.tasks, { kind: 'remove', name })
    assertRefusal(remove, 'protected')
    const materialize = await submitResult(h.tasks, {
      kind: 'materialize', name, spec: `file:${join(thirdPartyRoot(h.stateDir), 'x.tgz')}`, version: '0.1.5-rc.2',
    })
    assertRefusal(materialize, 'protected')
  }

  // An official opt-in layer (NOT in F) is installable — but only with this
  // instance's exact generation.
  const layer = '@deepseek-ai/dsh-experimental-agent-team-profile'
  assertRefusal(await submitResult(h.tasks, { kind: 'install', name: layer, spec: layer }), 'needs-version')
  assertRefusal(await submitResult(h.tasks, { kind: 'install', name: layer, spec: `${layer}@^0.1.5-rc.2` }), 'needs-exact-version')
  assertRefusal(await submitResult(h.tasks, { kind: 'install', name: layer, spec: `${layer}@0.1.5-rc.1` }), 'generation-mismatch')
  const okLayer = await submitResult(h.tasks, { kind: 'install', name: layer, spec: `${layer}@0.1.5-rc.2` })
  assert.equal(okLayer.ok, true, JSON.stringify(okLayer))

  // Removing an official-scope row that is NOT protected is allowed (removal is
  // judged by P alone, never by a version) — membership is the only extra gate.
  installedName(h.stateDir, layer)
  const removed = await submitResult(h.tasks, { kind: 'remove', name: layer })
  assert.equal(removed.ok, true, JSON.stringify(removed))

  assert.equal(h.manager.granted, 2, 'only the two accepted ops touched the write lease')
})

test('validation: malformed names / specs refuse before any lease', async t => {
  const h = makeHarness(t)
  const cases: Array<{ kind: 'install' | 'materialize' | 'remove'; name: string; spec?: string; code: PluginTaskRefusalCode }> = [
    { kind: 'install', name: 'bad name!', spec: 'bad name!@1', code: 'invalid_name' },
    { kind: 'install', name: 'pkg@1.0.0', spec: 'pkg@1.0.0', code: 'invalid_name' },
    { kind: 'install', name: 'pkg', spec: '', code: 'invalid_spec' },
    { kind: 'install', name: 'pkg', spec: 'file:/tmp/x.tgz', code: 'invalid_spec' },
    { kind: 'install', name: 'pkg', spec: 'pkg@>=1.0.0', code: 'invalid_spec' },
    { kind: 'install', name: 'pkg', spec: 'other@1.0.0', code: 'invalid_spec' },
    { kind: 'remove', name: 'pkg', spec: 'pkg', code: 'invalid_spec' },
    { kind: 'materialize', name: 'pkg', spec: '', code: 'invalid_spec' },
    { kind: 'materialize', name: 'pkg', spec: 'file:relative/x.tgz', code: 'invalid_spec' },
    { kind: 'materialize', name: 'pkg', spec: 'file:/outside/x.tgz', code: 'invalid_spec' },
    { kind: 'materialize', name: 'pkg', spec: 'file:/tmp/x.tgz', code: 'invalid_spec' },
  ]
  for (const entry of cases) {
    const result = await submitResult(h.tasks, entry)
    assertRefusal(result, entry.code)
  }
  assert.equal(h.manager.granted, 0)
})

test('validation: registry install accepts scoped names/specs and rejects mismatched spec names', async t => {
  const h = makeHarness(t)
  const scoped = await submitResult(h.tasks, { kind: 'install', name: '@scope/pkg', spec: '@scope/pkg@^1.2.3' })
  assert.ok(scoped.ok)
  if (scoped.ok) {
    assert.equal(scoped.deferred, false)
    h.spawnCalls[0]!.child.close(0)
    await waitFor(() => h.manager.held === 0, 'scoped lease released')
  }
})

test('validation: remove membership — absent profile → no_manifest, missing name → not_installed, corrupt → no_manifest', async t => {
  const h = makeHarness(t)
  const absentState = scratchDir(t, 'plugins-tasks-absent-')
  const absentTasks = createChamberPluginTasks({
    stateDir: absentState,
    manager: () => h.managerRef.current,
    statusProbe: () => 'ready',
    logger: silent,
    installed: createChamberInstalled(absentState),
    spawn: undefined,
  })
  const absent = await submitResult(absentTasks, { kind: 'remove', name: 'pkg' })
  assertRefusal(absent, 'no_manifest')

  // Corrupt manifest → no_manifest (cannot verify membership).
  const manifestPath = join(h.stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR, 'package.json')
  writeFileSync(manifestPath, '{ nope', 'utf8')
  const corrupt = await submitResult(h.tasks, { kind: 'remove', name: 'pkg' })
  assertRefusal(corrupt, 'no_manifest')

  // Healthy manifest without the name → not_installed.
  writeManifestFixture(h.stateDir, {})
  const missing = await submitResult(h.tasks, { kind: 'remove', name: 'not-there' })
  assertRefusal(missing, 'not_installed')

  // Present → proceeds to the lease.
  installedName(h.stateDir, 'installed-pkg')
  const present = await submitResult(h.tasks, { kind: 'remove', name: 'installed-pkg' })
  assert.ok(present.ok)
  if (present.ok) {
    h.spawnCalls[0]!.child.close(0)
    await waitFor(() => h.manager.held === 0, 'remove lease released')
  }
})

// ---------------------------------------------------------------------------
// Lease-ok flow: journal, spawn argv/env, lease lifecycle
// ---------------------------------------------------------------------------

test('lease-ok install: op journaled, spawns the resolved CLI entry argv, lease released at terminal and re-acquirable', async t => {
  const h = makeHarness(t)
  const result = await submitResult(h.tasks, { kind: 'install', name: 'alpha', spec: 'alpha@^1.2.3', initiator: 'gw.example' })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.deferred, false)
  const opId = result.opId
  assert.equal(h.manager.granted, 1)
  assert.equal(h.manager.held, 1, 'lease held while the op is live')

  // The spawn observes the REAL CLI launch shape: node + workspace entry
  // + plugin argv, DSH_HOME pinned to the managed home.
  await waitFor(() => h.spawnCalls.length === 1, 'spawn')
  const call = h.spawnCalls[0]!
  const entry = join(h.manager.workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assert.equal(call.command, process.execPath)
  assert.deepEqual(call.args, [entry, 'plugin', '--profile', 'web', 'add', 'alpha@^1.2.3'])
  assert.equal(call.options.cwd, h.manager.workspace)
  assert.equal(call.options.env?.DSH_HOME, join(h.stateDir, 'dsh-home'))

  // Not terminal until the child closes; the lease is held the whole time.
  assert.equal(h.manager.held, 1)
  call.child.close(0)
  await waitFor(() => h.manager.held === 0, 'lease released at terminal')
  assert.equal(h.manager.released, 1)
  assert.equal(h.tasks.tasks().tasks.find(op => op.id === opId)?.status, 'ok', 'op journaled ok')

  // The lease is acquirable again once the op is terminal.
  installedName(h.stateDir, 'alpha')
  const again = await submitResult(h.tasks, { kind: 'remove', name: 'alpha' })
  assert.ok(again.ok)
  if (again.ok) {
    assert.equal(h.manager.granted, 2)
    h.spawnCalls[1]!.child.close(0)
    await waitFor(() => h.manager.held === 0, 'second lease released')
  }
})

test('lease-ok failure surfaces in the journal and releases the lease; worker serializes two ops', async t => {
  const h = makeHarness(t)
  const first = await submitResult(h.tasks, { kind: 'install', name: 'one', spec: 'one@1' })
  assert.ok(first.ok)
  if (!first.ok) return
  installedName(h.stateDir, 'two')
  const second = await submitResult(h.tasks, { kind: 'remove', name: 'two' })
  assert.ok(second.ok)
  if (!second.ok) return
  const secondId = second.deferred ? null : second.opId
  assert.ok(secondId !== null)
  assert.equal(h.spawnCalls.length, 1, 'second op queued, not spawned (serial worker)')
  assert.equal(h.manager.held, 2, 'each accepted op holds its own lease')

  h.spawnCalls[0]!.child.close(0)
  await waitFor(() => h.spawnCalls.length === 2, 'second spawn after first terminal')
  h.spawnCalls[1]!.child.stderrLine('pnpm error: no matching version')
  h.spawnCalls[1]!.child.close(7)
  await waitFor(() => h.manager.held === 0, 'both leases released')
  assert.equal(h.manager.released, 2)
  const tasks = h.tasks.tasks()
  const failed = tasks.tasks.find(op => op.id === secondId)
  assert.equal(failed?.status, 'failed')
  assert.match(failed?.error ?? '', /no matching version/)
})

test('an op enqueued while a runtime mutation window is closed waits at dequeue, then runs when it opens (canRun wiring)', async t => {
  const h = makeHarness(t)
  // The fake grants the lease (a real manager would too — the profile-write
  // fence and the runtime-mutation window are orthogonal), but the runtime
  // mutation window is closed: the executor must NOT spawn the queued op
  // mid-transaction.
  h.manager.mutationBusy = true
  const result = await submitResult(h.tasks, { kind: 'install', name: 'window-pkg', spec: 'window-pkg@1' })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.deferred, false)
  assert.equal(h.manager.held, 1, 'the op holds its lease while parked at the dequeue gate')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(h.spawnCalls.length, 0, 'no spawn while the runtime mutation window is closed')
  assert.equal(h.tasks.tasks().tasks[0]?.status, 'pending', 'the parked op is not dropped while the window may open')

  // The mutation window closes (activation/rollback/start settled): the
  // parked op runs without a re-submission.
  h.manager.mutationBusy = false
  await waitFor(() => h.spawnCalls.length === 1, 'window opens → parked op spawns')
  h.spawnCalls[0]!.child.close(0)
  await waitFor(() => h.manager.held === 0, 'lease released at terminal')
  const journaled = h.tasks.tasks().tasks.find(op => op.name === 'window-pkg')
  assert.equal(journaled?.status, 'ok')
})

// ---------------------------------------------------------------------------
// Lease refusals → deferred intents / refusals
// ---------------------------------------------------------------------------

test('busy lease defers install to the deferred store (0600), drain clears it on a later ok lease', async t => {
  const h = makeHarness(t)
  h.manager.refusal = { code: 'runtime_busy', error: 'a restart is in flight' }
  const result = await submitResult(h.tasks, { kind: 'install', name: 'deferred-pkg', spec: 'deferred-pkg@1', initiator: 'host-x' })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.deferred, true)
  assert.equal(h.spawnCalls.length, 0, 'nothing spawned while busy')
  assert.equal(h.manager.held, 0)

  const deferredFile = deferredIntentsFilePath(h.stateDir)
  assert.equal(existsSync(deferredFile), true)
  if (posix) assert.equal(mode(deferredFile), 0o600)
  const persisted = JSON.parse(readFileSync(deferredFile, 'utf8'))
  assert.equal(persisted.intents.length, 1)
  assert.equal(persisted.intents[0].name, 'deferred-pkg')
  assert.equal(persisted.intents[0].initiator, 'host-x')
  assert.equal(h.tasks.deferredIntents().length, 1)

  // Drain while still busy: refused, intent left.
  h.manager.refusal = { code: 'runtime_busy', error: 'still busy' }
  assert.equal(await h.tasks.drainDeferred(), 0)
  assert.equal(h.tasks.deferredIntents().length, 1)

  // Ready edge: drain clears the intent into the journal.
  h.manager.refusal = null
  assert.equal(await h.tasks.drainDeferred(), 1)
  assert.equal(h.tasks.deferredIntents().length, 0)
  // Lease attempts: first submit (busy→deferred), busy drain round, ok drain
  // round — the granted op is the third beginProfileWrite call.
  assert.equal(h.manager.granted, 3)
  assert.equal(h.manager.held, 1, 'the drained op holds its lease')
  h.spawnCalls[0]!.child.close(0)
  await waitFor(() => h.manager.held === 0, 'drained op terminal releases the lease')
  const tasks = h.tasks.tasks()
  assert.equal(tasks.tasks[0]!.name, 'deferred-pkg')
  assert.equal(tasks.tasks[0]!.status, 'ok')
  assert.equal(tasks.busy, false)
})

test('busy lease defers materialize (spec preserved) and removes are NEVER deferred', async t => {
  const h = makeHarness(t)
  h.manager.refusal = { code: 'runtime_pending', error: 'version pending; restore first' }
  const staged = join(thirdPartyRoot(h.stateDir), 'pkg', 'pkg-1.0.0-a1b2c3d4.tgz')
  mkdirSync(join(thirdPartyRoot(h.stateDir), 'pkg'), { recursive: true, mode: 0o700 })
  writeFileSync(staged, 'tgz-bytes', { mode: 0o600 })
  const materialize = await submitResult(h.tasks, { kind: 'materialize', name: 'pkg', spec: `file:${staged}` })
  assert.ok(materialize.ok)
  if (!materialize.ok) return
  assert.equal(materialize.deferred, true)
  // The outward projection masks the gateway-local staging path (design 21
  // decision 18); the durable intent store keeps the REAL spec so the drain
  // can still submit the staged archive.
  assert.equal(h.tasks.deferredIntents()[0]?.spec, MATERIALIZED_VALUE_MASK)
  const persistedIntents = JSON.parse(readFileSync(deferredIntentsFilePath(h.stateDir), 'utf8'))
  assert.equal(persistedIntents.intents[0].spec, `file:${staged}`, 'the durable intent keeps the real staged path')

  // remove is user-instant: refused with the lease code, never persisted.
  installedName(h.stateDir, 'installed-pkg')
  const removal = await submitResult(h.tasks, { kind: 'remove', name: 'installed-pkg' })
  assertRefusal(removal, 'runtime_pending')
  assert.equal(h.tasks.deferredIntents().length, 1, 'remove added nothing to the deferred store')
})

test('runtime_recovery_required is never deferred (only retry/restore are allowed)', async t => {
  const h = makeHarness(t)
  h.manager.refusal = { code: 'runtime_recovery_required', error: 'recovery swap-attempted is required' }
  const result = await submitResult(h.tasks, { kind: 'install', name: 'pkg', spec: 'pkg@1' })
  assertRefusal(result, 'runtime_recovery_required')
  assert.equal(h.tasks.deferredIntents().length, 0)
  const materialize = await submitResult(h.tasks, { kind: 'materialize', name: 'pkg', spec: `file:${join(thirdPartyRoot(h.stateDir), 'x.tgz')}` })
  assertRefusal(materialize, 'runtime_recovery_required')
  assert.equal(h.tasks.deferredIntents().length, 0)
})

test('null manager defers install, refuses remove (runtime_pending), and the deferred intent survives a later drain', async t => {
  const h = makeHarness(t)
  h.setManagerNull()
  const install = await submitResult(h.tasks, { kind: 'install', name: 'early-pkg', spec: 'early-pkg@1' })
  assert.ok(install.ok)
  if (!install.ok) return
  assert.equal(install.deferred, true)

  installedName(h.stateDir, 'installed-pkg')
  const removal = await submitResult(h.tasks, { kind: 'remove', name: 'installed-pkg' })
  assertRefusal(removal, 'runtime_pending')

  // Manager comes up: the ready-edge drain picks the intent up.
  h.managerRef.current = h.manager
  assert.equal(await h.tasks.drainDeferred(), 1)
  assert.equal(h.tasks.deferredIntents().length, 0)
  h.spawnCalls[0]!.child.close(0)
  await waitFor(() => h.manager.held === 0, 'lease released')
})

test('degraded ladder: underivable F refuses official-scope installs with its own code, third-party/remove unaffected', async t => {
  const h = makeHarness(t)
  // Remove the workspace lockfile ⇒ F cannot be derived (the derivation is
  // fail-closed) while B₀ ∪ S stays a constant.
  rmSync(join(h.manager.workspace, 'pnpm-lock.yaml'))
  const official = await submitResult(h.tasks, { kind: 'install', name: '@deepseek-ai/dsh-cli-extra', spec: '@deepseek-ai/dsh-cli-extra@0.1.5-rc.2' })
  assertRefusal(official, 'protected-set-unavailable')
  // B₀ ∪ S keeps protecting by name (a composition member is still `protected`).
  const composition = await submitResult(h.tasks, { kind: 'install', name: '@deepseek-ai/dsh-base', spec: '@deepseek-ai/dsh-base@0.1.5-rc.2' })
  assertRefusal(composition, 'protected')
  // Third-party installs and every remove keep working (the ladder is
  // conservative in ONE direction only).
  const thirdParty = await submitResult(h.tasks, { kind: 'install', name: 'plain-pkg', spec: 'plain-pkg@1.0.0' })
  assert.ok(thirdParty.ok, JSON.stringify(thirdParty))
  installedName(h.stateDir, 'plain-pkg')
  const removal = await submitResult(h.tasks, { kind: 'remove', name: 'plain-pkg' })
  assert.ok(removal.ok, JSON.stringify(removal))
})

test('runtime version unknown: an exact official spec cannot be generation-checked ⇒ its own refusal', async t => {
  const h = makeHarness(t)
  h.manager.version = null
  const official = await submitResult(h.tasks, { kind: 'install', name: '@deepseek-ai/dsh-cli-extra', spec: '@deepseek-ai/dsh-cli-extra@0.1.5-rc.2' })
  assertRefusal(official, 'runtime-version-unknown')
})

test('a deferred materialize carries its declared version and drains once the manager is up', async t => {
  const h = makeHarness(t)
  h.setManagerNull()
  const staged = join(thirdPartyRoot(h.stateDir), 'deferred-1.2.3.tgz')
  mkdirSync(join(staged, '..'), { recursive: true })
  writeFileSync(staged, 'fake-archive')
  const submitted = await submitResult(h.tasks, {
    kind: 'materialize', name: 'plain-pkg', spec: `file:${staged}`, version: '1.2.3',
  })
  assert.ok(submitted.ok && submitted.deferred === true, JSON.stringify(submitted))
  // The declared version must survive the deferred store: without it the drain's
  // R2 judgement sees no version and can never accept the intent (2026-12 review).
  const stored = h.tasks.deferredIntents()[0]
  assert.equal(stored?.version, '1.2.3')
  h.managerRef.current = h.manager
  assert.equal(await h.tasks.drainDeferred(), 1)
  assert.equal(h.tasks.deferredIntents().length, 0)
  assert.equal(h.spawnCalls.length, 1, 'the drained materialize reaches the executor')
  h.spawnCalls[0]!.child.close(0)
  await waitFor(() => h.manager.held === 0, 'lease released')
})

test('the drain drops a permanently-refused intent and records it as a failed op (no silent zombie)', async t => {
  const h = makeHarness(t)
  // Inject a deferred intent that the judgement can never accept (its name is part
  // of the runtime family F of the active workspace). Before the 2026-12 review
  // this intent was re-submitted on every ready edge forever: refused each time,
  // never dropped, never journaled — a silent zombie holding a staged archive.
  const deferredPath = deferredIntentsFilePath(h.stateDir)
  mkdirSync(join(deferredPath, '..'), { recursive: true })
  writeFileSync(deferredPath, JSON.stringify({
    version: 1,
    intents: [{
      id: 'zombie-1',
      ts: Date.now(),
      kind: 'materialize',
      name: '@deepseek-ai/dsh-session',
      spec: `file:${join(thirdPartyRoot(h.stateDir), 'zombie.tgz')}`,
      version: '0.1.5-rc.2',
    }],
  }))
  assert.equal(h.tasks.deferredIntents().length, 1)
  assert.equal(await h.tasks.drainDeferred(), 0, 'a refused intent is not a successful drain')
  assert.equal(h.tasks.deferredIntents().length, 0, 'the permanent refusal must drop the intent')
  const failed = h.tasks.tasks().tasks.find(op => op.name === '@deepseek-ai/dsh-session')
  assert.ok(failed !== undefined, 'the refusal must be visible in the tasks projection')
  assert.equal(failed?.status, 'failed')
  assert.match(failed?.error ?? '', /protected/)
})

test('drain keeps a protected-set-unavailable intent deferred (gateway state, never a permanent drop)', async t => {
  // routes.ts maps this code to 503 — "the caller may retry once the instance is
  // up" — and design 21 §6.11.3 lists it as a retryable gateway state. It used to
  // sit in PERMANENT_DRAIN_REFUSALS, so a queued official-scope install was
  // deleted for good (only a failed op left) whenever the runtime facts were
  // momentarily unavailable during the drain (2026-09-13 round-2 review F4).
  const h = makeHarness(t)
  // A queued official-scope intent, injected the same way the zombie test does it:
  // this is the state an install reaches when it is deferred while no profile is up.
  const deferredPath = deferredIntentsFilePath(h.stateDir)
  mkdirSync(join(deferredPath, '..'), { recursive: true })
  writeFileSync(deferredPath, JSON.stringify({
    version: 1,
    intents: [{
      id: 'gateway-state-1',
      ts: Date.now(),
      kind: 'install',
      name: '@deepseek-ai/dsh-cli-extra',
      spec: '@deepseek-ai/dsh-cli-extra@0.1.5-rc.2',
      version: '0.1.5-rc.2',
    }],
  }))
  assert.equal(h.tasks.deferredIntents().length, 1)

  // The runtime facts go away mid-window: the drain judges with familySource
  // 'unavailable' ⇒ protected-set-unavailable.
  h.manager.resolveThrows = true
  assert.equal(await h.tasks.drainDeferred(), 0, 'a gateway-state refusal is not a successful drain')
  assert.equal(h.tasks.deferredIntents().length, 1, 'the intent must stay queued for the next ready edge')
  assert.equal(
    h.tasks.tasks().tasks.some(op => op.name === '@deepseek-ai/dsh-cli-extra' && op.status === 'failed'),
    false,
    'nothing may be recorded as a failed op for a retryable gateway state',
  )

  // Facts return: the same intent drains normally, proving the defer was not a loss.
  h.manager.resolveThrows = false
  assert.equal(await h.tasks.drainDeferred(), 1)
  assert.equal(h.tasks.deferredIntents().length, 0)
  h.spawnCalls[0]!.child.close(0)
  await waitFor(() => h.manager.held === 0, 'lease released')
})

test('absent profile defers install/materialize even with an ok lease; remove answers no_manifest', async t => {
  const stateDir = scratchDir(t, 'plugins-tasks-noprof-')
  const workspace = scratchDir(t, 'plugins-tasks-noprof-ws-')
  mkdirSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  const manager = new FakeManager(workspace)
  const managerRef = { current: manager as FakeManager | null }
  const spawn = makeSpawnHarness()
  const tasks = createChamberPluginTasks({
    stateDir,
    manager: () => managerRef.current,
    statusProbe: () => 'ready',
    logger: silent,
    installed: createChamberInstalled(stateDir),
    spawn: spawn.spawn,
  })
  const install = await submitResult(tasks, { kind: 'install', name: 'pkg', spec: 'pkg@1' })
  assert.ok(install.ok)
  if (!install.ok) return
  assert.equal(install.deferred, true, 'profile missing → deferred, never an immediate spawn')
  assert.equal(spawn.calls.length, 0)
  assert.equal(manager.granted, 0, 'no lease consumed for an absent-profile deferral')
  const removal = await submitResult(tasks, { kind: 'remove', name: 'pkg' })
  assertRefusal(removal, 'no_manifest')
})

// ---------------------------------------------------------------------------
// queue_full mapping + dispose + projections
// ---------------------------------------------------------------------------

test('queue_full passes through and releases the lease of the refused submission', async t => {
  const h = makeHarness(t)
  const held: string[] = []
  for (let index = 0; index < 8; index += 1) {
    const result = await submitResult(h.tasks, { kind: 'install', name: `pkg-q-${index}`, spec: `pkg-q-${index}@1` })
    assert.ok(result.ok)
    if (result.ok && !result.deferred) held.push(result.opId)
  }
  assert.equal(h.spawnCalls.length, 1, 'one running, seven queued')
  assert.equal(h.manager.held, 8)

  const overflow = await submitResult(h.tasks, { kind: 'install', name: 'pkg-overflow', spec: 'pkg-overflow@1' })
  assertRefusal(overflow, 'queue_full')
  assert.equal(h.manager.held, 8, 'the refused submission released its lease immediately')
  assert.equal(h.manager.released, 1)

  // Drain everything so the harness has no live children.
  for (let index = 0; index < 8; index += 1) {
    await waitFor(() => h.spawnCalls[index] !== undefined, `spawn ${index}`)
    h.spawnCalls[index]!.child.close(0)
  }
  await waitFor(() => h.manager.held === 0, 'all leases released')
  assert.equal(h.manager.released, 9)
  void held
})

test('dispose kills the in-flight child, blocks queued ops and releases every lease', async t => {
  const h = makeHarness(t)
  const inFlight = await submitResult(h.tasks, { kind: 'install', name: 'pkg-dispose', spec: 'pkg-dispose@1' })
  assert.ok(inFlight.ok)
  if (!inFlight.ok) return
  const inFlightId = inFlight.deferred ? null : inFlight.opId
  assert.ok(inFlightId !== null)
  const queued = await submitResult(h.tasks, { kind: 'install', name: 'pkg-dispose-2', spec: 'pkg-dispose-2@1' })
  assert.ok(queued.ok)
  if (!queued.ok) return
  const queuedId = queued.deferred ? null : queued.opId
  assert.ok(queuedId !== null)
  assert.equal(h.manager.held, 2)
  h.spawnCalls[0]!.child.closeOnKill = true
  await h.tasks.dispose()
  assert.equal(h.manager.held, 0, 'every lease released by dispose terminals')
  assert.equal(h.manager.released, 2)
  assert.deepEqual(h.spawnCalls[0]!.child.signals, ['SIGTERM'])

  const projection = h.tasks.tasks()
  const byId = new Map(projection.tasks.map(op => [op.id, op.status]))
  assert.equal(byId.get(inFlightId!), 'failed')
  assert.equal(byId.get(queuedId!), 'blocked')
  assert.equal(projection.busy, false)

  // dispose is idempotent.
  await h.tasks.dispose()
  assert.equal(h.manager.released, 2, 'second dispose releases nothing')
})

test('tasks projection: journal ops newest-first, deferred intents, busy flag while running', async t => {
  const h = makeHarness(t)
  const first = await submitResult(h.tasks, { kind: 'install', name: 'pkg-a', spec: 'pkg-a@1' })
  assert.ok(first.ok)
  if (!first.ok) return
  const firstId = first.deferred ? null : first.opId
  assert.ok(firstId !== null)
  const second = await submitResult(h.tasks, { kind: 'install', name: 'pkg-b', spec: 'pkg-b@1' })
  assert.ok(second.ok)
  if (!second.ok) return
  assert.equal(h.tasks.tasks().busy, true)

  h.spawnCalls[0]!.child.close(0)
  await waitFor(() => h.tasks.tasks().tasks.some(op => op.id === firstId && op.status === 'ok'), 'first ok')
  const mid = h.tasks.tasks()
  assert.deepEqual(
    mid.tasks.map(op => [op.name, op.status]),
    [['pkg-b', 'pending'], ['pkg-a', 'ok']],
    'newest first',
  )
  assert.deepEqual(mid.deferred, [])
  h.spawnCalls[1]!.child.close(0)
  await waitFor(() => h.tasks.tasks().busy === false, 'worker idle')
  assert.equal(h.tasks.tasks().tasks[0]!.status, 'ok')
})

// ---------------------------------------------------------------------------
// Deferred store corruption discipline
// ---------------------------------------------------------------------------

test('corrupt deferred store is renamed aside and a fresh store starts; appends keep working', async t => {
  const h = makeHarness(t)
  const deferredFile = deferredIntentsFilePath(h.stateDir)
  mkdirSync(thirdPartyRoot(h.stateDir), { recursive: true, mode: 0o700 })
  writeFileSync(deferredFile, '{ not json', { mode: 0o600 })

  h.manager.refusal = { code: 'runtime_busy', error: 'busy' }
  const result = await submitResult(h.tasks, { kind: 'install', name: 'pkg-after-corrupt', spec: 'pkg-after-corrupt@1' })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.deferred, true)
  const aside = readdirSync(thirdPartyRoot(h.stateDir)).filter(name => name.startsWith('deferred.json.corrupt-'))
  assert.equal(aside.length, 1, 'corrupt evidence retained aside')
  assert.equal(h.tasks.deferredIntents().length, 1, 'the fresh store carries the new intent')
})

test('lease release survives a synchronous terminal (CLI resolution failure on the first op)', async t => {
  const h = makeHarness(t)
  // Break the workspace entry so cliLaunch fails while the very first op is
  // being enqueued — the terminal can fire before the submit promise even
  // resolves; the per-op lease release must still run exactly once.
  const entry = join(h.manager.workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assert.equal(existsSync(entry), true)
  rmSync(entry)

  const result = await submitResult(h.tasks, { kind: 'install', name: 'pkg-cli-fail', spec: 'pkg-cli-fail@1' })
  assert.ok(result.ok)
  if (!result.ok) return
  await waitFor(() => h.manager.held === 0, 'lease released despite the synchronous terminal')
  assert.equal(h.manager.granted, 1)
  assert.equal(h.manager.released, 1)
  const tasks = h.tasks.tasks()
  const failed = tasks.tasks.find(op => op.id === (result.deferred ? '' : result.opId))
  assert.equal(failed?.status, 'failed')
  assert.match(failed?.error ?? '', /no dsh CLI entry/)
  assert.equal(tasks.busy, false)

  // With the entry restored the SAME executor keeps serving later ops.
  writeFileSync(entry, '#!/usr/bin/env node\n')
  const later = await submitResult(h.tasks, { kind: 'install', name: 'pkg-after-fail', spec: 'pkg-after-fail@1' })
  assert.ok(later.ok)
  if (later.ok && !later.deferred) {
    assert.equal(h.spawnCalls.length, 1, 'second op spawns once the entry is back')
    h.spawnCalls[0]!.child.close(0)
    await waitFor(() => h.manager.held === 0, 'second lease released')
  }
})

// ---------------------------------------------------------------------------
// Review-fix regressions: drain waves past the queue cap, one controlled
// restart after drained installs (design 21 §6.3), crash-orphan reaping at
// reconcile, and the masked outward task projection.
// ---------------------------------------------------------------------------

/** Slow-close spawn: children succeed only after `delayMs`, so a burst of
 * submissions outpaces the executor — the queue cap (and thus the drain's
 * wave pacing) is genuinely exercised instead of microtask-close racing each
 * submission. Records spawn timestamps for wave-gap assertions. */
function slowOkSpawn(
  base: ReturnType<typeof makeSpawnHarness>,
  delayMs = 200,
): { spawn: ReturnType<typeof makeSpawnHarness>['spawn']; spawnedAt: number[]; closeAt: number[] } {
  const spawnedAt: number[] = []
  const closeAt: number[] = []
  return {
    spawnedAt,
    closeAt,
    spawn: (command, args, options) => {
      const child = base.spawn(command, args, options)
      const record = base.calls[base.calls.length - 1]!
      spawnedAt.push(Date.now())
      setTimeout(() => {
        // 先记录 close 时刻再 close：executor 在 close 回调里同步推进（放
        // 槽 → 下一波 grant），closeAt 必须先于随后 grant 的时间戳落盘。
        closeAt.push(Date.now())
        record.child.close(0)
      }, delayMs)
      return child
    },
  }
}

test('drain WAVES past the queue cap: 10 deferred intents all clear on a healthy instance', async t => {
  const stateDir = scratchDir(t, 'plugins-tasks-waves-')
  writeManifestFixture(stateDir, {})
  const workspace = scratchDir(t, 'plugins-tasks-waves-ws-')
  mkdirSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  const manager = new FakeManager(workspace)
  const spawnBase = makeSpawnHarness()
  // SLOW children (200 ms): a burst of 10 submissions far outpaces the
  // serial executor, so intents 9-10 hit the queue cap and the drain MUST
  // wave — the pre-fix single-round drain would leave them behind.
  const slow = slowOkSpawn(spawnBase, 200)
  const tasks = createChamberPluginTasks({
    stateDir,
    manager: () => manager,
    statusProbe: () => 'ready',
    logger: silent,
    installed: createChamberInstalled(stateDir),
    spawn: slow.spawn,
    timeoutMs: 1000,
  })

  // Ten installs deferred while the runtime lease is refused.
  manager.refusal = { code: 'runtime_busy', error: 'busy' }
  for (let index = 0; index < 10; index += 1) {
    const name = `wave-pkg-${index}`
    const result = await submitResult(tasks, { kind: 'install', name, spec: `${name}@1` })
    assert.ok(result.ok)
    assert.equal(result.deferred, true)
  }
  assert.equal(tasks.deferredIntents().length, 10)

  // Ready edge: the drain paces itself against the queue cap (8) and clears
  // every intent once the accepted ops terminate. The pre-fix single-round
  // drain would stop at 8 (queue_full) — this must reach 10.
  // (The ten deferral submissions above already consumed ten refused
  // beginProfileWrite calls — baseline the grant counter before the drain.)
  const grantedBaseline = manager.granted
  manager.refusal = null
  const drainPromise = tasks.drainDeferred()
  // Wave-1 proof via LEASE GRANTS (spawn timestamps are serial by the worker
  // and cannot show enqueue waves): the first round attempts ALL ten intents
  // — 8 are accepted (each holding a lease: the queue cap) and 2 are refused
  // queue_full (lease released immediately) — so grants reach baseline+10
  // while exactly 8 leases stay held until the first children terminate.
  await waitFor(() => manager.granted === grantedBaseline + 10, 'wave-1 round attempts all ten intents (8 accepted + 2 queue_full)', 2000)
  assert.equal(manager.held, 8, 'exactly the queue cap of leases is held after wave 1 (refused submissions released)')
  // Wave-2 proof: the 11th grant happens only after a first-wave child
  // terminated (~200 ms later) freed a slot — the drain's slot wait is real.
  // 确定性断言（2026 flake 修复）：不用两次 waitFor 观察点之间的墙钟差
  // （轮询滞后会把真实 ~200ms 间隔压缩成 27ms 导致误报），改用事件内时间
  // 戳比较——首次波-2 grant 尝试（attempt 下标 grantedBaseline+10）不得
  // 早于首个波-1 child 的 close 时刻。closeAt 在 close 前落盘、grantedAt 在
  // grant 钩子内落盘，同进程单调时间，顺序即语义。
  await waitFor(() => manager.granted >= grantedBaseline + 11, 'wave 2 grants after a terminal frees a slot', 5000)
  assert.ok(slow.closeAt.length > 0, 'wave-1 child terminals must exist before wave 2')
  assert.ok(manager.grantedAt.length >= grantedBaseline + 11, 'grantedAt must cover the wave-2 grant')
  const firstWave1CloseAt = slow.closeAt[0]!
  const firstWave2GrantAt = manager.grantedAt[grantedBaseline + 10]!
  assert.ok(firstWave2GrantAt >= firstWave1CloseAt,
    `wave 2 grant (${firstWave2GrantAt}) must not precede the first wave-1 terminal (${firstWave1CloseAt})`)
  const cleared = await drainPromise
  assert.equal(cleared, 10, 'all ten intents clear across waves')
  await waitFor(() => manager.held === 0, 'every drained op released its lease')
  assert.equal(tasks.deferredIntents().length, 0)
  const projection = tasks.tasks()
  assert.equal(projection.tasks.filter(op => op.status === 'ok' && op.name.startsWith('wave-pkg-')).length, 10)
  assert.equal(spawnBase.calls.length, 10, 'each intent spawned exactly one mutation')
  await tasks.dispose()
})

test('drain requests ONE controlled restart only after EVERY drained op went terminal ok', async t => {
  const stateDir = scratchDir(t, 'plugins-tasks-restart-')
  writeManifestFixture(stateDir, {})
  const workspace = scratchDir(t, 'plugins-tasks-restart-ws-')
  mkdirSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  const manager = new FakeManager(workspace)
  // Manual-close spawn: ops terminal one at a time so the restart-once
  // ordering is observable.
  const spawnBase = makeSpawnHarness()
  let restartRequests = 0
  const tasks = createChamberPluginTasks({
    stateDir,
    manager: () => manager,
    statusProbe: () => 'ready',
    logger: silent,
    installed: createChamberInstalled(stateDir),
    spawn: spawnBase.spawn,
    timeoutMs: 1000,
    restartManaged: async () => { restartRequests += 1 },
  })

  // Two installs deferred while busy.
  manager.refusal = { code: 'runtime_busy', error: 'busy' }
  for (const name of ['restart-pkg-1', 'restart-pkg-2']) {
    const result = await submitResult(tasks, { kind: 'install', name, spec: `${name}@1` })
    assert.ok(result.ok)
    assert.equal(result.deferred, true)
  }
  manager.refusal = null
  assert.equal(await tasks.drainDeferred(), 2)
  // The FIRST drained op terminates ok — but the second is still pending
  // (its profile-write lease would keep the production gate closed): the
  // restart request must NOT have fired yet.
  spawnBase.calls[0]!.child.close(0)
  await waitFor(() => spawnBase.calls.length >= 1 && tasks.tasks().tasks.some(op => op.name === 'restart-pkg-1' && op.status === 'ok'), 'first drained op ok')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(restartRequests, 0, 'no restart while a drained op is still pending')
  // All drained ops terminal ok → exactly ONE restart request.
  await waitFor(() => spawnBase.calls.length === 2, 'second drained op spawns')
  spawnBase.calls[1]!.child.close(0)
  await waitFor(() => restartRequests === 1, 'exactly one restart request after ALL drained ops ok')
  assert.equal(restartRequests, 1)
  await waitFor(() => manager.held === 0, 'leases released')

  // A later FAILED drained op requests nothing: a restart mounts plugins
  // that never landed — the request only fires on a terminal 'ok'.
  const failState = scratchDir(t, 'plugins-tasks-restart-fail-')
  writeManifestFixture(failState, {})
  const failBase = makeSpawnHarness()
  const failingSpawn: ReturnType<typeof makeSpawnHarness>['spawn'] = (command, args, options) => {
    const child = failBase.spawn(command, args, options)
    const record = failBase.calls[failBase.calls.length - 1]!
    queueMicrotask(() => record.child.close(7))
    return child
  }
  const failManager = new FakeManager(workspace)
  const tasks2 = createChamberPluginTasks({
    stateDir: failState,
    manager: () => failManager,
    statusProbe: () => 'ready',
    logger: silent,
    installed: createChamberInstalled(failState),
    spawn: failingSpawn,
    timeoutMs: 1000,
    restartManaged: async () => { restartRequests += 1 },
  })
  failManager.refusal = { code: 'runtime_busy', error: 'busy' }
  const deferredResult = await submitResult(tasks2, { kind: 'install', name: 'restart-pkg-fail', spec: 'restart-pkg-fail@1' })
  assert.ok(deferredResult.ok)
  assert.equal(deferredResult.deferred, true)
  failManager.refusal = null
  assert.equal(await tasks2.drainDeferred(), 1)
  const failJournal = createPluginsJournal(failState, silent)
  await waitFor(() => failJournal.recent().find(op => op.name === 'restart-pkg-fail')?.status === 'failed', 'failed drained op terminal')
  assert.equal(restartRequests, 1, 'a failed drained op requests no restart')
  await tasks2.dispose()
})

test('reconcileJournal kills crash-orphaned children recorded on pending ops', async t => {
  const stateDir = scratchDir(t, 'plugins-tasks-orphan-')
  writeManifestFixture(stateDir, {})
  const workspace = scratchDir(t, 'plugins-tasks-orphan-ws-')
  mkdirSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  const manager = new FakeManager(workspace)
  const tasks = createChamberPluginTasks({
    stateDir,
    manager: () => manager,
    statusProbe: () => 'ready',
    logger: silent,
    installed: createChamberInstalled(stateDir),
  })

  // A previous gateway run died mid-mutation: a pending op carrying the
  // spawned child pid survives in the journal.
  const journal = createPluginsJournal(stateDir, silent)
  const opId = journal.appendPending({ kind: 'install', name: 'orphan-pkg', spec: 'orphan-pkg@1' })
  journal.markChildPid(opId, 4321)

  const killed: number[] = []
  const originalKill = process.kill
  process.kill = ((pid: number, signal?: string | number) => {
    killed.push(pid)
    if (signal === 'SIGKILL') {
      const error = new Error('no such process') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }
    return true
  }) as typeof process.kill
  t.after(() => { process.kill = originalKill })

  tasks.reconcileJournal()
  // Group first (negative pid), then the pid itself.
  assert.deepEqual(killed, [-4321, 4321])
  assert.equal(journal.recent().find(op => op.id === opId)?.status, 'failed', 'the interrupted op is marked failed')
  assert.equal(journal.recent().find(op => op.id === opId)?.childPid, undefined)
})

test('the outward tasks projection masks file: specs while the journal keeps the real staged path', async t => {
  const h = makeHarness(t)
  const staged = join(thirdPartyRoot(h.stateDir), 'slug', 'slug-1.0.0-deadbeef.tgz')
  mkdirSync(join(thirdPartyRoot(h.stateDir), 'slug'), { recursive: true, mode: 0o700 })
  writeFileSync(staged, 'tgz', { mode: 0o600 })
  const result = await submitResult(h.tasks, { kind: 'materialize', name: 'slug', spec: `file:${staged}` })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.deferred, false)
  h.spawnCalls[0]!.child.close(0)
  await waitFor(() => h.tasks.tasks().tasks[0]?.status === 'ok', 'materialize op ok')
  const projected = h.tasks.tasks().tasks[0]!
  assert.equal(projected.name, 'slug')
  assert.equal(projected.spec, MATERIALIZED_VALUE_MASK, 'the projection masks the staging path')
  // An EXECUTED materialize op RETAINS its staged archive: the dsh CLI
  // permanently records `file:<staged>` in the profile manifest + pnpm
  // lockfile, and a later re-resolution fetches that exact path again —
  // deleting it at the terminal would leave the manifest dangling (the same
  // "kept, never cleaned" policy as the desktop ssh plugin dir).
  assert.equal(existsSync(staged), true, 'the staged archive is retained after the op is terminal')
})

test('the tasks projection never exposes a pending op\'s live childPid; the journal keeps it internally', async t => {
  const h = makeHarness(t)
  const result = await submitResult(h.tasks, { kind: 'install', name: 'pid-proj-pkg', spec: 'pid-proj-pkg@1' })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.deferred, false)
  // Wait until the mutation child is spawned and still OPEN (op pending).
  await waitFor(() => h.spawnCalls.length === 1, 'mutation spawns')
  const journal = createPluginsJournal(h.stateDir, silent)
  await waitFor(() => journal.recent().find(op => op.name === 'pid-proj-pkg')?.childPid !== undefined, 'journal records the live pid')
  assert.equal(journal.recent().find(op => op.name === 'pid-proj-pkg')?.status, 'pending')
  const projected = h.tasks.tasks().tasks.find(op => op.name === 'pid-proj-pkg')
  assert.ok(projected !== undefined)
  assert.equal(Object.hasOwn(projected, 'childPid'), false, 'a live host pid must never reach the tasks projection')
  h.spawnCalls[0]!.child.close(0)
  await waitFor(() => journal.recent().find(op => op.name === 'pid-proj-pkg')?.status === 'ok', 'op ok')
  await waitFor(() => h.manager.held === 0, 'lease released')
})

test('the boot orphan sweep removes staged archives nothing references and keeps manifest-/intent-referenced ones', async t => {
  const h = makeHarness(t)
  const root = thirdPartyRoot(h.stateDir)
  // Executed-op retention: the profile manifest dependency points at this
  // staged archive — the sweep must never touch it.
  const keptByManifest = join(root, 'slug-alpha', 'alpha-1.0.0-11111111.tgz')
  // Deferred intent: drains at the next ready edge — its archive must
  // survive the sweep.
  const keptByIntent = join(root, 'slug-beta', 'beta-1.0.0-22222222.tgz')
  // Nothing references this one: a remove/upgrade cycle left it behind.
  const orphan = join(root, 'slug-gamma', 'gamma-0.0.1-33333333.tgz')
  for (const staged of [keptByManifest, keptByIntent, orphan]) {
    mkdirSync(join(root, staged.split('/').at(-2)!), { recursive: true, mode: 0o700 })
    writeFileSync(staged, 'tgz-bytes', { mode: 0o600 })
  }
  writeManifestFixture(h.stateDir, { alpha: `file:${keptByManifest}` })
  h.manager.refusal = { code: 'runtime_busy', error: 'busy' }
  const deferred = await submitResult(h.tasks, { kind: 'materialize', name: 'beta', spec: `file:${keptByIntent}` })
  assert.ok(deferred.ok)
  assert.equal(deferred.deferred, true, 'the intent is persisted for the next ready edge')
  h.manager.refusal = null

  h.tasks.sweepOrphanedStagedArchives()
  assert.equal(existsSync(keptByManifest), true, 'the manifest-referenced archive is retained')
  assert.equal(existsSync(keptByIntent), true, 'the intent-referenced archive is retained')
  assert.equal(existsSync(orphan), false, 'the unreferenced archive is reclaimed')

  // Idempotent: a second sweep leaves every referenced archive alone.
  h.tasks.sweepOrphanedStagedArchives()
  assert.equal(existsSync(keptByManifest), true)
  assert.equal(existsSync(keptByIntent), true)
})

test('reconcileJournal never claims "no pending operations" when the journal is corrupt', t => {
  const { logger, logs, warns } = makeCaptureLogger()
  const h = makeHarness(t, logger)
  // A previous run left a pending op with an executed preImage, then the
  // journal was torn (crash mid-write / damaged disk).
  const seed = createPluginsJournal(h.stateDir, silent)
  const lostOpId = seed.appendPending({ kind: 'install', name: 'lost-pkg', spec: 'lost-pkg@1' })
  seed.recordPreImage(lostOpId)
  const preImage = backupDirFor(h.stateDir, lostOpId)
  mkdirSync(preImage, { recursive: true })
  writeFileSync(join(preImage, 'package.json'), '{"name":"web"}', 'utf8')
  const filePath = journalFilePath(h.stateDir)
  const truncated = readFileSync(filePath, 'utf8').slice(0, 40)
  writeFileSync(filePath, truncated, 'utf8')

  h.tasks.reconcileJournal()

  assert.equal(
    logs.some(message => message.includes('no pending operations carried over')),
    false,
    'a corrupt journal must never be reported as "no pending operations"',
  )
  assert.ok(warns.some(message => message.includes('corrupt')), `corruption is loud (warns: ${warns.join(' | ')})`)
  // Evidence retained byte-for-byte; the lost op's rollback material untouched.
  const aside = readdirSync(thirdPartyRoot(h.stateDir)).find(name => /^journal\.json\.corrupt-\d+$/.test(name))
  assert.ok(aside !== undefined, 'the raw bytes are kept aside')
  assert.equal(readFileSync(join(thirdPartyRoot(h.stateDir), aside!), 'utf8'), truncated)
  assert.equal(existsSync(preImage), true, 'the lost pending op preImage is untouched')

  // A new record after the loss still works (guarded cleanup, not a dead journal).
  const fresh = seed.appendPending({ kind: 'install', name: 'pkg-after', spec: 'pkg-after@1' })
  const journal = createPluginsJournal(h.stateDir, silent)
  journal.markTerminal(fresh, { status: 'ok' })
  assert.equal(existsSync(preImage), true, 'a later terminal mark never reclaims the lost preImage')
})

test('the boot orphan sweep deletes nothing while the profile manifest is unreadable', t => {
  const { logger, warns } = makeCaptureLogger()
  const h = makeHarness(t, logger)
  const root = thirdPartyRoot(h.stateDir)
  const orphan = join(root, 'slug-gamma', 'gamma-0.0.1-33333333.tgz')
  mkdirSync(dirname(orphan), { recursive: true, mode: 0o700 })
  writeFileSync(orphan, 'tgz-bytes', { mode: 0o600 })
  const manifestPath = join(h.stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR, 'package.json')
  const profileDir = join(h.stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR)

  // (a) Present but not JSON: the read face answers profile_corrupt — the
  //     sweep must never read it as "nothing is referenced".
  writeFileSync(manifestPath, '{"name":"web","dependencies":{', 'utf8')
  h.tasks.sweepOrphanedStagedArchives()
  assert.equal(existsSync(orphan), true, 'a corrupt manifest never licenses deletion')
  assert.ok(warns.some(message => message.includes('manifest')), 'the skip names the manifest')

  // (b) Oversized (> read bound) is a read failure, not an empty reference set.
  writeFileSync(manifestPath, JSON.stringify({ dependencies: {}, pad: 'x'.repeat(INSTALLED_MANIFEST_MAX_BYTES) }), 'utf8')
  h.tasks.sweepOrphanedStagedArchives()
  assert.equal(existsSync(orphan), true, 'the read bound is honoured as unreadable')

  // (c) Symlinked profile directory (no-follow discipline, read-face parity).
  const real = scratchDir(t, 'plugins-tasks-sweep-real-')
  mkdirSync(join(real, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR), { recursive: true })
  writeFileSync(join(real, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR, 'package.json'), '{"name":"web","dependencies":{}}', 'utf8')
  rmSync(profileDir, { recursive: true, force: true })
  symlinkSync(join(real, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR), profileDir)
  h.tasks.sweepOrphanedStagedArchives()
  assert.equal(existsSync(orphan), true, 'a symlinked profile dir is unreadable, not empty')

  // (d) Absent manifest (fresh gateway): existing semantics — an orphan with
  //     no intent/op reference is still reclaimed.
  rmSync(profileDir, { force: true })
  h.tasks.sweepOrphanedStagedArchives()
  assert.equal(existsSync(orphan), false, 'an absent manifest keeps the original sweep semantics')
})

test('the boot orphan sweep deletes nothing while the journal is corrupt', t => {
  const { logger, warns } = makeCaptureLogger()
  const h = makeHarness(t, logger)
  const root = thirdPartyRoot(h.stateDir)
  const orphan = join(root, 'slug-delta', 'delta-0.0.1-44444444.tgz')
  mkdirSync(dirname(orphan), { recursive: true, mode: 0o700 })
  writeFileSync(orphan, 'tgz-bytes', { mode: 0o600 })
  // A pending op's staged spec is unknowable from a torn journal: the sweep
  // must refuse rather than delete the archive that lost op may still consume.
  writeFileSync(journalFilePath(h.stateDir), '{"version":1,"ops":[{"id":"lost"', 'utf8')

  h.tasks.reconcileJournal()
  h.tasks.sweepOrphanedStagedArchives()
  assert.equal(existsSync(orphan), true, 'a corrupt journal leaves live-op references unknown')
  assert.ok(
    warns.some(message => message.includes('journal') && message.includes('sweep')),
    `the skip is announced and names the journal (warns: ${warns.join(' | ')})`,
  )
})

test('the boot orphan sweep deletes nothing while the deferred intent store is corrupt', t => {
  const { logger, warns } = makeCaptureLogger()
  const h = makeHarness(t, logger)
  const root = thirdPartyRoot(h.stateDir)
  const orphan = join(root, 'slug-epsilon', 'epsilon-0.0.1-55555555.tgz')
  mkdirSync(dirname(orphan), { recursive: true, mode: 0o700 })
  writeFileSync(orphan, 'tgz-bytes', { mode: 0o600 })
  // A lost deferred materialize's staged spec is unknowable from a corrupt
  // store: the intent references are unknown, so nothing may be swept.
  writeFileSync(deferredIntentsFilePath(h.stateDir), '{"version":1,"intents":[', 'utf8')

  h.tasks.sweepOrphanedStagedArchives()
  assert.equal(existsSync(orphan), true, 'a corrupt deferred store leaves intent references unknown')
  assert.ok(
    warns.some(message => message.includes('deferred') && message.includes('sweep')),
    `the skip is announced and names the deferred store (warns: ${warns.join(' | ')})`,
  )
  // The store itself recovers exactly as before: evidence aside + fresh store.
  assert.ok(readdirSync(root).some(name => name.startsWith('deferred.json.corrupt-')), 'corrupt evidence retained')
  assert.deepEqual(h.tasks.deferredIntents(), [])
})
