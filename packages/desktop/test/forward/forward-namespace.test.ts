/**
 * browserNamespace / alias allocator tests (W0/S1, security review B1/B4).
 *
 * The security claims of the alias model are exactly the cases below:
 *   - stable across restarts while the connection identity is unchanged;
 *   - stable when OTHER sources are added/removed;
 *   - rotated (namespace + alias) on a retarget, and the old alias is retired;
 *   - never 127.0.0.1 / .0 / .255, never shared between namespaces;
 *   - deterministic first assignment (batch order independent of caller order);
 *   - explicit failure at the 253-alias lifetime budget, never silent reuse;
 *   - corrupt or unreadable state fails closed.
 * Everything runs against an in-memory storage adapter: no home directory, no
 * fs, no clock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  allocateForwardAlias,
  ForwardNamespaceError,
  ForwardNamespaces,
  forwardAliasHost,
  isForwardAliasHost,
  parseForwardNamespaceState,
  preferredAliasOctet,
  serializeForwardNamespaceState,
  FORWARD_ALIAS_CAPACITY,
  FORWARD_ALIAS_MAX_OCTET,
  FORWARD_ALIAS_MIN_OCTET,
} from '../../remote-forward-namespace.ts'
import type { ForwardNamespaceStorage } from '../../remote-forward-namespace.ts'

class MemoryStorage implements ForwardNamespaceStorage {
  text: string | null = null
  reads = 0
  writes = 0
  failRead: Error | null = null
  failWrite: Error | null = null

  async read(): Promise<string | null> {
    this.reads += 1
    if (this.failRead !== null) throw this.failRead
    return this.text
  }

  async write(text: string): Promise<void> {
    this.writes += 1
    if (this.failWrite !== null) throw this.failWrite
    this.text = text
  }
}

/** Deterministic mint: consumes the given values, then walks upward. */
function mintFrom(values: number[] = []): () => number {
  let next = 0
  return () => {
    const value = values.length > 0 ? (values.shift() as number) : next
    next += 1
    return value
  }
}

function makeStore(overrides: {
  storage?: MemoryStorage
  now?: () => number
  mint?: () => number
} = {}) {
  const storage = overrides.storage ?? new MemoryStorage()
  const store = new ForwardNamespaces({
    storage,
    now: overrides.now ?? (() => 1_000),
    mintNamespace: overrides.mint ?? mintFrom(),
  })
  return { storage, store }
}

async function loaded(overrides: Parameters<typeof makeStore>[0] = {}) {
  const harness = makeStore(overrides)
  await harness.store.load()
  return harness
}

test('first assignment: preferred alias from the namespace, persisted', async () => {
  const { storage, store } = await loaded({ mint: mintFrom([0]) })
  const assignment = await store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' })
  assert.deepEqual(assignment, { sourceId: 'dsh-a', namespace: 0, aliasHost: forwardAliasHost(preferredAliasOctet(0)) })
  assert.equal(assignment.aliasHost, '127.0.0.2')
  assert.equal(storage.writes, 1)
  const state = parseForwardNamespaceState(storage.text)
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].retiredAt, null)
})

test('stable across restarts: a new store over the same bytes returns the same alias', async () => {
  const first = await loaded({ mint: mintFrom([1234]) })
  const assignment = await first.store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' })
  const second = makeStore({ storage: first.storage, mint: mintFrom([9999]) })
  await second.store.load()
  const again = await second.store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' })
  assert.deepEqual(again, assignment)
  assert.equal(second.storage.writes, 1, 'idempotent ensure must not rewrite the store')
})

test('adding and removing OTHER sources never moves an existing alias', async () => {
  const { store } = await loaded({ mint: mintFrom([100, 200, 300]) })
  const a = await store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' })
  const b = await store.ensure({ sourceId: 'dsh-b', identity: 'ident-bbbb' })
  assert.notEqual(a.aliasHost, b.aliasHost)
  await store.retire('dsh-b')
  const a2 = await store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' })
  assert.deepEqual(a2, a)
  const c = await store.ensure({ sourceId: 'dsh-c', identity: 'ident-cccc' })
  assert.notEqual(c.aliasHost, a.aliasHost)
  assert.notEqual(c.aliasHost, b.aliasHost, 'a retired alias is never reused')
})

