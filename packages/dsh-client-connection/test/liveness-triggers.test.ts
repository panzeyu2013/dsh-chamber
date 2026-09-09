/**
 * node:test for the chamber liveness-triggers patch
 * (`packages/dsh-client-connection/src/client/liveness-triggers.ts`) — the
 * sleep/wake recovery triggers: window events (system-resume / online)
 * reconnect immediately, a long hidden span reconnects on visibility return,
 * short alt-tabs never reconnect, offline triggers are ignored, and the detach
 * removes every listener.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { attachLivenessTriggers, DEFAULT_HIDDEN_RECONNECT_THRESHOLD_MS, DEFAULT_MIN_RESTART_INTERVAL_MS } from '../src/client/liveness-triggers.ts'

/** Minimal EventTarget stub recording listeners per type. */
function stubTarget(): {
  emit(type: string): void
  listeners: Map<string, Array<() => void>>
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
} {
  const listeners = new Map<string, Array<() => void>>()
  return {
    listeners,
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type)
      if (list === undefined) return
      const next = list.filter(candidate => candidate !== listener)
      if (next.length === 0) listeners.delete(type)
      else listeners.set(type, next)
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
  }
}

function stubDocument(initial: 'visible' | 'hidden' = 'visible') {
  const target = stubTarget()
  let visibilityState = initial
  return {
    ...target,
    get visibilityState() { return visibilityState },
    setVisibility(state: 'visible' | 'hidden') {
      visibilityState = state
      target.emit('visibilitychange')
    },
  }
}

// ── window event triggers ─────────────────────────────────────────────────

test('liveness: each window event fires the shared restart (past the min interval)', () => {
  const win = stubTarget()
  let clock = 0
  const restarts: string[] = []
  const detach = attachLivenessTriggers(win as never, undefined, {
    restart: () => restarts.push('restart'),
    windowEvents: ['dsh-chamber:system-resume', 'online'],
    now: () => clock,
  })
  win.emit('online')
  assert.equal(restarts.length, 1)
  clock = DEFAULT_MIN_RESTART_INTERVAL_MS + 1 // resume arrives later (real wake)
  win.emit('dsh-chamber:system-resume')
  assert.equal(restarts.length, 2)
  detach()
})

test('liveness: overlapping triggers within the min interval collapse into one restart', () => {
  const win = stubTarget()
  let clock = 0
  const restarts: string[] = []
  const detach = attachLivenessTriggers(win as never, undefined, {
    restart: () => restarts.push('restart'),
    windowEvents: ['online'],
    now: () => clock,
  })
  // `online` flapping (or resume + online on one wake): a burst must restart once.
  win.emit('online')
  win.emit('online')
  win.emit('online')
  assert.equal(restarts.length, 1)
  // After the min interval the next trigger restarts again.
  clock = DEFAULT_MIN_RESTART_INTERVAL_MS + 1
  win.emit('online')
  assert.equal(restarts.length, 2)
  detach()
})

test('liveness: detach removes window listeners (no further restarts)', () => {
  const win = stubTarget()
  const restarts: string[] = []
  const detach = attachLivenessTriggers(win as never, undefined, {
    restart: () => restarts.push('restart'),
    windowEvents: ['online'],
  })
  detach()
  win.emit('online')
  assert.equal(restarts.length, 0)
})

// ── visibilitychange: long hidden span → restart on return ────────────────

test('liveness: visible again after a long hidden span restarts', () => {
  const win = stubTarget()
  const doc = stubDocument('visible')
  let clock = 0
  const restarts: string[] = []
  const detach = attachLivenessTriggers(win as never, doc as never, {
    restart: () => restarts.push('restart'),
    now: () => clock,
  })
  // hide, stay hidden past the default threshold, then return
  doc.setVisibility('hidden')
  clock = DEFAULT_HIDDEN_RECONNECT_THRESHOLD_MS + 1
  doc.setVisibility('visible')
  assert.equal(restarts.length, 1)
  detach()
})

