import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPurgedSessionStore,
  legacySessionRecheckDelay,
  legacyStaleSessionCandidates,
  legacyStaleSessionProtectedIds,
  parsePurgedSessionState,
  purgedSessionStateKey,
  PURGED_SESSION_FINGERPRINT_KEEP,
  PURGED_SESSION_INDEX_MAX_INSTANCES,
  PURGED_SESSION_STATE_INDEX_KEY,
  PURGED_SESSION_STATE_PREFIX,
  type PurgedSessionStorage,
} from '../../src/client/purged-session-store.ts'

test('purged session state is versioned, source-scoped, and round-trips only bounded ids', () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
  const local = createPurgedSessionStore('local', 'fingerprint-a', storage)
  const remote = createPurgedSessionStore('local', 'fingerprint-b', storage)
  local.save({ purgedIds: ['gone'], knownSessionIds: ['live', 'gone'] })

  assert.deepEqual(local.load(), { purgedIds: ['gone'], knownSessionIds: ['live', 'gone'] })
  assert.equal(remote.load(), undefined, 'a new source incarnation cannot inherit old session ids')
  assert.notEqual(purgedSessionStateKey('local', 'fingerprint-a'), purgedSessionStateKey('local', 'fingerprint-b'))
  assert.equal(parsePurgedSessionState('{bad json'), undefined)
  assert.equal(parsePurgedSessionState('{"v":2,"purgedIds":["gone"]}'), undefined)
})

test('purged session storage tolerates private-mode failures and removes malformed ids', () => {
  const storage = {
    getItem: () => JSON.stringify({ v: 1, purgedIds: ['ok', null, '', 'ok'], knownSessionIds: ['x'] }),
    setItem: () => { throw new Error('quota') },
  }
  const safe = createPurgedSessionStore('local', 'fingerprint-a', storage)
  assert.deepEqual(safe.load(), { purgedIds: ['ok'], knownSessionIds: ['x'] })
  assert.doesNotThrow(() => safe.save({ purgedIds: ['gone'], knownSessionIds: [] }))
})

/** localStorage-shaped fake: the index/eviction path needs enumeration + removeItem. */
class LocalStorageFake implements PurgedSessionStorage {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void { this.map.set(key, value) }
  removeItem(key: string): void { this.map.delete(key) }
  get length(): number { return this.map.size }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null }
  dataKeys(): string[] {
    return [...this.map.keys()].filter(key => key.startsWith(`${PURGED_SESSION_STATE_PREFIX}:`))
  }
  index(): { v: number; instances: Record<string, Array<{ fingerprint: string; usedAt: number }>> } | undefined {
    const raw = this.map.get(PURGED_SESSION_STATE_INDEX_KEY)
    return raw === undefined
      ? undefined
      : JSON.parse(raw) as { v: number; instances: Record<string, Array<{ fingerprint: string; usedAt: number }>> }
  }
}

test('a re-registered fingerprint key is evicted: K data keys per instanceId, the current one never deleted', () => {
  const storage = new LocalStorageFake()
  for (const fingerprint of ['fp-1', 'fp-2', 'fp-3', 'fp-4']) {
    const store = createPurgedSessionStore('local', fingerprint, storage)
    store.load()
    store.save({ purgedIds: [fingerprint], knownSessionIds: [] })
  }
  // 每个 instanceId 只保留最近 K=2 个指纹的数据键：旧键与其数据被删除。
  assert.equal(storage.dataKeys().length, PURGED_SESSION_FINGERPRINT_KEEP)
  assert.deepEqual(
    storage.dataKeys().slice().sort(),
    [purgedSessionStateKey('local', 'fp-3'), purgedSessionStateKey('local', 'fp-4')].sort(),
  )
  // 当前仍在用的指纹永不被淘汰：数据仍可读回。
  assert.deepEqual(createPurgedSessionStore('local', 'fp-4', storage).load(), { purgedIds: ['fp-4'], knownSessionIds: [] })
  // 索引自身有界（每实例 ≤ K 条），MRU 在前且带最近使用时间。
  const index = storage.index()
  assert.notEqual(index, undefined)
  assert.equal(index?.v, 1)
  assert.ok((index?.instances.local?.length ?? 0) <= PURGED_SESSION_FINGERPRINT_KEEP)
  assert.equal(index?.instances.local?.[0]?.fingerprint, 'fp-4')
  assert.ok(Number.isFinite(index?.instances.local?.[0]?.usedAt))
})