test('retarget (identity change) rotates BOTH namespace and alias and retires the old entry', async () => {
  const { storage, store } = await loaded({ mint: mintFrom([10, 11]) })
  const before = await store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' })
  const after = await store.ensure({ sourceId: 'dsh-a', identity: 'ident-bbbb' })
  assert.equal(after.sourceId, 'dsh-a')
  assert.notEqual(after.namespace, before.namespace)
  assert.notEqual(after.aliasHost, before.aliasHost)
  const state = parseForwardNamespaceState(storage.text)
  assert.equal(state.entries.length, 2)
  assert.equal(state.entries[0].retiredAt, 1_000)
  assert.equal(state.entries[0].aliasHost, before.aliasHost)
  assert.equal(state.entries[1].retiredAt, null)
  assert.equal(state.entries[1].aliasHost, after.aliasHost)
  assert.equal(store.assignment('dsh-a')?.aliasHost, after.aliasHost)
})

test('delete then re-add the same source id: the retired alias is never handed back', async () => {
  const { store } = await loaded({ mint: mintFrom([7, 8]) })
  const before = await store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' })
  assert.equal(await store.retire('dsh-a'), true)
  assert.equal(await store.retire('dsh-a'), false)
  assert.equal(store.assignment('dsh-a'), null)
  const after = await store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' })
  assert.notEqual(after.aliasHost, before.aliasHost)
  assert.notEqual(after.namespace, before.namespace)
})

test('253 assignments never allocate 127.0.0.0/.1/.255 and never share a host', async () => {
  const { store } = await loaded({ mint: mintFrom() })
  const used = new Set<string>()
  for (let index = 0; index < FORWARD_ALIAS_CAPACITY; index += 1) {
    const assignment = await store.ensure({
      sourceId: 'dsh-s' + String(index),
      identity: 'ident-' + String(index).padStart(4, '0'),
    })
    assert.equal(isForwardAliasHost(assignment.aliasHost), true, assignment.aliasHost)
    assert.notEqual(assignment.aliasHost, '127.0.0.1')
    assert.equal(used.has(assignment.aliasHost), false, 'duplicate alias ' + assignment.aliasHost)
    used.add(assignment.aliasHost)
  }
  assert.equal(used.size, FORWARD_ALIAS_CAPACITY)
  assert.equal(used.has(forwardAliasHost(FORWARD_ALIAS_MIN_OCTET)), true)
  assert.equal(used.has(forwardAliasHost(FORWARD_ALIAS_MAX_OCTET)), true)
  await assert.rejects(
    () => store.ensure({ sourceId: 'dsh-overflow', identity: 'ident-overflow' }),
    (error: unknown) => error instanceof ForwardNamespaceError && error.code === 'alias_exhausted',
  )
})

test('allocation is deterministic: batch order does not change the assignment', async () => {
  const inputs = [
    { sourceId: 'dsh-b', identity: 'ident-bbbb' },
    { sourceId: 'dsh-a', identity: 'ident-aaaa' },
    { sourceId: 'dsh-c', identity: 'ident-cccc' },
  ]
  const forwardOrder = await loaded({ mint: mintFrom([1, 2, 3]) })
  const reverseOrder = await loaded({ mint: mintFrom([1, 2, 3]) })
  const forward = await forwardOrder.store.ensureMany(inputs)
  const reverse = await reverseOrder.store.ensureMany([...inputs].reverse())
  const byId = new Map(reverse.map(entry => [entry.sourceId, entry]))
  for (const entry of forward) {
    assert.deepEqual(byId.get(entry.sourceId), entry, entry.sourceId)
  }
  assert.deepEqual(forward.map(entry => entry.sourceId), inputs.map(input => input.sourceId))
})

test('preferred octet wraps inside 2..254 and never leaves the range', () => {
  assert.equal(preferredAliasOctet(0), 2)
  assert.equal(preferredAliasOctet(FORWARD_ALIAS_CAPACITY), 2)
  assert.equal(preferredAliasOctet(0xffff), 2 + (0xffff % FORWARD_ALIAS_CAPACITY))
  assert.deepEqual(
    allocateForwardAlias(0, new Set(['127.0.0.2', '127.0.0.3'])),
    '127.0.0.4',
  )
  assert.deepEqual(
    allocateForwardAlias(0, new Set(Array.from({ length: 251 }, (_value, index) => forwardAliasHost(index + 2)))),
    '127.0.0.253',
  )
  const allButOne = new Set(Array.from({ length: 253 }, (_value, index) => forwardAliasHost(index + 2)).filter(host => host !== '127.0.0.9'))
  assert.equal(allocateForwardAlias(0, allButOne), '127.0.0.9')
  assert.throws(() => allocateForwardAlias(0, new Set(Array.from({ length: 253 }, (_value, index) => forwardAliasHost(index + 2)))), ForwardNamespaceError)
})

