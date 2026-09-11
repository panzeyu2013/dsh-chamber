/**
 * Persisted open-in choice unit tests (design 20 §5): the PER-SOURCE storage
 * key, the page-wide in-memory authority, the one-time migration of the legacy
 * page-wide key, the best-effort persistence and the fail-safe degradation when
 * storage is absent or hostile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LEGACY_OPEN_IN_CHOICE_STORAGE_KEY,
  OPEN_IN_CHOICE_STORAGE_PREFIX,
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

test('choice: the key is per source and the default is empty', () => {
  withStorage(fakeStorage(), () => {
    assert.equal(OPEN_IN_CHOICE_STORAGE_PREFIX, 'dsh-chamber.open-in.choice.')
    assert.equal(getOpenInChoice('local'), '')
    assert.equal(getOpenInChoice('dsh-edge-west'), '')
  })
})

test('choice: every source keeps its own remembered app', () => {
  const storage = fakeStorage({
    [`${OPEN_IN_CHOICE_STORAGE_PREFIX}local`]: 'cursor',
    [`${OPEN_IN_CHOICE_STORAGE_PREFIX}dsh-edge-west`]: 'vscode',
  })
  withStorage(storage, () => {
    assert.equal(getOpenInChoice('local'), 'cursor')
    assert.equal(getOpenInChoice('dsh-edge-west'), 'vscode')
    setOpenInChoice('local', 'terminal')
    assert.equal(storage.data.get(`${OPEN_IN_CHOICE_STORAGE_PREFIX}local`), 'terminal')
    assert.equal(storage.data.get(`${OPEN_IN_CHOICE_STORAGE_PREFIX}dsh-edge-west`), 'vscode',
      'picking for one source must not touch another source\'s memory')
  })
})

test('choice: a pick persists, notifies subscribers and is idempotent', () => {
  const storage = fakeStorage()
  withStorage(storage, () => {
    const seen: string[] = []
    const unsubscribe = subscribeOpenInChoice(() => { seen.push(getOpenInChoice('local')) })
    setOpenInChoice('local', 'vscode')
    assert.deepEqual(seen, ['vscode'])
    assert.equal(storage.data.get(`${OPEN_IN_CHOICE_STORAGE_PREFIX}local`), 'vscode')
    // Same value = no notification (idempotent pick).
    setOpenInChoice('local', 'vscode')
    assert.deepEqual(seen, ['vscode'])
    // Empty/non-string picks are ignored.
    setOpenInChoice('local', '')
    setOpenInChoice('local', 7 as unknown as string)
    assert.equal(getOpenInChoice('local'), 'vscode')
    unsubscribe()
    setOpenInChoice('local', 'finder')
    assert.deepEqual(seen, ['vscode'])
  })
})

test('choice: a source id that cannot own a key is inert', () => {
  const storage = fakeStorage()
  withStorage(storage, () => {
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(81), 7 as unknown as string]) {
      assert.equal(getOpenInChoice(bad), '', `id ${JSON.stringify(bad)}`)
      setOpenInChoice(bad, 'vscode')
    }
    assert.equal(storage.data.size, 0, 'no key may be written for a malformed source id')
  })
})

test('choice: the legacy page-wide key seeds the local source exactly once, read-only', () => {
  const storage = fakeStorage({ [LEGACY_OPEN_IN_CHOICE_STORAGE_KEY]: 'iterm' })
  withStorage(storage, () => {
    assert.equal(LEGACY_OPEN_IN_CHOICE_STORAGE_KEY, 'dsh.open-in-app.choice')
    assert.equal(getOpenInChoice('local'), 'iterm', 'the user\'s remembered app survives the upgrade')
    assert.equal(getOpenInChoice('dsh-edge-west'), '', 'the legacy key belongs to the local source only')
    setOpenInChoice('local', 'terminal')
    assert.equal(storage.data.get(LEGACY_OPEN_IN_CHOICE_STORAGE_KEY), 'iterm',
      'the legacy key is a migration source, never a write target')
  })
})

test('choice: absent or throwing storage degrades to the in-memory value', () => {
  withStorage(undefined, () => {
    assert.equal(getOpenInChoice('local'), '')
    setOpenInChoice('local', 'vscode')
    assert.equal(getOpenInChoice('local'), 'vscode')
  })
  withStorage({
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
  }, () => {
    assert.equal(getOpenInChoice('local'), '')
    setOpenInChoice('local', 'cursor')
    assert.equal(getOpenInChoice('local'), 'cursor', 'the choice survives for this page')
  })
})
