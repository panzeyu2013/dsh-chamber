/**
 * /chamber/runtime ownership boundaries after R2: the dsh-runtime tree-safety
 * refusals stay here, and the state-root writer lease is either ADOPTED from
 * createGateway (never released by the manager) or SELF-ACQUIRED by a directly
 * constructed manager and released in dispose(). The lock contract itself
 * (live/dead pid, stale takeover, torn record, release token+inode) lives in
 * the shared contract suite packages/control-plane/test/state/state-root-lease.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_ROOT_LEASE_FILENAME, StateRootLeaseError, acquireStateRootLease } from '@dsh-chamber/control-plane'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import {
  silentLogger,
  TEST_BUILTIN_VERSION,
  config,
  fakePlane,
  probeResultsFor,
  armPendingSwitch,
} from '../support/runtime-routes-harness.ts'

const leaseFile = (stateDir: string): string => join(stateDir, STATE_ROOT_LEASE_FILENAME)
const readLease = (stateDir: string): Record<string, unknown> => JSON.parse(readFileSync(leaseFile(stateDir), 'utf8')) as Record<string, unknown>

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
    assert.ok(!existsSync(join(externalDir, 'owner.json')), 'no lease or owner guard writes through the linked root')
    assert.ok(!existsSync(join(externalDir, 'registry.json')), 'registry state never writes through the linked root')
    assert.ok(!existsSync(leaseFile(stateDir)), 'the reachability check runs before the lease is taken')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(externalDir, { recursive: true, force: true })
  }
})

test('a directly constructed manager self-acquires the one state-root lease and dispose releases it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-self-lease-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.ok(existsSync(leaseFile(stateDir)), 'a direct construction owns exactly one lease')
    const record = readLease(stateDir)
    assert.equal(record.pid, process.pid)
    assert.equal(record.scope, 'state-root')
    assert.equal(record.flavor, 'gateway')
    assert.equal(typeof record.token, 'string')
    assert.equal((record.token as string).length, 48)
    assert.equal(statSync(leaseFile(stateDir)).mode & 0o777, 0o600)
    await manager.dispose()
    assert.ok(!existsSync(leaseFile(stateDir)), 'dispose releases the self-acquired lease')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an adopted gateway lease is asserted but never released or rewritten by the manager', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-adopt-lease-'))
  try {
    const lease = acquireStateRootLease(stateDir, { scope: 'state-root', flavor: 'gateway' })
    const before = readFileSync(leaseFile(stateDir), 'utf8')
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      stateLease: lease,
    })
    assert.equal(readFileSync(leaseFile(stateDir), 'utf8'), before, 'adoption never rewrites the record')
    await manager.dispose()
    assert.equal(lease.held(), true, 'the gateway handle survives manager disposal')
    assert.equal(readFileSync(leaseFile(stateDir), 'utf8'), before)
    lease.release()
    assert.ok(!existsSync(leaseFile(stateDir)))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a stateLease for a different root is refused before any runtime write', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-wrong-lease-'))
  const otherDir = mkdtempSync(join(tmpdir(), 'gw-rt-wrong-lease-other-'))
  try {
    const lease = acquireStateRootLease(otherDir, { scope: 'state-root', flavor: 'gateway' })
    try {
      assert.throws(
        () => createGatewayRuntimeManager({
          config: config(stateDir),
          plane: fakePlane(),
          logger: silentLogger,
          stateLease: lease,
        }),
        /does not match the state-root lease/,
      )
    } finally {
      lease.release()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(otherDir, { recursive: true, force: true })
  }
})

test('same-process duplicate managers cannot share one runtime stateDir', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-same-process-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      (error: unknown) => error instanceof StateRootLeaseError && error.code === 'state_root_duplicate',
    )
    await manager.dispose()
    const replacement = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    await replacement.dispose()
    assert.ok(!existsSync(leaseFile(stateDir)))
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
    assert.equal(existsSync(leaseFile(constructDir)), false,
      'a constructor tail failure releases the exact acquired lease')
    assert.equal(abandonedTicks.length, 1)
    abandonedTicks[0]!()
    assert.equal(existsSync(leaseFile(constructDir)), false,
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
    assert.equal(existsSync(leaseFile(cancelDir)), false,
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
    assert.equal(existsSync(leaseFile(stateDir)), false, 'the Windows read-only projection owns no state-root lease')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
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
    assert.equal(statSync(registry).mode & 0o777, 0o644)

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
    const ownerPath = leaseFile(stateDir)
    await manager.applyNow()
    await entered

    let disposeSettled = false
    const disposal = manager.dispose().then(() => { disposeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposeSettled, false, 'dispose waits for the complete detached activation job')
    assert.equal(manager.activationInProgress(), true, 'dispose immediately enters a sticky exposure quarantine')
    assert.equal(probeSignal?.aborted, true, 'the manager lifecycle abort reaches the live candidate probe')
    assert.ok(existsSync(ownerPath), 'the state-root lease remains while an activation writer can still settle')

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
    const ownerPath = leaseFile(stateDir)
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
    const ownerPath = leaseFile(stateDir)
    await assert.rejects(manager.dispose(), /writers could not be proven quiescent/)
    assert.ok(existsSync(ownerPath), 'failed writer proof retains the state-root lease')
    assert.throws(
      () => createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger }),
      (error: unknown) => error instanceof StateRootLeaseError && error.code === 'state_root_duplicate',
      'a replacement manager cannot enter after unsafe disposal',
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('dispose() releases only its exact lease token and inode', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-owner-release-token-'))
  try {
    const manager = createGatewayRuntimeManager({ config: config(stateDir), plane: fakePlane(), logger: silentLogger })
    const ownerPath = leaseFile(stateDir)
    rmSync(ownerPath)
    const replacementPayload = JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      startedAt: 2,
      token: 'b'.repeat(48),
      scope: 'state-root',
      flavor: 'gateway',
    }) + '\n'
    writeFileSync(ownerPath, replacementPayload, { mode: 0o600 })
    await assert.rejects(manager.dispose(), (error: unknown) => (
      error instanceof StateRootLeaseError && error.code === 'state_root_not_owner'
    ))
    assert.equal(readFileSync(ownerPath, 'utf8'), replacementPayload,
      'an old manager never unlinks a replacement lease')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
