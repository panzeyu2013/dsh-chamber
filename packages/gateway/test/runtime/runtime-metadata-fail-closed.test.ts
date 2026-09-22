/**
 * 2026-12 Phase B (B2): the gateway runtime manager's authority consumption
 * fails closed on corrupt/unreadable override / current / known-good material.
 * Corrupt or unknown material proves neither absence nor a legal record, so it
 * must never be projected as "no override" / builtin / zero failures — every
 * decision site refuses and every read-only projection carries a reason.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCurrentPointerState,
  readOverrideState,
  runtimeFailureSummary,
  writeCurrentPointer,
} from '@dsh-chamber/dsh-runtime'
import {
  fakePlane,
  makeValidTree,
  runtimeManager,
  writeOverrideRow,
} from '../support/runtime-routes-harness.ts'

function stateRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function runtimeDir(stateDir: string): string {
  const dir = join(stateDir, 'dsh-runtime')
  mkdirSync(dir, { recursive: true })
  return dir
}

test('corrupt override metadata fails every authority path closed and never rewrites the evidence', async () => {
  const stateDir = stateRoot('gw-rt-corrupt-override-')
  try {
    const dir = runtimeDir(stateDir)
    const file = join(dir, 'override.json')
    const corrupt = '{"shellVersion":'
    writeFileSync(file, corrupt, { mode: 0o600 })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane)

    const status = await manager.status()
    assert.match(status.startupBlockedReason ?? '', /override metadata is corrupt/)
    assert.equal(status.hasOverride, true, 'corrupt override is not "no override"')
    assert.equal(status.selectedVersion, null, 'no selection is invented from unreadable bytes')

    assert.throws(() => manager.resolveWorkspace(), /override metadata is corrupt/)
    await assert.rejects(manager.select('1.0.0'), /override metadata is corrupt/)
    await assert.rejects(manager.apply(), /override metadata is corrupt/)
    await assert.rejects(manager.rollback('1.0.0'), /override metadata is corrupt/)
    assert.throws(() => manager.applyNowPreflight(), /override metadata is corrupt/)
    await assert.rejects(manager.retryApply(), /override metadata is corrupt/)

    const lease = manager.beginProfileWrite()
    assert.equal(lease.ok, false, 'a profile write may not start over unreadable selection metadata')
    if (!lease.ok) {
      assert.equal(lease.code, 'runtime_recovery_required')
      assert.match(lease.error, /override metadata is corrupt/)
    }

    // The corrupt bytes are preserved as quarantine evidence and no fresh
    // override row was fabricated over them.
    assert.equal(existsSync(file), false, 'the corrupt leaf was quarantined, not overwritten')
    const evidence = readdirSync(dir).filter(name => name.startsWith('override.json.corrupt'))
    assert.equal(evidence.length, 1)
    assert.equal(readFileSync(join(dir, evidence[0]), 'utf8'), corrupt)
    assert.equal(readOverrideState(stateDir).kind, 'corrupt', 'the corrupt state stays durable for later boots')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('corrupt current pointer fails resolution and mutation closed without touching the bytes', async () => {
  const stateDir = stateRoot('gw-rt-corrupt-pointer-')
  try {
    const dir = runtimeDir(stateDir)
    makeValidTree(stateDir, '1.0.0')
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null })
    const pointerFile = join(dir, 'current')
    const corrupt = '{corrupt'
    writeFileSync(pointerFile, corrupt, { mode: 0o600 })
    const overrideBytes = readFileSync(join(dir, 'override.json'), 'utf8')
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane)

    const status = await manager.status()
    assert.match(status.startupBlockedReason ?? '', /current pointer is corrupt/)
    assert.equal(status.currentVersion, null)

    assert.throws(() => manager.resolveWorkspace(), /current pointer is corrupt/)
    await assert.rejects(manager.select('1.0.0'), /current pointer is corrupt/)
    await assert.rejects(manager.apply(), /current pointer is corrupt/)
    await assert.rejects(manager.rollback('1.0.0'), /current pointer is corrupt/)
    assert.throws(() => manager.applyNowPreflight(), /current pointer is corrupt/)

    assert.equal(readFileSync(pointerFile, 'utf8'), corrupt, 'the corrupt pointer evidence is untouched')
    assert.equal(
      readFileSync(join(dir, 'override.json'), 'utf8'),
      overrideBytes,
      'no override row is rewritten around a corrupt pointer',
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an unreadable failure ledger carries failureError instead of a fabricated zero', async () => {
  const stateDir = stateRoot('gw-rt-failures-unknown-')
  try {
    const dir = runtimeDir(stateDir)
    // A file where the failures directory belongs: readdirSync fails with
    // ENOTDIR — an unreadable set, not an empty one (chmod cannot block a root
    // reader, so this is the portable unknown fixture).
    writeFileSync(join(dir, 'failures'), 'not-a-directory', { mode: 0o600 })
    const manager = runtimeManager(stateDir, fakePlane())
    assert.equal(runtimeFailureSummary(stateDir).kind, 'unknown')

    const status = await manager.status()
    assert.equal(status.failure, null)
    assert.ok(status.failureError !== null && status.failureError.length > 0, 'the read failure is projected')
    assert.match(status.failureError ?? '', /ENOTDIR|runtime failures/)
    assert.equal(status.startupBlockedReason, null, 'the selection metadata itself is healthy')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a corrupt known-good ledger fails activation facts closed instead of reporting an empty trust set', () => {
  const stateDir = stateRoot('gw-rt-known-good-corrupt-')
  try {
    const dir = runtimeDir(stateDir)
    writeFileSync(join(dir, 'known-good.json'), '{corrupt', { mode: 0o600 })
    const manager = runtimeManager(stateDir, fakePlane())
    assert.throws(() => manager.activationFacts(), /known-good metadata is corrupt/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

test('unreadable selection metadata (EACCES) is never builtin or no-override', {
  skip: runningAsRoot ? 'requires a non-root POSIX host (chmod 000 must block the reader)' : false,
}, async () => {
  const stateDir = stateRoot('gw-rt-unknown-')
  try {
    const dir = runtimeDir(stateDir)
    makeValidTree(stateDir, '1.0.0')
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null })
    writeCurrentPointer(stateDir, '1.0.0')
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane)
    chmodSync(dir, 0o000)
    try {
      assert.equal(readCurrentPointerState(stateDir).kind, 'unknown')
      assert.equal(readOverrideState(stateDir).kind, 'unknown')

      const status = await manager.status()
      assert.match(status.startupBlockedReason ?? '', /unreadable/)
      assert.equal(status.source, null, 'unreadable authority never resolves to builtin')
      assert.throws(() => manager.resolveWorkspace(), /unreadable/)
      await assert.rejects(manager.select('1.0.0'), /unreadable/)
      const lease = manager.beginProfileWrite()
      assert.equal(lease.ok, false, 'a profile write is refused while selection metadata is unreadable')
    } finally {
      chmodSync(dir, 0o700)
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
