/**
 * node:test for the chamber liveness-triggers patch
 * (`packages/dsh-client-connection/src/client/liveness-triggers.ts`) — the
 * sleep/wake recovery triggers: window events (system-resume / online) restart
 * immediately, a long hidden span restarts on visibility return, short
 * alt-tabs never restart, and the detach removes every listener.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

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
