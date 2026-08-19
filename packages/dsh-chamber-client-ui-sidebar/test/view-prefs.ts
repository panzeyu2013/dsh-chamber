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
  clearSourceBookkeeping,
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
  return { v: 1, folded: {}, ungroupedOrder: {}, orderBy: {}, updatedOrder: {}, sessionUpdatedAtByAccount: {}, seenSources: [] }
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
    orderBy: { local: 'updated', 'ssh-a': 'manual' },
    updatedOrder: { 'local/w1': ['s3', 's1', 's2'], 'ssh-a/__ungrouped__': ['x'] },
    sessionUpdatedAtByAccount: { 'local/w1': { s1: 100, s2: 200 } },
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
      updatedOrder: {
        'local/w1': ['s1', 's2'],
        'local/w2': 'not-an-array',
        'local/w3': [1, 's3', null],
      },
      sessionUpdatedAtByAccount: {
        'local/w1': { s1: 100, s2: 200, bad: 'x' },
        'local/w2': 'not-an-object',
        'local/w3': { s3: NaN, s4: Infinity, s5: -1 },
      },
      extra: 'ignored',
    }),
  )
  assert.deepEqual(loadViewPrefs(storage), {
    v: 1,
    folded: { good: true },
    ungroupedOrder: { local: ['s1', 's2'], empty: [] },
    orderBy: {},
    updatedOrder: { 'local/w1': ['s1', 's2'], 'local/w3': ['s3'] },
    sessionUpdatedAtByAccount: { 'local/w1': { s1: 100, s2: 200 }, 'local/w3': { s5: -1 } },
    seenSources: [],
  })
})

test('loadViewPrefs falls back to defaults when a top-level section is the wrong type', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: 'x', ungroupedOrder: 7 }))
  assert.deepEqual(loadViewPrefs(storage), defaults())
})

test('default fallbacks are fresh objects — an in-place mutation of one load cannot pollute later loads', () => {
  // A shared module-level DEFAULTS would leak one caller's in-place mutation
  // into every later default load and every post-reset cache (2026-08 audit
  // guard): mutating a returned default must NOT show up in the next load.
  const storage = new MemoryStorage()
  const first = loadViewPrefs(storage) // missing key → defaults
  first.folded['polluted/w'] = true
  first.ungroupedOrder['polluted'] = ['s1']
  first.updatedOrder!['polluted/w'] = ['s1']
  first.sessionUpdatedAtByAccount!['polluted/w'] = { s1: 1 }
  assert.deepEqual(loadViewPrefs(storage), defaults())
  storage.setItem(VIEW_PREFS_KEY, '{corrupt') // corrupt JSON → defaults
  assert.deepEqual(loadViewPrefs(storage), defaults())
})

