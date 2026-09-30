/**
 * 单列表 flat（design 06 §3.4，per-source）：账号键、无表头渲染分支、拖拽本地提交与
 * updated 账号推导的接线锁。
 * Run directly: node test/session-rows/flat-list.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FLAT_ACCOUNT_KEY } from '@dsh-chamber/dsh-chamber-client-core/flat-account'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const SECTION = read('../../src/client/ServerSection.tsx')
const DRAG = read('../../src/client/sidebar-root-drag.ts')
const PROJ = read('../../src/client/sidebar-root-projection.ts')
const ROWS_SRC = read('../../src/client/ServerSectionRows.tsx')

test('flat is one per-source account keyed like the official FLAT_SESSION_ORDER_KEY', () => {
  assert.equal(FLAT_ACCOUNT_KEY, '__flat__')
})

test('the section renders flat as one header-less list over the flat account (source lock)', () => {
  assert.ok(SECTION.includes("const groupByMode = viewPrefs.groupBy?.[server.id] ?? 'workspace'")
    && SECTION.includes("const flatGroupBy = groupByMode === 'flat'"))
  assert.ok(SECTION.includes('const flatMemberSessions = flatGroupBy')
    && SECTION.includes('? orderedWorkspaces.flatMap(workspace => workspace.sessions)')
    && SECTION.includes(': []'),
    'flat members are fold-independent (upstream sessionMemberIds semantics) and only computed in flat mode')
  assert.ok(SECTION.includes('viewPrefs.flatOrder?.[server.id]'), 'the manual flat account is the stored baseline')
  assert.ok(SECTION.includes('viewPrefs.updatedOrder?.[flatUpdatedAccountKey]'), 'the updated flat account is the NUL-sentinel key')
  assert.ok(SECTION.includes('(flatGroupBy ? [flatWorkspace] : visibleOrderedWorkspaces).map(workspace => {'),
    'the flat pseudo account replaces the workspace list')
  assert.ok(SECTION.includes('const flatAccount = flatGroupBy && workspace.id === FLAT_ACCOUNT_KEY'))
  assert.ok(SECTION.includes('{flatAccount ? null : workspace.createdAt === undefined ? ('),
    'the pseudo account renders no workspace header (nor hover card)')
  const gateCount = (SECTION.match(/flatAccount \|\| workspace\.ungrouped === true/gu) ?? []).length
  assert.equal(gateCount, 2, 'both workspace drag gates stand down for the flat pseudo account')
})

test('flat drag commits locally: manual → flatOrder, updated → the flatAccountKey sentinel account (no wire)', () => {
  assert.ok(DRAG.includes('if (activeDrag.flat) {'), 'the flat branch is gated on the drag flag, not a colliding accountKey')
  // 拖拽位由调用侧显式传入（flatGroupBy && 伪账号），不得从 accountKey 反推：真实工作区 id
  // 恰好等于 FLAT_ACCOUNT_KEY 时会误判为 flat 并劫持它的提交。
  assert.equal(ROWS_SRC.includes('flat: accountKey === FLAT_ACCOUNT_KEY'), false, 'the flat bit is not re-derived from the id')
  assert.ok(ROWS_SRC.includes('flat={flat}') && SECTION.includes('flat={flatAccount}'),
    'SectionSection passes the explicit flat bit down to the rows')
  assert.ok(DRAG.includes('const memberIds = flatWorkspaces.flatMap(workspace => workspace.sessions.map(session => session.id))'),
    'the flat member set is the override-aware rendered order, not the raw wire order')
  assert.ok(DRAG.includes('updateViewPrefs(prev => ({ ...prev, flatOrder: { ...prev.flatOrder, [server.id]: nextOrder } }))'))
  assert.ok(DRAG.includes('updateViewPrefs(prev => ({ ...prev, updatedOrder: { ...prev.updatedOrder, [accountKey]: nextOrder } }))'))
  // 平铺账号分支必须**先于** workspace 解析：找不到 workspace 会提前 return，顺序即正确性。
  assert.ok(DRAG.indexOf('if (activeDrag.flat) {')
    < DRAG.indexOf('const workspace = server.workspaces.find(candidate =>'))
  // flat 分支里不得出现 wire 提交（insertSessionBefore 只属于真实 workspace 分支）。
  const flatBlock = DRAG.slice(
    DRAG.indexOf('if (activeDrag.flat) {'),
    DRAG.indexOf('const workspace = server.workspaces.find(candidate =>'),
  )
  assert.equal(flatBlock.includes('insertSessionBefore'), false)
})

test('the updated-mode derivation maintains the flat account only while the source is flat', () => {
  assert.ok(PROJ.includes("if ((current.groupBy?.[server.id] ?? 'workspace') === 'flat') {"))
  assert.ok(PROJ.includes('const flatSessions = server.workspaces.flatMap(workspace => workspace.sessions)'))
  assert.ok(PROJ.includes('flatAccountKey(server.id)'), 'the updated flat account uses the NUL-sentinel helper key')
  assert.equal((PROJ.match(/pendingOrder\[accountKey\] = planned\.order/g) ?? []).length, 2,
    'both accounts write through the shared commit plan')
})
