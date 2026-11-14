/**
 * Mounted-source store contract (host/mounted-sources-store.ts): ONE authority
 * for "this source's ctx published a complete snapshot". The table used to live
 * in three places at once (rendered useState + ledger ref mirror + reducer
 * lifecycle state); these cases pin the domain operations and the source lock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core'
import { createMountedSourcesStore } from '../../src/host/mounted-sources-store.ts'
import {
  planSessionFactsSources,
  readA3SkipMountedFacts,
  sessionFactsSpecSignature,
} from '../../src/app-hooks/use-session-facts-lifecycle.ts'

test('mark/withdraw publish one snapshot to render and callbacks alike', () => {
  const store = createMountedSourcesStore()
  assert.deepEqual(store.getSnapshot(), {})
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.mark('a')
  assert.deepEqual(store.getSnapshot(), { a: true }, 'the synchronous read sees the push')
  store.mark('a')
  assert.equal(notifications, 1, 're-marking a mounted source is a no-op')
  store.withdraw('a')
  assert.deepEqual(store.getSnapshot(), {})
  store.withdraw('missing')
  assert.equal(notifications, 2, 'withdrawing an absent source is a no-op')
})

test('retire drops exactly the given ids and stays identity-preserving otherwise', () => {
  const store = createMountedSourcesStore({ a: true, b: true, c: true })
  const before = store.getSnapshot()
  store.retire(['missing'])
  assert.equal(store.getSnapshot(), before, 'no matching id keeps the same table object')
  store.retire(['a', 'c'])
  assert.deepEqual(store.getSnapshot(), { b: true })
})

test('prune returns the dropped ids that drive the snapshotAt lockstep', () => {
  const store = createMountedSourcesStore({ a: true, b: true })
  const dropped = store.prune(new Set(['a']))
  assert.deepEqual([...dropped], ['b'])
  assert.deepEqual(store.getSnapshot(), { a: true })
  assert.deepEqual([...store.prune(new Set(['a']))], [], 'a clean sweep drops nothing')
})

test('the snapshot identity is stable unless membership changes', () => {
  const store = createMountedSourcesStore({ a: true })
  const first = store.getSnapshot()
  store.mark('a')
  store.withdraw('missing')
  assert.equal(store.getSnapshot(), first)
})

test('the App and its hooks keep ONE mounted-source store', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const app = read('../../src/App.tsx')
  assert.match(app, /createMountedSourcesStore/, 'one store instance')
  assert.match(app, /useSyncExternalStore\(mountedSources\.subscribe, mountedSources\.getSnapshot/, 'the render binding subscribes to the store snapshot')
  for (const file of [
    app,
    read('../../src/app-hooks/use-aggregate-refresh.ts'),
    read('../../src/app-hooks/use-bridge-subscriptions.ts'),
    read('../../src/host/source-ledger.ts'),
  ]) {
    assert.doesNotMatch(file, /snapshotSourcesRef|setSnapshotSources/,
      'the ledger ref mirror and its setter must not come back')
  }
})

// ── A3 调试开关（默认关）：已挂载来源不进 facts 订阅面 ───────────────────────
// hook 本身不可在 node 直测（React 渲染/effect 需 DOM），所以把「期望态规划」抽成纯函数
// 在此钉住两态，接线由 wiring 源锁（test/wiring/session-authority-wiring.test.ts）覆盖。

/** 只读 id/kind/sourceFingerprint/connected 的最小投影（规划器只消费这四个字段）。 */
const factsServer = (
  id: string,
  kind: string,
  connected = true,
): ChamberServerAggregate => ({ id, kind, connected, sourceFingerprint: 'fp-' + id } as unknown as ChamberServerAggregate)

test('A3 flag: default OFF — only an explicit boolean true enables (missing/false/truthy strings stay off)', () => {
  // 出厂页面的真实 globalThis 没有任何 A3 键 ⇒ 默认关（现状保持的第一层证据）。
  assert.equal(readA3SkipMountedFacts(), false, 'the shipped page has no A3 key => OFF')
  assert.equal(readA3SkipMountedFacts({}), false, 'absent key = shipped behavior')
  assert.equal(readA3SkipMountedFacts({ __DSH_CHAMBER_A3_SKIP_MOUNTED_FACTS__: undefined }), false)
  assert.equal(readA3SkipMountedFacts({ __DSH_CHAMBER_A3_SKIP_MOUNTED_FACTS__: false }), false)
  assert.equal(readA3SkipMountedFacts({ __DSH_CHAMBER_A3_SKIP_MOUNTED_FACTS__: true }), true)
  // 非布尔真值不启用：开关是「显式裁决」，不是 truthiness 猜测。
  for (const value of [1, 'true', {}, []]) {
    assert.equal(readA3SkipMountedFacts({ __DSH_CHAMBER_A3_SKIP_MOUNTED_FACTS__: value }), false,
      'non-boolean ' + JSON.stringify(value) + ' must not arm the dev flag')
  }
  // 宿主形状兜底：null / 非对象 scope 视为关闭（SSR/无页面环境）。
  assert.equal(readA3SkipMountedFacts(null), false)
  assert.equal(readA3SkipMountedFacts('globalThis'), false)
})

