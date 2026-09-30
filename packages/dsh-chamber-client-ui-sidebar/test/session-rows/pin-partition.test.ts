/**
 * 置顶渲染分区（Phase 4，选项1）：上游 `sectionMembers` 语义的纯函数 + 工作区/树/flat
 * 三处接线锁 + 集合出处门（pinSetKnown）的聚合与发布签名锁。
 * Run directly: node test/session-rows/pin-partition.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { partitionPinnedSessions } from '@dsh-chamber/dsh-chamber-client-core/pin-partition'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const SECTION = read('../../src/client/ServerSection.tsx')
const SEARCH = read('../../src/client/ServerSectionSearch.tsx')
const DERIVE = read('../../../../packages/dsh-chamber-client-core/src/derive.ts')
const SERVERS = read('../../../../packages/renderer/src/host/servers.ts')

const row = (id: string, extra: Record<string, unknown> = {}): { id: string } & Record<string, unknown> => ({ id, ...extra })

test('the pinned block leads its account: blank first, then pinned, then the rest (each order preserved)', () => {
  const rows = [row('a'), row('b'), row('c'), row('blank', { blank: true }), row('d')]
  const pinnedIds = new Set(['c', 'a'])
  // 无 pinOrder：块内保持传入顺序（updated 模式的语义）。
  assert.deepEqual(partitionPinnedSessions(rows, { pinnedIds }).map(r => r.id), ['blank', 'a', 'c', 'b', 'd'])
  // manual：块内按宿主「最近置顶在前」。
  assert.deepEqual(partitionPinnedSessions(rows, { pinnedIds, pinOrder: ['c', 'a'] }).map(r => r.id), ['blank', 'c', 'a', 'b', 'd'])
  // 归档行不算置顶（即便 id 在集合里，derive 也从不给归档行 pinned 标记）。
  assert.deepEqual(
    partitionPinnedSessions([row('a'), row('x', { archived: true })], { pinnedIds: new Set(['a', 'x']) }).map(r => r.id),
    ['a', 'x'],
  )
  // 集合未知：不宣称任何置顶（无置顶块），但 blank 占位行照上游无条件提前；返回副本而非同一引用。
  const unknown = partitionPinnedSessions(rows)
  assert.deepEqual(unknown.map(r => r.id), ['blank', 'a', 'b', 'c', 'd'])
  assert.notEqual(unknown, rows)
  // 已知但为空的集合：不宣称任何置顶，但 blank 占位行仍提前（上游 sectionMembers 无条件）。
  assert.deepEqual(partitionPinnedSessions(rows, { pinnedIds: new Set() }).map(r => r.id),
    ['blank', 'a', 'b', 'c', 'd'])
})

test('an id missing from pinOrder keeps its relative position after the ranked ones (stable sort)', () => {
  const rows = [row('a'), row('b'), row('c')]
  assert.deepEqual(
    partitionPinnedSessions(rows, { pinnedIds: new Set(['a', 'b', 'c']), pinOrder: ['c'] }).map(r => r.id),
    ['c', 'a', 'b'],
  )
})

test('the section applies the partition to every mode: workspace, tree and flat (source lock)', () => {
  assert.ok(SECTION.includes('const pinnedOrder = server.pinSetKnown === true ? server.pinnedSessionIds : undefined'),
    'the host pin array is the block-order source, gated on the provenance flag')
  assert.ok(SECTION.includes('const pinnedIds = pinnedOrder === undefined ? undefined : new Set(pinnedOrder)'))
  assert.ok(SECTION.includes('const sessionsInOrder = (workspace: ChamberServerWorkspace)'),
    'the raw mode order stays its own function; the partition is layered on top')
  assert.ok(SECTION.includes('partitionPinnedSessions(sessionsInOrder(workspace), pinOptions)'),
    'workspace and tree modes consume the partitioned order through sessionsOf')
  assert.ok(SECTION.includes('return partitionPinnedSessions(ordered, pinOptions)'), 'the flat list is partitioned too')
  assert.ok(SECTION.includes('const pinOptions = {'), 'one shared options object feeds both partition sites')
  assert.equal(SECTION.split("...(pinnedOrder === undefined || orderBy === 'updated' ? {} : { pinOrder: pinnedOrder }),").length - 1, 1,
    'manual uses the host pin order; updated keeps the account own order - the rule exists once')
  assert.equal(SECTION.includes('reconciledSessionOrder'), false,
    'the stored-order replay is single-sourced in orderUngroupedSessions')
  assert.equal(SEARCH.includes('partitionPinnedSessions'), false, 'search results are never pin-partitioned (upstream rule)')
})

test('the aggregate producer and the publish signature carry the pin set (source lock)', () => {
  assert.ok(SERVERS.includes('aggregate.pinnedSessionIds.map(String)')
    && SERVERS.includes('pinSetKnown: aggregate.pinSetKnown === true'),
    'the renderer projects the host pin set with its provenance gate')
  assert.ok(DERIVE.includes('pinnedSessionIds: server.pinnedSessionIds ?? null')
    && DERIVE.includes('pinSetKnown: server.pinSetKnown === true'),
    'a pin-set or provenance change must move the publish gate')
})
