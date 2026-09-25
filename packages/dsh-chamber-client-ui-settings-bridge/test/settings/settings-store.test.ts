/**
 * settings-store tests: hydration self-heal (a one-shot bridge get()
 * failure or a late bridge must never strand the store unhydrated forever)
 * + optimistic-save overlay (闪烁修复: a pending save is
 * visible immediately, a failed save rolls back, and an older save settling
 * late never flashes over a newer overlay).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChamberSettings, ChamberSettingsStatus, SettingsSurface } from '../../src/ambient/settings-bridge.d.ts'
import { notificationsPatch } from '../../src/client/notifications-settings.ts'
import { sessionTodoPatch } from '../../src/client/session-todo-settings.ts'

function statusWith(overrides?: Partial<ChamberSettings>,
  debugRuntime?: ChamberSettingsStatus['debugRuntime']): ChamberSettingsStatus {
  const base: ChamberSettings = {
    windowCloseBehavior: 'quit', launchAtLogin: false, keepAwake: false, quitConfirmation: true,
    vscodeOpenInNewWindow: true, registryOrigin: 'https://registry.npmjs.org',
    notifications: { enabled: false, mode: 'hidden-only', onComplete: true, onAsk: true, onRequest: true, badgeEnabled: true },
    sessionTodo: { enabled: true, onComplete: true, onAsk: true, onRequest: true },
    debug: { enabled: false },
  }
  return {
    settings: overrides === undefined ? base : { ...base, ...overrides },
    supported: { launchAtLogin: true, closeToTray: true, debugInspectable: true },
    ...(debugRuntime === undefined ? {} : { debugRuntime }),
  }
}

function fakeSurface(behavior: {
  failFirstGet?: boolean
  setError?: string
  setDelayMs?: number
} = {}): SettingsSurface & {
  getCalls: number
  setCalls: number
  /** Mutable host read-back the fake returns (only the main process can produce it). */
  debugRuntime: ChamberSettingsStatus['debugRuntime']
} {
  const surface = {
    getCalls: 0,
    setCalls: 0,
    // The bridge's authoritative state: patches accumulate like the real main
    // process (deep-merge, never drop nested sibling keys).
    applied: statusWith().settings,
    // 宿主实测回读（投影事实面）：只有主进程能提供，overlay 永远不得编造。
    debugRuntime: undefined as ChamberSettingsStatus['debugRuntime'],
    async get(): Promise<ChamberSettingsStatus> {
      surface.getCalls += 1
      if (behavior.failFirstGet === true && surface.getCalls === 1) {
        throw new Error('simulated bridge invoke failure')
      }
      return statusWith(surface.applied, surface.debugRuntime)
    },
    async set(patch: Partial<ChamberSettings>): Promise<ChamberSettingsStatus | { error: string; code?: string }> {
      surface.setCalls += 1
      if (behavior.setError !== undefined) return { error: behavior.setError }
      if (behavior.setDelayMs !== undefined) await new Promise(resolve => setTimeout(resolve, behavior.setDelayMs))
      surface.applied = {
        ...surface.applied,
        ...patch,
        notifications: patch.notifications !== undefined ? { ...surface.applied.notifications, ...patch.notifications } : surface.applied.notifications,
        sessionTodo: patch.sessionTodo !== undefined ? { ...surface.applied.sessionTodo, ...patch.sessionTodo } : surface.applied.sessionTodo,
        debug: patch.debug !== undefined ? { ...surface.applied.debug, ...patch.debug } : surface.applied.debug,
      }
      return statusWith(surface.applied, surface.debugRuntime)
    },
    onChanged(): () => void { return () => {} },
  }
  return surface
}

/** Fresh module instance (the store is a module-level singleton). */
function freshStore(): Promise<typeof import('../../src/client/settings-store.ts')> {
  return import(`../../src/client/settings-store.ts?case=${Math.random().toString(36).slice(2)}`)
}