test('A3 flag OFF: the plan and spec signatures are byte-identical to the pre-flag inline formulas', () => {
  const servers = [
    factsServer('g1', 'gateway', true),
    factsServer('l1', 'local', false),
    factsServer('d1', 'dsh', true),
    factsServer('g2', 'gateway', false),
  ]
  // 改动前两个 useMemo 的内联公式（逐字复刻）：开关关时必须产出同一份签名字节。
  const legacyGateway = servers
    .filter(server => server.kind === 'gateway')
    .map(server => server.id + ':' + server.sourceFingerprint + ':' + (server.connected ? '1' : '0'))
    .join('|')
  const legacyMux = servers
    .filter(server => ['local', 'dsh'].includes(server.kind))
    .map(server => server.id + ':' + server.sourceFingerprint + ':' + (server.connected ? '1' : '0'))
    .join('|')
  const plan = planSessionFactsSources(servers) // mounted === undefined = 开关关
  assert.equal(sessionFactsSpecSignature(plan.gateway), legacyGateway)
  assert.equal(sessionFactsSpecSignature(plan.mux), legacyMux)
  assert.equal(legacyGateway, 'g1:fp-g1:1|g2:fp-g2:0', 'format/order pinned (id:fingerprint:connected, | joined)')
  assert.equal(legacyMux, 'l1:fp-l1:0|d1:fp-d1:1')
  assert.deepEqual(plan.gateway.map(entry => entry.id), ['g1', 'g2'], 'every gateway source subscribes when the flag is off')
  assert.deepEqual(plan.mux.map(entry => entry.id), ['l1', 'd1'], 'every dsh-protocol source is observed when the flag is off')
  // 空 mounted 表（开关开但没有已挂来源）与开关关同效。
  assert.deepEqual(planSessionFactsSources(servers, {}), plan)
})

test('A3 flag ON: mounted sources leave the facts plan; unmounted sources stay; unrelated ids are inert', () => {
  const servers = [
    factsServer('g1', 'gateway', true),
    factsServer('l1', 'local', false),
    factsServer('d1', 'dsh', true),
    factsServer('g2', 'gateway', false),
  ]
  const plan = planSessionFactsSources(servers, { g1: true, l1: true })
  assert.deepEqual(plan.gateway.map(entry => entry.id), ['g2'], 'a mounted gateway source must not get a facts source')
  assert.deepEqual(plan.mux.map(entry => entry.id), ['d1'], 'a mounted local source must not get a mux observer')
  assert.equal(sessionFactsSpecSignature(plan.gateway), 'g2:fp-g2:0', 'remaining spec keeps the legacy format')
  assert.equal(sessionFactsSpecSignature(plan.mux), 'd1:fp-d1:1')
  // 未知 id 的挂载位不改变任何期望态（mounted 表是全局表，服务器清单才是权威域）。
  assert.deepEqual(planSessionFactsSources(servers, { 'never-listed': true }), planSessionFactsSources(servers))
  // 已挂来源消失（退订）后：mounted 位清掉 ⇒ 重新进入期望态 = 订阅复活（A/B 的挂载边沿语义）。
  const revived = planSessionFactsSources(servers, {})
  assert.deepEqual(revived.gateway.map(entry => entry.id), ['g1', 'g2'])
  assert.deepEqual(revived.mux.map(entry => entry.id), ['l1', 'd1'])
})

test('A3 planner is pure: same inputs -> same output; input servers are never mutated', () => {
  const servers = [factsServer('g1', 'gateway', true), factsServer('l1', 'local', true)]
  const frozen = JSON.parse(JSON.stringify(servers)) as ChamberServerAggregate[]
  const first = planSessionFactsSources(servers, { g1: true })
  const second = planSessionFactsSources(servers, { g1: true })
  assert.deepEqual(first, second)
  assert.deepEqual(servers, frozen, 'the planner must not touch the projected servers array')
})
