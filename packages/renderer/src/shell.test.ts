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
  __testDisposedCount, __testEventLog, __testResetDisposed, __testResetEventLog,
  __testLifecycleLog, __testResetLifecycleLog, __testSetBootError, __testSetDisposeDelayMs,
  __testSetModuleSystemError, __testSetRunDelayMs, __testSetRunError, __testSetRunHang,
} from '../test-fixtures/dsh-client-web.mjs'

const { bootInstanceShell, disposeInstanceShell, __testSetBootTimeoutMs } = await import('./shell.ts')

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

/** Poll a condition (the budget timers are unref'd; the test loop must poll). */
async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** shell.ts reads the `window` global for the per-boot knob; mirror it onto globalThis. */
function stubWindow(): () => void {
  const g = globalThis as Record<string, unknown>
  const original = g.window
  g.window = globalThis
  return () => {
    if (original === undefined) delete g.window
    else g.window = original
  }
}

test('bootInstanceShell: a resolved-but-failed run (bootError set) settles as a failure and disposes the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError('client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table')
  __testSetRunError(undefined)
  try {
    const state = await bootInstanceShell('test-fail-1', '/api/i/test-fail-1', {} as HTMLElement, () => {})
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
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  try {
    const state = await bootInstanceShell('test-clean-2', '/api/i/test-clean-2', {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    assert.equal(state.error, null)
    assert.equal(__testDisposedCount(), 0)
  } finally {
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a throwing run settles as a failure (legacy rejection path) and disposes the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(new Error('loader exploded'))
  try {
    const state = await bootInstanceShell('test-throw-3', '/api/i/test-throw-3', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'loader exploded')
    assert.equal(__testDisposedCount(), 1)
  } finally {
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
    const state = await bootInstanceShell('test-order-5', '/api/i/test-order-5', {} as HTMLElement, () => {})
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
    const state = await bootInstanceShell('test-manifest-6', '/api/i/test-manifest-6', {} as HTMLElement, () => {})
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
  const sourceId = 'test-diagnostic-generation-7'
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
    assert.deepEqual(states, ['ok'])
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

// ── H1 / M1 (2026 audit): boot-budget cancellation + serialized dispose ────

test('bootInstanceShell: a run() that never settles is cancelled at the boot budget (H1) — the caller and the chain both settle', async () => {
  // 200 + empty entries: the graph channel resolves WITHOUT the 503 retry
  // budget (6 × 500ms sleeps would delay entry construction past the budget).
  const originalFetch = globalThis.fetch
  const restoreFetch = () => { globalThis.fetch = originalFetch }
  globalThis.fetch = (async () => new Response(JSON.stringify({
    rpcId: 't', result: { ok: true, value: { entries: [] } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  console.error = () => {}
  __testResetDisposed()
  __testSetRunHang(true)
  __testSetBootTimeoutMs(40)
  // The budget timer is unref'd by design (a hung boot must not keep the app
  // alive); a ref'd interval keeps the TEST event loop alive until it fires.
  const keepAlive = setInterval(() => {}, 500)
  try {
    const state = await bootInstanceShell('t-hang-run', '/api/i/t-hang-run', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.match(state.error ?? '', /timed out/)
    assert.equal(__testDisposedCount(), 1, 'the hung entry is disposed by the timeout branch')
    // The serialized chain advanced: a second instance's boot runs and
    // settles normally after the timeout (never concurrent with the zombie).
    __testSetRunHang(false)
    const second = await bootInstanceShell('t-after-hang', '/api/i/t-after-hang', {} as HTMLElement, () => {})
    assert.equal(second.booted, true)
  } finally {
    clearInterval(keepAlive)
    __testSetRunHang(false)
    __testSetBootTimeoutMs(60_000)
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a hung host-graph channel also settles at the budget and never constructs an entry (H1)', async () => {
  const restoreWindow = stubWindow()
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  console.error = () => {}
  // The graph channel never settles → collectExtraRows hangs pre-knob.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch
  __testResetDisposed()
  __testResetLifecycleLog()
  __testSetBootTimeoutMs(40)
  const keepAlive = setInterval(() => {}, 500)
  try {
    const state = await bootInstanceShell('t-hang-graph', '/api/i/t-hang-graph', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.match(state.error ?? '', /timed out/)
    assert.deepEqual(__testLifecycleLog(), [], 'no entry was ever constructed before the budget expired')
    assert.equal(__testDisposedCount(), 0)
  } finally {
    clearInterval(keepAlive)
    globalThis.fetch = originalFetch
    __testSetBootTimeoutMs(60_000)
    console.error = originalConsoleError
    restoreWindow()
  }
})

test('disposeInstanceShell → immediate re-boot: the fresh ctx is constructed only after the old async dispose settles (M1)', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  console.error = () => {}
  __testResetDisposed()
  __testResetLifecycleLog()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetDisposeDelayMs(60)
  const keepAlive = setInterval(() => {}, 500)
  try {
    const el = {} as HTMLElement
    const first = await bootInstanceShell('t-serial', '/api/i/t-serial', el, () => {})
    assert.equal(first.booted, true)
    disposeInstanceShell('t-serial')
    const second = await bootInstanceShell('t-serial', '/api/i/t-serial', el, () => {})
    assert.equal(second.booted, true)
    assert.deepEqual(
      __testLifecycleLog(),
      ['construct', 'dispose', 'construct'],
      'the re-boot awaits the old teardown — no same-id ctx overlap',
    )
    assert.equal(__testDisposedCount(), 1)
  } finally {
    clearInterval(keepAlive)
    __testSetDisposeDelayMs(0)
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('H1: a timed-out boot that LATE-settles must never register over a newer boot (monotonic cancellation threshold)', async () => {
  // 200 + empty entries: no 503 retry budget (fast entry construction).
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    rpcId: 't', result: { ok: true, value: { entries: [] } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  console.error = () => {}
  __testResetDisposed()
  __testResetLifecycleLog()
  __testSetRunDelayMs(250) // run() settles AFTER the budget (wide margins)
  __testSetBootTimeoutMs(80)
  const keepAlive = setInterval(() => {}, 500)
  try {
    const first = await bootInstanceShell('t-late', '/api/i/t-late', {} as HTMLElement, () => {})
    assert.match(first.error ?? '', /timed out/)
    assert.equal(__testDisposedCount(), 1, 'the timeout branch disposed the hung entry')
    // Retry boots and registers while the timed-out run() is still pending.
    __testSetRunDelayMs(0)
    const retry = await bootInstanceShell('t-late', '/api/i/t-late', {} as HTMLElement, () => {})
    assert.equal(retry.booted, true)
    // The FIRST boot's run() now settles late: it must be CANCELLED (its entry
    // disposed again), never registered over the retry entry.
    await waitUntil(() => __testDisposedCount() >= 2, 2000)
    assert.deepEqual(__testLifecycleLog(), ['construct', 'dispose', 'construct', 'dispose'],
      'late settle is torn down — the retry entry is never overwritten (no zombie ctx)')
  } finally {
    clearInterval(keepAlive)
    __testSetRunDelayMs(0)
    __testSetBootTimeoutMs(60_000)
    console.error = originalConsoleError
    globalThis.fetch = originalFetch
    restoreWindow()
  }
})

test('two DIFFERENT instances boot strictly serially through the shared chain (round-3 review: cross-instance isolation)', async () => {
  // 200 + empty entries stub (no 503 retry budget — fast entry construction).
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    rpcId: 't', result: { ok: true, value: { entries: [] } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  console.error = () => {}
  __testResetDisposed()
  __testResetLifecycleLog()
  __testSetRunDelayMs(80) // instance A holds the chain for 80ms
  const keepAlive = setInterval(() => {}, 500)
  try {
    const start = Date.now()
    const bootA = bootInstanceShell('t-serial-a', '/api/i/t-serial-a', {} as HTMLElement, () => {})
    // Let A's task run to its run() call first (a microtask yield is NOT
    // enough — the task awaits the dispose chain and the stub fetch before
    // constructing; a macrotask guarantees all microtasks drained, so A's
    // run() has read the 80ms knob), THEN clear it for B: the knob is a
    // module-level global read at run() call time, so clearing it
    // synchronously would zero A's delay too. With B at 0ms, serial B
    // settles only after A's 80ms run delay, concurrent B ~0ms (2026
    // review — the old test left B at 80ms, which a concurrent B would
    // also pass: false-negative).
    await new Promise(resolve => setTimeout(resolve, 0))
    __testSetRunDelayMs(0)
    const bootB = bootInstanceShell('t-serial-b', '/api/i/t-serial-b', {} as HTMLElement, () => {})
    // B's settle must come AFTER A's 80ms run delay — serialization, not
    // concurrency (a concurrent regression would settle B in ~0ms).
    const stateB = await bootB
    const elapsedB = Date.now() - start
    assert.equal(stateB.booted, true)
    assert.ok(elapsedB >= 60, `instance B booted after ${elapsedB}ms — the chain must serialize across instances`)
    const stateA = await bootA
    assert.equal(stateA.booted, true)
    // Both constructed exactly once, in order.
    assert.deepEqual(__testLifecycleLog().filter(e => e === 'construct'), ['construct', 'construct'])
  } finally {
    clearInterval(keepAlive)
    __testSetRunDelayMs(0)
    __testSetBootTimeoutMs(60_000)
    console.error = originalConsoleError
    globalThis.fetch = originalFetch
    restoreWindow()
  }
})
