/**
 * update-store.ts module-level restart recovery-rule tests (design 11) —
 * node:test, no DOM.
 *
 * The module restart single-flight (mirroring the main process) is deliberately NOT
 * reset when main ACCEPTED a restart ({ok:true} — quitAndInstall armed). It MUST
 * release when a PUSHED state proves the restart failed, or every later click would
 * be silently refused until an app reload. Failure proof per the recovery rule: the
 * push carries restartFailureText (main keeps phase `downloaded`), or the phase left
 * {downloaded, downloading} toward 'error'/'up-to-date' (belt). The module needs no
 * DOM; tests install a fake window.dshChamber.update BEFORE importing a fresh module
 * instance (query-cache-busted) and drive the rule through the onChanged push.
 *
 * Coverage: the「检查更新」invoke is module single-flight (one bridge edge per
 * click across N-ctx shells), the page runs no discovery, and the snapshot mirrors
 * the shell-pushed phases (checking → available/up-to-date/error).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UpdateState, UpdateSurface } from '../../src/ambient/update-bridge.d.ts'
import { updateCheckDisabled, updateRestartAvailable } from '../../src/client/update-gate.ts'

/** A completed-download state (the phase a restart arm requires). */
function downloadedState(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: 'downloaded', currentVersion: '0.2.2', latestVersion: '0.3.0', channel: 'stable',
    downloadPercent: 100, installBlockedReason: null, error: null, ...overrides,
    releaseUrl: 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.3.0',
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
function freshStore(): Promise<typeof import('../../src/client/update-store.ts')> {
  return import(`../../src/client/update-store.ts?case=${Math.random().toString(36).slice(2)}`)
}

/** Install the fake surface as the page bridge; returns the cleanup. */
function installUpdateSurface(surface: UpdateSurface): () => void {
  ;(globalThis as Record<string, unknown>).window = { dshChamber: { update: surface } }
  return () => { delete (globalThis as Record<string, unknown>).window }
}

async function waitHydrated(store: typeof import('../../src/client/update-store.ts')): Promise<void> {
  const deadline = Date.now() + 2_000
  while (store.getUpdateState() === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.notEqual(store.getUpdateState(), null, 'the store hydrates from the fake surface')
}

test('restart recovery rule: a pushed state carrying restartFailureText releases the module gate', async () => {
  const { surface, push } = fakeUpdateSurface()
  const cleanup = installUpdateSurface(surface)
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
  } finally { cleanup() }
})

test('restart recovery rule: a plain downloaded push WITHOUT a failure keeps the gate armed', async () => {
  const { surface, push } = fakeUpdateSurface()
  const cleanup = installUpdateSurface(surface)
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
  } finally { cleanup() }
})

test('restart recovery rule: a pushed phase error releases the module gate (belt leg)', async () => {
  const { surface, push } = fakeUpdateSurface()
  const cleanup = installUpdateSurface(surface)
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
  } finally { cleanup() }
})

test('restart recovery rule: a pushed up-to-date phase releases the module gate (belt leg)', async () => {
  const { surface, push } = fakeUpdateSurface()
  const cleanup = installUpdateSurface(surface)
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
  } finally { cleanup() }
})

test('native (Sparkle) phase pushes hydrate the same snapshot the Electron path consumes', async () => {
  const { surface, push } = fakeUpdateSurface()
  const cleanup = installUpdateSurface(surface)
  const store = await freshStore()
  try {
    await waitHydrated(store)
    // Shell reports the native downloading phase: no percentage (null) — the
    // snapshot must carry it as-is so UpdateSection renders the indeterminate row.
    push(downloadedState({ phase: 'downloading', downloadPercent: null, installBlockedReason: null }))
    assert.equal(store.getUpdateState()?.phase, 'downloading')
    assert.equal(store.getUpdateState()?.downloadPercent, null)
    // downloaded → the restart action is offered and maps to the surface call
    // (the same requestUpdateRestart the Electron path uses).
    push(downloadedState({ phase: 'downloaded', downloadPercent: 100, installBlockedReason: null }))
    assert.equal(store.getUpdateState()?.phase, 'downloaded')
    assert.equal(updateRestartAvailable(store.getUpdateState()?.phase, store.getUpdateState()?.installBlockedReason ?? null, 'darwin'), true)
    assert.deepEqual(await store.requestUpdateRestart(), { ok: true })
    assert.equal(surface.restartCalls, 1)
    // installing is a distinct native phase: no second restart affordance, and
    // the single-flight stays armed (the app is being replaced, not failed).
    push(downloadedState({ phase: 'installing', installBlockedReason: null }))
    assert.equal(store.getUpdateState()?.phase, 'installing')
    assert.equal(updateRestartAvailable(store.getUpdateState()?.phase, null, 'darwin'), false)
    // failed → error + sanitized text, releasing the restart gate for retry.
    push(downloadedState({ phase: 'error', downloadPercent: null, error: 'sparkle boom' }))
    assert.equal(store.getUpdateState()?.phase, 'error')
    assert.equal(store.getUpdateState()?.error, 'sparkle boom')
    assert.deepEqual(await store.requestUpdateRestart(), { ok: true })
    assert.equal(surface.restartCalls, 2)
  } finally { cleanup() }
})

