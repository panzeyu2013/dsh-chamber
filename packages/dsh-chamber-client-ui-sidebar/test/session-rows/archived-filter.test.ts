/**
 * 归档筛选（design 06 §3.4，per-source 三态）：
 *  - deriveServerWorkspaces：default 隐藏 / show 原槽位混入并打稀疏 archived 标记 /
 *    only 只显归档且丢弃无可见成员的 workspace；
 *  - deriveLocalSearchMatches：搜索结果跟随筛选；
 *  - 接线锁：renderer 投影把 per-source 筛选作为输入（servers.ts）并用签名订阅触发
 *    重投影（App.tsx）。
 * Run directly: node test/session-rows/archived-filter.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deriveLocalSearchMatches, deriveServerWorkspaces } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { server as aggregate, session, snapshot, workspace } from '../support/derive-fixtures.ts'
import { projectionToLocalSearchSnapshot } from '../../src/client/server-section-model.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

function derive(
  rows: ReturnType<typeof workspace>[],
  sessions: ReturnType<typeof session>[],
  filter: 'default' | 'show' | 'only',
  options: { archived?: string[]; pinned?: string[]; current?: string; now?: number } = {},
) {
  const base = snapshot(rows, sessions, { pinnedSessionIds: options.pinned ?? [], pinSetKnown: true })
  return deriveServerWorkspaces(
    { ...base, archivedSessionIds: options.archived ?? [], archiveSetKnown: true },
    'srv-a', '', options.current, options.now ?? 1_000, filter,
  )
}

test('archived rows follow the filter: hidden by default, in-slot on show, sole rows on only', () => {
  const rows = [workspace('w1', 'Work', ['s1', 's2']), workspace('w2', 'Other', ['s3'])]
  const sessions = [session('s1', 10), session('s2', 20), session('s3', 30)]
  const archived = ['s2', 's3']

  // default = 现状：归档行不进入投影。
  assert.deepEqual(derive(rows, sessions, 'default', { archived }).flatMap(w => w.sessions.map(s => s.id)), ['s1'])

  // show：归档行回它在 workspace.sessionIds 里的原槽位（记账槽未动），并打稀疏标记。
  const show = derive(rows, sessions, 'show', { archived })
  assert.deepEqual(show.map(w => w.id), ['w1', 'w2'])
  assert.deepEqual(show.flatMap(w => w.sessions.map(s => s.id)), ['s1', 's2', 's3'])
  const showRows = new Map(show.flatMap(w => w.sessions.map(s => [s.id, s] as const)))
  assert.equal(showRows.get('s2')?.archived, true)
  assert.equal(showRows.get('s1')?.archived, undefined, 'the flag is sparse, never a stable false')

  // only：只显归档行；两份 workspace 都各有归档成员，均保留。
  const only = derive(rows, sessions, 'only', { archived })
  assert.deepEqual(only.map(w => w.id), ['w1', 'w2'])
  assert.deepEqual(only.flatMap(w => w.sessions.map(s => s.id)).sort(), ['s2', 's3'])
})

test('an archived row never carries the pin flag (upstream pinned && !archived), and only drops empty workspaces', () => {
  const rows = [workspace('w1', 'Work', ['s1', 's2']), workspace('w2', 'Other', ['s3'])]
  const sessions = [session('s1', 10), session('s2', 20), session('s3', 30)]
  const show = derive(rows, sessions, 'show', { archived: ['s2', 's3'], pinned: ['s2', 's1'] })
  const byId = new Map(show.flatMap(w => w.sessions.map(s => [s.id, s] as const)))
  assert.equal(byId.get('s1')?.pinned, true)
  assert.equal(byId.get('s2')?.pinned, undefined, 'an archived row is never pinned (host clears the pin on archive)')
  assert.equal(byId.get('s2')?.archived, true)

  // only：没有可见归档成员的 workspace 整个丢弃（上游 groupByWorkspace 同规则）。
  assert.deepEqual(derive([workspace('w1', 'Work', ['s1'])], [session('s1')], 'only', { archived: [] }), [])
  // 有归档成员的另一半保留：混合来源里只有空组消失。
  const mixed = derive([workspace('w1', 'Work', ['s1']), workspace('w2', 'Other', ['s2'])], [session('s1'), session('s2')], 'only', { archived: ['s2'] })
  assert.deepEqual(mixed.map(w => w.id), ['w2'])
})

test('archived STRAY (ungrouped) rows follow the filter too, not only workspace members', () => {
  // 未归属任何 workspace 的行走 ungrouped 分支：它必须收到同一个 filter 参数，
  // 否则 show/only 下归档的游离行永不出现（与 workspace 成员分支不一致）。
  const rows = [workspace('w1', 'Work', ['s1'])]
  const sessions = [session('s1', 10), session('stray', 20)]
  const show = derive(rows, sessions, 'show', { archived: ['stray'] })
  const ungrouped = show.find(group => group.ungrouped === true)
  assert.deepEqual(ungrouped?.sessions.map(row => row.id), ['stray'])
  assert.equal(ungrouped?.sessions[0]?.archived, true, 'the sparse archived flag rides the stray row too')
  assert.deepEqual(derive(rows, sessions, 'default', { archived: ['stray'] }).flatMap(group => group.sessions.map(row => row.id)), ['s1'])
  const only = derive(rows, sessions, 'only', { archived: ['stray'] })
  assert.deepEqual(only.map(group => group.id), ['__ungrouped__'])
  assert.deepEqual(only.flatMap(group => group.sessions.map(row => row.id)), ['stray'])
})

test('local search follows the filter: default excludes archived hits, show/only include them', () => {
  const base = snapshot([workspace('w1', 'Work', ['s1', 's2'])], [session('s1', 10), session('s2', 20)])
  const snap = { ...base, archivedSessionIds: ['s2'], archiveSetKnown: true }
  assert.deepEqual(deriveLocalSearchMatches(snap, 's2', 'default'), [], 'the archived hit stays out of the default search')
  assert.deepEqual(deriveLocalSearchMatches(snap, 's2', 'show').map(row => row.sessionId), ['s2'])
  assert.deepEqual(deriveLocalSearchMatches(snap, 's2', 'only').map(row => row.sessionId), ['s2'])
  assert.deepEqual(deriveLocalSearchMatches(snap, 's1', 'only'), [], 'only keeps non-archived hits out')
})

test('the renderer projection wires the per-source filter as a projection input (source lock)', () => {
  const SERVERS = read('../../../../packages/renderer/src/host/servers.ts')
  const SECTION = read('../../src/client/ServerSection.tsx')
  assert.ok(SERVERS.includes('archivedFilters?: Readonly<Record<string, ArchivedFilter>>'),
    'deriveServers takes the per-source filter map')
  assert.ok(SERVERS.includes('const archivedFilter: ArchivedFilter = aggregate?.archiveSetKnown === true'),
    'the degraded provenance gate resolves the rendered filter (unknown set falls back to default)')
  assert.ok(SERVERS.includes("? (archivedFilters?.[id] ?? 'default')") && SERVERS.includes("      : 'default'"),
    'the stored filter only applies while the archive set is known (stored value kept in prefs)')
  assert.ok(SECTION.includes('const archivedFilter = server.archiveSetKnown === true'),
    'the section applies the same fallback gate (search / empty state / notice link)')
  assert.ok(SERVERS.includes('      aggregate ?? null,\n      archivedFilter,'),
    'the filter is a per-source cache key component (a filter change must invalidate the entry)')
  assert.ok(SERVERS.includes("        current,\n        undefined,\n        archivedFilter,"),
    'the filter reaches deriveServerWorkspaces in the archivedFilter slot')

  const APP = read('../../../../packages/renderer/src/App.tsx')
  assert.ok(APP.includes('subscribeViewPrefs'), 'App subscribes to the shared view-prefs store')
  assert.ok(APP.includes("JSON.stringify(getViewPrefs().archivedFilter ?? {})"),
    'only the filter map signature is subscribed (other prefs writes must not re-render the App)')
  assert.ok(APP.includes('echoes.placement, archivedFilters, echoes.removal)'),
    'the map rides the deriveServers call (and the removal ledger is appended after it — parameter order is a wiring contract)')
  assert.ok(APP.includes('projectionCaches, archivedFilters]'), 'the map is a memo dependency')

  const DERIVE = read('../../../../packages/dsh-chamber-client-core/src/derive.ts')
  assert.ok(DERIVE.includes('archived: x.archived === true,'),
    'the publish signature carries the archived bit (a filter change must republish)')
})

test('the local-search snapshot rebuilds archivedSessionIds so the only leg can classify hits', () => {
  // 生产 helper 重建的快照必须带回归档 id（第二轮 A.2 的**行为**锁；源码锁在 row-render-cost）。
  const agg = aggregate('srv-a', {
    archiveSetKnown: true,
    workspaces: [{
      id: 'w1',
      title: 'Work',
      sessions: [
        { id: 'a', title: 'Alpha', displayTitle: 'Alpha', running: false, updatedAt: 5 },
        { id: 'z', title: 'Zeta', displayTitle: 'Zeta', running: false, updatedAt: 6, archived: true },
      ],
    }],
  })
  const snap = projectionToLocalSearchSnapshot(agg)
  assert.deepEqual(snap.archivedSessionIds, ['z'], 'the rebuilt snapshot carries the sparse archived bit')
  assert.deepEqual(deriveLocalSearchMatches(snap, 'zeta', 'only').map(row => row.sessionId), ['z'])
  assert.deepEqual(deriveLocalSearchMatches(snap, 'zeta', 'default'), [], 'default hides the archived hit')
  assert.deepEqual(deriveLocalSearchMatches(snap, 'alpha', 'only'), [], 'only keeps live hits out')
})

test('blank rows follow the upstream order: non-current blanks hidden everywhere, archived current blank is a tombstone', () => {
  const rows = [workspace('w1', 'Work', ['b1', 'b2', 's1'])]
  const sessions = [session('b1', 10, { blank: true }), session('b2', 20, { blank: true }), session('s1', 30)]
  // 非当前、非 ghost 的 blank 行在任何三态都不渲染（上游 blank 先于筛选）。
  for (const filter of ['default', 'show', 'only'] as const) {
    const ids = derive(rows, sessions, filter, { current: 'b1' }).flatMap(w => w.sessions.map(s => s.id))
    assert.equal(ids.includes('b2'), false, `a non-current blank is hidden under ${filter}`)
  }
  // 当前 blank 正常可见；归档的当前 blank 只在 show/only 出现（default 隐藏 = tombstone 契约）。
  assert.deepEqual(derive(rows, sessions, 'default', { current: 'b1' }).flatMap(w => w.sessions.map(s => s.id)), ['b1', 's1'])
  assert.deepEqual(derive(rows, sessions, 'show', { archived: ['b1'], current: 'b1' }).flatMap(w => w.sessions.map(s => s.id)), ['b1', 's1'])
  assert.deepEqual(derive(rows, sessions, 'only', { archived: ['b1'], current: 'b1' }).flatMap(w => w.sessions.map(s => s.id)), ['b1'])
  assert.deepEqual(derive(rows, sessions, 'default', { archived: ['b1'], current: 'b1' }).flatMap(w => w.sessions.map(s => s.id)), ['s1'])
})
