/**
 * view-prefs.ts unit tests (plain node:test, no dsh, no DOM): round-trip
 * save/load, corrupt JSON / version mismatch / malformed shape / missing key
 * → defaults, throwing storage never propagates, a throwing localStorage
 * accessor degrades to defaults / no-op (lazy default resolution), lenient
 * entry sanitizing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetViewPrefsForTests,
  getViewPrefs,
  loadViewPrefs,
  saveViewPrefs,
  subscribeViewPrefs,
  updateViewPrefs,
  VIEW_PREFS_KEY,
  type ChamberSidebarViewPrefs,
  type StorageLike,
} from '../src/shared/view-prefs.ts'
import { chamberBridge } from '../src/shared/aggregate-store.ts'

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  peek(key: string): string | undefined {
    return this.map.get(key)
  }
}

function defaults(): ChamberSidebarViewPrefs {
  return { v: 1, folded: {}, ungroupedOrder: {}, seenSources: [] }
}

test('loadViewPrefs returns defaults when the key is missing', () => {
  assert.deepEqual(loadViewPrefs(new MemoryStorage()), defaults())
})

test('save then load round-trips the prefs', () => {
  const storage = new MemoryStorage()
  const prefs: ChamberSidebarViewPrefs = {
    v: 1,
    folded: { 'local/w1': true, 'ssh-a/w2': false },
    ungroupedOrder: { local: ['s3', 's1', 's2'], 'ssh-a': [] },
    // seenSources is SESSION-ONLY memory: it is never persisted, so a
    // round-trip through storage always lands back on [].
    seenSources: [],
  }
  saveViewPrefs(prefs, storage)
  assert.deepEqual(loadViewPrefs(storage), prefs)
  assert.equal(storage.peek(VIEW_PREFS_KEY), JSON.stringify(prefs))
})

test('loadViewPrefs falls back to defaults on corrupt JSON', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, '{not json')
  assert.deepEqual(loadViewPrefs(storage), defaults())
})

test('loadViewPrefs falls back to defaults on a version mismatch', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 2, folded: {}, ungroupedOrder: {} }))
  assert.deepEqual(loadViewPrefs(storage), defaults())
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: '1', folded: {}, ungroupedOrder: {} }))
  assert.deepEqual(loadViewPrefs(storage), defaults())
})

test('loadViewPrefs falls back to defaults on a wrong top-level shape', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify(null))
  assert.deepEqual(loadViewPrefs(storage), defaults())
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify([1, 2]))
  assert.deepEqual(loadViewPrefs(storage), defaults())
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify('v1'))
  assert.deepEqual(loadViewPrefs(storage), defaults())
})

test('loadViewPrefs sanitizes malformed entries leniently and keeps valid ones', () => {
  const storage = new MemoryStorage()
  storage.setItem(
    VIEW_PREFS_KEY,
    JSON.stringify({
      v: 1,
      folded: { good: true, bad: 'yes', nope: 1, list: [] },
      ungroupedOrder: {
        local: ['s1', 42, 's2', null, { id: 's3' }],
        broken: 'not-an-array',
        empty: [],
      },
      extra: 'ignored',
    }),
  )
  assert.deepEqual(loadViewPrefs(storage), {
    v: 1,
    folded: { good: true },
    ungroupedOrder: { local: ['s1', 's2'], empty: [] },
    seenSources: [],
  })
})

test('loadViewPrefs falls back to defaults when a top-level section is the wrong type', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: 'x', ungroupedOrder: 7 }))
  assert.deepEqual(loadViewPrefs(storage), { v: 1, folded: {}, ungroupedOrder: {}, seenSources: [] })
})

test('default fallbacks are fresh objects — an in-place mutation of one load cannot pollute later loads', () => {
  // A shared module-level DEFAULTS would leak one caller's in-place mutation
  // into every later default load and every post-reset cache (2026-08 audit
  // guard): mutating a returned default must NOT show up in the next load.
  const storage = new MemoryStorage()
  const first = loadViewPrefs(storage) // missing key → defaults
  first.folded['polluted/w'] = true
  first.ungroupedOrder['polluted'] = ['s1']
  assert.deepEqual(loadViewPrefs(storage), { v: 1, folded: {}, ungroupedOrder: {}, seenSources: [] })
  storage.setItem(VIEW_PREFS_KEY, '{corrupt') // corrupt JSON → defaults
  assert.deepEqual(loadViewPrefs(storage), { v: 1, folded: {}, ungroupedOrder: {}, seenSources: [] })
})

test('saveViewPrefs never throws when setItem throws', () => {
  const throwing: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded')
    },
  }
  assert.doesNotThrow(() => saveViewPrefs({ v: 1, folded: { a: true }, ungroupedOrder: {}, seenSources: [] }, throwing))
})

test('loadViewPrefs never throws when getItem throws', () => {
  const throwing: StorageLike = {
    getItem: () => {
      throw new Error('storage disabled')
    },
    setItem: () => undefined,
  }
  assert.deepEqual(loadViewPrefs(throwing), defaults())
})

test('a storage-like whose getItem and setItem both throw never propagates (load → defaults, save → no-op)', () => {
  const throwing: StorageLike = {
    getItem: () => {
      throw new Error('storage disabled')
    },
    setItem: () => {
      throw new Error('quota exceeded')
    },
  }
  assert.deepEqual(loadViewPrefs(throwing), defaults())
  assert.doesNotThrow(() => saveViewPrefs({ v: 1, folded: { a: true }, ungroupedOrder: {}, seenSources: [] }, throwing))
})

test('a throwing localStorage accessor degrades to defaults / no-op when no storage is passed', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage denied on opaque origin')
      },
    })
    assert.deepEqual(loadViewPrefs(undefined), defaults())
    assert.doesNotThrow(() => saveViewPrefs({ v: 1, folded: { a: true }, ungroupedOrder: {}, seenSources: [] }, undefined))
  } finally {
    if (original === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage
    } else {
      Object.defineProperty(globalThis, 'localStorage', original)
    }
  }
})

// ---- Shared live store (design 06 §3, 2026-08: cross-ctx live sync) ----
// Node has no localStorage, so the store runs on its in-memory cache — which
// is exactly the shared-singleton behavior every ctx's sidebar relies on.

test('shared view-prefs store: updateViewPrefs keeps one live shared state and notifies subscribers', () => {
  __resetViewPrefsForTests()
  let notified = 0
  const unsubscribe = subscribeViewPrefs(() => { notified += 1 })
  updateViewPrefs(prev => ({ ...prev, folded: { ...prev.folded, 'local/w1': true } }))
  assert.equal(notified, 1)
  assert.deepEqual(getViewPrefs().folded, { 'local/w1': true })
  // A second write sees the first — single source of truth, no lost update
  // and no stale per-ctx copy (a fold in source A is immediately visible to B).
  updateViewPrefs(prev => ({ ...prev, folded: { ...prev.folded, 'ssh-a/w2': true } }))
  assert.equal(notified, 2)
  assert.deepEqual(getViewPrefs().folded, { 'local/w1': true, 'ssh-a/w2': true })
  unsubscribe()
  updateViewPrefs(prev => ({ ...prev, folded: { ...prev.folded, 'local/w3': true } }))
  assert.equal(notified, 2) // unsubscribed — no further notifications
})

test('shared view-prefs store: safe prune — only sources SEEN then vanished are pruned, never against an empty projection', () => {
  __resetViewPrefsForTests()
  // Seed the prefs this test asserts on (self-contained — must not depend on
  // another test's writes): present-connected (local), present-disconnected
  // (ssh-b), never-seen (ssh-a, ghost) keys, plus ungrouped orders.
  updateViewPrefs(prev => ({
    ...prev,
    folded: { 'local/w1': true, 'local/w3': true, 'ssh-a/w2': true, 'ghost/w': true },
    ungroupedOrder: { local: ['s1'], 'ssh-b': ['s2'], ghost: ['s3'] },
  }))
  // Empty projection (nothing published yet): updateViewPrefs leaves the
  // prefs untouched — a transiently unready projection must never wipe them.
  assert.equal(getViewPrefs().folded['ghost/w'], true)
  assert.deepEqual(getViewPrefs().seenSources, []) // nothing seen yet — first write prunes nothing

  // Non-empty projection arrives: only sources that were SEEN in an earlier
  // projection and are now absent are pruned. ghost/ssh-a were never seen —
  // their prefs are KEPT (the startup window where the roster arrives after
  // the local-only projection must not wipe ssh sources' prefs). Present
  // sources keep theirs — a present-but-disconnected source (no workspaces
  // in the projection) keeps its folds and they return on reconnect.
  chamberBridge.publish([
    {
      id: 'local',
      kind: 'local',
      label: 'L',
      connected: true,
      phase: 'ready',
      workspaces: [{ id: 'w1', title: 'W1', sessions: [] }],
      updatedAt: 0,
    },
    {
      id: 'ssh-b',
      kind: 'ssh',
      label: 'B',
      connected: false,
      phase: 'stopped',
      workspaces: [],
      updatedAt: 0,
    },
  ])
  updateViewPrefs(prev => ({
    ...prev,
    folded: { ...prev.folded, 'ghost/w2': true, 'ssh-b/w9': true },
  }))
  const after = getViewPrefs()
  assert.equal(after.folded['ghost/w'], true)   // never seen → kept (safe)
  assert.equal(after.folded['ghost/w2'], true)  // never seen → kept (safe)
  assert.equal(after.folded['ssh-a/w2'], true)  // never seen → kept (safe)
  assert.equal(after.folded['local/w1'], true)  // present connected source keeps its folds
  assert.equal(after.folded['local/w3'], true)
  assert.equal(after.folded['ssh-b/w9'], true)  // present disconnected source keeps its folds
  assert.deepEqual(after.ungroupedOrder['local'], ['s1'])
  assert.deepEqual(after.ungroupedOrder['ssh-b'], ['s2'])
  assert.deepEqual(after.ungroupedOrder['ghost'], ['s3']) // never seen → kept (safe)
  // seenSources records only the sources observed in THIS session's projection.
  assert.deepEqual(after.seenSources, ['local', 'ssh-b'])

  // ssh-b disappears from the projection AFTER being seen: its keys are
  // pruned on the next write; never-seen ghosts and local's survive.
  chamberBridge.publish([
    {
      id: 'local',
      kind: 'local',
      label: 'L',
      connected: true,
      phase: 'ready',
      workspaces: [{ id: 'w1', title: 'W1', sessions: [] }],
      updatedAt: 0,
    },
  ])
  updateViewPrefs(prev => ({ ...prev, folded: { ...prev.folded, 'local/w4': true } }))
  const pruned = getViewPrefs()
  assert.equal(pruned.folded['ssh-b/w9'], undefined) // seen then vanished → pruned
  assert.deepEqual(pruned.ungroupedOrder['ssh-b'], undefined) // ungrouped order pruned too
  assert.equal(pruned.folded['ghost/w'], true)       // never seen → still safe
  assert.equal(pruned.folded['local/w1'], true)
  assert.equal(pruned.folded['local/w4'], true)
  assert.deepEqual(pruned.ungroupedOrder['local'], ['s1']) // present source keeps its order
  // seenSources keeps the full session history (ssh-b stays known — its keys
  // are already gone; a later re-add of ssh-b would prune on its next absence).
  assert.deepEqual(pruned.seenSources, ['local', 'ssh-b'])
})

test('loadViewPrefs never restores a persisted seenSources from storage', () => {
  // Storage carries a previous session's roster + remote prefs (the exact
  // payload that made the startup window wipe remote prefs before the
  // 2026-08 fix). Loading must zero seenSources while keeping the prefs.
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({
    v: 1,
    folded: { 'ssh-x/w': true },
    ungroupedOrder: { 'ssh-x': ['s1'] },
    seenSources: ['local', 'ssh-x'],
  }))
  const loaded = loadViewPrefs(storage)
  assert.deepEqual(loaded.seenSources, [])      // never restored — the fix's guard
  assert.equal(loaded.folded['ssh-x/w'], true)  // the prefs themselves survive
  assert.deepEqual(loaded.ungroupedOrder['ssh-x'], ['s1'])
})

test('a fresh session under a local-only projection never prunes unloaded remote prefs (startup window)', () => {
  __resetViewPrefsForTests()
  // Session starts with remote prefs present (loaded from storage — their
  // seenSources is empty by construction) and the projection local-only
  // (roster not yet arrived). The FIRST write of the session must not prune
  // any remote key.
  updateViewPrefs(prev => ({
    ...prev,
    folded: { ...prev.folded, 'ssh-x/w': true, 'local/w1': true },
    ungroupedOrder: { 'ssh-x': ['s1'] },
  }))
  chamberBridge.publish([
    {
      id: 'local',
      kind: 'local',
      label: 'L',
      connected: true,
      phase: 'ready',
      workspaces: [{ id: 'w1', title: 'W1', sessions: [] }],
      updatedAt: 0,
    },
  ])
  updateViewPrefs(prev => ({ ...prev, folded: { ...prev.folded, 'local/w2': true } }))
  const after = getViewPrefs()
  assert.equal(after.folded['ssh-x/w'], true)          // unloaded remote source survives
  assert.deepEqual(after.ungroupedOrder['ssh-x'], ['s1'])
  assert.equal(after.folded['local/w1'], true)
  assert.equal(after.folded['local/w2'], true)
  // ssh-x was never seen this session — it is not pruned by a later write
  // either (only seen-then-vanished sources are).
  updateViewPrefs(prev => ({ ...prev, folded: { ...prev.folded, 'local/w3': true } }))
  assert.equal(getViewPrefs().folded['ssh-x/w'], true)
})
