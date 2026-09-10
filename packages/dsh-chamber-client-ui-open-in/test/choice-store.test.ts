/**
 * Persisted open-in choice unit tests (Batch 3 Phase 2): the official storage
 * key, the page-wide in-memory authority, the best-effort persistence and the
 * fail-safe degradation when storage is absent or hostile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OPEN_IN_CHOICE_STORAGE_KEY,
  __resetOpenInChoiceForTests,
  getOpenInChoice,
  setOpenInChoice,
  subscribeOpenInChoice,
} from '../src/client/choice-store.ts'

interface FakeStorage {
  data: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
  }
}

function withStorage<T>(value: unknown, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true })
  try {
    return run()
  } finally {
    __resetOpenInChoiceForTests()
    if (previous === undefined) delete (globalThis as Record<string, unknown>).localStorage
    else Object.defineProperty(globalThis, 'localStorage', previous)
  }
}

test('choice: the storage key is the official one and the default is empty', () => {
  withStorage(fakeStorage(), () => {
    assert.equal(OPEN_IN_CHOICE_STORAGE_KEY, 'dsh.open-in-app.choice')
    assert.equal(getOpenInChoice(), '')
  })
})

test('choice: a stored value is read once and a pick persists + notifies subscribers', () => {
  const storage = fakeStorage({ 'dsh.open-in-app.choice': 'cursor' })
  withStorage(storage, () => {
    assert.equal(getOpenInChoice(), 'cursor')
    const seen: string[] = []
    const unsubscribe = subscribeOpenInChoice(() => { seen.push(getOpenInChoice()) })
    setOpenInChoice('vscode')
    assert.deepEqual(seen, ['vscode'])
    assert.equal(storage.data.get('dsh.open-in-app.choice'), 'vscode')
    // Same value = no notification (idempotent pick).
    setOpenInChoice('vscode')
    assert.deepEqual(seen, ['vscode'])
    // Empty/non-string picks are ignored.
    setOpenInChoice('')
    setOpenInChoice(7 as unknown as string)
    assert.equal(getOpenInChoice(), 'vscode')
    unsubscribe()
    setOpenInChoice('finder')
    assert.deepEqual(seen, ['vscode'])
  })
})

test('choice: absent or throwing storage degrades to the in-memory value', () => {
  withStorage(undefined, () => {
    assert.equal(getOpenInChoice(), '')
    setOpenInChoice('vscode')
    assert.equal(getOpenInChoice(), 'vscode')
  })
  withStorage({
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
  }, () => {
    assert.equal(getOpenInChoice(), '')
    setOpenInChoice('cursor')
    assert.equal(getOpenInChoice(), 'cursor', 'the choice survives for this page')
  })
})
