/**
 * settings-store hydration self-heal tests (P2 regression): a one-shot
 * bridge get() failure — or a late bridge — must never strand the settings
 * store unhydrated forever; the retry chain re-attaches with backoff.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChamberSettingsStatus, SettingsSurface } from '../src/ambient/settings-bridge.d.ts'

function status(registryOrigin: string): ChamberSettingsStatus {
  return {
    settings: {
      windowCloseBehavior: 'quit',
      launchAtLogin: false,
      keepAwake: false,
      quitConfirmation: true,
      registryOrigin,
    },
    supported: { launchAtLogin: true, closeToTray: true },
  }
}

function fakeSurface(behavior: { failFirstGet?: boolean }): SettingsSurface & { getCalls: number } {
  const surface = {
    getCalls: 0,
    async get(): Promise<ChamberSettingsStatus> {
      surface.getCalls += 1
      if (behavior.failFirstGet === true && surface.getCalls === 1) {
        throw new Error('simulated bridge invoke failure')
      }
      return status('https://registry.npmjs.org')
    },
    async set(): Promise<ChamberSettingsStatus> {
      return status('https://registry.npmjs.org')
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
