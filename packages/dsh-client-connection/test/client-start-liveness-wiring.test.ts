/**
 * node:test for the `start(sinks, config)` WIRING of the chamber connection
 * fork (`src/client/index.ts:343-409`, design 14 D4 plus the 2026-09 sleep/wake
 * extension). The two sibling tests each blind half of it:
 * `test/client-apply.test.ts` stops at `apply()` (it never calls `start()`), and
 * `test/liveness-triggers.test.ts` drives `attachLivenessTriggers` directly, so
 * neither observes what `start()` actually installs:
 *
 *  - the loop hands the page `window`/`document`, the CONTROLLER's native
 *    `reconnect()` and `SYSTEM_RESUME_EVENT` as an always-fire (offline-gate
 *    bypassing) event to `attachLivenessTriggers` (`index.ts:379-401`);
 *  - a dispatched wake event really reaches the controller — a fresh physical
 *    carrier attempt with no backoff — even while the controller sits parked in
 *    its suspended-offline state (the stuck-half-open-socket recovery path);
 *  - an ordinary `online` event gets no such head start while the browser still
 *    reports offline (the gate the always-fire list must stay narrow for);
 *  - `stop()` detaches every listener the loop installed and releases the loop.
 *
 * Driven with no browser and no new injection seam: a fake `window`/`document`
 * pair (real listener bookkeeping + synchronous `dispatch`) is installed on
 * `globalThis` for the duration of each test, and the generation source is a
 * fake `ConnectionGenerationSource` that counts carrier attempts. The wiring
 * under test reads both through its existing page-global seams
 * (`typeof window === 'undefined' ? undefined : window` in `index.ts:380-381`,
 * `registerGenerationSource` / `start(sinks, config)` on the handle).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, SYSTEM_RESUME_EVENT } from '../src/client/index.ts'
import type {
  ConnectionGenerationSource,
  ConnectionHandle,
  ConnectionLoop,
  ConnectionSinks,
  ConnectionState,
} from '../src/client/index.ts'

// ── fake page: listener bookkeeping + synchronous dispatch ────────────────

interface FakeTarget {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  /** Test-only bookkeeping: listeners currently registered for `type`. */
  listenerCount(type: string): number
  /** Test-only: deliver an event to every listener registered right now. */
  dispatch(type: string): void
}

function fakeTarget(): FakeTarget {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    listenerCount: type => listeners.get(type)?.size ?? 0,
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
  }
}

interface FakeWindow extends FakeTarget {
  readonly navigator: { onLine: boolean }
}

interface FakeDocument extends FakeTarget {
  readonly visibilityState: string
}

interface BrowserEnv {
  readonly win: FakeWindow
  readonly doc: FakeDocument
  readonly windowDispatch: (type: string) => void
  restore(): void
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name]
  else Object.defineProperty(globalThis, name, descriptor)
}

/**
 * Install a fake page on `globalThis`. `window.navigator` IS `globalThis.navigator`
 * (as in a real page), so upstream's network watch (`index.ts:224-237`, which reads
 * `window.navigator.onLine`) and the liveness gate (`browserIsOnline()` in
 * `liveness-triggers.ts`, which reads `globalThis.navigator.onLine`) observe one
 * coherent link state — exactly the state a suspended page is stuck in.
 */
function installBrowserEnv(onLine: boolean): BrowserEnv {
  const navigator = { onLine }
  const win: FakeWindow = { ...fakeTarget(), navigator }
  const doc: FakeDocument = { ...fakeTarget(), visibilityState: 'visible' }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true })
  return {
    win,
    doc,
    windowDispatch: (type) => { win.dispatch(type) },
    restore() {
      restoreGlobal('window', previousWindow)
      restoreGlobal('document', previousDocument)
      restoreGlobal('navigator', previousNavigator)
    },
  }
}

// ── fake generation source: one carrier attempt per invocation ────────────

interface GenerationProbe {
  readonly source: ConnectionGenerationSource
  /** Physical carrier attempts the controller opened (source invocations). */
  attempts(): number
}