test('corrupt persisted state fails closed (every malformed shape)', () => {
  const validEntry = {
    sourceId: 'dsh-a',
    namespace: 1,
    aliasHost: '127.0.0.2',
    identity: 'ident-aaaa',
    assignedAt: 1_000,
    retiredAt: null,
  }
  const corrupt: string[] = [
    '{',
    'null',
    '[]',
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [], extra: 1 }),
    JSON.stringify({ version: 1, entries: {} }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, aliasHost: '127.0.0.1' }] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, aliasHost: '127.0.0.255' }] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, namespace: 65536 }] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, sourceId: 'local' }] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, identity: 'short' }] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, retiredAt: 500 }] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, extra: 1 }] }),
    JSON.stringify({ version: 1, entries: [validEntry, { ...validEntry, sourceId: 'dsh-b' }] }),
    JSON.stringify({ version: 1, entries: [validEntry, { ...validEntry, sourceId: 'dsh-a', aliasHost: '127.0.0.3' }] }),
  ]
  corrupt.forEach((text, index) => {
    assert.throws(() => parseForwardNamespaceState(text), (error: unknown) => {
      return error instanceof ForwardNamespaceError && error.code === 'namespace_store_corrupt'
    }, 'case ' + String(index))
  })
  assert.deepEqual(parseForwardNamespaceState(null), { version: 1, entries: [] })
  assert.deepEqual(parseForwardNamespaceState(''), { version: 1, entries: [] })
})

test('a corrupt file makes load reject and leaves the store unloaded (no allocation)', async () => {
  const storage = new MemoryStorage()
  storage.text = '{"version":2,"entries":[]}'
  const { store } = makeStore({ storage })
  await assert.rejects(
    () => store.load(),
    (error: unknown) => error instanceof ForwardNamespaceError && error.code === 'namespace_store_corrupt',
  )
  await assert.rejects(
    () => store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' }),
    (error: unknown) => error instanceof ForwardNamespaceError && error.code === 'namespace_store_corrupt',
  )
  assert.equal(store.loaded, false)
  assert.equal(storage.writes, 0)
})

test('storage failures are typed and never commit', async () => {
  const storage = new MemoryStorage()
  storage.failRead = new Error('EACCES')
  const { store } = makeStore({ storage })
  await assert.rejects(
    () => store.load(),
    (error: unknown) => error instanceof ForwardNamespaceError && error.code === 'namespace_store_unavailable',
  )
  const writable = await loaded({ storage: new MemoryStorage() })
  writable.storage.failWrite = new Error('ENOSPC')
  await assert.rejects(
    () => writable.store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' }),
    (error: unknown) => error instanceof ForwardNamespaceError && error.code === 'namespace_store_unavailable',
  )
  assert.equal(writable.store.assignment('dsh-a'), null, 'a failed write must not commit memory state')
})

test('assignment()/entries() refuse to guess before a load', () => {
  const { store } = makeStore()
  assert.throws(() => store.assignment('dsh-a'), (error: unknown) => {
    return error instanceof ForwardNamespaceError && error.code === 'namespace_not_loaded'
  })
  assert.throws(() => store.entries(), (error: unknown) => {
    return error instanceof ForwardNamespaceError && error.code === 'namespace_not_loaded'
  })
})

test('invalid inputs are refused (local source ids, short identities, bad mint)', async () => {
  const { store } = await loaded()
  for (const input of [
    { sourceId: 'local', identity: 'ident-aaaa' },
    { sourceId: 'dsh-a/b', identity: 'ident-aaaa' },
    { sourceId: 'dsh-a', identity: 'short' },
    { sourceId: 'dsh-a', identity: 'has space here' },
  ]) {
    await assert.rejects(() => store.ensure(input), (error: unknown) => {
      return error instanceof ForwardNamespaceError && error.code === 'namespace_invalid_input'
    })
  }
  const badMint = makeStore({ mint: () => 70_000 })
  await badMint.store.load()
  await assert.rejects(
    () => badMint.store.ensure({ sourceId: 'dsh-a', identity: 'ident-aaaa' }),
    (error: unknown) => error instanceof ForwardNamespaceError && error.code === 'namespace_invalid_input',
  )
})

test('serialize/parse round-trips the strict schema', () => {
  const state = {
    version: 1 as const,
    entries: [
      { sourceId: 'dsh-a', namespace: 1, aliasHost: '127.0.0.2', identity: 'ident-aaaa', assignedAt: 10, retiredAt: 20 },
      { sourceId: 'dsh-a', namespace: 2, aliasHost: '127.0.0.3', identity: 'ident-bbbb', assignedAt: 20, retiredAt: null },
    ],
  }
  const text = serializeForwardNamespaceState(state)
  assert.equal(text.endsWith('\n'), true)
  assert.deepEqual(parseForwardNamespaceState(text), state)
})
