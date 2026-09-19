/**
 * /chamber/runtime ownership and the single-owner guard: unsafe owner leaves,
 * live/dead-pid records, stale-owner takeover, duplicate managers and dispose
 * release. Split from runtime-routes.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import {
  silentLogger,
  TEST_BUILTIN_VERSION,
  config,
  fakePlane,
  probeResultsFor,
  armPendingSwitch,
} from '../support/runtime-routes-harness.ts'

test('gateway runtime ownership fails closed when dsh-runtime root is a symlink', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-root-link-'))
  const externalDir = mkdtempSync(join(tmpdir(), 'gw-rt-root-target-'))
  try {
    const gatewayConfig = config(stateDir)
    const sentinel = join(externalDir, 'sentinel')
    writeFileSync(sentinel, 'outside-state', { mode: 0o644 })
    symlinkSync(externalDir, join(stateDir, 'dsh-runtime'), process.platform === 'win32' ? 'junction' : 'dir')

    assert.throws(
      () => createGatewayRuntimeManager({ config: gatewayConfig, plane: fakePlane(), logger: silentLogger }),
      /不安全|unsafe/i,
    )
    assert.equal(readFileSync(sentinel, 'utf8'), 'outside-state')
    assert.equal(statSync(sentinel).mode & 0o777, 0o644)
    assert.ok(!existsSync(join(externalDir, 'owner.json')), 'owner guard never writes through the linked root')
    assert.ok(!existsSync(join(externalDir, 'registry.json')), 'registry state never writes through the linked root')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(externalDir, { recursive: true, force: true })
  }
})

test('gateway runtime ownership refuses an unsafe owner leaf without touching its target', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-link-'))
  const externalDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-target-'))
  try {
    const gatewayConfig = config(stateDir)
    const stateRoot = join(stateDir, 'dsh-runtime')
    const externalOwner = join(externalDir, 'owner-target')
    mkdirSync(stateRoot, { mode: 0o700 })
    writeFileSync(externalOwner, JSON.stringify({ pid: 99_999_999 }), { mode: 0o644 })
    symlinkSync(externalOwner, join(stateRoot, 'owner.json'), 'file')

    assert.throws(
      () => createGatewayRuntimeManager({ config: gatewayConfig, plane: fakePlane(), logger: silentLogger }),
      /owner record is unsafe or unreadable/,
    )
    assert.equal(readFileSync(externalOwner, 'utf8'), JSON.stringify({ pid: 99_999_999 }))
    assert.equal(statSync(externalOwner).mode & 0o777, 0o644)
    assert.ok(lstatSync(join(stateRoot, 'owner.json')).isSymbolicLink(), 'unsafe owner evidence remains in place')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(externalDir, { recursive: true, force: true })
  }
})

test('single-process guard: a live owner record from another pid fails loud', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-'))
  try {
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, 'dsh-runtime', 'owner.json'), JSON.stringify({ pid: process.ppid }), { mode: 0o600 })
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      /another gateway process/,
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stale-owner takeover detects A-move/A-create/B-move and restores the exact fresh owner', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-interleave-'))
  try {
    const stateRoot = join(stateDir, 'dsh-runtime')
    const owner = join(stateRoot, 'owner.json')
    const displacedOld = join(stateRoot, 'owner.old-fixture')
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    writeFileSync(owner, `${JSON.stringify({ pid: 99_999_999, startedAt: 'old' })}\n`, { mode: 0o600 })
    const freshPayload = `${JSON.stringify({ pid: process.pid, startedAt: 'fresh', token: 'a'.repeat(48) })}\n`

    assert.throws(
      () => createGatewayRuntimeManager({
        config: config(stateDir),
        plane: fakePlane(),
        logger: silentLogger,
        ownerTakeoverBeforeRename: () => {
          // A has already read the stale owner. Just after B's final old-inode
          // check, A wins the rename and publishes its fresh token; B's rename
          // therefore moves A's fresh owner and must detect/restore it.
          renameSync(owner, displacedOld)
          writeFileSync(owner, freshPayload, { mode: 0o600 })
        },
      }),
      /replaced the owner during stale takeover|could not be durably claimed/,
    )
    assert.equal(readFileSync(owner, 'utf8'), freshPayload,
      'the losing takeover restores A\'s exact fresh token instead of entering or deleting it')
    assert.ok(existsSync(displacedOld), 'the original dead-owner evidence remains available')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('constructor and scheduler cancellation failures release ownership safely', async () => {
  const constructDir = mkdtempSync(join(tmpdir(), 'gw-rt-scheduler-construct-'))
  try {
    const abandonedTicks: Array<() => void> = []
    assert.throws(() => createGatewayRuntimeManager({
      config: config(constructDir),
      plane: fakePlane(),
      logger: silentLogger,
      scheduleKnownGoodPromotion: callback => {
        abandonedTicks.push(callback)
        throw new Error('scheduler setup failed')
      },
    }), /scheduler setup failed/)
    assert.equal(existsSync(join(constructDir, 'dsh-runtime', 'owner.json')), false,
      'a constructor tail failure releases the exact acquired lease')
    assert.equal(abandonedTicks.length, 1)
    abandonedTicks[0]!()
    assert.equal(existsSync(join(constructDir, 'dsh-runtime', 'owner.json')), false,
      'a scheduler callback retained by a throwing adapter is permanently fenced')
    const replacement = createGatewayRuntimeManager({ config: config(constructDir), plane: fakePlane(), logger: silentLogger })
    await replacement.dispose()
  } finally {
    rmSync(constructDir, { recursive: true, force: true })
  }

  const cancelDir = mkdtempSync(join(tmpdir(), 'gw-rt-scheduler-cancel-'))
  try {
    const manager = createGatewayRuntimeManager({
      config: config(cancelDir),
      plane: fakePlane(),
      logger: silentLogger,
      scheduleKnownGoodPromotion: () => () => { throw new Error('scheduler cancel failed') },
    })
    await manager.dispose()
    assert.equal(existsSync(join(cancelDir, 'dsh-runtime', 'owner.json')), false,
      'a fenced stale callback cannot make cancellation failure skip writer drain/release')
  } finally {
    rmSync(cancelDir, { recursive: true, force: true })
  }
})

test('Windows read-only projection never enters POSIX runtime-root writer primitives', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-win-readonly-'))
  const external = mkdtempSync(join(tmpdir(), 'gw-rt-win-external-'))
  try {
    const gatewayConfig = config(stateDir)
    const sentinel = join(external, 'sentinel')
    writeFileSync(sentinel, 'untouched', { mode: 0o644 })
    symlinkSync(external, join(stateDir, 'dsh-runtime'), process.platform === 'win32' ? 'junction' : 'dir')
    let schedulerCalled = false
    const manager = createGatewayRuntimeManager({
      config: gatewayConfig,
      plane: fakePlane(),
      logger: silentLogger,
      platform: 'win32',
      scheduleKnownGoodPromotion: () => {
        schedulerCalled = true
        return () => {}
      },
    })
    assert.equal(manager.stateRoot(), join(stateDir, 'dsh-runtime'))
    assert.equal(manager.resolveWorkspace().source, 'builtin')
    assert.deepEqual(await manager.startupTransaction(), { blockedReason: null })
    const status = await manager.status()
    assert.equal(status.platform, 'win32')
    assert.equal(status.mutationsAllowed, false)
    assert.equal(status.activeVersion, TEST_BUILTIN_VERSION)
    assert.equal(manager.getRegistry().origin, 'https://registry.npmjs.org')
    await assert.rejects(manager.setRegistry('https://registry.npmmirror.com'), (error: unknown) => (
      (error as Error & { code?: string }).code === 'platform_read_only'
    ))
    assert.equal(schedulerCalled, false, 'the POSIX sustained-health writer is not scheduled on Windows')
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
    assert.equal(statSync(sentinel).mode & 0o777, 0o644)
    assert.equal(existsSync(join(external, 'owner.json')), false)
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('same-process duplicate managers cannot share one runtime stateDir', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-same-process-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      /already owns/,
    )
    await manager.dispose()
    const replacement = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await replacement.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an owner record with this pid is rejected even without a module-local lease', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-same-pid-record-'))
  try {
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, 'dsh-runtime', 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      /already owns/,
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('single-process guard: a stale owner record from a dead pid is taken over', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-esrch-'))
  try {
    mkdirSync(join(stateDir, 'dsh-runtime'), { recursive: true, mode: 0o700 })
    // A pid that cannot exist on any platform probing kill(pid,0).
    writeFileSync(join(stateDir, 'dsh-runtime', 'owner.json'), JSON.stringify({ pid: 99_999_999 }), { mode: 0o600 })
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.equal(manager.resolveWorkspace().source, 'builtin')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() reaps install children and removes the owner record', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-dispose-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    assert.ok(existsSync(ownerPath))
    assert.equal(statSync(ownerPath).mode & 0o777, 0o600, 'owner record created via wx is owner-only')
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: unknown }
    assert.equal(typeof owner.token, 'string')
    assert.equal((owner.token as string).length, 48, 'owner release authority is a random exact token')
    await manager.dispose()
    assert.ok(!existsSync(join(stateDir, 'dsh-runtime', 'owner.json')), 'owner record dropped on dispose')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a disposed manager cannot read/quarantine authority owned by its replacement', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-disposed-reader-'))
  try {
    const oldManager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await oldManager.dispose()
    const replacement = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const registry = join(stateDir, 'dsh-runtime', 'registry.json')
    writeFileSync(registry, '{replacement-owned-broken-json', { mode: 0o644 })
    chmodSync(registry, 0o644)

    await assert.rejects(oldManager.status(), (error: unknown) => (
      (error as Error & { code?: string }).code === 'runtime_disposed'
    ))
    assert.throws(() => oldManager.getRegistry(), (error: unknown) => (
      (error as Error & { code?: string }).code === 'runtime_disposed'
    ))
    assert.throws(() => oldManager.resolveWorkspace(), (error: unknown) => (
      (error as Error & { code?: string }).code === 'runtime_disposed'
    ))
    assert.equal(readFileSync(registry, 'utf8'), '{replacement-owned-broken-json')
    assert.equal(statSync(registry).mode & 0o777, 0o644,
      'the old object cannot chmod a new owner\'s authority while pretending to read')
    assert.equal(readdirSync(join(stateDir, 'dsh-runtime')).some(name => name.startsWith('registry.json.corrupt-')), false,
      'the old object cannot quarantine the new owner\'s authority')
    await replacement.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() aborts and drains an apply-now probe before releasing runtime ownership', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-dispose-applynow-'))
  try {
    armPendingSwitch(stateDir, '1.0.0')

    let probeEntered!: () => void
    const entered = new Promise<void>(resolve => { probeEntered = resolve })
    let releaseProbe!: () => void
    const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
    let probeSignal: AbortSignal | undefined
    let starts = 0
    const quarantineEdges: boolean[] = []
    const plane = fakePlane({
      startLocal: async () => { starts += 1 },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      onActivationQuarantineChange: active => { quarantineEdges.push(active) },
      probeCandidate: async ({ signal }) => {
        probeSignal = signal
        probeEntered()
        await probeGate
        return probeResultsFor(stateDir).map(name => ({ name, ok: true }))
      },
    })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    await manager.applyNow()
    await entered

    let disposeSettled = false
    const disposal = manager.dispose().then(() => { disposeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposeSettled, false, 'dispose waits for the complete detached activation job')
    assert.equal(manager.activationInProgress(), true, 'dispose immediately enters a sticky exposure quarantine')
    assert.equal(probeSignal?.aborted, true, 'the manager lifecycle abort reaches the live candidate probe')
    assert.ok(existsSync(ownerPath), 'owner.json remains while an activation writer can still settle')

    releaseProbe()
    await disposal
    assert.equal(manager.activationInProgress(), true, 'a disposed manager can never reopen exposure')
    assert.equal(quarantineEdges.includes(false), false,
      'the rollback activation tail cannot publish an open edge after disposal begins')
    assert.equal(starts, 1, 'dispose prevents the apply-now recovery tail from spawning after abort')
    assert.ok(!existsSync(ownerPath), 'ownership is released only after the activation job and final stop settle')
    const replacement = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await replacement.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() drains the full select promise and forwards abort to registry metadata fetch', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-dispose-select-'))
  try {
    let fetchEntered!: () => void
    const entered = new Promise<void>(resolve => { fetchEntered = resolve })
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve })
    let fetchSignal: AbortSignal | undefined
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      fetchMetadata: async (_name, options) => {
        fetchSignal = options?.signal
        fetchEntered()
        await fetchGate
        throw new Error('registry fetch released after disposal')
      },
    })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    const selection = manager.select('2.0.0')
    await entered
    let disposeSettled = false
    const disposal = manager.dispose().then(() => { disposeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposeSettled, false, 'the registry phase is part of the manager writer promise')
    assert.equal(fetchSignal?.aborted, true)
    assert.ok(existsSync(ownerPath))
    releaseFetch()
    await assert.rejects(selection, /released after disposal/)
    await disposal
    assert.ok(!existsSync(ownerPath))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() retains runtime ownership when final process quiescence cannot be proved', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-dispose-unsafe-'))
  try {
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane({ stopLocal: async () => { throw new Error('stop ownership unsafe') } }),
      logger: silentLogger,
    })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    await assert.rejects(manager.dispose(), /writers could not be proven quiescent/)
    assert.ok(existsSync(ownerPath), 'failed writer proof retains owner.json')
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      /already owns/,
      'a replacement manager cannot enter after unsafe disposal',
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() releases only its exact owner token and inode', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-release-token-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const ownerPath = join(stateDir, 'dsh-runtime', 'owner.json')
    rmSync(ownerPath)
    const replacementPayload = `${JSON.stringify({
      pid: process.pid,
      startedAt: 'replacement',
      token: 'b'.repeat(48),
    })}\n`
    writeFileSync(ownerPath, replacementPayload, { mode: 0o600 })
    await assert.rejects(manager.dispose(), /owner token no longer matches/)
    assert.equal(readFileSync(ownerPath, 'utf8'), replacementPayload,
      'an old manager never unlinks a replacement lease')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