test('saveViewPrefs never throws when setItem throws', () => {
  const throwing: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded')
    },
  }
  assert.doesNotThrow(() => saveViewPrefs({ v: 1, folded: { a: true }, ungroupedOrder: {}, orderBy: {}, seenSources: [] }, throwing))
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
  assert.doesNotThrow(() => saveViewPrefs({ v: 1, folded: { a: true }, ungroupedOrder: {}, orderBy: {}, seenSources: [] }, throwing))
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
    assert.doesNotThrow(() => saveViewPrefs({ v: 1, folded: { a: true }, ungroupedOrder: {}, orderBy: {}, seenSources: [] }, undefined))
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
  // (ssh-b), never-seen (ssh-a, ghost) keys, plus ungrouped orders,
  // per-source orderBy preferences, updated-mode account orders and the
  // activity bookkeeping.
  updateViewPrefs(prev => ({
    ...prev,
    folded: { 'local/w1': true, 'local/w3': true, 'ssh-a/w2': true, 'ghost/w': true },
    ungroupedOrder: { local: ['s1'], 'ssh-b': ['s2'], ghost: ['s3'] },
    orderBy: { local: 'updated', 'ssh-b': 'updated', ghost: 'manual' },
    updatedOrder: {
      'local/w1': ['s1'],
      'ssh-b/w9': ['s2'],
      'ghost/w': ['s3'],
      'ssh-a/w2': ['s4'],
    },
    sessionUpdatedAtByAccount: {
      'local/w1': { s1: 100 },
      'ssh-b/w9': { s2: 200 },
      'ghost/w': { s3: 300 },
    },
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
  // orderBy follows the same source-keyed rules: present sources keep it,
  // never-seen ghosts keep it.
  assert.deepEqual(after.orderBy, { local: 'updated', 'ssh-b': 'updated', ghost: 'manual' })
  // updated-mode account orders / bookkeeping follow the same source-keyed
  // rules (keys are `${sourceId}/…`): present + never-seen keep their keys.
  assert.deepEqual(after.updatedOrder?.['local/w1'], ['s1'])
  assert.deepEqual(after.updatedOrder?.['ssh-b/w9'], ['s2'])
  assert.deepEqual(after.updatedOrder?.['ghost/w'], ['s3'])
  assert.deepEqual(after.updatedOrder?.['ssh-a/w2'], ['s4'])
  assert.deepEqual(after.sessionUpdatedAtByAccount?.['local/w1'], { s1: 100 })
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
  assert.equal(pruned.orderBy?.['ssh-b'], undefined) // orderBy pruned too
  assert.equal(pruned.orderBy?.['ghost'], 'manual')  // never seen → still safe
  assert.equal(pruned.orderBy?.['local'], 'updated') // present source keeps its preference
  assert.equal(pruned.folded['ghost/w'], true)       // never seen → still safe
  assert.equal(pruned.folded['local/w1'], true)
  assert.equal(pruned.folded['local/w4'], true)
  assert.deepEqual(pruned.ungroupedOrder['local'], ['s1']) // present source keeps its order
  // updated-mode accounts/bookkeeping prune with the source: ssh-b vanished,
  // local keeps its account, never-seen ghosts keep theirs.
  assert.equal(pruned.updatedOrder?.['ssh-b/w9'], undefined)
  assert.equal(pruned.sessionUpdatedAtByAccount?.['ssh-b/w9'], undefined)
  assert.deepEqual(pruned.updatedOrder?.['local/w1'], ['s1'])
  assert.deepEqual(pruned.updatedOrder?.['ghost/w'], ['s3'])
  assert.deepEqual(pruned.sessionUpdatedAtByAccount?.['local/w1'], { s1: 100 })
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

// ---- orderBy preference (design 06 §3.1; v stays 1 — no re-seed on old data) ----

test('loadViewPrefs sanitizes orderBy: legal values kept, illegal entries dropped', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({
    v: 1,
    folded: {},
    ungroupedOrder: {},
    orderBy: {
      local: 'updated',
      'ssh-a': 'manual',
      'ssh-b': 'ascending',   // illegal — dropped
      'ssh-c': 42,            // illegal — dropped
      'ssh-d': null,          // illegal — dropped
    },
  }))
  const loaded = loadViewPrefs(storage)
  assert.deepEqual(loaded.orderBy, { local: 'updated', 'ssh-a': 'manual' })
  // The rest of the prefs survives the sanitize.
  assert.equal(loaded.v, 1)
  assert.deepEqual(loaded.folded, {})
  assert.deepEqual(loaded.ungroupedOrder, {})
})

test('loadViewPrefs falls back to {} orderBy for old data written without the field (v stays 1)', () => {
  // Old-version payload: no orderBy key at all. It must NOT re-seed to
  // defaults (which would drop folded/ungroupedOrder) — orderBy just lands on
  // the empty fallback while the rest survives.
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({
    v: 1,
    folded: { 'local/w1': true },
    ungroupedOrder: { local: ['s1', 's2'] },
  }))
  const loaded = loadViewPrefs(storage)
  assert.deepEqual(loaded.orderBy, {})
  assert.equal(loaded.folded['local/w1'], true)
  assert.deepEqual(loaded.ungroupedOrder['local'], ['s1', 's2'])
})

test('loadViewPrefs falls back to {} orderBy when the field is the wrong type', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, orderBy: 'updated' }))
  assert.deepEqual(loadViewPrefs(storage).orderBy, {})
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, orderBy: ['updated'] }))
  assert.deepEqual(loadViewPrefs(storage).orderBy, {})
})

test('orderBy persists through save/load and the shared store keeps it on unrelated writes', () => {
  __resetViewPrefsForTests()
  updateViewPrefs(prev => ({ ...prev, orderBy: { local: 'updated', 'ssh-a': 'manual' } }))
  assert.deepEqual(getViewPrefs().orderBy, { local: 'updated', 'ssh-a': 'manual' })
  // A later unrelated write (fold) must not drop orderBy — the mutator's
  // spread keeps it, and sanitize re-validates the same values.
  updateViewPrefs(prev => ({ ...prev, folded: { ...prev.folded, 'local/w1': true } }))
  assert.deepEqual(getViewPrefs().orderBy, { local: 'updated', 'ssh-a': 'manual' })
  // updateViewPrefs re-sanitizes on every write: replacing orderBy with an
  // illegal value must land on the empty fallback, not persist the garbage.
  updateViewPrefs(prev => ({ ...prev, orderBy: { 'ssh-b': 'ascending' as never } }))
  assert.deepEqual(getViewPrefs().orderBy, {})
})

// ---- clearSourceBookkeeping (setOrderBy entering-updated clear, 2026-08 C档) ----

