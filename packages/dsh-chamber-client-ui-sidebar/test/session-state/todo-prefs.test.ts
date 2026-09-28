/**
 * todo-prefs tests (sidebar todo area settings subset) — node:test. Part 1: the value-validated
 * decode of the chamber-global sessionTodo block and the defaults mirror (the ipc-surface-mirror
 * guard keeps the authoritative types in lockstep). Part 2: the read-only hydration state machine
 * over a fake window.dshChamber.settings bridge — a persistent get()
 * failure must never stack permanent onChanged listeners (each retry releases the previous handle).
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SIDEBAR_TODO_PREFS_DEFAULTS, todoPrefsOf } from '../../../dsh-chamber-client-core/src/todo-prefs.ts'

// ---- decode (pure, no window) ---

test('sidebar todo defaults are ALL ON and mirror the desktop store defaults', () => {
  // Mirror assertion against the AUTHORITATIVE desktop default (not a re-spelled literal):
  // ipc-surface-mirror only compares types, so a drift here would otherwise stay green.
  const source = readFileSync(new URL('../../../desktop/chamber-settings.ts', import.meta.url), 'utf8')
  const block = /sessionTodo:\s*\{([\s\S]*?)\}/.exec(source)?.[1]
  assert.ok(block, 'desktop DEFAULT_CHAMBER_SETTINGS.sessionTodo block must be locatable')
  assert.deepEqual(SIDEBAR_TODO_PREFS_DEFAULTS, { enabled: true, onComplete: true, onAsk: true, onRequest: true })
  for (const [key, value] of Object.entries(SIDEBAR_TODO_PREFS_DEFAULTS)) {
    assert.match(block, new RegExp(String.raw`(?<![A-Za-z])${key}:\s*${String(value)}`), `desktop default ${key} must mirror the sidebar default`)
  }
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

// ---- hydration (fake window bridge, fresh module instance per test) ---

// The singleton guard logs a diagnostic per EXTRA module instance; each fresh import below is an
// intentional second instance — keep the noise out of the test output.
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  if (!(typeof args[0] === 'string' && args[0].includes('共享单例模块'))) originalConsoleError(...args)
}
after(() => {
  console.error = originalConsoleError
})

type TodoPrefsModule = typeof import('../../../dsh-chamber-client-core/src/todo-prefs.ts')

/** Fresh module instance (the store is a page-wide singleton). */
function freshModule(): Promise<TodoPrefsModule> {
  return import(`../../../dsh-chamber-client-core/src/todo-prefs.ts?case=${Math.random().toString(36).slice(2)}`)
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
    onChanged: (callback: (status: { settings?: { sessionTodo?: unknown } }) => void): (() => void) =>
      (listeners.add(callback), () => { listeners.delete(callback) }),
    push(enabled: boolean): void {
      surface.status = { settings: { sessionTodo: { enabled, onComplete: true, onAsk: true, onRequest: true } } }
      for (const callback of [...listeners]) callback(surface.status)
    },
  }
  return surface
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(condition(), 'condition timed out')
}

test('hydration: a late bridge hydrates through the probe chain and pushes update the mirror', async () => {
  ;(globalThis as Record<string, unknown>).window = {}
  const store = await freshModule()
  const unsubscribe = store.subscribeTodoPrefs(() => {})
  try {
    // The bridge arrives after the module started probing — unhydrated reads as the design defaults.
    assert.deepEqual(store.getTodoPrefs(), SIDEBAR_TODO_PREFS_DEFAULTS)
    const surface = makeSurface({})
    surface.status = { settings: { sessionTodo: { enabled: false, onComplete: true, onAsk: true, onRequest: true } } }
    ;((globalThis as Record<string, unknown>).window as { dshChamber?: unknown }).dshChamber = { settings: surface }
    // The one-shot get() lands (enabled=false proves the query result was applied, not defaults).
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
  // Sample from the callback itself: the store fires it on every attach/release hop, so the
  // leak is observed at the transition instead of being re-sampled on a wall clock.
  let maxActive = 0
  const unsubscribe = store.subscribeTodoPrefs(() => {
    maxActive = Math.max(maxActive, surface.activeListeners())
  })
  try {
    // Let several attach→fail→release cycles run. Each attach registers ONE listener and must
    // release it before re-arming — a leaked handle keeps previous cycles' listeners registered.
    await waitFor(() => surface.getCalls >= 3)
    // Short settle sweep: never more than 1 active listener (0 between hops is fine).
    const deadline = Date.now() + 200
    while (Date.now() < deadline) {
      assert.ok(surface.activeListeners() <= 1, `listener leak: ${surface.activeListeners()} active onChanged handles`)
      assert.ok(maxActive <= 1, `listener leak observed at a transition: ${maxActive} active handles`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(maxActive <= 1, `listener leak observed at a transition: ${maxActive} active handles`)
    // deepEqual, not identity: the fresh module carries its own defaults constant.
    assert.deepEqual(store.getTodoPrefs(), SIDEBAR_TODO_PREFS_DEFAULTS, 'unhydrated keeps serving the design defaults')
  } finally {
    unsubscribe()
    delete (globalThis as Record<string, unknown>).window
  }
})