test('liveness: a short hidden span never restarts', () => {
  const win = stubTarget()
  const doc = stubDocument('visible')
  let clock = 0
  const restarts: string[] = []
  const detach = attachLivenessTriggers(win as never, doc as never, {
    restart: () => restarts.push('restart'),
    now: () => clock,
  })
  doc.setVisibility('hidden')
  clock = DEFAULT_HIDDEN_RECONNECT_THRESHOLD_MS - 1
  doc.setVisibility('visible')
  assert.equal(restarts.length, 0)
  detach()
})

test('liveness: an exact-threshold hidden span restarts (>= semantics)', () => {
  const win = stubTarget()
  const doc = stubDocument('visible')
  let clock = 0
  const restarts: string[] = []
  const detach = attachLivenessTriggers(win as never, doc as never, {
    restart: () => restarts.push('restart'),
    hiddenReconnectThresholdMs: 5_000,
    now: () => clock,
  })
  doc.setVisibility('hidden')
  clock = 5_000
  doc.setVisibility('visible')
  assert.equal(restarts.length, 1)
  detach()
})

test('liveness: becoming visible without a prior hidden span never restarts', () => {
  const win = stubTarget()
  const doc = stubDocument('visible')
  let clock = 0
  const restarts: string[] = []
  const detach = attachLivenessTriggers(win as never, doc as never, {
    restart: () => restarts.push('restart'),
    now: () => clock,
  })
  // No hidden transition: a stray visible event (initial page) is a no-op.
  clock = 1_000_000
  doc.setVisibility('visible')
  assert.equal(restarts.length, 0)
  detach()
})

test('liveness: a hidden span resets on each hide transition (re-hide before threshold)', () => {
  const win = stubTarget()
  const doc = stubDocument('visible')
  let clock = 0
  const restarts: string[] = []
  const detach = attachLivenessTriggers(win as never, doc as never, {
    restart: () => restarts.push('restart'),
    hiddenReconnectThresholdMs: 10_000,
    now: () => clock,
  })
  doc.setVisibility('hidden') // t=0
  clock = 8_000
  doc.setVisibility('visible') // within threshold → no restart, hiddenSince kept
  assert.equal(restarts.length, 0)
  doc.setVisibility('hidden') // re-hide resets the clock
  clock = 20_000
  doc.setVisibility('visible')
  assert.equal(restarts.length, 1)
  detach()
})

test('liveness: detach removes the visibilitychange listener', () => {
  const win = stubTarget()
  const doc = stubDocument('visible')
  let clock = 0
  const restarts: string[] = []
  const detach = attachLivenessTriggers(win as never, doc as never, {
    restart: () => restarts.push('restart'),
    now: () => clock,
  })
  detach()
  doc.setVisibility('hidden')
  clock = DEFAULT_HIDDEN_RECONNECT_THRESHOLD_MS + 1
  doc.setVisibility('visible')
  assert.equal(restarts.length, 0)
})

// ── non-browser guards ────────────────────────────────────────────────────

test('liveness: undefined window/document is a safe no-op', () => {
  let restarts = 0
  const detach = attachLivenessTriggers(undefined, undefined, {
    restart: () => { restarts += 1 },
    windowEvents: ['online'],
  })
  detach()
  detach() // idempotent
  assert.equal(restarts, 0)
})

// ── the debounce value is pinned to the vendored recovery default ─────────

test('liveness: DEFAULT_MIN_RESTART_INTERVAL_MS equals the vendored recovery backoffMaxMs default', () => {
  // The chamber value must track the upstream recovery schema's own slowest
  // retry step; nothing else pins the literal, so a vendor bump would
  // otherwise drift silently (upstream-touchpoints §4 contract-mirror row).
  assert.equal(DEFAULT_MIN_RESTART_INTERVAL_MS, 10_000)
  const vendor = readFileSync(
    new URL('../../../vendor/harness-checkout/packages/client/connection/src/recovery-config.ts', import.meta.url),
    'utf8',
  )
  const match = vendor.match(/backoffMaxMs:[\s\S]*?\.default\(([0-9_]+)\)/)
  assert.ok(match !== null, 'the vendored recovery-config must declare a backoffMaxMs default')
  assert.equal(Number(match[1]!.replaceAll('_', '')), DEFAULT_MIN_RESTART_INTERVAL_MS)
})