test('clearSourceBookkeeping removes only the target source keys, keeps the rest, no-op on undefined', () => {
  assert.equal(clearSourceBookkeeping(undefined, 'local'), undefined)
  const bookkeeping = {
    'local/w1': { s1: 1 },
    'ssh-a/w1': { s2: 2 },
    'ssh-a/w2': { s3: 3 },
  }
  const cleared = clearSourceBookkeeping(bookkeeping, 'ssh-a')
  assert.deepEqual(cleared, { 'local/w1': { s1: 1 } })
  assert.notEqual(cleared, bookkeeping) // a new object only when something was removed
  // Nothing left to clear → the SAME reference back (callers skip the write).
  assert.equal(clearSourceBookkeeping(cleared, 'ssh-a'), cleared)
  // Clearing everything yields an empty map, not undefined.
  assert.deepEqual(clearSourceBookkeeping({ 'local/w1': { s1: 1 } }, 'local'), {})
})

// ---- sidebarWidth preference (chamber ui-layout fork, 2026-09; v stays 1 — no re-seed on old data) ----

test('sidebarWidth round-trips through save/load', () => {
  const storage = new MemoryStorage()
  const prefs: ChamberSidebarViewPrefs = {
    v: 1,
    folded: { 'local/w1': true },
    ungroupedOrder: { local: ['s1'] },
    orderBy: {},
    updatedOrder: {},
    sessionUpdatedAtByAccount: {},
    sidebarWidth: 360,
    seenSources: [],
  }
  saveViewPrefs(prefs, storage)
  assert.deepEqual(loadViewPrefs(storage), prefs)
  assert.equal(storage.peek(VIEW_PREFS_KEY), JSON.stringify(prefs))
})

test('loadViewPrefs clamps sidebarWidth into the vendor drag range and rounds it', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: {}, ungroupedOrder: {}, sidebarWidth: 500 }))
  assert.equal(loadViewPrefs(storage).sidebarWidth, 420) // above SIDEBAR_MAX → clamped
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: {}, ungroupedOrder: {}, sidebarWidth: 100 }))
  assert.equal(loadViewPrefs(storage).sidebarWidth, 264) // below SIDEBAR_MIN → clamped
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: {}, ungroupedOrder: {}, sidebarWidth: 280.4 }))
  assert.equal(loadViewPrefs(storage).sidebarWidth, 280) // rounded like the vendor clampWidth
})

test('loadViewPrefs drops illegal sidebarWidth values and keeps the rest of the prefs', () => {
  const storage = new MemoryStorage()
  for (const bad of ['360', NaN, Infinity, -Infinity, null]) {
    storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: { 'local/w1': true }, ungroupedOrder: {}, sidebarWidth: bad }))
    const loaded = loadViewPrefs(storage)
    assert.equal(loaded.sidebarWidth, undefined, `sidebarWidth ${String(bad)} must be dropped`)
    assert.equal(loaded.folded['local/w1'], true) // the rest of the prefs survives
  }
  // Finite out-of-range numbers are NOT dropped — they clamp like the vendor
  // clampWidth (any px clamps into [264, 420]; 0 means "closed" in the layout
  // store, but the width PREFERENCE only records an open drag, so a corrupt 0
  // clamps up to the floor instead of persisting "closed").
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: {}, ungroupedOrder: {}, sidebarWidth: 0 }))
  assert.equal(loadViewPrefs(storage).sidebarWidth, 264)
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: {}, ungroupedOrder: {}, sidebarWidth: -5 }))
  assert.equal(loadViewPrefs(storage).sidebarWidth, 264)
})

test('loadViewPrefs keeps old payloads without sidebarWidth valid (v stays 1 — no re-seed)', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: { 'local/w1': true }, ungroupedOrder: { local: ['s1'] } }))
  const loaded = loadViewPrefs(storage)
  assert.equal(loaded.sidebarWidth, undefined) // absent = never dragged → layout boots at SIDEBAR_DEFAULT
  assert.equal(loaded.folded['local/w1'], true) // no re-seed — the rest survives
  assert.deepEqual(loaded.ungroupedOrder['local'], ['s1'])
})

test('sidebarWidth survives the write-time prune rebuild and unrelated writes', () => {
  __resetViewPrefsForTests()
  // The FIRST write of a session adds a seen source and rebuilds the prefs
  // object (prunePrefs' reconstructed branch); the rebuild must carry
  // sidebarWidth — a fixed-field reconstruction would have dropped it.
  updateViewPrefs(prev => ({ ...prev, folded: { 'ghost/w': true }, sidebarWidth: 340 }))
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
  updateViewPrefs(prev => ({ ...prev, folded: { ...prev.folded, 'local/w1': true } }))
  assert.equal(getViewPrefs().sidebarWidth, 340)
  // A later unrelated write (fold) keeps it too — spread carries it and
  // sanitize re-validates the same value.
  updateViewPrefs(prev => ({ ...prev, folded: { ...prev.folded, 'local/w2': true } }))
  assert.equal(getViewPrefs().sidebarWidth, 340)
})
