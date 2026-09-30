/**
 * 第三轮 review 的行为/接线锁：置顶拖放门与 blank 落半归一、拖拽看门狗、待办区归档排除、
 * sessionFacts 发布签名、提升簿记保留、焦点归还、归档悬停卡、提示条 role/断连门、flat 哨兵键
 * 与视图键、git flags 订阅、ctx 覆盖与稳定包装、工作区账号裁剪。每条都对应第三轮的确认结论。
 * Run directly: node test/session-rows/round3-regressions.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { flatAccountKey } from '@dsh-chamber/dsh-chamber-client-core/flat-account'
import { serversProjectionSignature } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { partitionPinnedSessions } from '@dsh-chamber/dsh-chamber-client-core/pin-partition'
import { server as aggregate } from '../support/derive-fixtures.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const ROOT = read('../../src/client/SidebarRoot.tsx')
const CTX = read('../../src/client/sidebar-context.ts')
const SECTION = read('../../src/client/ServerSection.tsx')
const ROWS = read('../../src/client/ServerSectionRows.tsx')
const SEARCH = read('../../src/client/ServerSectionSearch.tsx')
const DRAG = read('../../src/client/sidebar-root-drag.ts')
const PROJ = read('../../src/client/sidebar-root-projection.ts')
const NOTICES = read('../../src/client/sidebar-root-notices.ts')
const VP = read('../../../../packages/dsh-chamber-client-core/src/view-prefs.ts')

test('flat updated account uses the NUL sentinel (never the colliding __flat__ key)', () => {
  assert.equal(flatAccountKey('srv'), 'srv/\u0000flat')
  assert.notEqual(flatAccountKey('srv'), 'srv/__flat__')
  assert.ok(SECTION.includes('const flatUpdatedAccountKey = flatAccountKey(server.id)'))
  assert.equal(SECTION.includes('`${server.id}/${FLAT_ACCOUNT_KEY}`'), false, 'no collision-prone account key in the render')
  assert.ok(PROJ.includes('flatAccountKey(server.id)') && DRAG.includes('flatAccountKey(server.id)'))
})

test('flat pseudo-account view state is namespaced apart from a real __flat__ workspace', () => {
  assert.ok(SECTION.includes('const accountStateKey = flatAccount ? flatAccountKey(server.id) : workspaceKey'))
  assert.ok(SECTION.includes('viewPrefs.folded[accountStateKey] === true'))
  assert.ok(SECTION.includes('sessionRowsExpanded[accountStateKey] === true'))
  assert.ok(SECTION.includes('[accountStateKey]: !rowsExpanded'))
})

test('git flags reach the tree memo reactively (subscription + exact dep)', () => {
  assert.ok(SECTION.includes('subscribeWorkspaceGitFlags, getWorkspaceGitFlagsVersion, getWorkspaceGitFlagsVersion,'))
  assert.ok(SECTION.includes('[server.workspaces, server.id, groupByMode, gitFlagsVersion]'))
})

test('pinned rows never take part in a drag commit, and blank targets normalize to after', () => {
  assert.ok(ROWS.includes('pinned: session.pinned === true'))
  assert.ok(ROWS.includes('sessionDrag?.pinned === true || session.pinned === true'), 'dragover gate')
  assert.equal((ROWS.match(/session\.blank === true \? 'after' : rowHalf\(event\)/g) ?? []).length, 2,
    'both half sites normalize a blank target to after')
  assert.ok(DRAG.includes('if (activeDrag.pinned || sourceSession?.pinned === true || targetSession?.pinned === true) return'),
    'the source row is re-read too (a mid-drag pin flip no-ops)')
  assert.ok(DRAG.includes("const half: 'before' | 'after' = targetSession?.blank === true ? 'after' : over.half"))
})

test('a lost dragend cannot leave the click-suppress flag stuck', () => {
  assert.ok(DRAG.includes('suppressClickRef.current = false'))
  assert.ok(DRAG.includes('const sessionAlive = (drag: SessionDragState): boolean =>')
    && DRAG.includes('!sessionAlive(sessionDrag))'), 'the dragged session itself must be alive, not only its source')
  assert.ok(DRAG.includes('const workspaceAlive = (drag: WorkspaceDragState): boolean =>')
    && DRAG.includes('!workspaceAlive(workspaceDrag))'), 'the dragged workspace itself must be alive')
  assert.ok(DRAG.includes('}, [servers, sessionDrag, workspaceDrag, serverDrag])'))
})

test('archived rows are unopenable, not merely styled', () => {
  assert.ok(ROWS.includes("if (session.archived === true) {\n          showNotice(server.id, 'archivedNotOpenable', session.id)\n          return\n        }"),
    'the row click guard must return before the open path')
  assert.ok(SEARCH.includes("if (archived) {\n                                      showNotice(server.id, 'archivedNotOpenable', item.sessionId)\n                                      return\n                                    }"),
    'the search hit guard must return before openSession')
})

test('the archive notice is an alert and is never created for a disconnected source', () => {
  assert.ok(SECTION.includes('className={cc.archiveNotice} role="alert"'))
  assert.ok(NOTICES.includes('if (!connectedRef.current.has(sourceId)) return'))
  const show = NOTICES.slice(NOTICES.indexOf('const showNotice'))
  assert.ok(show.indexOf('clearTimer(sourceId)') < show.indexOf('setNotices'), 'a re-show clears its previous timer first')
})

test('the focus hand-back records the pre-unmount state before updating it', () => {
  assert.ok(SECTION.includes('const wasMounted = prevSearchCapsuleMounted.current'))
  assert.ok(SECTION.includes('if (wasMounted && !searchCapsuleMounted) capsuleHeldFocus.current = false'))
  assert.equal(SECTION.includes('if (searchCapsuleMounted) capsuleHeldFocus.current = false'), false,
    'the old same-commit wipe must be gone')
})

test('the archived hover card reports 已归档 instead of done/idle', () => {
  // additive（上游 Rows.tsx:432-454）：状态行只在归档+done/idle 时被滤掉，归档行总是追加。
  assert.ok(ROWS.includes('&& !(session.archived === true'))
  assert.ok(ROWS.includes('{session.archived === true && ('))
  assert.ok(ROWS.includes("t('row.archived')"))
})

test('updated-mode bookkeeping survives a filter-hidden window (no re-promotion on re-exposure)', () => {
  assert.equal((PROJ.match(/carried\[id\] = ts/g) ?? []).length, 1, 'the carry rule exists once and serves both accounts')
  assert.ok(PROJ.includes('if (!(id in next.updatedAt) && archivedIds.has(id)) carried[id] = ts'),
    'the carry is bounded to ids still in the archive set (no unbounded growth)')
})

test('the workspace prune only runs on an authoritative, unfolded, unfiltered projection (F1)', () => {
  for (const gate of [
    "if ((prefs.archivedFilter?.[server.id] ?? 'default') !== 'default') continue",
    'if (server.archiveSetKnown !== true) continue',
    'if (server.aggregateReady !== true) continue',
    'if (server.workspaces.some(workspace => workspace.synthetic === true)) continue',
  ]) {
    assert.ok(VP.includes(gate), 'prune gate missing: ' + gate)
  }
})

test('the flat drag baseline is the rendered (override-aware) order, not raw wire order (F3)', () => {
  assert.ok(DRAG.includes('orderWithOverride(realWorkspaces, workspaceOrderOverride[server.id], workspace => workspace.id)'))
  assert.ok(DRAG.includes('const flatWorkspaces = ['))
})

test('a mid-drag pin flip of the SOURCE row is re-read at commit time', () => {
  assert.ok(DRAG.includes('const sourceSession = allSessions.find(candidate => candidate.id === activeDrag.sessionId)'))
  assert.ok(DRAG.includes('if (activeDrag.pinned || sourceSession?.pinned === true || targetSession?.pinned === true) return'))
})

test('deleted workspaces drop their accounts from persisted prefs', () => {
  assert.ok(VP.includes('const workspaceAccountGone = (key: string): boolean =>'))
  assert.ok(VP.includes('if (key === flatAccountKey(sourceId)) return false'))
  assert.ok(VP.includes('if (workspaceId === UNGROUPED_WORKSPACE_ID) return false'))
  assert.ok(VP.includes('if (server.workspaces.length === 0) continue'), 'a source with no loaded workspaces is never pruned')
})

test('sessionFacts rides the publish signature (the header capability note cannot freeze)', () => {
  const full = aggregate('srv-a', { sessionFacts: 'full' as never })
  const degraded = aggregate('srv-a', { sessionFacts: 'degraded' as never })
  assert.notEqual(serversProjectionSignature([full]), serversProjectionSignature([degraded]))
})

test('partition: an archived row is never hoisted even when listed first', () => {
  const out = partitionPinnedSessions(
    [{ id: 'x', blank: true }, { id: 'arch', archived: true }, { id: 'a' }],
    { pinnedIds: new Set(['arch', 'a']) },
  )
  assert.deepEqual(out.map(row => row.id), ['x', 'a', 'arch'],
    'dropping the archived guard would hoist arch into the pinned block')
})

test('the motion rowKeys seed and the empty gate agree in flat mode', () => {
  const gate = '(flatGroupBy ? flatSessions.length === 0 : server.workspaces.length === 0)'
  assert.ok(SECTION.includes(`const rowKeys: string[] = ${gate}`))
  assert.ok(SECTION.includes(`${gate} && (`))
  assert.ok(SECTION.includes('if (!flatAccount) rowKeys.push(`workspace:${workspace.id}`)'))
})

test('ctxValue covers every interface field and the stable wrapper is created once', () => {
  const iface = /export interface SidebarSectionContextValue \{([\s\S]*?)\n\}/.exec(CTX)
  assert.ok(iface !== null, 'SidebarSectionContextValue must exist')
  const fields = [...iface[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)].map(match => match[1])
  assert.ok(fields.length >= 50, `interface fields parsed (${fields.length})`)
  const literal = /const ctxValue: SidebarSectionContextValue = useMemo\(\(\) => \(\{([\s\S]*?)\}\), \[([\s\S]*?)\]\)/.exec(ROOT)
  const actions = /const actions = useStableHandlers\(\{([\s\S]*?)\n  \}\)/.exec(ROOT)
  assert.ok(literal !== null && actions !== null)
  for (const field of fields) {
    assert.ok(literal[1].includes(`    ${field},`) || actions[1].includes(`    ${field},`),
      `ctxValue must provide ${field}`)
  }
  const helperAt = ROOT.indexOf('function useStableHandlers')
  assert.ok(ROOT.indexOf('handlersRef.current = handlers') < ROOT.indexOf('return useMemo(() => {', helperAt),
    'the ref refresh must precede the one-time memo factory')
  assert.ok(ROOT.includes('  }, [])'), 'the stable wrapper is memoized once')
})

test('perf gates stay: one sessionsOf per workspace per render, dropEnv only while dragging', () => {
  assert.ok(SECTION.includes("const sessionsCache = new Map<string, ChamberServerWorkspace['sessions']>()"))
  assert.ok(SECTION.includes('if (cached !== undefined) return cached'))
  assert.ok(SECTION.includes('const workspaceDragLive = workspaceDrag !== null && workspaceDrag.sourceId === server.id'))
  assert.ok(SECTION.includes('? workspaceDropEnv('))
  assert.ok(SECTION.includes('const flatMemberSessions = flatGroupBy'))
})

test('the todo area excludes archived rows (their open dead-ends, so the entry could never clear)', async () => {
  const { deriveTodoAttention } = await import('@dsh-chamber/dsh-chamber-client-core/todo-attention')
  const filters = { completed: true, ask: true, request: true }
  const srv = (row: Record<string, unknown>) => ({
    id: 'local', sourceFingerprint: 'local', kind: 'local', transport: 'local', connected: true,
    phase: 'ready', label: 'local', updatedAt: 0,
    workspaces: [{ id: 'w', title: 'W', sessions: [row] }],
    runtime: { current: 'x', sessions: { arch: { completed: true } } },
  })
  const archived = { id: 'arch', title: '归档', displayTitle: '归档', running: false, updatedAt: 1, archived: true }
  const live = { id: 'arch', title: '归档', displayTitle: '归档', running: false, updatedAt: 1 }
  assert.deepEqual(deriveTodoAttention([srv(archived)] as never, { viewingSourceId: 'local', filters }), [])
  assert.deepEqual(deriveTodoAttention([srv(live)] as never, { viewingSourceId: 'local', filters }).map(e => e.sessionId), ['arch'])
})
