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
  loadViewPrefs,
  saveViewPrefs,
  VIEW_PREFS_KEY,
  type ChamberSidebarViewPrefs,
  type StorageLike,
} from '../src/shared/view-prefs.ts'

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
  return { v: 1, folded: {}, ungroupedOrder: {} }
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
  })
})

test('loadViewPrefs falls back to defaults when a top-level section is the wrong type', () => {
  const storage = new MemoryStorage()
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({ v: 1, folded: 'x', ungroupedOrder: 7 }))
  assert.deepEqual(loadViewPrefs(storage), { v: 1, folded: {}, ungroupedOrder: {} })
})

test('saveViewPrefs never throws when setItem throws', () => {
  const throwing: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded')
    },
  }
  assert.doesNotThrow(() => saveViewPrefs({ v: 1, folded: { a: true }, ungroupedOrder: {} }, throwing))
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
  assert.doesNotThrow(() => saveViewPrefs({ v: 1, folded: { a: true }, ungroupedOrder: {} }, throwing))
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
    assert.doesNotThrow(() => saveViewPrefs({ v: 1, folded: { a: true }, ungroupedOrder: {} }, undefined))
  } finally {
    if (original === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage
    } else {
      Object.defineProperty(globalThis, 'localStorage', original)
    }
  }
})
