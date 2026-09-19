/**
 * openInstanceSession polling/deadline/supersede tests, split out of
 * shell.test.ts (05 §4 session-open path). Shared harness:
 * test/support/shell-harness.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __testEventLog, __testOpenedSessions, __testQueueRunGate, __testResetEventLog,
  __testResetLifecycle, __testSetChamberPrefetchError, __testSetSessionsAvailable,
  __testSetSessionsListed, __testSetSessionsOpenError, __testSetSessionsReadError,
  __testSetSessionsSnapshotError,
  bootInstanceShell, disposeAllShells, disposeInstanceShell, hostileThrownValue,
  openInstanceSession, shellModule, shellTestScope,
} from '../support/shell-harness.ts'

test('openInstanceSession: dispose immediately cancels an active list poll and it can never open later', async (t) => {
  const instanceId = 'ssh-test-dispatch-dispose-11'
  shellTestScope(t, { silentConsole: false }, instanceId)
  const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  __testSetSessionsListed(false)
  const opening = openInstanceSession(instanceId, 'appears-after-dispose')
  const rejected = assert.rejects(opening, /shell disposed/)

  disposeInstanceShell(instanceId)
  await rejected
  __testSetSessionsListed(true)
  t.mock.timers.tick(4_000)
  await Promise.resolve()
  assert.deepEqual(__testOpenedSessions(), [])
})

test('openInstanceSession: same-id replacement cancels the old holder poll while the new holder still opens', async (t) => {
  const instanceId = 'ssh-test-dispatch-replacement-12'
  shellTestScope(t, { silentConsole: false }, instanceId)
  const gen1State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(gen1State.booted, true)
  __testSetSessionsListed(false)
  const oldOpening = openInstanceSession(instanceId, 'old-holder-session')
  const oldRejected = assert.rejects(oldOpening, /shell replaced by a newer generation/)

  const gen2State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(gen2State.booted, true)
  await oldRejected

  __testSetSessionsListed(true)
  await openInstanceSession(instanceId, 'new-holder-session')
  t.mock.timers.tick(4_000)
  await Promise.resolve()
  assert.deepEqual(__testOpenedSessions(), [
    { label: 'entry-2', sessionId: 'new-holder-session' },
  ])
})

test('openInstanceSession: hostile delayed list/open throws reject instead of stranding the poll', async (t) => {
  const instanceId = 'ssh-test-dispatch-hostile-error'
  shellTestScope(t, { silentConsole: false }, instanceId)
  const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(state.booted, true)

  // First attempt schedules the 400ms poll. The external snapshot then throws
  // from the timer callback with a value that cannot itself be inspected.
  __testSetSessionsListed(false)
  const snapshotOpening = openInstanceSession(instanceId, 'snapshot-hostile')
  const snapshotRejected = assert.rejects(snapshotOpening, /unknown error/)
  __testSetSessionsSnapshotError(hostileThrownValue())
  t.mock.timers.tick(400)
  await snapshotRejected

  // Exercise the independent irreversible open boundary on a later timer
  // attempt; it must reject and clean up the holder-owned cancel handle too.
  __testSetSessionsSnapshotError(undefined)
  __testSetSessionsListed(false)
  const openOpening = openInstanceSession(instanceId, 'open-hostile')
  const openRejected = assert.rejects(openOpening, /unknown error/)
  __testSetSessionsListed(true)
  __testSetSessionsOpenError(hostileThrownValue())
  t.mock.timers.tick(400)
  await openRejected
  assert.deepEqual(__testOpenedSessions(), [])
})

test('disposeAllShells: active holder pollers reject and cannot reach sessions.open later', async (t) => {
  const instanceId = 'ssh-test-dispatch-dispose-all-13'
  shellTestScope(t, { silentConsole: false })
  const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  __testSetSessionsListed(false)
  const opening = openInstanceSession(instanceId, 'appears-after-dispose-all')
  const rejected = assert.rejects(opening, /all shells disposed/)

  disposeAllShells()
  await rejected
  __testSetSessionsListed(true)
  t.mock.timers.tick(4_000)
  await Promise.resolve()
  assert.deepEqual(__testOpenedSessions(), [])
})

test('openInstanceSession: a late boot flush keeps the original 68s total deadline', async (t) => {
  const instanceId = 'ssh-test-queued-total-deadline-14'
  shellTestScope(t, {}, instanceId)
  __testSetSessionsListed(false)
  const runGate = __testQueueRunGate('late-boot')
  let boot: ReturnType<typeof bootInstanceShell> | undefined
  let opening: Promise<void> | undefined
  try {
    opening = openInstanceSession(instanceId, 'never-listed-before-total-deadline')
    let settled = false
    void opening.then(() => { settled = true }, () => { settled = true })
    const rejected = assert.rejects(opening, /等待超时/)

    boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await runGate.started
    t.mock.timers.tick(67_900)
    runGate.release()
    const state = await boot
    assert.equal(state.booted, true)
    await Promise.resolve()
    assert.equal(settled, false)

    // Only 100ms remains from the enqueue-time 68s budget. flush must not
    // grant a new 8s window (nor even one full 400ms retry interval).
    t.mock.timers.tick(99)
    await Promise.resolve()
    assert.equal(settled, false)
    t.mock.timers.tick(1)
    await rejected
    assert.equal(settled, true)
    assert.deepEqual(__testOpenedSessions(), [])
  } finally {
    runGate.release()
    if (boot !== undefined) await boot
    if (opening !== undefined) await Promise.allSettled([opening])
  }
})

test('openInstanceSession: a direct dispatch whose sessions service registers after the first attempt still opens', async (t) => {
  const instanceId = 'ssh-test-service-late-direct'
  shellTestScope(t, { silentConsole: false }, instanceId)
  __testSetSessionsAvailable(false)
  const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  // The holder exists but the runtime sessions service is not registered
  // yet (boot settle waits only on root fibers). The open must stay pending
  // and poll, never fail on the first attempt.
  const opening = openInstanceSession(instanceId, 'late-service-session')
  let settled = false
  void opening.then(() => { settled = true }, () => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)

  __testSetSessionsAvailable(true)
  t.mock.timers.tick(400)
  await opening
  assert.deepEqual(__testOpenedSessions(), [
    { label: 'entry-1', sessionId: 'late-service-session' },
  ])
})

test('openInstanceSession: a queued open flushed before the sessions service registers polls instead of failing instantly', async (t) => {
  const instanceId = 'ssh-test-service-late-flush'
  shellTestScope(t, {}, instanceId)
  __testSetSessionsAvailable(false)
  let boot: ReturnType<typeof bootInstanceShell> | undefined
  let opening: Promise<void> | undefined
  try {
    // Cold-shell click: the open is queued while the boot is still gated, so
    // the flush (right after entries.set) is the first dispatch attempt.
    const runGate = __testQueueRunGate('slow-boot')
    opening = openInstanceSession(instanceId, 'flushed-before-service')
    let settled = false
    void opening.then(() => { settled = true }, () => { settled = true })
    boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await runGate.started
    runGate.release()
    const state = await boot
    assert.equal(state.booted, true)
    await Promise.resolve()
    assert.equal(settled, false)

    __testSetSessionsAvailable(true)
    t.mock.timers.tick(400)
    await opening
    assert.equal(settled, true)
    assert.deepEqual(__testOpenedSessions(), [
      { label: 'slow-boot', sessionId: 'flushed-before-service' },
    ])
  } finally {
    if (boot !== undefined) await Promise.allSettled([boot])
    if (opening !== undefined) await Promise.allSettled([opening])
  }
})

test('openInstanceSession: a sessions service that never registers fails loud at the deadline with the boot-readiness report', async (t) => {
  const instanceId = 'ssh-test-service-never-ready'
  shellTestScope(t, {}, instanceId)
  __testSetSessionsAvailable(false)
  const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  const opening = openInstanceSession(instanceId, 'never-ready-session')
  const rejected = assert.rejects(opening, /boot 未完全就绪/)
  let settled = false
  void opening.then(() => { settled = true }, () => { settled = true })
  await Promise.resolve()
  // Pins the fail-fast removal: pre-fix code rejected synchronously here,
  // so `settled` would already be true with the same terminal message.
  assert.equal(settled, false)

  // Still polling halfway through the 8s budget — the failure must land on
  // the dispatch's own deadline, not on the first attempt.
  t.mock.timers.tick(4_000)
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(4_001)
  await rejected
  assert.equal(settled, true)
  assert.deepEqual(__testOpenedSessions(), [])
})

test('openInstanceSession: disposing while the sessions service is still absent cancels the wait and nothing opens later', async (t) => {
  const instanceId = 'ssh-test-service-dispose-wait'
  shellTestScope(t, { silentConsole: false }, instanceId)
  __testSetSessionsAvailable(false)
  const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  const opening = openInstanceSession(instanceId, 'disposed-while-waiting')
  const rejected = assert.rejects(opening, /shell disposed/)

  disposeInstanceShell(instanceId)
  await rejected
  // The cancelled poller must not survive the holder: even a service that
  // arrives later must never reach sessions.open for the disposed shell.
  __testSetSessionsAvailable(true)
  t.mock.timers.tick(4_000)
  await Promise.resolve()
  assert.deepEqual(__testOpenedSessions(), [])
})

test('openInstanceSession: a throwing runtimeCtx read fails loud instantly (distinct from the transient undefined arm)', async (t) => {
  const instanceId = 'ssh-test-service-read-hostile'
  shellTestScope(t, {}, instanceId)
  __testSetSessionsReadError(hostileThrownValue())
  const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  // A throwing read is terminal on the first attempt (never-throw
  // descriptor); only an UNDEFINED read is the transient poll state.
  const opening = openInstanceSession(instanceId, 'read-hostile-session')
  const rejected = assert.rejects(opening, /unknown error/)
  await Promise.resolve()
  await rejected
  t.mock.timers.tick(4_000)
  await Promise.resolve()
  assert.deepEqual(__testOpenedSessions(), [])
})

test('openInstanceSession: a service that arrives after the first attempt but never lists the session reports 等待超时 at the deadline', async (t) => {
  const instanceId = 'ssh-test-service-late-never-listed'
  shellTestScope(t, {}, instanceId)
  __testSetSessionsAvailable(false)
  __testSetSessionsListed(false)
  const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  const opening = openInstanceSession(instanceId, 'late-service-never-listed')
  const rejected = assert.rejects(opening, /等待超时/)

  // Attempt 1 saw no service; from attempt 2 on the service exists (so the
  // boot-readiness report must NOT fire) but the session never surfaces.
  __testSetSessionsAvailable(true)
  t.mock.timers.tick(8_001)
  await rejected
  assert.deepEqual(__testOpenedSessions(), [])
})

// ── C3 gate (2026-09 性能审计): the chamber prefetch must fire before the
// extra-row channel is consulted, and its failure is swallowed by the shell
// gate (the loud path is run()'s create-side import; a boot with no extra
// rows never even reaches the gate's await). The fixture now returns the
// module-system face (manifest + prefetch) so these paths are exercised for
// real instead of degrading through a swallowed TypeError.
test('C3 gate: chamber prefetch fires after the module system install and before the boot settles', async (t) => {
  const instanceId = 'local'
  shellTestScope(t, { timers: false, silentConsole: false }, instanceId)
  __testResetEventLog()
  const state = await bootInstanceShell(instanceId, '/api/i/local', {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  const log = __testEventLog()
  assert.ok(log.includes('ensure'), `module system installed first (log: ${log.join(',')})`)
  const prefetchAt = log.indexOf('prefetch:@dsh-chamber/app')
  assert.ok(prefetchAt !== -1, `chamber prefetch fired (log: ${log.join(',')})`)
  assert.ok(prefetchAt > log.indexOf('ensure'), 'prefetch strictly after the module-system install')
})

test('C3 gate: a chamber prefetch rejection is swallowed — the boot still settles (loud owned by create-side import)', async (t) => {
  const instanceId = 'local'
  shellTestScope(t, { timers: false }, instanceId)
  __testResetEventLog()
  __testSetChamberPrefetchError(new Error('chamber bundle load failed'))
  const state = await bootInstanceShell(instanceId, '/api/i/local', {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  assert.ok(__testEventLog().includes('prefetch:@dsh-chamber/app'))
})

test('openInstanceSession: a request superseded by a newer one on the same source resolves quietly and never opens', async (t) => {
  // 2026-12 (design 05 §2.2 revision): per-source open requests are a
  // last-intent-wins stream, and the queued (cold-boot) path is where they can
  // actually race: both clicks land in the pending queue, the settle flush then
  // walks them in FIFO order. The boot-ctx early-open arm has already opened the
  // LATEST intent during boot, so dispatching the abandoned older request would
  // visibly flip the shell back (Y→X→Y). The dispatcher must drop it: resolve
  // quietly (it is not a failure — the row error surface belongs to the newest
  // request) and never call sessions.open for it.
  const instanceId = 'ssh-test-superseded-open'
  shellTestScope(t, { silentConsole: false }, instanceId)
  // Two clicks on a source that is still booting: both are queued.
  const stale = openInstanceSession(instanceId, 'session-X')
  const fresh = openInstanceSession(instanceId, 'session-Y')
  const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  await Promise.all([stale, fresh])
  // The flush dispatches the queue in order; X must be skipped and Y opened.
  // The extra tick proves no stray poller re-opens the abandoned session later.
  t.mock.timers.tick(1_000)
  assert.deepEqual(
    __testOpenedSessions(),
    [{ label: 'entry-1', sessionId: 'session-Y' }],
    'the superseded request must resolve without ever touching the runtime',
  )

  // A repeat of the CURRENT session stays openable (idempotent re-open): the
  // supersession check compares against the last request, not against an
  // "already opened once" marker.
  await openInstanceSession(instanceId, 'session-Y')
  assert.deepEqual(__testOpenedSessions(), [
    { label: 'entry-1', sessionId: 'session-Y' },
    { label: 'entry-1', sessionId: 'session-Y' },
  ])

  // With no newer request in play, a pre-boot queued open still dispatches:
  // the check must never swallow the FIRST request of a source.
  const third = openInstanceSession(instanceId, 'session-Z')
  await third
  assert.deepEqual(__testOpenedSessions().at(-1), { label: 'entry-1', sessionId: 'session-Z' })
})

test('openInstanceSession: the supersede record is PER SOURCE — an open on another source never swallows this one', async (t) => {
  // 2026-09-11 review F4(a): the supersede rule is "last intent wins WITHIN one
  // source" (design 05 §2.2 revision). A single page-wide "last requested
  // session" would make two different servers interfere: clicking a session on B
  // while A's cold-boot open is still queued would drop A's request silently at
  // its flush (no error, no row report — the user's click just does nothing).
  // Both requests are queued BEFORE either source boots, so the flush order is
  // the only thing the dispatcher sees and the cross-source mistake is visible.
  const sourceA = 'ssh-test-supersede-per-source-a'
  const sourceB = 'ssh-test-supersede-per-source-b'
  shellTestScope(t, { silentConsole: false })
  const openA = openInstanceSession(sourceA, 'session-AX')
  const openB = openInstanceSession(sourceB, 'session-BY')
  const stateA = await bootInstanceShell(sourceA, `/api/i/${sourceA}`, {} as HTMLElement, () => {})
  const stateB = await bootInstanceShell(sourceB, `/api/i/${sourceB}`, {} as HTMLElement, () => {})
  assert.equal(stateA.booted, true)
  assert.equal(stateB.booted, true)
  await Promise.all([openA, openB])
  t.mock.timers.tick(1_000)
  assert.deepEqual(
    __testOpenedSessions(),
    [
      { label: 'entry-1', sessionId: 'session-AX' },
      { label: 'entry-2', sessionId: 'session-BY' },
    ],
    'each source must open its OWN requested session; a shared record would drop A as "superseded" by B',
  )
})

test('openInstanceSession: the request record is dropped for a same-id re-add — the new incarnation is never judged superseded', async (t) => {
  // 2026-09-11 review F4(b): this is the invariant disposeInstanceShell's own
  // comment states ("a same-id re-add is a new generation, and its first open
  // must not be judged as superseded by the previous incarnation's last
  // request").
  //
  // The record is asserted DIRECTLY (`__testLastRequestedSession`), because the
  // behavior alone cannot see it: every dispatch follows the write of its own
  // request, so the re-added source's first open overwrites the leftover record
  // before the supersede check can compare it. A behavioral-only version of this
  // test passes with the retirement deleted (mutation-verified 2026-09-11) — it
  // would be a lock that proves nothing. The user-visible half (the re-added
  // source's first open still reaches the runtime) is asserted too.
  const instanceId = 'ssh-test-supersede-readd'
  shellTestScope(t, { silentConsole: false }, instanceId)
  const first = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(first.booted, true)
  await openInstanceSession(instanceId, 'session-X')
  assert.equal(
    shellModule.__testLastRequestedSession(instanceId),
    'session-X',
    'a live shell records the session it was asked to open',
  )
  assert.deepEqual(__testOpenedSessions(), [{ label: 'entry-1', sessionId: 'session-X' }])

  // The source leaves the registry and comes back under the SAME id.
  disposeInstanceShell(instanceId)
  assert.equal(
    shellModule.__testLastRequestedSession(instanceId),
    undefined,
    'the record retires with the source — the new incarnation must not inherit the old request',
  )
  const second = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
  assert.equal(second.booted, true)
  await openInstanceSession(instanceId, 'session-Y')
  assert.deepEqual(
    __testOpenedSessions(),
    [
      { label: 'entry-1', sessionId: 'session-X' },
      { label: 'entry-2', sessionId: 'session-Y' },
    ],
    'the re-added source’s first open must reach the runtime, never be judged against the previous incarnation',
  )
})