test('first migration seeds the index from existing keys, then evicts only the touched instanceId', () => {
  const storage = new LocalStorageFake()
  for (const fingerprint of ['old-1', 'old-2', 'old-3', 'old-4']) {
    storage.setItem(purgedSessionStateKey('local', fingerprint), JSON.stringify({ v: 1, purgedIds: [fingerprint] }))
  }
  for (const fingerprint of ['remote-1', 'remote-2', 'remote-3', 'remote-4']) {
    storage.setItem(purgedSessionStateKey('ssh-a', fingerprint), JSON.stringify({ v: 1, purgedIds: [fingerprint] }))
  }
  const store = createPurgedSessionStore('local', 'fresh', storage)
  assert.equal(store.load(), undefined)
  // 先建立索引（迁移），再对当前 instanceId 淘汰；其他 instanceId 的键不受影响。
  const index = storage.index()
  assert.notEqual(index, undefined, '首次迁移必须先建立索引键')
  assert.equal(index?.instances.local?.length, PURGED_SESSION_FINGERPRINT_KEEP)
  assert.equal(index?.instances.local?.[0]?.fingerprint, 'fresh')
  assert.equal(index?.instances['ssh-a']?.length, 4, '迁移只记录、不动其他 instanceId 的键')
  assert.equal(storage.dataKeys().filter(key => key.includes(':local:')).length, 1)
  assert.equal(storage.dataKeys().filter(key => key.includes(':local:'))[0], purgedSessionStateKey('local', 'old-1'))
  assert.equal(storage.dataKeys().filter(key => key.includes(':ssh-a:')).length, 4)
  // 当前指纹写盘后，local 仍是 K 个数据键；ssh-a 直到自己的 store 加载才被裁。
  store.save({ purgedIds: ['fresh'], knownSessionIds: [] })
  assert.equal(storage.dataKeys().filter(key => key.includes(':local:')).length, PURGED_SESSION_FINGERPRINT_KEEP)
  createPurgedSessionStore('ssh-a', 'remote-5', storage).load()
  assert.equal(storage.dataKeys().filter(key => key.includes(':ssh-a:')).length, 1, '未写盘的当前指纹也为旧键预留名额')
  assert.equal(storage.dataKeys().filter(key => key.includes(':local:')).length, PURGED_SESSION_FINGERPRINT_KEEP, '其他 instanceId 的淘汰互不影响')
})

test('the index table itself is bounded: oldest instanceIds fall off without touching their data keys', () => {
  const storage = new LocalStorageFake()
  for (let index = 0; index < PURGED_SESSION_INDEX_MAX_INSTANCES + 2; index += 1) {
    const store = createPurgedSessionStore(`inst-${index}`, 'fp', storage)
    store.load()
    store.save({ purgedIds: ['x'], knownSessionIds: [] })
  }
  const index = storage.index()
  assert.equal(Object.keys(index?.instances ?? {}).length, PURGED_SESSION_INDEX_MAX_INSTANCES)
  // 索引淘汰只忘掉簿记，绝不连带删除数据键（被落下的 instance 下次加载时自行裁旧）。
  assert.equal(storage.dataKeys().length, PURGED_SESSION_INDEX_MAX_INSTANCES + 2)
})

test('a storage without enumeration or removeItem still builds the index and degrades softly', () => {
  const data = new Map<string, string>()
  const storage: PurgedSessionStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
  }
  const store = createPurgedSessionStore('local', 'fp-a', storage)
  store.load()
  const raw = data.get(PURGED_SESSION_STATE_INDEX_KEY)
  assert.notEqual(raw, undefined, '无法枚举时也先建立索引（迁移的第一半）')
  const index = JSON.parse(raw!) as { v: number; instances: Record<string, Array<{ fingerprint: string; usedAt: number }>> }
  assert.deepEqual(index.instances.local?.map(entry => entry.fingerprint), ['fp-a'])
  // 没有 removeItem：淘汰软降级，不抛错。
  assert.doesNotThrow(() => store.save({ purgedIds: ['gone'], knownSessionIds: [] }))
  assert.deepEqual(store.load(), { purgedIds: ['gone'], knownSessionIds: [] })
})

test('legacy cleanup candidates exclude running, blank and recently active session rows', () => {
  assert.deepEqual([...legacyStaleSessionCandidates({
    deleted: { updatedAt: 0 },
    active: { running: true, updatedAt: 10 },
    blank: { blank: true, updatedAt: 10 },
    recentlyActive: { updatedAt: 59_999 },
    missingActivity: {},
  }, 60_000)].sort(), ['deleted', 'missingActivity'])
})

test('legacy recent-row protection schedules one recheck after grace, while active and blank rows wait for state changes', () => {
  const summaries = {
    recent: { updatedAt: 9_500 },
    running: { running: true, updatedAt: 1_000 },
    blank: { blank: true, updatedAt: 1_000 },
    old: { updatedAt: 8_000 },
    present: { updatedAt: 1_000 },
  }
  const missing = new Set(['recent', 'running', 'blank', 'old'])
  const protectedIds = legacyStaleSessionProtectedIds(summaries, missing, 10_000, 1_000)

  assert.deepEqual([...protectedIds].sort(), ['blank', 'recent', 'running'])
  assert.equal(legacySessionRecheckDelay(summaries, protectedIds, 10_000, 1_000), 500)
  assert.equal(legacySessionRecheckDelay(summaries, protectedIds, 10_500, 1_000), 0)
  assert.equal(legacySessionRecheckDelay(summaries, new Set(['running', 'blank']), 10_000, 1_000), undefined)
})
