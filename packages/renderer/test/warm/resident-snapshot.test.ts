/**
 * resident-snapshot 纯构建器的单测（N-ctx 壳常驻 v1.1）：状态词表全部可产出（含 released 行）、
 * 隐藏事实只属于 resident、counts、DOM 节点数注入、lastRelease 透传、不改入参。
 * 零依赖：类型 import 被 type strip 擦除，纯 node 直跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildResidentSnapshot, type ResidentSnapshotInputs } from '../../src/resident-snapshot.ts'

function inputs(overrides: Partial<ResidentSnapshotInputs> = {}): ResidentSnapshotInputs {
  return {
    mountedIds: ['local', 'active', 'warm'],
    activeId: 'active',
    paintedId: 'active',
    shellStates: {
      local: { booted: true, error: null },
      active: { booted: true, error: null },
      warm: { booted: true, error: null },
    },
    labels: { local: '本地', active: 'A', warm: 'W', old: 'O' },
    releasedIds: new Set<string>(),
    autoPrewarmed: { has: () => false },
    lastActiveAt: { local: 1_000, active: 2_000, warm: 500 },
    now: 10_000,
    ...overrides,
  }
}

test('state vocabulary: active / resident / booting / failed all projected from mounted facts', () => {
  const snapshot = buildResidentSnapshot(inputs({
    mountedIds: ['local', 'a', 'b', 'c', 'd'],
    activeId: 'a',
    paintedId: 'a',
    shellStates: {
      local: { booted: true, error: null },
      a: { booted: true, error: null },
      b: { booted: true, error: null },
      c: { booted: false, error: null },
      d: { booted: false, error: 'boot failed' },
    },
    lastActiveAt: { local: 1, a: 2, b: 3, c: 4, d: 5 },
  }))
  assert.deepEqual(snapshot.sources.map(s => [s.id, s.state]), [
    ['local', 'resident'], ['a', 'active'], ['b', 'resident'], ['c', 'booting'], ['d', 'failed'],
  ])
})

test('hidden facts belong to resident shells only (active/booting/failed carry neither field)', () => {
  const snapshot = buildResidentSnapshot(inputs())
  const byId = new Map(snapshot.sources.map(s => [s.id, s]))
  assert.deepEqual(byId.get('active'), { id: 'active', label: 'A', state: 'active' },
    'the on-screen shell must not carry hiddenSinceMs/lastActiveAt')
  assert.equal(byId.get('warm')?.hiddenSinceMs, 9_500, 'a settled hidden shell carries its hidden duration')
  assert.equal(byId.get('warm')?.lastActiveAt, 500)
  const booting = buildResidentSnapshot(inputs({
    mountedIds: ['local', 'booting'],
    activeId: 'local',
    paintedId: 'local',
    shellStates: { local: { booted: true, error: null }, booting: { booted: false, error: null } },
    lastActiveAt: { local: 1, booting: 2 },
  }))
  const bootingFact = booting.sources.find(s => s.id === 'booting')
  assert.deepEqual(bootingFact, { id: 'booting', label: 'booting', state: 'booting' },
    'an unsettled shell has no hidden window yet; label falls back to the id')
})

test('released rows: sources include registered-but-unmounted sources as released, after mounted rows', () => {
  const snapshot = buildResidentSnapshot(inputs({
    releasedIds: new Set(['old', 'local', 'ghost']),
    labels: { local: '本地', active: 'A', warm: 'W', old: 'O' },
  }))
  assert.deepEqual(snapshot.sources.slice(-1), [{ id: 'old', label: 'O', state: 'released' }],
    'local (still mounted) and ghost (no label) are dropped defensively')
  assert.equal(snapshot.counts.released, 1)
  assert.deepEqual(snapshot.sources.filter(s => s.state === 'released').map(s => s.id), ['old'])
})

test('counts: mounted includes local; active/resident count mounted shells only; released = released rows', () => {
  const snapshot = buildResidentSnapshot(inputs({
    releasedIds: new Set(['old', 'old2']),
    labels: { local: '本地', active: 'A', warm: 'W', old: 'O', old2: 'O2' },
  }))
  assert.deepEqual(snapshot.counts, { mounted: 3, active: 1, resident: 2, released: 2 })
})

test('domNodes: injected callback value is passed through; undefined and 0 are omitted', () => {
  const snapshot = buildResidentSnapshot(inputs({
    domNodes: id => (id === 'warm' ? 900 : id === 'local' ? 0 : undefined),
  }))
  const byId = new Map(snapshot.sources.map(s => [s.id, s]))
  assert.equal(byId.get('warm')?.domNodes, 900)
  assert.equal(byId.get('local')?.domNodes, undefined)
  assert.equal(byId.get('active')?.domNodes, undefined)
})

test('autoPrewarmed fact: only mounted speculative shells are marked', () => {
  const snapshot = buildResidentSnapshot(inputs({ autoPrewarmed: { has: (id: string) => id === 'warm' } }))
  const byId = new Map(snapshot.sources.map(s => [s.id, s]))
  assert.equal(byId.get('warm')?.autoPrewarmed, true)
  assert.equal(byId.get('active')?.autoPrewarmed, undefined)
})

test('settingsTarget fact: only the panel target mounted shell is marked', () => {
  const snapshot = buildResidentSnapshot(inputs({ settingsTargetId: 'warm' }))
  const byId = new Map(snapshot.sources.map(s => [s.id, s]))
  assert.equal(byId.get('warm')?.settingsTarget, true)
  assert.equal(byId.get('active')?.settingsTarget, undefined)
  assert.equal(buildResidentSnapshot(inputs({ settingsTargetId: null })).sources.some(s => s.settingsTarget === true), false)
})

test('lastRelease: passed through by reference; absent stays absent (not an empty object)', () => {
  const lastRelease = { sourceId: 'warm', reason: 'pressure' as const, at: 42 }
  assert.deepEqual(buildResidentSnapshot(inputs({ lastRelease })).lastRelease, lastRelease)
  assert.equal('lastRelease' in buildResidentSnapshot(inputs()), false)
})

test('purity: the builder never mutates its inputs', () => {
  const lastActiveAt = { local: 1, active: 2 }
  const input = inputs({ lastActiveAt, releasedIds: new Set(['old']) })
  const before = JSON.stringify({ mounted: input.mountedIds, lastActiveAt, released: [...input.releasedIds] })
  buildResidentSnapshot(input)
  buildResidentSnapshot(input)
  assert.equal(JSON.stringify({ mounted: input.mountedIds, lastActiveAt, released: [...input.releasedIds] }), before)
})
