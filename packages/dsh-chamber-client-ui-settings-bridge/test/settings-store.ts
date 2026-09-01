/**
 * settings-store tests: hydration self-heal (P2 regression — a one-shot
 * bridge get() failure or a late bridge must never strand the store
 * unhydrated forever) + optimistic-save overlay (闪烁修复: a pending save is
 * visible immediately, a failed save rolls back, and an older save settling
 * late never flashes over a newer overlay).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChamberSettings, ChamberSettingsStatus, SettingsSurface } from '../src/ambient/settings-bridge.d.ts'
import { notificationsPatch } from '../src/client/notifications-settings.ts'

function statusWith(overrides?: Partial<ChamberSettings>): ChamberSettingsStatus {
  const base: ChamberSettings = {
    windowCloseBehavior: 'quit',
    launchAtLogin: false,
    keepAwake: false,
    quitConfirmation: true,
    registryOrigin: 'https://registry.npmjs.org',
    notifications: { enabled: false, mode: 'hidden-only', onComplete: true, onAsk: true, onRequest: true },
  }
  return {
    settings: overrides === undefined ? base : { ...base, ...overrides },
    supported: { launchAtLogin: true, closeToTray: true },
  }
}

function fakeSurface(behavior: {
  failFirstGet?: boolean
  setError?: string
  setDelayMs?: number
} = {}): SettingsSurface & { getCalls: number; setCalls: number } {
  const surface = {
    getCalls: 0,
    setCalls: 0,
    // The bridge's authoritative state: patches accumulate like the real main
    // process (deep-merge, never drop nested sibling keys).
    applied: statusWith().settings,
    async get(): Promise<ChamberSettingsStatus> {
      surface.getCalls += 1
      if (behavior.failFirstGet === true && surface.getCalls === 1) {
        throw new Error('simulated bridge invoke failure')
      }
      return statusWith(surface.applied)
    },
    async set(patch: Partial<ChamberSettings>): Promise<ChamberSettingsStatus | { error: string; code?: string }> {
      surface.setCalls += 1
      if (behavior.setError !== undefined) return { error: behavior.setError }
      if (behavior.setDelayMs !== undefined) {
        await new Promise(resolve => setTimeout(resolve, behavior.setDelayMs))
      }
      surface.applied = {
        ...surface.applied,
        ...patch,
        notifications: patch.notifications !== undefined
          ? { ...surface.applied.notifications, ...patch.notifications }
          : surface.applied.notifications,
      }
      return statusWith(surface.applied)
    },
    onChanged(): () => void {
      return () => {}
    },
  }
  return surface
}

/** Fresh module instance (the store is a module-level singleton). */
function freshStore(): Promise<typeof import('../src/client/settings-store.ts')> {
  return import(`../src/client/settings-store.ts?case=${Math.random().toString(36).slice(2)}`)
}

async function hydrate(store: typeof import('../src/client/settings-store.ts')): Promise<void> {
  const deadline = Date.now() + 2_000
  while (store.getSettingsStatus() === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.notEqual(store.getSettingsStatus(), null, 'the store hydrates before the save under test')
}

test('a one-shot bridge get() failure self-heals through the retry chain', async () => {
  const surface = fakeSurface({ failFirstGet: true })
  ;(globalThis as Record<string, unknown>).window = {
    dshChamber: { settings: surface },
  }
  const store = await freshStore()
  try {
    // The module hydrates on import: the first get() rejects, the retry
    // chain re-attaches (backoff starts at 100ms) and the second get()
    // lands. Poll up to 2s.
    const deadline = Date.now() + 2_000
    while (store.getSettingsStatus() === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.notEqual(store.getSettingsStatus(), null, 'the store hydrates after a transient get() failure')
    assert.ok(surface.getCalls >= 2, `the retry chain re-attached (getCalls=${surface.getCalls})`)
    assert.equal(store.getSettingsStatus()?.settings.registryOrigin, 'https://registry.npmjs.org')
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('a late bridge still hydrates through the retry chain while subscribers wait', async () => {
  ;(globalThis as Record<string, unknown>).window = {}
  const store = await freshStore()
  try {
    const unsubscribe = store.subscribeSettings(() => {})
    try {
      // The bridge arrives after the module already gave up its fast chain.
      const surface = fakeSurface({})
      ;((globalThis as Record<string, unknown>).window as { dshChamber?: unknown }).dshChamber = { settings: surface }
      const deadline = Date.now() + 2_000
      while (store.getSettingsStatus() === null && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.notEqual(store.getSettingsStatus(), null, 'a late bridge hydrates through the re-probe')
      assert.ok(surface.getCalls >= 1, 'the late bridge was queried')
    } finally {
      unsubscribe()
    }
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('a pending save overlays the snapshot optimistically (no flash window)', async () => {
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { settings: fakeSurface({ setDelayMs: 60 }) } }
  const store = await freshStore()
  try {
    await hydrate(store)
    const pending = store.applySettingsPatch({ keepAwake: true })
    // The overlay is visible BEFORE the bridge settles — the control reflects
    // the click in the same frame instead of flashing a disabled/dimmed state.
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, true, 'optimistic overlay is visible immediately')
    // Nested notifications patch: the overlay deep-merges, never dropping
    // sibling keys of the authoritative block.
    const pendingNested = store.applySettingsPatch(notificationsPatch({ enabled: true }))
    assert.equal(store.getSettingsStatus()?.settings.notifications.enabled, true)
    assert.equal(store.getSettingsStatus()?.settings.notifications.mode, 'hidden-only', 'sibling keys survive the overlay')
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, true, 'earlier top-level overlay still applied')
    const [first, second] = await Promise.all([pending, pendingNested])
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, true)
    assert.equal(store.getSettingsStatus()?.settings.notifications.enabled, true)
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('a failed save rolls the optimistic overlay back', async () => {
  ;(globalThis as Record<string, unknown>).window = {
    dshChamber: { settings: fakeSurface({ setError: 'persist failed' }) },
  }
  const store = await freshStore()
  try {
    await hydrate(store)
    const result = await store.applySettingsPatch({ keepAwake: true })
    assert.equal(result.ok, false)
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, false, 'rollback restores the authoritative value')
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('an older save settling late never flashes over a newer optimistic overlay', async () => {
  // Programmable bridge: each set() is held until the test releases it.
  const held: Array<{ patch: Partial<ChamberSettings>; resolve: (v: ChamberSettingsStatus) => void }> = []
  const surface = fakeSurface({})
  surface.set = (patch: Partial<ChamberSettings>) => new Promise<ChamberSettingsStatus>(resolve => {
    held.push({ patch, resolve })
  })
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { settings: surface } }
  const store = await freshStore()
  try {
    await hydrate(store)
    const first = store.applySettingsPatch({ keepAwake: true })
    const second = store.applySettingsPatch({ keepAwake: false })
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, false, 'the NEWER overlay owns the snapshot')
    assert.equal(store.getSettingsStatus()?.settings.notifications.mode, 'hidden-only', 'accumulated overlays keep nested siblings')
    // Release the OLDER save first: its result must not clear the newer overlay.
    held[0]?.resolve(statusWith({ keepAwake: true }))
    await first
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, false, 'an older settle never flashes its value over the newer overlay')
    held[1]?.resolve(statusWith({ keepAwake: false }))
    await second
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, false, 'the authoritative value settles')
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})
