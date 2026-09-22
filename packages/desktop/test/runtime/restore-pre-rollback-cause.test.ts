/**
 * shell-ipc-runtime RUNTIME_RESTORE_PRE_ROLLBACK — the restore catch path
 * (B1 §2.6): a restore that THROWS leaves restoreResult.outcome at 'blocked'
 * while recording the cause. That MUST reach the error branch (restart +
 * throw the diagnostic) instead of resolving silently through the
 * fence-refused no-op branch.
 *
 * Driven through the registered IPC handler with a real dsh-runtime restore
 * core over a temp state dir: the stash listing accepts the fixture, but the
 * transaction cannot create its staging dir (the DSH_HOME parent is absent),
 * so requireOutcome throws with the report cause attached — exactly the
 * 'blocked + cause' shape the handler's catch records.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../ipc-events.ts'
import { registerRuntimeHandlersC } from '../../shell-ipc-runtime.ts'

/** A stash-shaped basename (13-digit epoch + 8 hex, the only accepted form). */
const STASH_NAME = '1700000000000-deadbeef'

test('restore-pre-rollback: a thrown restore with a cause reaches the error branch (blocked + cause, never a silent no-op)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-pre-rollback-cause-'))
  const runtimeBaseDir = join(root, 'state')
  // The DSH_HOME parent deliberately does NOT exist: the restore transaction
  // begins (marker written) but fails when it must create the staging dir, so
  // restorePreRollback throws with the RestoreReport cause attached.
  const localDshHome = join(root, 'missing-parent', 'dsh-home')
  try {
    await mkdir(join(runtimeBaseDir, 'dsh-runtime', 'pre-rollback', STASH_NAME), { recursive: true })
    await writeFile(join(runtimeBaseDir, 'dsh-runtime', 'pre-rollback', STASH_NAME, 'payload.txt'), 'stash\n')

    const calls = { stop: 0, startup: 0, blockedStartup: 0, begin: 0, end: 0, released: 0 }
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>()
    const ctx = {
      deps: {
        ipc: {
          handle(channel: string, handler: (args: unknown) => Promise<unknown>) { handlers.set(channel, handler) },
        },
        ctx: {
          authoritativeMetadataRecoveryStatus: () => null,
          bundledRuntimeVersion: '0.1.1-rc.2',
          localDshHome,
          publishBlockedStartup: async () => { calls.blockedStartup += 1 },
          readApplyNowGateInput: () => ({ ok: false }),
          refreshRuntimeEvidence: async () => undefined,
          runRuntimeStartup: async () => { calls.startup += 1 },
          runUserMetadataRecovery: async () => null,
          runtimeActionAllowed: () => true,
          runtimeBaseDir,
          runtimeController: { getState: () => ({ marker: 'runtime-state' }) },
          runtimeOperationBusy: () => false,
          runtimeOperationSlot: {
            begin: () => { calls.begin += 1 },
            end: () => { calls.end += 1 },
            inFlight: () => null,
          },
          runtimeWriterFence: {
            busy: false,
            tryAcquire: () => ({ release: () => { calls.released += 1 } }),
          },
          selectedJournalIntent: () => null,
          setRuntimeGate: () => undefined,
          stopLocalDsh: async () => { calls.stop += 1 },
        },
      },
      confirmRuntimeMutation: async () => true,
      quittingLeaf: () => false,
    }
    registerRuntimeHandlersC(ctx as unknown as Parameters<typeof registerRuntimeHandlersC>[0])
    const handler = handlers.get(IPC_CHANNELS.RUNTIME_RESTORE_PRE_ROLLBACK)
    assert.ok(handler !== undefined, 'the pre-rollback restore handler is registered')

    await assert.rejects(
      () => handler({ stashName: STASH_NAME }),
      /恢复回滚前数据失败：/,
      'a thrown restore must surface as the persistent action error, not resolve silently',
    )
    assert.ok(calls.stop >= 1, 'the catch stops the local instance before the restart')
    assert.equal(calls.startup, 1, 'the error branch restarts the instance before reporting')
    assert.equal(calls.blockedStartup, 0, 'the blocked+cause path is NOT the half/blocked-startup branch')
    assert.equal(calls.released, 1, 'the writer fence lease is always released')
    assert.deepEqual([calls.begin, calls.end], [1, 1], 'the runtime operation slot is always cleared')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore-pre-rollback: the fence-refused no-op (nothing recorded) still resolves without restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-pre-rollback-nofence-'))
  try {
    const calls = { stop: 0, startup: 0, released: 0 }
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>()
    const ctx = {
      deps: {
        ipc: { handle(channel: string, handler: (args: unknown) => Promise<unknown>) { handlers.set(channel, handler) } },
        ctx: {
          authoritativeMetadataRecoveryStatus: () => null,
          bundledRuntimeVersion: '0.1.1-rc.2',
          localDshHome: join(root, 'dsh-home'),
          publishBlockedStartup: async () => undefined,
          readApplyNowGateInput: () => ({ ok: false }),
          refreshRuntimeEvidence: async () => undefined,
          runRuntimeStartup: async () => { calls.startup += 1 },
          runUserMetadataRecovery: async () => null,
          runtimeActionAllowed: () => true,
          runtimeBaseDir: root,
          runtimeController: { getState: () => ({ marker: 'runtime-state' }) },
          runtimeOperationBusy: () => false,
          runtimeOperationSlot: { begin: () => undefined, end: () => undefined, inFlight: () => null },
          // A concurrent writer holds the fence → tryAcquire refuses.
          runtimeWriterFence: { busy: true, tryAcquire: () => null },
          selectedJournalIntent: () => null,
          setRuntimeGate: () => undefined,
          stopLocalDsh: async () => { calls.stop += 1 },
        },
      },
      confirmRuntimeMutation: async () => true,
      quittingLeaf: () => false,
    }
    registerRuntimeHandlersC(ctx as unknown as Parameters<typeof registerRuntimeHandlersC>[0])
    const handler = handlers.get(IPC_CHANNELS.RUNTIME_RESTORE_PRE_ROLLBACK)
    assert.ok(handler !== undefined)
    const result = await handler({ stashName: STASH_NAME })
    assert.deepEqual(result, { marker: 'runtime-state' })
    assert.deepEqual({ stop: calls.stop, startup: calls.startup }, { stop: 0, startup: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
