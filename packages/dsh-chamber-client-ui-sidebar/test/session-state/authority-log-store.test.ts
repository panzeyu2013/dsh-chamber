/**
 * P5 evidence surface contract: the machine-persistent authority action log.
 *
 * It must answer "did a probe fire / did the write-back run" after a reload, and it
 * must never break the authority chain: every storage failure degrades to "no evidence".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  appendAuthorityLog,
  authorityLogStorage,
  type AuthorityLogStorage,
} from '@dsh-chamber/dsh-chamber-client-core/authority-log-store'
// Test-only internals: package-internal deep imports keep them off the public subpath face.
import {
  AUTHORITY_LOG_FACTS_HEALTH_RESERVE,
  AUTHORITY_LOG_KEY,
  AUTHORITY_LOG_MAX_PER_SOURCE,
  AUTHORITY_LOG_MAX_SOURCES,
  loadAuthorityLog,
} from '../../../dsh-chamber-client-core/src/authority-log-store.ts'

class MemoryStorage implements AuthorityLogStorage {
  readonly map = new Map<string, string>()
  throwOnSet = false
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error('quota exceeded')
    this.map.set(key, value)
  }
}

test('missing, corrupt and hostile payloads read as empty, never throw', () => {
  const storage = new MemoryStorage()
  assert.deepEqual(loadAuthorityLog(storage), {})
  storage.map.set(AUTHORITY_LOG_KEY, '{not json')
  assert.deepEqual(loadAuthorityLog(storage), {})
  storage.map.set(AUTHORITY_LOG_KEY, '["array"]')
  assert.deepEqual(loadAuthorityLog(storage), {})
  storage.map.set(AUTHORITY_LOG_KEY, '"string"')
  assert.deepEqual(loadAuthorityLog(storage), {})
  storage.map.set(AUTHORITY_LOG_KEY, JSON.stringify({ s1: 'nope', s2: [{ at: 'x', kind: 1 }] }))
  assert.deepEqual(loadAuthorityLog(storage), {})
})

test('append then load round-trips entries in production order', () => {
  const storage = new MemoryStorage()
  appendAuthorityLog(storage, 's1', { at: 10, kind: 'probe' })
  appendAuthorityLog(storage, 's1', { at: 20, kind: 'read-failed', detail: 'x' })
  assert.deepEqual(loadAuthorityLog(storage), {
    s1: [{ at: 10, kind: 'probe' }, { at: 20, kind: 'read-failed', detail: 'x' }],
  })
})

test('entries are bounded per source, oldest dropped', () => {
  const storage = new MemoryStorage()
  for (let index = 0; index < AUTHORITY_LOG_MAX_PER_SOURCE + 8; index += 1) {
    appendAuthorityLog(storage, 's1', { at: index, kind: 'probe' })
  }
  const entries = loadAuthorityLog(storage).s1 ?? []
  assert.equal(entries.length, AUTHORITY_LOG_MAX_PER_SOURCE)
  assert.equal(entries[0]?.at, 8, 'the oldest overflow is gone')
  assert.equal(entries[entries.length - 1]?.at, AUTHORITY_LOG_MAX_PER_SOURCE + 7)
})

test('facts-health keeps a reserved share while a flood of other kinds ages out (W0 保底)', () => {
  const storage = new MemoryStorage()
  // 状态转折的唯一时间线：先写一条 facts-health，随后被 32+ 条高频 status-divergence 冲刷。
  appendAuthorityLog(storage, 's1', { at: 0, kind: 'facts-health', detail: 'ready=1 rows=113 maxWatermark=0' })
  for (let index = 0; index < AUTHORITY_LOG_MAX_PER_SOURCE + 8; index += 1) {
    appendAuthorityLog(storage, 's1', { at: index + 1, kind: 'status-divergence', detail: 'x' })
  }
  const entries = loadAuthorityLog(storage).s1 ?? []
  assert.equal(entries.length, AUTHORITY_LOG_MAX_PER_SOURCE, '环上界不变')
  assert.equal(entries[0]?.kind, 'facts-health', '保底名额让状态时间线留在盘上')
  assert.equal(entries[0]?.at, 0)
  assert.equal(entries[entries.length - 1]?.at, AUTHORITY_LOG_MAX_PER_SOURCE + 8, '非保底 kind 的 recency 淘汰不变')
})

test('the reserve prefers the newest facts-health breadcrumbs and caps their share', () => {
  const storage = new MemoryStorage()
  for (let index = 0; index < 10; index += 1) appendAuthorityLog(storage, 's1', { at: index, kind: 'facts-health' })
  for (let index = 0; index < AUTHORITY_LOG_MAX_PER_SOURCE + 4; index += 1) appendAuthorityLog(storage, 's1', { at: 100 + index, kind: 'probe' })
  const entries = loadAuthorityLog(storage).s1 ?? []
  assert.equal(entries.length, AUTHORITY_LOG_MAX_PER_SOURCE)
  const keptHealth = entries.filter(entry => entry.kind === 'facts-health')
  assert.equal(keptHealth.length, AUTHORITY_LOG_FACTS_HEALTH_RESERVE, '保底名额是上界，不是额外容量')
  assert.deepEqual(keptHealth.map(entry => entry.at), [2, 3, 4, 5, 6, 7, 8, 9], '保最新的事实健康条目')
})

test('the source table is bounded by recency', () => {
  const storage = new MemoryStorage()
  for (let index = 0; index <= AUTHORITY_LOG_MAX_SOURCES; index += 1) {
    appendAuthorityLog(storage, 's' + String(index), { at: index, kind: 'probe' })
  }
  const table = loadAuthorityLog(storage)
  assert.equal(Object.keys(table).length, AUTHORITY_LOG_MAX_SOURCES)
  assert.equal(table.s0, undefined, 'the least recent source was pruned')
  assert.notEqual(table['s' + String(AUTHORITY_LOG_MAX_SOURCES)], undefined)
})

test('a throwing storage never propagates into the authority chain', () => {
  const storage = new MemoryStorage()
  storage.throwOnSet = true
  assert.doesNotThrow(() => { appendAuthorityLog(storage, 's1', { at: 1, kind: 'probe' }) })
})

test('the browser seam is fail-soft when localStorage is absent', () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage
  try {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true })
    assert.equal(authorityLogStorage(), undefined)
    Object.defineProperty(globalThis, 'localStorage', { value: {}, configurable: true })
    assert.equal(authorityLogStorage(), undefined, 'a shape without get/set is refused')
  } finally {
    if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true })
  }
})