function fakeGenerationSource(): GenerationProbe {
  const signals: AbortSignal[] = []
  const source: ConnectionGenerationSource = (signal, ready) => {
    signals.push(signal)
    return new Promise<void>((resolve) => {
      const settle = (): void => { resolve() }
      if (signal.aborted) {
        settle()
        return
      }
      signal.addEventListener('abort', settle, { once: true })
      // A real carrier attaches its incremental listeners, then reports ready
      // and stays pending until the generation is lost or aborted.
      ready({ home: '/home/liveness' })
    })
  }
  return { source, attempts: () => signals.length }
}

/**
 * Backoff floor for every non-immediate retry path. A resumed/`online`-restored
 * loop that did NOT take the controller's immediate (manual) reconnect branch
 * would have to sleep 30-60s before its next attempt, so an attempt observed
 * inside a sub-second window can only come from the immediate branch.
 */
const UNREACHABLE_BACKOFF_MS = 60_000

interface Harness {
  readonly handle: ConnectionHandle
  readonly loop: ConnectionLoop
  readonly unregisterSource: () => void
  readonly attempts: () => number
  readonly hosts: string[]
  readonly states: ConnectionState[]
  readonly reconnectRequests: () => number
}

/** `apply()` a fresh handle, register the fake source and `start()` the loop. */
function startWiredLoop(): Harness {
  let provided: unknown
  apply({
    chamberBasePath: undefined,
    provide(name: string, value: unknown): void {
      if (name === 'connection') provided = value
    },
  } as never)
  const handle = provided as ConnectionHandle
  const probe = fakeGenerationSource()
  const unregisterSource = handle.registerGenerationSource(probe.source)
  const hosts: string[] = []
  const states: ConnectionState[] = []
  let reconnectRequests = 0
  const sinks: ConnectionSinks = {
    onConnected: (host) => { hosts.push(host.home) },
    onStateChange: (state) => { states.push(state) },
    onReconnectRequested: () => { reconnectRequests += 1 },
  }
  const loop = handle.start(sinks, {
    backoffBaseMs: UNREACHABLE_BACKOFF_MS,
    backoffMaxMs: UNREACHABLE_BACKOFF_MS,
  })
  return {
    handle,
    loop,
    unregisterSource,
    attempts: probe.attempts,
    hosts,
    states,
    reconnectRequests: () => reconnectRequests,
  }
}

/** Let the controller's own promise chain (source → ready → connected) run. */
async function settle(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
}

/** Bounded wait for an asynchronous consequence (returns false on timeout). */
async function waitUntil(predicate: () => boolean, timeoutMs = 400): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** Teardown shared by every test: stop the loop, withdraw the source, un-fake the page. */
function teardown(harness: Harness, env: BrowserEnv): void {
  harness.loop.stop()
  harness.unregisterSource()
  env.restore()
}

// ── the wiring itself ─────────────────────────────────────────────────────

test('start(): runs the carrier and installs every liveness listener on the page', async () => {
  const env = installBrowserEnv(true)
  const harness = startWiredLoop()
  try {
    await settle()
    // The loop really opened its first carrier attempt and reached ready.
    assert.equal(harness.attempts(), 1)
    assert.deepEqual(harness.hosts, ['/home/liveness'])
    assert.equal(harness.handle.state.getSnapshot(), 'connected')
    assert.equal(harness.handle.generation.getSnapshot()?.id, 1)
    // An online page is never parked offline.
    assert.deepEqual(harness.states, ['connected'])

    // Wiring: the wake event, the network events and the visibility event are
    // all attached to the page. 'online' carries two listeners on purpose —
    // upstream's own watchBrowserNetwork (index.ts:231) plus the liveness
    // trigger (index.ts:394).
    assert.equal(env.win.listenerCount(SYSTEM_RESUME_EVENT), 1)
    assert.equal(env.win.listenerCount('online'), 2)
    assert.equal(env.win.listenerCount('offline'), 1)
    assert.equal(env.doc.listenerCount('visibilitychange'), 1)
  } finally {
    teardown(harness, env)
  }
})