// ── offline gate (Batch 2: the native recovery control owns offline) ──────

test('liveness: an offline browser ignores every trigger', () => {
  const win = stubTarget()
  const doc = stubDocument()
  let clock = 0
  const restarts: string[] = []
  attachLivenessTriggers(win as never, doc as never, {
    restart: () => restarts.push('restart'),
    windowEvents: ['online'],
    isOnline: () => false,
    now: () => clock,
  })
  win.emit('online')
  doc.setVisibility('hidden')
  clock = DEFAULT_HIDDEN_RECONNECT_THRESHOLD_MS + 1
  doc.setVisibility('visible')
  assert.deepEqual(restarts, [], 'the controller\u2019s own setNetworkAvailable(false) covers offline')
})

test('liveness: the network gate is re-read per trigger, so a restored link reconnects', () => {
  const win = stubTarget()
  let clock = 0
  let online = false
  const restarts: string[] = []
  attachLivenessTriggers(win as never, undefined, {
    restart: () => restarts.push('restart'),
    windowEvents: ['online'],
    isOnline: () => online,
    now: () => clock,
  })
  win.emit('online')
  assert.deepEqual(restarts, [], 'offline event is ignored')
  online = true
  clock += 1
  win.emit('online')
  assert.deepEqual(restarts, ['restart'], 'the restored link reconnects on the next trigger')
})

test('liveness: an always-fire event bypasses the offline gate but still honours the debounce', () => {
  const win = stubTarget()
  let clock = 0
  const restarts: string[] = []
  attachLivenessTriggers(win as never, undefined, {
    restart: () => restarts.push('restart'),
    windowEvents: ['system-resume', 'online'],
    alwaysFireEvents: ['system-resume'],
    isOnline: () => false,
    now: () => clock,
  })
  // An OS wake is the one moment the browser's offline flag is least
  // trustworthy (a page frozen across suspend/resume can miss `online`).
  win.emit('system-resume')
  assert.deepEqual(restarts, ['restart'], 'the wake event forces one bounded attempt')
  // The forced event still shares the debounce with every other trigger.
  clock += DEFAULT_MIN_RESTART_INTERVAL_MS - 1
  win.emit('system-resume')
  assert.deepEqual(restarts, ['restart'], 'a second wake inside the debounce window collapses')
  clock += 1
  win.emit('system-resume')
  assert.deepEqual(restarts, ['restart', 'restart'])
  // A non-always-fire event stays gated while offline.
  win.emit('online')
  assert.deepEqual(restarts, ['restart', 'restart'])
})

test('liveness: an always-fire event list is empty by default (no bypass without opting in)', () => {
  const win = stubTarget()
  const restarts: string[] = []
  attachLivenessTriggers(win as never, undefined, {
    restart: () => restarts.push('restart'),
    windowEvents: ['system-resume'],
    isOnline: () => false,
  })
  win.emit('system-resume')
  assert.deepEqual(restarts, [], 'without alwaysFireEvents the offline gate still applies')
})

test('liveness: without an explicit gate the browser navigator.onLine decides', () => {
  const win = stubTarget()
  const restarts: string[] = []
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
  try {
    attachLivenessTriggers(win as never, undefined, {
      restart: () => restarts.push('restart'),
      windowEvents: ['online'],
    })
    win.emit('online')
    assert.deepEqual(restarts, [], 'navigator.onLine === false blocks the reconnect')
  } finally {
    if (previousNavigator === undefined) delete (globalThis as Record<string, unknown>).navigator
    else Object.defineProperty(globalThis, 'navigator', previousNavigator)
  }
})
