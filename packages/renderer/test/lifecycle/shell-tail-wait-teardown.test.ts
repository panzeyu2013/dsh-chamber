/**
 * Same-id tail-wait cap and teardown-barrier tests, split out of
 * shell.test.ts (2026-12 复查 BLOCKER/MINOR + generation ownership).
 * Shared harness: test/support/shell-harness.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __testDisposedCount, __testEntryStates, __testOpenedSessions,
  __testQueueDisposeGate, __testQueueRunGate,
  __testResetDisposed, __testResetLifecycle,
  __testSetBootError, __testSetModuleSystemError, __testSetRunError,
  bootInstanceShell, disposeAllShells, disposeInstanceShell, INSTANCE_TAIL_WAIT_CAP_MS,
  openInstanceSession, shellModule, stubReadyGraph, stubWindow, tailWaitRemainingMs,
} from '../support/shell-harness.ts'

test('bootInstanceShell: a never-settling same-id predecessor stops pinning the id at the wait cap', async (t) => {
  // 2026-12 复查 BLOCKER：严格同 id 尾必须保留（它是 generation 记录的持有者），
  // 但"等待上一代"必须有绝对上限——否则一个 entry.run() 永不 settle 的 boot 会让
  // 该源此后每次重挂都卡住。上限 = 两个 boot 预算，低于 App 的放弃上限。
  const instanceId = 'ssh-test-tail-cap-9'
  __testResetLifecycle()
  const gen1Gate = __testQueueRunGate('gen1')
  const restoreFetch = stubReadyGraph(() => undefined)
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  let gen1Boot: ReturnType<typeof bootInstanceShell> | undefined
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  let gen2Gate: ReturnType<typeof __testQueueRunGate> | undefined
  t.mock.timers.enable({ apis: ['setTimeout'] })
  console.error = () => {}
  try {
    gen1Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await gen1Gate.started

    gen2Gate = __testQueueRunGate('gen2')
    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await Promise.resolve()
    // 上限之前：后继代仍严格等前代（不抢注册/teardown）。
    t.mock.timers.tick(INSTANCE_TAIL_WAIT_CAP_MS - 1)
    await Promise.resolve()
    // 上限到点：后继代放行，且迟到注册的前代被 generation 判为 superseded。
    t.mock.timers.tick(1)
    await gen2Gate.started
    assert.equal(__testEntryStates().filter(entry => entry.label === 'gen2').length, 1)
    gen2Gate.release()
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, true)

    // 迟到后继：同 id 尾已在上一代 settle 后释放，它必须立刻入队。
    // 绝对截止（共享，而非每个后继各等一个上限）由纯函数 tailWaitRemainingMs 单测
    // 钉住——时间敏感的一体化断言在这里观察不到（2026-12 复查 MINOR）。
    const lateGate = __testQueueRunGate('late')
    const lateBoot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await lateGate.started
    lateGate.release()
    const lateState = await lateBoot
    assert.equal(lateState.booted, true, 'a late successor joins without a fresh full cap')

    // 前代最终 settle 时不得覆盖后继（generation 阈值）。
    gen1Gate.release()
    const gen1State = await gen1Boot
    assert.equal(gen1State.booted, false)
    assert.match(gen1State.error ?? '', /superseded/)
    // 每个新代都会退役上一代（同 id 前驱），最终只有最新一代存活。
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: true },
      { label: 'gen2', disposed: true },
      { label: 'late', disposed: false },
    ])
  } finally {
    gen1Gate.release()
    gen2Gate?.release()
    restoreFetch()
    restoreWindow()
    console.error = originalConsoleError
    disposeAllShells()
    __testResetLifecycle()
  }
})

test('tailWaitRemainingMs: all successors share one absolute deadline', () => {
  // 2026-12 复查 MINOR：时间敏感的一体化断言观察不到"共享截止"，这里用纯函数钉住
  // 语义——已过期的截止必须立刻放行（0），未给截止才退回一个完整上限。
  assert.equal(tailWaitRemainingMs(undefined, 1_000), INSTANCE_TAIL_WAIT_CAP_MS)
  assert.equal(tailWaitRemainingMs(1_000 + INSTANCE_TAIL_WAIT_CAP_MS, 1_000), INSTANCE_TAIL_WAIT_CAP_MS)
  assert.equal(tailWaitRemainingMs(1_000 + INSTANCE_TAIL_WAIT_CAP_MS - 1, 1_000), INSTANCE_TAIL_WAIT_CAP_MS - 1)
  assert.equal(tailWaitRemainingMs(1_000, 1_000), 0, 'an expired deadline joins immediately')
  assert.equal(tailWaitRemainingMs(500, 1_000), 0, 'a long-expired deadline joins immediately')
})

test('bootInstanceShell: timeout releases a different id while same-id gen2 waits for gen1 teardown', async (t) => {
  const instanceId = 'ssh-test-same-id-late-settle-8'
  const otherId = 'ssh-test-timeout-other-id-8'
  const graphFetches: string[] = []
  const restoreFetch = stubReadyGraph(url => { graphFetches.push(url) })
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  const gen1Gate = __testQueueRunGate('gen1')
  let gen1Boot: ReturnType<typeof bootInstanceShell> | undefined
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  let otherBoot: ReturnType<typeof bootInstanceShell> | undefined
  let otherGate: ReturnType<typeof __testQueueRunGate> | undefined
  let gen2Gate: ReturnType<typeof __testQueueRunGate> | undefined
  let gen1DisposeGate: ReturnType<typeof __testQueueDisposeGate> | undefined
  t.mock.timers.enable({ apis: ['setTimeout'] })
  console.error = () => {}
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  try {
    gen1Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await gen1Gate.started

    // Registry removal cancels gen1 while it is hung. Re-adding the same id
    // creates gen2, but it must remain behind gen1's strict per-id tail.
    disposeInstanceShell(instanceId)
    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await Promise.resolve()
    assert.equal(
      graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length,
      1,
      'same-id gen2 must not start graph/bundle preloading while gen1 owns the instance tail',
    )

    // A different id queues after gen2. Because gen2 does not claim a global
    // slot while waiting on its same-id predecessor, gen1's 60s timeout must
    // release this unrelated boot immediately.
    otherGate = __testQueueRunGate('other-id')
    otherBoot = bootInstanceShell(otherId, `/api/i/${otherId}`, {} as HTMLElement, () => {})
    t.mock.timers.tick(60_000)
    await Promise.resolve()
    await otherGate.started
    assert.equal(graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length, 1)
    assert.equal(graphFetches.filter(url => url.includes(`/api/i/${otherId}/`)).length, 1)
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: false },
      { label: 'other-id', disposed: false },
    ])
    otherGate.release()
    const otherState = await otherBoot
    assert.equal(otherState.booted, true)

    // Even after the timeout, gen2 must not construct until gen1 settles AND
    // its async disposer completes. This removes both producer registration
    // inversion and two-React-roots-on-one-container races at the source.
    gen1DisposeGate = __testQueueDisposeGate()
    gen2Gate = __testQueueRunGate('gen2')
    gen1Gate.release()
    assert.equal(await gen1DisposeGate.started, 'gen1')
    await Promise.resolve()
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: true },
      { label: 'other-id', disposed: false },
    ])
    gen1DisposeGate.release()
    const gen1State = await gen1Boot
    assert.equal(gen1State.booted, false)
    assert.match(gen1State.error ?? '', /shell boot superseded by generation 2/)
    await gen2Gate.started
    assert.equal(
      graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length,
      2,
      'gen2 may preload only after gen1 settle and teardown release its strict tail',
    )
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: true },
      { label: 'other-id', disposed: false },
      { label: 'gen2', disposed: false },
    ])
    assert.equal(__testDisposedCount(), 1)
    gen2Gate.release()
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, true)
    await openInstanceSession(instanceId, 'after-gen2')
    assert.deepEqual(__testOpenedSessions(), [
      { label: 'gen2', sessionId: 'after-gen2' },
    ])

    // The replacement remains the one live holder until the registry removes
    // it; final disposal releases that resource as well.
    disposeInstanceShell(instanceId)
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: true },
      { label: 'other-id', disposed: false },
      { label: 'gen2', disposed: true },
    ])
    assert.equal(__testDisposedCount(), 2)
    disposeInstanceShell(otherId)
    assert.equal(__testDisposedCount(), 3)
  } finally {
    gen1Gate.release()
    otherGate?.release()
    gen2Gate?.release()
    gen1DisposeGate?.release()
    await Promise.allSettled([
      ...(gen1Boot === undefined ? [] : [gen1Boot]),
      ...(gen2Boot === undefined ? [] : [gen2Boot]),
      ...(otherBoot === undefined ? [] : [otherBoot]),
    ])
    disposeInstanceShell(instanceId)
    disposeInstanceShell(otherId)
    __testResetLifecycle()
    t.mock.timers.reset()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('disposeInstanceShell: a live holder records and cancels a newer same-id queued generation', async () => {
  const instanceId = 'ssh-test-live-holder-cancels-inflight-9'
  const blockerId = 'ssh-test-live-holder-blocker-9'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  console.error = () => {}
  let blockerGate: ReturnType<typeof __testQueueRunGate> | undefined
  let blockerBoot: ReturnType<typeof bootInstanceShell> | undefined
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  try {
    const gen1State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(gen1State.booted, true)

    // Hold the page-global queue on another source so gen2 has acquired its
    // generation number but has not yet retired the still-live gen1 holder.
    blockerGate = __testQueueRunGate('other-source-blocker')
    blockerBoot = bootInstanceShell(blockerId, `/api/i/${blockerId}`, {} as HTMLElement, () => {})
    await blockerGate.started
    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    // A holder exists (gen1), while bootGenerations already points at queued
    // gen2. The disposal threshold must record gen2 before releasing gen1.
    disposeInstanceShell(instanceId)
    blockerGate.release()
    const blockerState = await blockerBoot
    assert.equal(blockerState.booted, true)
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, false)
    assert.equal(gen2State.error, 'shell disposed (instance left ready)')
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'other-source-blocker', disposed: false },
    ])
    assert.equal(__testDisposedCount(), 1)
  } finally {
    blockerGate?.release()
    if (blockerBoot !== undefined) await blockerBoot
    if (gen2Boot !== undefined) await gen2Boot
    disposeInstanceShell(instanceId)
    disposeInstanceShell(blockerId)
    __testResetLifecycle()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: registering a newer same-id generation awaits displaced-holder teardown', async () => {
  const instanceId = 'ssh-test-same-id-holder-replacement-10'
  const graphFetches: string[] = []
  const restoreFetch = stubReadyGraph(url => { graphFetches.push(url) })
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  const disposeGate = __testQueueDisposeGate()
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  try {
    const gen1State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(gen1State.booted, true)
    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(await disposeGate.started, 'entry-1')
    await Promise.resolve()
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
    ], 'gen2 must not even be constructed while gen1 teardown is pending')
    assert.equal(
      graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length,
      1,
      'gen2 must not start graph/bundle preloading before the displaced holder tears down',
    )

    disposeGate.release()
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, true)
    assert.equal(graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length, 2)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'entry-2', disposed: false },
    ])
    assert.equal(__testDisposedCount(), 1)
    await openInstanceSession(instanceId, 'new-holder-session')
    assert.deepEqual(__testOpenedSessions(), [
      { label: 'entry-2', sessionId: 'new-holder-session' },
    ])

    disposeInstanceShell(instanceId)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'entry-2', disposed: true },
    ])
    assert.equal(__testDisposedCount(), 2)
  } finally {
    disposeGate.release()
    if (gen2Boot !== undefined) await gen2Boot
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: remove then re-add awaits the removed holder async teardown', async () => {
  const instanceId = 'ssh-test-remove-readd-teardown-10b'
  const graphFetches: string[] = []
  const restoreFetch = stubReadyGraph(url => { graphFetches.push(url) })
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  const disposeGate = __testQueueDisposeGate()
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  try {
    const gen1State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(gen1State.booted, true)
    disposeInstanceShell(instanceId)
    assert.equal(await disposeGate.started, 'entry-1')

    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    let gen2Settled = false
    void gen2Boot.then(() => { gen2Settled = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(gen2Settled, false)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
    ])
    assert.equal(
      graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length,
      1,
      're-added generation must not preload while the removed holder is still disposing',
    )

    disposeGate.release()
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, true)
    assert.equal(graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length, 2)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'entry-2', disposed: false },
    ])
  } finally {
    disposeGate.release()
    if (gen2Boot !== undefined) await gen2Boot
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: one source teardown barrier does not block a different source', async () => {
  const blockedId = 'ssh-test-teardown-isolation-a'
  const otherId = 'ssh-test-teardown-isolation-b'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  const disposeGate = __testQueueDisposeGate()
  try {
    const first = await bootInstanceShell(blockedId, `/api/i/${blockedId}`, {} as HTMLElement, () => {})
    assert.equal(first.booted, true)
    disposeInstanceShell(blockedId)
    assert.equal(await disposeGate.started, 'entry-1')

    // blockedId's disposer is still pending; otherId owns a distinct barrier.
    const other = await bootInstanceShell(otherId, `/api/i/${otherId}`, {} as HTMLElement, () => {})
    assert.equal(other.booted, true)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'entry-2', disposed: false },
    ])
  } finally {
    disposeGate.release()
    disposeInstanceShell(blockedId)
    disposeInstanceShell(otherId)
    __testResetLifecycle()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: async teardown rejection is loud but cannot wedge same-id re-add', async () => {
  const instanceId = 'ssh-test-teardown-rejection-contained'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  const errors: unknown[][] = []
  __testResetLifecycle()
  const disposeGate = __testQueueDisposeGate()
  console.error = (...args: unknown[]) => { errors.push(args) }
  let readd: ReturnType<typeof bootInstanceShell> | undefined
  try {
    const first = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(first.booted, true)
    disposeInstanceShell(instanceId)
    assert.equal(await disposeGate.started, 'entry-1')

    readd = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    disposeGate.fail(new Error('fixture dispose exploded'))
    const second = await readd
    assert.equal(second.booted, true)
    assert.ok(errors.some(args => String(args[0]).includes('async dispose') && String(args[1]).includes('fixture dispose exploded')))
  } finally {
    disposeGate.release()
    if (readd !== undefined) await readd
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('shell lifecycle owners are reclaimed after churn without an old cleanup erasing a same-id re-add', async () => {
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  const waitForOwnerCounts = async (bootGenerations: number, cancelledBoots: number): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const counts = shellModule.__testShellLifecycleOwnerCounts()
      if (counts.bootGenerations === bootGenerations && counts.cancelledBoots === cancelledBoots) return
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.deepEqual(shellModule.__testShellLifecycleOwnerCounts(), { bootGenerations, cancelledBoots })
  }
  const instanceId = 'ssh-test-owner-readd'
  let disposeGate: ReturnType<typeof __testQueueDisposeGate> | undefined
  let replacement: ReturnType<typeof bootInstanceShell> | undefined
  try {
    // Clear holders intentionally retained by earlier shell tests, then pin
    // the storage seam at an empty baseline before exercising reclamation.
    disposeAllShells()
    await waitForOwnerCounts(0, 0)
    disposeGate = __testQueueDisposeGate()

    const first = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(first.booted, true)
    assert.deepEqual(shellModule.__testShellLifecycleOwnerCounts(), { bootGenerations: 1, cancelledBoots: 0 })

    disposeInstanceShell(instanceId)
    assert.equal(await disposeGate.started, 'entry-1')
    replacement = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(
      shellModule.__testShellLifecycleOwnerCounts(),
      { bootGenerations: 1, cancelledBoots: 1 },
      'the old teardown cleanup must retain the current same-id generation and its cancellation barrier',
    )

    disposeGate.release()
    const second = await replacement
    assert.equal(second.booted, true)
    assert.deepEqual(
      shellModule.__testShellLifecycleOwnerCounts(),
      { bootGenerations: 1, cancelledBoots: 0 },
      'the replacement remains owned while its entry is live',
    )
    disposeInstanceShell(instanceId)
    await waitForOwnerCounts(0, 0)

    for (let index = 0; index < 64; index += 1) {
      const churnId = `ssh-test-owner-churn-${index}`
      const state = await bootInstanceShell(churnId, `/api/i/${churnId}`, {} as HTMLElement, () => {})
      assert.equal(state.booted, true)
      disposeInstanceShell(churnId)
    }
    await waitForOwnerCounts(0, 0)
  } finally {
    disposeGate?.release()
    if (replacement !== undefined) await replacement
    disposeInstanceShell(instanceId)
    disposeAllShells()
    __testResetLifecycle()
    restoreFetch()
    restoreWindow()
  }
})

