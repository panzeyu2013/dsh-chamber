/**
 * resident-store 单测（N-ctx 壳常驻重构 v1.1）：页面级 residentBridge 的 publish 同引用守卫、
 * 订阅/释放/刷新监听的抛错隔离、释放请求通道、订阅者计数（DOM 采集的预算信号）、
 * 冻结初值与不可变快照约定、页面本地（不落盘/无 wire）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  residentBridge,
  type ResidentSnapshot,
  type ResidentSourceFact,
} from '../src/resident-store.ts'

function source(id: string, overrides: Partial<ResidentSourceFact> = {}): ResidentSourceFact {
  return { id, label: id, state: 'resident', ...overrides }
}

function snapshot(overrides: Partial<ResidentSnapshot> = {}): ResidentSnapshot {
  return {
    sources: [],
    counts: { mounted: 0, resident: 0, active: 0, released: 0 },
    ...overrides,
  }
}

test('residentBridge: the initial page state is an empty, frozen snapshot', () => {
  const initial = residentBridge.get()
  assert.deepEqual(initial.sources, [])
  assert.deepEqual(initial.counts, { mounted: 0, resident: 0, active: 0, released: 0 })
  assert.equal(initial.lastRelease, undefined)
  assert.equal(Object.isFrozen(initial), true, 'a reader must not be able to write the shared empty state')
  assert.equal(Object.isFrozen(initial.sources), true)
  assert.equal(Object.isFrozen(initial.counts), true)
})

test('publish: stores the exact reference, notifies once, and never replays on subscribe', () => {
  let calls = 0
  const off = residentBridge.subscribe(() => { calls += 1 })
  assert.equal(calls, 0, 'subscribe does not immediately invoke the listener (the panel reads get() first)')
  const next = snapshot({
    sources: [source('local', { label: 'Local', state: 'active', lastActiveAt: 12 })],
    counts: { mounted: 1, resident: 0, active: 1, released: 0 },
    lastRelease: { sourceId: 'ssh-a', reason: 'manual', at: 42 },
  })
  residentBridge.publish(next)
  assert.equal(residentBridge.get(), next, 'the published snapshot is stored by reference (subscribers can diff by identity)')
  assert.equal(calls, 1)
  assert.deepEqual(residentBridge.get().lastRelease, { sourceId: 'ssh-a', reason: 'manual', at: 42 })
  off()
})

test('publish: the same reference is silent (the resident guard re-publishes on every effect)', () => {
  const next = snapshot({ counts: { mounted: 2, resident: 1, active: 1, released: 0 } })
  residentBridge.publish(next)
  let calls = 0
  const off = residentBridge.subscribe(() => { calls += 1 })
  residentBridge.publish(next)
  assert.equal(calls, 0, 'same-reference publish must not wake the panel')
  assert.equal(residentBridge.get(), next)
  off()
})

test('subscribe: the returned unsubscribe is idempotent and stops notifications', () => {
  let calls = 0
  const off = residentBridge.subscribe(() => { calls += 1 })
  residentBridge.publish(snapshot({ counts: { mounted: 1, resident: 0, active: 0, released: 0 } }))
  assert.equal(calls, 1)
  off()
  off()
  residentBridge.publish(snapshot({ counts: { mounted: 2, resident: 0, active: 0, released: 0 } }))
  assert.equal(calls, 1, 'no notification after unsubscribe')
})

test('publish: one throwing subscriber cannot break the others or the publisher', () => {
  const originalError = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    const order: string[] = []
    const offThrow = residentBridge.subscribe(() => {
      order.push('throw')
      throw new Error('listener boom')
    })
    const offAfter = residentBridge.subscribe(() => { order.push('after') })
    assert.doesNotThrow(
      () => residentBridge.publish(snapshot({ counts: { mounted: 3, resident: 0, active: 0, released: 0 } })),
      'a bad listener must never propagate to the producer',
    )
    assert.deepEqual(order, ['throw', 'after'], 'every remaining listener still runs')
    assert.equal(logged.length, 1, 'the isolated listener error is reported, not silently swallowed')
    offThrow()
    offAfter()
  } finally {
    console.error = originalError
  }
})

test('requestRelease: delivers the source id to every release listener (one command channel)', () => {
  const seen: string[] = []
  const offFirst = residentBridge.onReleaseRequest(id => { seen.push('first:' + id) })
  const offSecond = residentBridge.onReleaseRequest(id => { seen.push('second:' + id) })
  residentBridge.requestRelease('ssh-a')
  assert.deepEqual(seen, ['first:ssh-a', 'second:ssh-a'])
  offFirst()
  offFirst()
  residentBridge.requestRelease('ssh-b')
  assert.deepEqual(seen, ['first:ssh-a', 'second:ssh-a', 'second:ssh-b'], 'unsubscribe is idempotent and per-listener')
  offSecond()
  residentBridge.requestRelease('ssh-c')
  assert.deepEqual(seen, ['first:ssh-a', 'second:ssh-a', 'second:ssh-b'], 'no listeners = a silent command')
})

test('requestRelease: a throwing release listener cannot block the next one', () => {
  const originalError = console.error
  console.error = () => {}
  try {
    const seen: string[] = []
    const offThrow = residentBridge.onReleaseRequest(() => { throw new Error('release boom') })
    const offOk = residentBridge.onReleaseRequest(id => { seen.push(id) })
    assert.doesNotThrow(() => residentBridge.requestRelease('ssh-z'))
    assert.deepEqual(seen, ['ssh-z'], 'the release request still reaches the guard')
    offThrow()
    offOk()
  } finally {
    console.error = originalError
  }
})

test('subscriberCount: only snapshot subscribers count (release/refresh listeners are not a render budget)', () => {
  const base = residentBridge.subscriberCount()
  const offSnap = residentBridge.subscribe(() => {})
  const offRelease = residentBridge.onReleaseRequest(() => {})
  const offRefresh = residentBridge.onRefresh(() => {})
  assert.equal(residentBridge.subscriberCount(), base + 1, 'only the panel subscription gates expensive facts (DOM counts)')
  offSnap()
  offRelease()
  offRefresh()
  assert.equal(residentBridge.subscriberCount(), base)
})

test('requestRefresh: every refresh listener runs, throws are isolated, no listener = silent', () => {
  const originalError = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    const order: string[] = []
    const offThrow = residentBridge.onRefresh(() => {
      order.push('throw')
      throw new Error('refresh boom')
    })
    const offOk = residentBridge.onRefresh(() => { order.push('ok') })
    assert.doesNotThrow(() => residentBridge.requestRefresh(), 'a bad refresh listener must never propagate to the panel')
    assert.deepEqual(order, ['throw', 'ok'], 'every remaining listener still runs')
    assert.equal(logged.length, 1, 'the isolated listener error is reported, not silently swallowed')
    offThrow()
    offOk()
    assert.doesNotThrow(() => residentBridge.requestRefresh(), 'no listener = a silent request (panel closed)')
  } finally {
    console.error = originalError
  }
})

test('publish: counts and facts are publisher-owned; the bridge never recomputes or mutates them', () => {
  const sources: ResidentSourceFact[] = [source('ssh-a'), source('ssh-b', { state: 'booting' })]
  const next = snapshot({ sources, counts: { mounted: 2, resident: 1, active: 0, released: 3 } })
  residentBridge.publish(next)
  const read = residentBridge.get()
  assert.equal(read.sources, sources, 'the exact sources array is exposed (no copy churn)')
  assert.equal(read.counts, next.counts, 'counts are taken as-is')
  assert.deepEqual(read.counts, { mounted: 2, resident: 1, active: 0, released: 3 })
  assert.deepEqual(sources.map(fact => fact.id), ['ssh-a', 'ssh-b'], 'the bridge appended/removed nothing')
})

test('resident-store: page-local only (no persistence, no wire, no clock read)', () => {
  const text = readFileSync(fileURLToPath(new URL('../src/resident-store.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|JSON\.stringify|postMessage|fetch\(/,
    'the bridge must not persist or cross the wire')
  assert.doesNotMatch(text, /Date\.now|performance\.now/,
    'timestamps are producer facts (lastRelease.at / lastActiveAt); the bridge reads no clock')
})
