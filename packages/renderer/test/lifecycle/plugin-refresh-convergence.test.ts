/**
 * Plugin-refresh convergence policy (design 09 §3.7 / design 15 §6).
 *
 * One settled plugin/bundle change must (a) re-subscribe the client-plugin graph ONLY
 * when the action's own frame has not arrived, and (b) watch a BOUNDED window for the
 * page-level `restart-required` fact. Provenance is the action START time: the host
 * frame (and the fact it writes) usually lands BEFORE the RPC answer that settles the
 * action, and live-graph dedupes an identical fact — so the subscription's synchronous
 * replay of a fact from THIS action must be honored, while an older fact must not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'
import {
  createPluginRefreshConvergence, type PluginRefreshConvergenceDeps,
} from '../../src/plugin-refresh-convergence.ts'

/** Fake diagnostic source: `subscribe` replays the current record like the real bridge. */
function fakeDiagnostics() {
  const listeners = new Set<(diagnostic: PluginGraphDiagnostic | undefined) => void>()
  let replay: PluginGraphDiagnostic | undefined
  return {
    setReplay(diagnostic: PluginGraphDiagnostic | undefined): void { replay = diagnostic },
    subscribe(listener: (diagnostic: PluginGraphDiagnostic | undefined) => void): () => void {
      if (replay !== undefined) listener(replay)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(diagnostic: PluginGraphDiagnostic | undefined): void {
      for (const listener of [...listeners]) listener(diagnostic)
    },
    get size(): number { return listeners.size },
  }
}

/** Timer fake with real clear semantics (a cleared timer never fires). */
function harness(over: Partial<PluginRefreshConvergenceDeps> = {}) {
  const diagnostics = fakeDiagnostics()
  const reloads: string[] = []
  const warns: string[] = []
  const resyncs: string[] = []
  const clock = { now: 1_000 }
  const timers: Array<{ handler: () => void; ms: number }> = []
  const cleared: unknown[] = []
  const convergence = createPluginRefreshConvergence({
    resync: () => { resyncs.push('resync'); return true },
    subscribeDiagnostic: listener => diagnostics.subscribe(listener),
    requestReload: () => { reloads.push('reload'); return true },
    now: () => clock.now,
    warn: message => { warns.push(message) },
    setTimeout: (handler, ms) => {
      const handle = { handler, ms }
      timers.push(handle)
      return handle
    },
    clearTimeout: handle => {
      cleared.push(handle)
      const index = timers.indexOf(handle as { handler: () => void; ms: number })
      if (index >= 0) timers.splice(index, 1)
    },
    ...over,
  })
  return {
    convergence, diagnostics, reloads, warns, resyncs, clock, timers, cleared,
    fireWindow(): void { for (const handle of timers.splice(0)) handle.handler() },
  }
}

const restart = (updatedAt: number): PluginGraphDiagnostic => ({ state: 'restart-required', updatedAt })

test('the fact written while the action ran (frame before settle) reloads through the replay', () => {
  const h = harness()
  h.clock.now = 1_050
  h.diagnostics.setReplay(restart(1_020))
  h.convergence.notifyChange(1_000)
  assert.deepEqual(h.reloads, ['reload'], 'a fact from this action is not a stale replay')
  assert.deepEqual(h.resyncs, [], 'the replay ends the window before any resync')
  assert.equal(h.diagnostics.size, 0)
  assert.equal(h.timers.length, 0)
})

test('a stale replay is ignored; every settle re-subscribes the topic', () => {
  const h = harness()
  h.clock.now = 1_050
  h.diagnostics.setReplay(restart(900))
  h.convergence.notifyChange(1_000)
  assert.deepEqual(h.reloads, [])
  assert.deepEqual(h.resyncs, ['resync'], 'no frame shortcut: the resync itself is the recovery')
  assert.equal(h.diagnostics.size, 1, 'the window stays open')
  h.diagnostics.emit(restart(1_500))
  assert.deepEqual(h.reloads, ['reload'])
})

test('a failed resync warns but still arms the window', () => {
  const h = harness({ resync: () => false })
  h.convergence.notifyChange(1_000)
  assert.equal(h.warns.filter(m => m.includes('no live client-plugin subscription')).length, 1)
  h.diagnostics.emit(restart(1_500))
  assert.deepEqual(h.reloads, ['reload'])
})

test('a fact older than the wall-clock window does not reload (timer throttling cannot extend it)', () => {
  const h = harness()
  h.clock.now = 1_050
  h.convergence.notifyChange(1_000)
  h.clock.now = 1_050 + 5_001
  h.diagnostics.emit(restart(1_400))
  assert.deepEqual(h.reloads, [])
  h.fireWindow()
  h.diagnostics.emit(restart(1_600))
  assert.deepEqual(h.reloads, [], 'the ended window stays ended')
})

test('a new action start closes the open window (a later action is never reloaded mid-flight)', () => {
  const h = harness()
  h.convergence.notifyChange(1_000)
  h.convergence.notifyActionStart()
  assert.equal(h.diagnostics.size, 0)
  assert.equal(h.timers.length, 0)
  h.diagnostics.emit(restart(1_200))
  assert.deepEqual(h.reloads, [])
})

test('non-restart facts and a later change replacing the window keep exactly one reload', () => {
  const h = harness()
  h.convergence.notifyChange(1_000)
  h.diagnostics.emit({ state: 'ok', updatedAt: 1_100 })
  h.diagnostics.emit({ state: 'bundle-load-failed', updatedAt: 1_100 })
  h.clock.now = 1_200
  h.convergence.notifyChange(1_150)
  assert.equal(h.diagnostics.size, 1, 'one watch per settled change')
  assert.equal(h.timers.length, 1)
  h.diagnostics.emit(restart(1_300))
  assert.equal(h.reloads.length, 1)
})

test('a denied reload does not consume the window (a later fact can still fire)', () => {
  const h = harness({ requestReload: () => false })
  h.clock.now = 1_050
  h.convergence.notifyChange(1_000)
  h.diagnostics.emit(restart(1_300))
  assert.deepEqual(h.reloads, [])
  assert.equal(h.diagnostics.size, 1, 'the window stays open until the deadline')
  assert.equal(h.timers.length, 1)
})

test('dispose is terminal: a later settle cannot reopen a window', () => {
  const h = harness()
  h.convergence.dispose()
  h.convergence.notifyChange(1_000)
  assert.equal(h.diagnostics.size, 0)
  assert.equal(h.timers.length, 0)
  assert.deepEqual(h.resyncs, [])
})

test('dispose ends the watch, clears the timer and ignores later facts', () => {
  const h = harness()
  h.convergence.notifyChange(1_000)
  h.convergence.dispose()
  assert.equal(h.diagnostics.size, 0)
  assert.equal(h.cleared.length, 1)
  h.diagnostics.emit(restart(1_500))
  assert.deepEqual(h.reloads, [])
})