async function hydrate(store: typeof import('../../src/client/settings-store.ts'),
  message = 'the store hydrates before the save under test'): Promise<void> {
  const deadline = Date.now() + 2_000
  while (store.getSettingsStatus() === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.notEqual(store.getSettingsStatus(), null, message)
}

test('a one-shot bridge get() failure self-heals through the retry chain', async () => {
  const surface = fakeSurface({ failFirstGet: true })
  ;(globalThis as Record<string, unknown>).window = {
    dshChamber: { settings: surface },
  }
  const store = await freshStore()
  try {
    // The module hydrates on import: the first get() rejects, the retry chain
    // re-attaches (backoff starts at 100ms) and the second get() lands.
    await hydrate(store, 'the store hydrates after a transient get() failure')
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
      await hydrate(store, 'a late bridge hydrates through the re-probe')
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
    // Nested sessionTodo patch: same deep-merge discipline.
    const pendingTodo = store.applySettingsPatch(sessionTodoPatch({ enabled: false }))
    assert.equal(store.getSettingsStatus()?.settings.sessionTodo.enabled, false)
    assert.equal(store.getSettingsStatus()?.settings.sessionTodo.onComplete, true, 'sessionTodo sibling keys survive the overlay')
    // Nested debug patch: same deep-merge discipline（单键块也走同一合流，
    // 未来加键时旧快照不会清掉兄弟键）。
    const pendingDebug = store.applySettingsPatch({ debug: { enabled: true } })
    assert.equal(store.getSettingsStatus()?.settings.debug.enabled, true, 'debug overlay is visible immediately')
    const [first, second, third, fourth] = await Promise.all([pending, pendingNested, pendingTodo, pendingDebug])
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(third.ok, true)
    assert.equal(fourth.ok, true)
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, true)
    assert.equal(store.getSettingsStatus()?.settings.notifications.enabled, true)
    assert.equal(store.getSettingsStatus()?.settings.sessionTodo.enabled, false)
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
    // A failed NESTED sessionTodo save rolls back the same way — sibling keys
    // and the whole block stay authoritative (dropOptimistic is
    // block-agnostic; this pins the nested path).
    const nested = await store.applySettingsPatch(sessionTodoPatch({ enabled: false }))
    assert.equal(nested.ok, false)
    assert.equal(store.getSettingsStatus()?.settings.sessionTodo.enabled, true, 'nested rollback restores the authoritative value')
    assert.equal(store.getSettingsStatus()?.settings.sessionTodo.onComplete, true, 'sibling keys stay authoritative')
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('the optimistic overlay never fabricates the host read-back (debugRuntime stays a host fact)', async () => {
  const surface = fakeSurface({ setDelayMs: 40 })
  // 宿主事实：开关想开、实测没开成（无窗）。投影必须原样带着它，直到主进程换掉。
  surface.debugRuntime = {
    inspectable: false,
    apiAvailable: true,
    reason: 'swift-edge-ui-unavailable:setDebugMode:no-window',
  }
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { settings: surface } }
  const store = await freshStore()
  try {
    await hydrate(store)
    const pending = store.applySettingsPatch({ debug: { enabled: true } })
    // 意图立刻可见（开关不回弹）……
    assert.equal(store.getSettingsStatus()?.settings.debug.enabled, true, 'optimistic debug overlay is visible immediately')
    // ……但事实面照旧：overlay 只覆盖 settings，绝不编造 debugRuntime（编造 = UI 假绿）。
    assert.deepEqual(store.getSettingsStatus()?.debugRuntime, {
      inspectable: false,
      apiAvailable: true,
      reason: 'swift-edge-ui-unavailable:setDebugMode:no-window',
    }, 'the overlay never invents the host read-back')
    await pending
    assert.deepEqual(store.getSettingsStatus()?.debugRuntime, {
      inspectable: false,
      apiAvailable: true,
      reason: 'swift-edge-ui-unavailable:setDebugMode:no-window',
    })
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('a failed debug save rolls the intent back without touching the host read-back', async () => {
  const surface = fakeSurface({ setError: 'persist failed' })
  surface.debugRuntime = { inspectable: true, apiAvailable: true }
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { settings: surface } }
  const store = await freshStore()
  try {
    await hydrate(store)
    const result = await store.applySettingsPatch({ debug: { enabled: true } })
    assert.equal(result.ok, false)
    assert.equal(store.getSettingsStatus()?.settings.debug.enabled, false, 'intent rolls back')
    assert.deepEqual(store.getSettingsStatus()?.debugRuntime, { inspectable: true, apiAvailable: true },
      'the host fact (inspector still open) survives the rollback — 撤销失败绝不能被藏起来')
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('a NEWER save failing never clears an OLDER in-flight overlay (and reports its own error)', async () => {
  const held: Array<{
    patch: Partial<ChamberSettings>
    resolve: (v: ChamberSettingsStatus | { error: string }) => void
  }> = []
  const surface = fakeSurface({})
  surface.set = ((patch: Partial<ChamberSettings>) => new Promise(resolve => {
    held.push({ patch, resolve })
  })) as typeof surface.set
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { settings: surface } }
  const store = await freshStore()
  try {
    await hydrate(store)
    const older = store.applySettingsPatch({ keepAwake: true })
    const newer = store.applySettingsPatch({ debug: { enabled: true } })
    // 新的一次失败 → 只回滚它自己；旧的那条仍在飞（稍后成功），绝不能被清掉。
    held[1]?.resolve({ error: 'persist failed' })
    assert.equal((await newer).ok, false, '新的一次如实报错（不假装成功）')
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, true, 'older in-flight overlay survives')
    assert.equal(store.getSettingsStatus()?.settings.debug.enabled, false, 'failed newest patch rolled back')
    held[0]?.resolve(statusWith({ keepAwake: true }))
    assert.equal((await older).ok, true)
    assert.equal(store.getSettingsStatus()?.settings.keepAwake, true, 'no flash back to the stale value')
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
