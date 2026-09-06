/**
 * update-store.ts module-level restart recovery-rule tests (design 11,
 * 2026-12 review round-2 coverage gap (a)) — node:test, no DOM.
 *
 * The store's module restart single-flight (mirroring the main-process
 * single-flight) is deliberately NOT reset when the main process ACCEPTED a
 * restart ({ok:true} — quitAndInstall armed, the app is on its way out). It
 * MUST release when a PUSHED state proves the restart actually failed, or
 * every later click would be silently refused ('restart already in progress')
 * until an app reload. Failure proof per the recovery rule: the pushed state
 * carries restartFailureText (main keeps phase `downloaded` there), or the
 * phase left {downloaded, downloading} toward 'error'/'up-to-date' (belt).
 * The module is node-importable without a DOM: its only ambient import is
 * type-only (erased at runtime) and every window access is typeof-guarded —
 * tests install a fake window.dshChamber.update BEFORE importing a fresh
 * module instance (query-cache-busted, same pattern as settings-store.test.ts)
 * and drive the recovery rule through the fake surface's onChanged push.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UpdateState, UpdateSurface } from '../src/ambient/update-bridge.d.ts'

/** A completed-download state (the phase a restart arm requires). */
function downloadedState(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: 'downloaded',
    currentVersion: '0.2.2',
    latestVersion: '0.3.0',
    channel: 'stable',
    downloadPercent: 100,
    releaseUrl: 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.3.0',
    installBlockedReason: null,
    error: null,
    ...overrides,
  }
}

/** Fake UpdateSurface with a recordable push (the store's onChanged sink). */
function fakeUpdateSurface(): {
  surface: UpdateSurface & { restartCalls: number }
  push: (state: UpdateState) => void
} {
  let changed: ((state: UpdateState) => void) | null = null
  const surface: UpdateSurface & { restartCalls: number } = {
    restartCalls: 0,
    onChanged(listener: (state: UpdateState) => void): () => void {
      changed = listener
      return () => { changed = null }
    },
    async state(): Promise<UpdateState> {
      return downloadedState()
    },
    async check(): Promise<{ ok: true } | { ok: false; error: string }> {
      return { ok: true }
    },
    async download(): Promise<{ ok: true } | { ok: false; error: string }> {
      return { ok: true }
    },
    async restartAndInstall(): Promise<{ ok: true } | { ok: false; error: string }> {
      surface.restartCalls += 1
      return { ok: true }
    },
    async openReleasePage(): Promise<{ ok: true } | { ok: false; error: string }> {
      return { ok: true }
    },
  }
  const push = (state: UpdateState): void => {
    assert.notEqual(changed, null, 'the bridge onChanged subscription must be attached before a push')
    changed?.(state)
  }
  return { surface, push }
}

/** Fresh module instance (the store is a module-level singleton). */
function freshStore(): Promise<typeof import('../src/client/update-store.ts')> {
  return import(`../src/client/update-store.ts?case=${Math.random().toString(36).slice(2)}`)
}

async function waitHydrated(store: typeof import('../src/client/update-store.ts')): Promise<void> {
  const deadline = Date.now() + 2_000
  while (store.getUpdateState() === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.notEqual(store.getUpdateState(), null, 'the store hydrates from the fake surface')
}

test('restart recovery rule: a pushed state carrying restartFailureText releases the module gate', async () => {
  const { surface, push } = fakeUpdateSurface()
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { update: surface } }
  const store = await freshStore()
  try {
    await waitHydrated(store)
    // The main process ACCEPTS the restart ({ok:true} = quitAndInstall armed):
    // the module gate is deliberately NOT reset (armed-forever-quit) — a
    // second click in the quit window is refused.
    assert.deepEqual(await store.requestUpdateRestart(), { ok: true })
    assert.equal(surface.restartCalls, 1)
    assert.deepEqual(await store.requestUpdateRestart(), { ok: false, error: 'restart already in progress' })
    // A pushed state proving the restart FAILED — main keeps phase
    // `downloaded` and rides the one-shot restartFailureText carry — must
    // release the gate so the in-place retry goes through.
    push(downloadedState({ restartFailureText: 'Cannot read [path]' }))
    assert.equal(store.getUpdateState()?.restartFailureText, 'Cannot read [path]', 'the push updates the snapshot')
    const retry = await store.requestUpdateRestart()
    assert.equal(retry.ok, true, 'a failure-carrying push must release the module gate for an in-place retry')
    assert.equal(surface.restartCalls, 2)
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('restart recovery rule: a plain downloaded push WITHOUT a failure keeps the gate armed', async () => {
  const { surface, push } = fakeUpdateSurface()
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { update: surface } }
  const store = await freshStore()
  try {
    await waitHydrated(store)
    assert.deepEqual(await store.requestUpdateRestart(), { ok: true })
    assert.equal(surface.restartCalls, 1)
    // A plain downloaded re-push (no restartFailureText, phase stays
    // `downloaded`): not a failure proof — the armed-forever-quit semantics
    // keep the single-flight held until the actual quit.
    push(downloadedState())
    const again = await store.requestUpdateRestart()
    assert.deepEqual(again, { ok: false, error: 'restart already in progress' },
      'a plain downloaded push must NOT release the gate (the quit is still expected)')
    assert.equal(surface.restartCalls, 1)
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('restart recovery rule: a pushed phase error releases the module gate (belt leg)', async () => {
  const { surface, push } = fakeUpdateSurface()
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { update: surface } }
  const store = await freshStore()
  try {
    await waitHydrated(store)
    assert.deepEqual(await store.requestUpdateRestart(), { ok: true })
    assert.equal(surface.restartCalls, 1)
    // The phase left `downloaded` toward 'error' — a restart failure by the
    // belt rule (normally unreachable while armed, harmless when not armed).
    push(downloadedState({ phase: 'error', downloadPercent: null, error: 'Cannot read [path]' }))
    const retry = await store.requestUpdateRestart()
    assert.equal(retry.ok, true, 'an error-phase push must release the module gate')
    assert.equal(surface.restartCalls, 2)
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

test('restart recovery rule: a pushed up-to-date phase releases the module gate (belt leg)', async () => {
  const { surface, push } = fakeUpdateSurface()
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { update: surface } }
  const store = await freshStore()
  try {
    await waitHydrated(store)
    assert.deepEqual(await store.requestUpdateRestart(), { ok: true })
    assert.equal(surface.restartCalls, 1)
    // up-to-date is equally a failure proof under the recovery rule (a
    // downloaded state is final for this version; leaving it means the
    // restart flow died and a fresh check owns the section now).
    push(downloadedState({ phase: 'up-to-date', latestVersion: null, downloadPercent: null, releaseUrl: null }))
    const retry = await store.requestUpdateRestart()
    assert.equal(retry.ok, true, 'an up-to-date push must release the module gate')
    assert.equal(surface.restartCalls, 2)
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})