test('S-21: one「检查更新」invoke emits exactly one bridge check — N-ctx shells share the module gate', async () => {
  let checkCalls = 0
  const releases: Array<() => void> = []
  const { surface } = fakeUpdateSurface()
  surface.check = () => new Promise((resolve) => {
    checkCalls += 1
    releases.push(() => resolve({ ok: true }))
  })
  const cleanup = installUpdateSurface(surface)
  const store = await freshStore()
  try {
    await waitHydrated(store)
    const first = store.requestUpdateCheck()
    // 第二个 shell/第二次点击在 invoke 结算前：本地拒绝，绝不再发一条边。
    assert.deepEqual(await store.requestUpdateCheck(), { ok: false, error: 'check already in progress' })
    assert.equal(checkCalls, 1, 'S-21：一次点击恰一条 check edge（native 边绝不重复）')
    releases.shift()!()
    assert.deepEqual(await first, { ok: true })
    // invoke 结算即释放单飞（不是 restart 的 armed-forever）：下一次点击照常发出。
    const second = store.requestUpdateCheck()
    assert.equal(checkCalls, 2)
    releases.shift()!()
    assert.deepEqual(await second, { ok: true })
    // 桥抛错也必须释放单飞，否则一次故障会永久禁用按钮。
    surface.check = async () => { throw new Error('bridge boom') }
    assert.deepEqual(await store.requestUpdateCheck(), { ok: false, error: 'Error: bridge boom' })
    let recovered = 0
    surface.check = async () => { recovered += 1; return { ok: true } }
    assert.deepEqual(await store.requestUpdateCheck(), { ok: true })
    assert.equal(recovered, 1, '抛错后单飞复位：按钮可重试')
  } finally { cleanup() }
})

test('S-21: the page renders the shell-pushed phases (checking → available) and runs no discovery of its own', async () => {
  let checkCalls = 0
  const releases: Array<() => void> = []
  const extraCalls: string[] = []
  const { surface, push } = fakeUpdateSurface()
  surface.check = () => new Promise((resolve) => {
    checkCalls += 1
    releases.push(() => resolve({ ok: true }))
  })
  const realDownload = surface.download.bind(surface)
  surface.download = async () => { extraCalls.push('download'); return realDownload() }
  const realOpen = surface.openReleasePage.bind(surface)
  surface.openReleasePage = async (url: string) => { extraCalls.push('openReleasePage'); return realOpen(url) }
  const cleanup = installUpdateSurface(surface)
  const store = await freshStore()
  try {
    await waitHydrated(store)
    const seen: string[] = []
    store.subscribeUpdateState(() => {
      const snapshot = store.getUpdateState()
      if (snapshot !== null) seen.push(snapshot.phase)
    })
    const pending = store.requestUpdateCheck()
    assert.equal(checkCalls, 1)
    // 壳的第一帧：checking —— 页面如实渲染，按钮门随之关闭（无法重入）。
    push(downloadedState({ phase: 'checking', latestVersion: null, downloadPercent: null, releaseUrl: null, installBlockedReason: null }))
    assert.equal(store.getUpdateState()?.phase, 'checking')
    assert.equal(updateCheckDisabled(store.getUpdateState()?.phase), true)
    releases.shift()!()
    assert.deepEqual(await pending, { ok: true })
    // 壳的结果帧：available —— 原生腿 installBlockedReason=null，页面直接给「更新」。
    push(downloadedState({ phase: 'available', installBlockedReason: null }))
    assert.equal(store.getUpdateState()?.phase, 'available')
    assert.equal(store.getUpdateState()?.latestVersion, '0.3.0')
    assert.equal(updateCheckDisabled(store.getUpdateState()?.phase), false)
    assert.deepEqual(seen, ['checking', 'available'], '页面相位序列 = 壳推送序列（无自有发现）')
    assert.deepEqual(extraCalls, [], '检查路径绝不触碰 download/openReleasePage 等其它面')
  } finally { cleanup() }
})