// ── design 14 D4: the wake event reaches the controller past the offline gate ──

test('start(): a SYSTEM_RESUME_EVENT reconnects immediately while the controller is offline-suspended', async () => {
  const env = installBrowserEnv(false) // the stuck state: the page still reports offline
  const harness = startWiredLoop()
  try {
    await settle()
    // Precondition — the upstream network watch parked the loop: upstream's own
    // retry machinery cannot open a carrier while `navigator.onLine === false`,
    // so no attempt exists and every trigger that honours the gate is inert.
    assert.equal(harness.attempts(), 0, 'offline: the loop is suspended, not retrying')
    assert.equal(harness.handle.state.getSnapshot(), 'disconnected')
    assert.deepEqual(harness.states, ['disconnected'])

    env.windowDispatch(SYSTEM_RESUME_EVENT)

    // Synchronous evidence the event reached `controller.reconnect()`: it
    // publishes 'connecting' before aborting the offline wait.
    assert.equal(harness.handle.state.getSnapshot(), 'connecting')
    assert.ok(
      await waitUntil(() => harness.attempts() === 1),
      'the wake event must open a new carrier attempt past the offline gate',
    )
    // It took the immediate (manual) reconnect branch: a backoff-bound retry
    // would still be sleeping for UNREACHABLE_BACKOFF_MS.
    assert.equal(harness.reconnectRequests(), 1)
    assert.deepEqual(harness.hosts, ['/home/liveness'], 'the reconnect re-ran the readiness handshake')
    assert.equal(harness.handle.state.getSnapshot(), 'connected')
    assert.equal(harness.handle.generation.getSnapshot()?.id, 1)
  } finally {
    teardown(harness, env)
  }
})

test('start(): an ordinary online event does not get the same immediate reconnect while offline', async () => {
  const env = installBrowserEnv(false)
  const harness = startWiredLoop()
  try {
    await settle()
    assert.equal(harness.attempts(), 0)

    // The link "returns" only in the sense that the browser fires `online`; the
    // page still reports offline (`navigator.onLine === false`), which is the
    // race the always-fire list must stay narrow for. Upstream's watch does
    // un-park the loop, but the liveness trigger's gate holds.
    env.windowDispatch('online')
    assert.equal(
      harness.handle.state.getSnapshot(),
      'connecting',
      'upstream setNetworkAvailable(true) un-parked the loop',
    )

    await sleep(300)
    // No carrier attempt: the ordinary event did not force one, and the
    // un-parked loop is still inside its backoff sleep.
    assert.equal(harness.attempts(), 0, 'only the wake event bypasses the offline gate')
    assert.equal(harness.reconnectRequests(), 0)
  } finally {
    teardown(harness, env)
  }
})

test('start(): a wake event reconnects a live loop at once, and a burst collapses into one attempt', async () => {
  const env = installBrowserEnv(true)
  const harness = startWiredLoop()
  try {
    await settle()
    assert.equal(harness.attempts(), 1)
    assert.equal(harness.handle.generation.getSnapshot()?.id, 1)

    env.windowDispatch(SYSTEM_RESUME_EVENT)
    assert.equal(harness.handle.state.getSnapshot(), 'connecting')
    assert.ok(
      await waitUntil(() => harness.attempts() === 2),
      'a wake event must replace the live generation immediately',
    )
    assert.deepEqual(harness.hosts, ['/home/liveness', '/home/liveness'])
    assert.equal(harness.handle.generation.getSnapshot()?.id, 2)
    assert.equal(harness.handle.state.getSnapshot(), 'connected')

    // A second wake inside the trigger's own debounce window (10s — the pump's
    // slowest retry step) must not churn the loop again.
    env.windowDispatch(SYSTEM_RESUME_EVENT)
    await sleep(100)
    assert.equal(harness.attempts(), 2, 'the wake burst must collapse into one reconnect')
    assert.equal(harness.handle.state.getSnapshot(), 'connected')
  } finally {
    teardown(harness, env)
  }
})

