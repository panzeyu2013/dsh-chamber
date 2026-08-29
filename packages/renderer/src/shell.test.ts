/**
 * shell.ts boot-failure tests (05 §4 failure-presentation revision + 2026-08
 * first-boot race fix).
 *
 * The renderer has no install-tree copy of the dsh workspace packages, so
 * `@deepseek-ai/dsh-client-web` is mapped by `scripts/test-shell-loader.mjs`
 * (registered via `--import scripts/test-shell-register.mjs`, see the
 * test:renderer-shell script) to the committed fixture
 * `test-fixtures/dsh-client-web.mjs`, whose AppWebEntry reports a controlled
 * `bootError` through the test knobs. The host-graph channel is stubbed to 503
 * `instance_unavailable` (no bundle preloads, no DOM needed).
 *
 * Covered: the resolved-but-failed boot (run() resolves, bootError set → the
 * chamber sees a failure and disposes the failed entry so a retry re-boots
 * cleanly), the clean settle, and the legacy run()-rejection path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge } from '../../dsh-chamber-client-ui-sidebar/src/shared/aggregate-store.ts'

// Test knobs — same module instance shell.ts sees (the loader maps the bare
// specifier to this URL; the relative import resolves to the same file).
import {
  __testConfiguredContexts, __testDisposedCount, __testEventLog,
  __testEntryStates, __testOpenedSessions, __testQueueDisposeGate, __testQueueRunGate,
  __testResetConfiguredContexts, __testResetDisposed, __testResetEventLog,
  __testResetLifecycle, __testSetSessionsListed, __testSetSessionsOpenError,
  __testSetSessionsSnapshotError,
  __testSetBootError, __testSetModuleSystemError, __testSetRunError,
} from '../test-fixtures/dsh-client-web.mjs'

const shellModule = await import('./shell.ts')
const {
  disposeAllShells, disposeInstanceShell, openInstanceSession,
} = shellModule

const testSourceFingerprint = (instanceId: string): string => instanceId === 'local'
  ? 'local'
  : 'ab'.repeat(32)
const createChamberContextSetup = (instanceId: string, basePath: string, sourceFingerprint = testSourceFingerprint(instanceId)) =>
  shellModule.createChamberContextSetup(instanceId, basePath, sourceFingerprint)
const bootInstanceShell = (
  instanceId: string,
  basePath: string,
  el: HTMLElement,
  onState: Parameters<typeof shellModule.bootInstanceShell>[3],
) => shellModule.bootInstanceShell(instanceId, basePath, el, onState, testSourceFingerprint(instanceId))

// ── Plumbing ───────────────────────────────────────────────────────────────

/** Host-graph channel resolves 503 instance_unavailable (expected pre-ready; no bundle preloads). */
function stubUnavailableGraph(onFetch?: () => void): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    onFetch?.()
    return new Response(
      JSON.stringify({ code: 'instance_unavailable', error: 'instance not ready' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** Host graph is ready immediately with no extra plugin rows. */
function stubReadyGraph(onFetch?: (url: string) => void): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input) => {
    onFetch?.(String(input))
    return new Response(JSON.stringify({
      rpcId: 'shell-generation-test',
      result: { ok: true, value: { rev: 'empty', entries: [] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** Mirror the browser's `window === globalThis` relationship for renderer code. */
function stubWindow(): () => void {
  const g = globalThis as Record<string, unknown>
  const original = g.window
  g.window = globalThis
  return () => {
    if (original === undefined) delete g.window
    else g.window = original
  }
}

/** Thrown value whose Error test and String conversion both throw. This is a
 * realistic hostile plugin/runtime boundary: catch blocks must not assume the
 * caught value is safely inspectable. */
function hostileThrownValue(): unknown {
  return new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      throw new Error('hostile getPrototypeOf trap')
    },
    get(_target, property) {
      if (property === Symbol.toPrimitive || property === 'toString' || property === 'valueOf') {
        throw new Error('hostile string conversion trap')
      }
      return undefined
    },
  })
}

test('bootInstanceShell: a resolved-but-failed run (bootError set) settles as a failure and disposes the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError('client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table')
  __testSetRunError(undefined)
  try {
    const state = await bootInstanceShell('ssh-test-fail-1', '/api/i/ssh-test-fail-1', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table')
    // The failed entry was disposed: a retry re-boots the container cleanly
    // (no duplicate React root / zombie ctx).
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetBootError(undefined)
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a clean run settles booted with no error and keeps the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testResetConfiguredContexts()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  try {
    const state = await bootInstanceShell('ssh-test-clean-2', '/api/i/ssh-test-clean-2', {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    assert.equal(state.error, null)
    assert.equal(__testDisposedCount(), 0)
    assert.deepEqual(__testConfiguredContexts(), [{
      chamberInstanceId: 'ssh-test-clean-2',
      chamberBasePath: '/api/i/ssh-test-clean-2',
      chamberSourceFingerprint: testSourceFingerprint('ssh-test-clean-2'),
      chamberTransport: 'ssh',
    }])
  } finally {
    __testResetConfiguredContexts()
    restoreFetch()
    restoreWindow()
  }
})

test('createChamberContextSetup: immutable entry facts cannot cross when boots activate out of order', () => {
  const capture = (): { facts: Record<string, unknown>; ctx: { provide(name: string, value?: unknown): () => void } } => {
    const facts: Record<string, unknown> = {}
    return {
      facts,
      ctx: {
        provide(name, value) {
          facts[name] = value
          return () => {}
        },
      },
    }
  }
  const configureA = createChamberContextSetup('ssh-instance-a', '/api/i/ssh-instance-a')
  const configureB = createChamberContextSetup('ssh-instance-b', '/api/i/ssh-instance-b')
  const a = capture()
  const b = capture()

  // Model the original failure window: B starts after the queue timeout, then
  // A resumes late. Each closure must still install only its own facts.
  configureB(b.ctx)
  configureA(a.ctx)
  assert.deepEqual(a.facts, {
    chamberInstanceId: 'ssh-instance-a',
    chamberBasePath: '/api/i/ssh-instance-a',
    chamberSourceFingerprint: testSourceFingerprint('ssh-instance-a'),
    chamberTransport: 'ssh',
  })
  assert.deepEqual(b.facts, {
    chamberInstanceId: 'ssh-instance-b',
    chamberBasePath: '/api/i/ssh-instance-b',
    chamberSourceFingerprint: testSourceFingerprint('ssh-instance-b'),
    chamberTransport: 'ssh',
  })
  assert.throws(() => createChamberContextSetup(' ', '/api/i/ '), /empty instance id/)
  for (const sourceId of [
    'remote-1', 'ssh-', 'ssh-local', 'ssh-bad/id', 'ssh-a.b', `ssh-${'a'.repeat(65)}`,
  ]) {
    assert.throws(
      () => createChamberContextSetup(sourceId, `/api/i/${sourceId}`),
      /invalid instance id/,
      `expected ${sourceId} to be rejected`,
    )
  }
  assert.doesNotThrow(() => createChamberContextSetup('local', '/api/i/local'))
  assert.doesNotThrow(() => createChamberContextSetup('ssh-dev_01', '/api/i/ssh-dev_01'))
  assert.doesNotThrow(() => createChamberContextSetup(`ssh-${'a'.repeat(64)}`, `/api/i/ssh-${'a'.repeat(64)}`))
  assert.throws(
    () => createChamberContextSetup('ssh-dev_01', '/api/i/ssh-dev_01', 'A'.repeat(64)),
    /invalid source fingerprint/,
  )
  assert.throws(
    () => createChamberContextSetup('local', '/api/i/local', 'not-local'),
    /invalid source fingerprint/,
  )
  assert.throws(
    () => createChamberContextSetup('ssh-instance-a', '/api/i/ssh-instance-b'),
    /instance\/base-path mismatch/,
  )
})

test('bootInstanceShell: rejects an invalid source before any host-graph request', () => {
  let fetched = false
  const restoreFetch = stubUnavailableGraph(() => { fetched = true })
  try {
    assert.throws(
      () => bootInstanceShell('ssh-local', '/api/i/ssh-local', {} as HTMLElement, () => {}),
      /invalid instance id/,
    )
    assert.equal(fetched, false)
  } finally {
    restoreFetch()
  }
})

test('bootInstanceShell: a throwing run settles as a failure (legacy rejection path) and disposes the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(new Error('loader exploded'))
  try {
    const state = await bootInstanceShell('ssh-test-throw-3', '/api/i/ssh-test-throw-3', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'loader exploded')
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetRunError(undefined)
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a hostile thrown value still settles as a contained failure', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  const hostile = hostileThrownValue()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetModuleSystemError(hostile)
  __testSetRunError(hostile)
  try {
    const state = await bootInstanceShell(
      'ssh-test-hostile-boot',
      '/api/i/ssh-test-hostile-boot',
      {} as HTMLElement,
      () => {},
    )
    assert.equal(state.booted, false)
    assert.equal(state.error, 'unknown error')
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetModuleSystemError(undefined)
    __testSetRunError(undefined)
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: installs the module system BEFORE any host-graph fetch (first-boot race fix)', async () => {
  // The race: an extra bundle's script evaluates at load and registers its
  // factory through the __ModuleLoader__ sink, so the sink must exist before
  // the host-graph channel is even contacted (collectExtraRows's first step is
  // the graph fetch; bundle scripts are only appended after it resolves).
  const restoreFetch = stubUnavailableGraph(() => { __testEventLog().push('fetch') })
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testResetEventLog()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  try {
    const state = await bootInstanceShell('ssh-test-order-5', '/api/i/ssh-test-order-5', {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    // The fixture's ensureWebModuleSystem records 'ensure' synchronously at
    // bootInstanceShell entry; the fetch is collectExtraRows's first step.
    // collectExtraRows now retries the pre-ready 503 on a bounded budget, so
    // the event log carries repeated 'fetch' entries — the invariant under
    // test is the ORDER (module system installed before the FIRST fetch).
    const events = __testEventLog()
    assert.deepEqual(events.slice(0, 2), ['ensure', 'fetch'])
  } finally {
    __testResetEventLog()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a module-system install failure skips the host-graph channel and settles with the same error', async () => {
  // Malformed/missing boot manifest: ensureWebModuleSystem throws → the extras
  // preload is skipped (no sink ⇒ no bundle must execute) and run() rethrows
  // the same parse error (simulated here via the run knob with the same text).
  const restoreFetch = stubUnavailableGraph(() => { __testEventLog().push('fetch') })
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testResetEventLog()
  __testSetBootError(undefined)
  __testSetModuleSystemError(new Error('missing boot manifest'))
  __testSetRunError(new Error('missing boot manifest'))
  try {
    const state = await bootInstanceShell('ssh-test-manifest-6', '/api/i/ssh-test-manifest-6', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'missing boot manifest')
    // No host-graph fetch at all: with no sink, no bundle may be requested.
    assert.deepEqual(__testEventLog(), ['ensure'])
    // The entry was constructed and disposed via the run()-rejection path.
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetModuleSystemError(undefined)
    __testSetRunError(undefined)
    __testResetEventLog()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a cancelled generation cannot overwrite the retry plugin diagnostic', async () => {
  const sourceId = 'ssh-test-diagnostic-generation-7'
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  const restoreWindow = stubWindow()
  let releaseFirst!: () => void
  let calls = 0
  globalThis.fetch = (() => {
    calls += 1
    if (calls === 1) {
      return new Promise<Response>(resolve => {
        releaseFirst = () => resolve(new Response('{}', { status: 404 }))
      })
    }
    return Promise.resolve(new Response(JSON.stringify({
      rpcId: 'retry', result: { ok: true, value: { entries: [] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
  console.error = () => {}
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  const states: string[] = []
  const unsubscribe = chamberBridge.onPluginDiagnostic((id, diagnostic) => {
    if (id === sourceId && diagnostic !== undefined) states.push(diagnostic.state)
  })
  try {
    const first = bootInstanceShell(sourceId, `/api/i/${sourceId}`, {} as HTMLElement, () => {})
    disposeInstanceShell(sourceId)
    const retry = bootInstanceShell(sourceId, `/api/i/${sourceId}`, {} as HTMLElement, () => {})
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(states, [], 'same-id retry must defer its graph probe until the predecessor settles')
    releaseFirst()
    await Promise.all([first, retry])
    assert.deepEqual(states, ['ok'], 'the cancelled slow boot must not publish its late not-injected state')
  } finally {
    unsubscribe()
    chamberBridge.clearPluginDiagnostic(sourceId)
    disposeInstanceShell(sourceId)
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
    restoreWindow()
  }
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

test('openInstanceSession: dispose immediately cancels an active list poll and it can never open later', async (t) => {
  const instanceId = 'ssh-test-dispatch-dispose-11'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
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
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: same-id replacement cancels the old holder poll while the new holder still opens', async (t) => {
  const instanceId = 'ssh-test-dispatch-replacement-12'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
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
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: hostile delayed list/open throws reject instead of stranding the poll', async (t) => {
  const instanceId = 'ssh-test-dispatch-hostile-error'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
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
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('disposeAllShells: active holder pollers reject and cannot reach sessions.open later', async (t) => {
  const instanceId = 'ssh-test-dispatch-dispose-all-13'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
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
  } finally {
    disposeAllShells()
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: a late boot flush keeps the original 68s total deadline', async (t) => {
  const instanceId = 'ssh-test-queued-total-deadline-14'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  __testSetSessionsListed(false)
  const runGate = __testQueueRunGate('late-boot')
  let boot: ReturnType<typeof bootInstanceShell> | undefined
  let opening: Promise<void> | undefined
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  console.error = () => {}
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
    disposeInstanceShell(instanceId)
    if (opening !== undefined) await Promise.allSettled([opening])
    __testResetLifecycle()
    t.mock.timers.reset()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})
