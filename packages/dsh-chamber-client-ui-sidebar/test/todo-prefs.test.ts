/**
 * todo-prefs tests (sidebar todo area settings subset) — node:test. Part 1:
 * the value-validated decode of the chamber-global sessionTodo block and the
 * defaults mirror (desktop store + settings-bridge helpers keep the same
 * literal; the ipc-surface-mirror guard keeps the authoritative types in
 * lockstep). Part 2: the read-only hydration state machine over a fake
 * window.dshChamber.settings bridge — the round-1 P2 regression pin: a
 * persistent get() failure must never stack permanent onChanged listeners
 * (each retry attach releases the previous handle first).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIDEBAR_TODO_PREFS_DEFAULTS,
  todoPrefsOf,
} from '../src/shared/todo-prefs.ts'

// ---- decode (pure, no window) ------------------------------------------------

test('sidebar todo defaults are ALL ON and mirror the desktop store defaults', () => {
  // Mirror assertion: desktop DEFAULT_CHAMBER_SETTINGS.sessionTodo is
  // { enabled: true, onComplete: true, onAsk: true, onRequest: true }.
  assert.deepEqual(SIDEBAR_TODO_PREFS_DEFAULTS, { enabled: true, onComplete: true, onAsk: true, onRequest: true })
})

test('todoPrefsOf: absent/invalid block reads as the full defaults (never a fake off)', () => {
  assert.deepEqual(todoPrefsOf(undefined), SIDEBAR_TODO_PREFS_DEFAULTS)
  assert.deepEqual(todoPrefsOf(null), SIDEBAR_TODO_PREFS_DEFAULTS)
  assert.deepEqual(todoPrefsOf('yes'), SIDEBAR_TODO_PREFS_DEFAULTS)
  assert.deepEqual(todoPrefsOf(['enabled']), SIDEBAR_TODO_PREFS_DEFAULTS)
})

test('todoPrefsOf: a partial block fills missing keys from the defaults', () => {
  const got = todoPrefsOf({ enabled: false })
  assert.deepEqual(got, { enabled: false, onComplete: true, onAsk: true, onRequest: true })
})

test('todoPrefsOf: unknown future keys and non-boolean values are filtered/ignored', () => {
  assert.deepEqual(todoPrefsOf({ enabled: false, futureKey: 42 }), { enabled: false, onComplete: true, onAsk: true, onRequest: true })
  assert.deepEqual(todoPrefsOf({ enabled: 'yes', onComplete: 1 }), SIDEBAR_TODO_PREFS_DEFAULTS)
})

// ---- hydration (fake window bridge, fresh module instance per test) ---------

// The singleton guard logs a diagnostic for every EXTRA module instance; each
// fresh import below is an intentional second instance — keep the noise out
// of the test output.
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('共享单例模块')) return
  originalConsoleError(...args)
}

type TodoPrefsModule = typeof import('../src/shared/todo-prefs.ts')

/** Fresh module instance (the store is a page-wide singleton). */
function freshModule(): Promise<TodoPrefsModule> {
  return import(`../src/shared/todo-prefs.ts?case=${Math.random().toString(36).slice(2)}`)
}

/** Minimal fake of the consumed settings surface. */
function makeSurface(behavior: { failGet?: boolean } = {}) {
  const listeners = new Set<(status: { settings?: { sessionTodo?: unknown } }) => void>()
  const surface = {
    getCalls: 0,
    activeListeners: (): number => listeners.size,
    status: { settings: { sessionTodo: { enabled: true, onComplete: true, onAsk: true, onRequest: true } } },
    async get(): Promise<{ settings?: { sessionTodo?: unknown } }> {
      surface.getCalls += 1
      if (behavior.failGet === true) throw new Error('simulated bridge invoke failure')
      return surface.status
    },
    onChanged(callback: (status: { settings?: { sessionTodo?: unknown } }) => void): () => void {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    push(enabled: boolean): void {
      surface.status = {
        settings: { sessionTodo: { enabled, onComplete: true, onAsk: true, onRequest: true } },
      }
      for (const callback of [...listeners]) callback(surface.status)
    },
  }
  return surface
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(condition(), 'condition timed out')
}

test('hydration: a late bridge hydrates through the probe chain and pushes update the mirror', async () => {
  ;(globalThis as Record<string, unknown>).window = {}
  const store = await freshModule()
  const unsubscribe = store.subscribeTodoPrefs(() => {})
  try {
    // The bridge arrives after the module started probing — unhydrated reads
    // as the design defaults until then (never a fake off).
    assert.deepEqual(store.getTodoPrefs(), SIDEBAR_TODO_PREFS_DEFAULTS)
    const surface = makeSurface({})
    surface.status = { settings: { sessionTodo: { enabled: false, onComplete: true, onAsk: true, onRequest: true } } }
    ;((globalThis as Record<string, unknown>).window as { dshChamber?: unknown }).dshChamber = { settings: surface }
    // The one-shot get() query lands (enabled=false proves the query result
    // was applied, not the defaults).
    await waitFor(() => store.getTodoPrefs().enabled === false)
    assert.equal(store.getTodoPrefs().onComplete, true, 'sibling keys keep the decode defaults')
    // A push (main-process SETTINGS_CHANGED) updates the mirror live.
    surface.push(true)
    assert.equal(store.getTodoPrefs().enabled, true)
    assert.equal(store.getTodoPrefs().onAsk, true)
  } finally {
    unsubscribe()
    delete (globalThis as Record<string, unknown>).window
  }
})

test('hydration: persistent get() failures never stack onChanged listeners (round-1 P2 regression)', async () => {
  const surface = makeSurface({ failGet: true })
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { settings: surface } }
  const store = await freshModule()
  const unsubscribe = store.subscribeTodoPrefs(() => {})
  try {
    // Let several attach→fail→release cycles run (fast probe hops). Each
    // attach registers ONE listener and must release it before re-arming —
    // a leaked handle would keep every previous cycle's listener registered.
    await waitFor(() => surface.getCalls >= 3)
    // Sample across a few hundred ms: the active listener count must never
    // exceed 1 (0 between a release and the next attach hop is legitimate).
    const deadline = Date.now() + 800
    while (Date.now() < deadline) {
      assert.ok(surface.activeListeners() <= 1, `listener leak: ${surface.activeListeners()} active onChanged handles`)
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    // deepEqual, not identity: the fresh module instance carries its own
    // defaults constant (per-instance module state).
    assert.deepEqual(store.getTodoPrefs(), SIDEBAR_TODO_PREFS_DEFAULTS, 'unhydrated keeps serving the design defaults')
  } finally {
    unsubscribe()
    delete (globalThis as Record<string, unknown>).window
  }
})