// ── stop(): the returned handle is the only teardown ──────────────────────

test('stop(): detaches every liveness listener and releases the loop', async () => {
  const env = installBrowserEnv(true)
  const harness = startWiredLoop()
  try {
    await settle()
    assert.equal(harness.attempts(), 1)
    assert.equal(env.win.listenerCount(SYSTEM_RESUME_EVENT), 1)
    assert.equal(env.doc.listenerCount('visibilitychange'), 1)

    harness.loop.stop()

    // Every listener the loop installed is gone — window and document halves.
    assert.equal(env.win.listenerCount(SYSTEM_RESUME_EVENT), 0, 'the wake listener must be removed')
    assert.equal(env.win.listenerCount('online'), 0)
    assert.equal(env.win.listenerCount('offline'), 0)
    assert.equal(env.doc.listenerCount('visibilitychange'), 0, 'the visibility listener must be removed')
    // The owner was released: no generation, no state, no loop to reconnect.
    assert.equal(harness.handle.state.getSnapshot(), undefined)
    assert.equal(harness.handle.generation.getSnapshot(), undefined)

    // Nothing is left to dispatch into, so a late wake event cannot resurrect it.
    env.windowDispatch(SYSTEM_RESUME_EVENT)
    await sleep(50)
    assert.equal(harness.attempts(), 1)
    assert.equal(harness.reconnectRequests(), 0)
  } finally {
    teardown(harness, env)
  }
})

/*
 * Documented gap — the `ownsGeneration()` guard inside `restart` (`index.ts:387`)
 * has no reachable witness, so this file deliberately asserts nothing about it
 * (an assertion that cannot go red is a fake green):
 *
 *  - The guard can only matter when the owner was released while the liveness
 *    listeners stayed attached — the `registerGenerationSource` disposer path
 *    (`index.ts:336-341`). The stop handle detaches first (`index.ts:404-405`),
 *    so there the callback is never called at all.
 *  - That path releases through `releaseOwner` (`index.ts:298-305`), which
 *    always calls `controller.stop()`: afterwards the generation's AbortSignal
 *    is aborted and the loop is provably dead. The same holds for the
 *    `onConnected` / `onStateChange` guards at `index.ts:354,361`.
 *  - `ConnectionController.reconnect()` returns immediately while
 *    `!this.running` (`connection.ts:130-131`), so even without the guard a
 *    stale trigger reaches a stopped controller and changes nothing.
 *
 * Measured: deleting the guard leaves this file 7/7 green, and a direct probe
 * of the disposer path (carrier attempts, aborted signal, state, reconnect
 * sink) prints byte-identical output with and without it. The guard is
 * defence-in-depth for a future `reconnect()` that stops being
 * `running`-gated; it is an unwitnessed guard, not covered behaviour.
 */

// ── the owner / generation-source single-flight gates ─────────────────────

test('start(): a second start() on the same handle fails loudly', async () => {
  const env = installBrowserEnv(true)
  const harness = startWiredLoop()
  try {
    await settle()
    assert.throws(
      () => { harness.handle.start({}) },
      /connection: the stream loop is already owned by another consumer/,
    )
    // The rejected call left the running loop untouched.
    assert.equal(harness.attempts(), 1)
    assert.equal(harness.handle.state.getSnapshot(), 'connected')
  } finally {
    teardown(harness, env)
  }
})

test('start(): starting without a registered generation source fails loudly', () => {
  let provided: unknown
  apply({
    chamberBasePath: undefined,
    provide(name: string, value: unknown): void {
      if (name === 'connection') provided = value
    },
  } as never)
  const handle = provided as ConnectionHandle
  // The gate is before any browser wiring: no window/document is installed here.
  assert.throws(
    () => { handle.start({}) },
    /connection: no generation source is registered/,
  )
})
