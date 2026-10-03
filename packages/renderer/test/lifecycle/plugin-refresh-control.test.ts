/**
 * Shell glue contracts for plugin-refresh convergence (design 09 §3.7 / design 15 §6):
 * the page-wide reload gate (single-flight + plugin-refresh budget + ignored-navigation
 * re-arm) and the per-boot control face (boot fence + dispose). The convergence policy
 * itself is covered by plugin-refresh-convergence.test.ts; this file covers the shell
 * wiring that used to live untestably inside shell.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'
import {
  createPluginRefreshControl, createPluginRefreshReloadGate, type PluginRefreshControlDeps,
  type PluginRefreshReloadDeps,
} from '../../src/plugin-refresh-control.ts'
import type { ReloadBudgetStorage } from '../../src/document-reload-budget.ts'

const PLUGIN_KEY = 'dsh-chamber.plugin-reloads.v1'

/** sessionStorage-shaped fake; a fresh slot map per call unless seeded. */
function memoryStorage(seed: Record<string, string> = {}): ReloadBudgetStorage {
  const slots: Record<string, string> = { ...seed }
  return {
    getItem: key => slots[key] ?? null,
    setItem: (key, value) => { slots[key] = value },
  }
}

function gateHarness(over: Partial<PluginRefreshReloadDeps> = {}) {
  const reloads: string[] = []
  const warns: string[] = []
  const timers: Array<{ handler: () => void; ms: number }> = []
  const cleared: unknown[] = []
  const state = { now: 1_000 }
  const gate = createPluginRefreshReloadGate({
    reload: () => { reloads.push('reload') },
    storage: () => memoryStorage(),
    now: () => state.now,
    schedule: (handler, ms) => {
      const handle = { handler, ms }
      timers.push(handle)
      return handle
    },
    clearSchedule: handle => {
      cleared.push(handle)
      const index = timers.indexOf(handle as { handler: () => void; ms: number })
      if (index >= 0) timers.splice(index, 1)
    },
    warn: message => { warns.push(message) },
    ...over,
  })
  return {
    gate, reloads, warns, timers, cleared, state,
    fireReset(): void { for (const handle of timers.splice(0)) handle.handler() },
  }
}

test('the gate reloads once and holds single-flight while a navigation is pending', () => {
  const h = gateHarness()
  assert.equal(h.gate.request('local'), true)
  assert.deepEqual(h.reloads, ['reload'])
  assert.equal(h.gate.request('local'), false, 'a second armed reload is refused')
  assert.deepEqual(h.reloads, ['reload'])
  assert.equal(h.timers.length, 1, 'the ignored-navigation probe is armed')
})

test('the plugin-refresh budget denies a reload fail-closed (absent or exhausted storage)', () => {
  const absent = gateHarness({ storage: () => undefined })
  assert.equal(absent.gate.request('local'), false)
  assert.deepEqual(absent.reloads, [])
  assert.equal(absent.warns.filter(message => message.includes('denied by the reload budget')).length, 1)

  const seeded = gateHarness({ storage: () => memoryStorage({ [PLUGIN_KEY]: JSON.stringify([999, 998, 997]) }) })
  seeded.state.now = 1_000
  assert.equal(seeded.gate.request('local'), false, 'three attempts inside the window exhaust the quota')
  assert.deepEqual(seeded.reloads, [])
})

test('a throwing reload releases single-flight', () => {
  const attempts: string[] = []
  const h = gateHarness({ reload: () => { attempts.push('reload'); throw new Error('blocked') } })
  assert.equal(h.gate.request('local'), false)
  assert.equal(h.warns.filter(message => message.includes('failed')).length, 1)
  assert.equal(h.gate.request('local'), false)
  assert.deepEqual(attempts, ['reload', 'reload'], 'the flag was released, so the gate tried again')
})

test('a silently ignored reload re-arms after the grace window (attempt budget stays consumed)', () => {
  const h = gateHarness()
  assert.equal(h.gate.request('local'), true)
  h.fireReset()
  assert.equal(h.warns.filter(message => message.includes('did not navigate; re-armed')).length, 1)
  assert.equal(h.gate.request('local'), true, 'a later action can still converge')
  assert.equal(h.reloads.length, 2)
})

test('dispose cancels the ignored-navigation probe', () => {
  const h = gateHarness()
  assert.equal(h.gate.request('local'), true)
  h.gate.dispose()
  assert.equal(h.cleared.length, 1)
  assert.equal(h.timers.length, 0)
  h.fireReset()
  assert.equal(h.reloads.length, 1)
})

function controlHarness(over: Partial<PluginRefreshControlDeps> = {}) {
  const listeners = new Set<(diagnostic: PluginGraphDiagnostic | undefined) => void>()
  const resyncs: string[] = []
  const reloads: string[] = []
  const state = { current: true }
  const control = createPluginRefreshControl({
    isCurrentBoot: () => state.current,
    resync: () => { resyncs.push('resync'); return true },
    subscribeDiagnostic: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    requestReload: () => { reloads.push('reload'); return true },
    ...over,
  })
  return {
    control, listeners, resyncs, reloads, state,
    emit(diagnostic: PluginGraphDiagnostic | undefined): void {
      for (const listener of [...listeners]) listener(diagnostic)
    },
  }
}

const restartFact = (updatedAt: number): PluginGraphDiagnostic => ({ state: 'restart-required', updatedAt })

test('a settled change of the current boot resyncs and watches the restart fact', () => {
  const h = controlHarness()
  h.control.requestRefresh(1_000)
  assert.deepEqual(h.resyncs, ['resync'])
  assert.equal(h.listeners.size, 1)
  h.emit(restartFact(1_100))
  assert.deepEqual(h.reloads, ['reload'])
  assert.equal(h.listeners.size, 0, 'a granted reload ends the watch')
})

test('a superseded boot can neither open a window nor resync', () => {
  const h = controlHarness()
  h.state.current = false
  h.control.requestRefresh(1_000)
  assert.deepEqual(h.resyncs, [])
  assert.equal(h.listeners.size, 0)
})

test('the boot fence is re-checked when the fact arrives', () => {
  const h = controlHarness()
  h.control.requestRefresh(1_000)
  h.state.current = false
  h.emit(restartFact(1_100))
  assert.deepEqual(h.reloads, [], 'a superseded boot must not navigate')
  assert.equal(h.listeners.size, 1, 'the denied reload keeps the window open')
  h.control.dispose()
})

test('actionStarted closes the window; dispose is terminal', () => {
  const h = controlHarness()
  h.control.requestRefresh(1_000)
  h.control.actionStarted()
  assert.equal(h.listeners.size, 0)
  h.control.requestRefresh(2_000)
  assert.equal(h.listeners.size, 1)
  h.control.dispose()
  assert.equal(h.listeners.size, 0)
  h.control.requestRefresh(3_000)
  assert.equal(h.listeners.size, 0, 'a disposed control cannot reopen a window')
  assert.equal(h.resyncs.length, 2)
})
