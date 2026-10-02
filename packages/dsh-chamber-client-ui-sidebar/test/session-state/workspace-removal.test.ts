/**
 * workspace-removal.ts unit tests (plain node:test, no dsh, no DOM): 工作区**删除意图**
 * （pre-delete 半边，design 05 §2.2.1 修订）。
 *
 * 契约：宿主删除一个 workspace 会先提交"不含该 id 的 workspaceIds"（pending-delete 状态写）并发
 * 出 order 帧，pinned client store 把新 order 未列的项一律排到最后（unranked-sink）；表行删除之后
 * 才发 remove 帧。于是"行先滑到本 section 最后一行、再消失"的可见缺陷发生在两帧之间。这些用例钉住：
 * 投影**只在观察到下沉时**才摘掉尾部连续的 pending 段（段尾就是上一次投影的真实尾部 / 没有上一次
 * 投影的尾部证据 / 段尾不是 pending，一律恒等返回；旧尾部先离表、帧合并、待删行被他人重排到尾部，
 * 或意图发布后有一次非 ok 派生时，按 design 05 §2.2.1 的登记边界处理）、账本绝不发明或隐藏别的行、四条退场路径
 * （权威列表不再列该 id、失败侧撤下、来源退役、TTL）与身份保持。最后是源码接线锁：出口 / App /
 * 投影链不能被 node 测试导入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  chamberBridge,
  deleteWorkspaceForSource,
  forgetPendingRemovals,
  getInstanceClient,
  reconcilePendingRemovals,
  recordPendingWorkspaceRemoval,
  releaseInstanceClient,
  removePendingWorkspaceRemoval,
  sweepPendingRemovals,
  withoutPendingWorkspaceRemovals,
  type PendingWorkspaceRemoval,
  type UnaryResult,
  type WorkspaceRemovalLedger,
} from '@dsh-chamber/dsh-chamber-client-core'
import { PENDING_REMOVAL_TTL_MS } from '../../../dsh-chamber-client-core/src/workspace-removal.ts'
import type { InstanceAggregate, SessionRow, WorkspaceRow } from '@dsh-chamber/dsh-chamber-client-core/instance-api'

function row(workspaceId: string, path: string): WorkspaceRow {
  return { workspaceId, path, title: workspaceId, sessionIds: [], createdAt: '', updatedAt: '' }
}

function aggregate(workspaces: WorkspaceRow[], state: InstanceAggregate['state'] = 'ok'): InstanceAggregate {
  const sessions: SessionRow[] = []
  return { state, workspaces, sessions, archivedSessionIds: [], archiveSetKnown: state === 'ok', error: null }
}

const pending: readonly PendingWorkspaceRemoval[] = [{ workspaceId: 'b', at: 1 }]

test('observed sink: the doomed tail row is dropped, everything else keeps its order', () => {
  // 宿主 order 帧把 b 沉到尾部（上一次投影的尾部是 c）——投影摘掉它，行在原地淡出，
  // 不再让侧栏把它滑到最后一行再抹掉。
  const before = aggregate([row('a', '/a'), row('c', '/c'), row('b', '/repo/b')])
  const after = withoutPendingWorkspaceRemovals(before, pending, 'c')
  assert.deepEqual(after.workspaces.map(entry => entry.workspaceId), ['a', 'c'])
  assert.notEqual(after, before, 'a corrected projection is a new aggregate')
  assert.deepEqual(before.workspaces.map(entry => entry.workspaceId), ['a', 'c', 'b'],
    'the input aggregate is never mutated')
})

test('a row that was already the tail never moved: no premature hide', () => {
  // 被删行本来就是列表最后一行：没有位移要修，交给权威 remove 帧（删最后一行时不再提前一帧隐藏、
  // 删除失败时也没有"消失再回来"的一闪）。
  const before = aggregate([row('a', '/a'), row('b', '/repo/b')])
  assert.equal(withoutPendingWorkspaceRemovals(before, pending, 'b'), before)
})

test('without the previous projection tail there is no sink evidence', () => {
  // 没有上一次投影（冷启第一帧 / 没有投影缓存）⇒ 判不了，绝不动行（TTL 与权威帧兜底）。
  const before = aggregate([row('a', '/a'), row('b', '/repo/b')])
  assert.equal(withoutPendingWorkspaceRemovals(before, pending, undefined), before)
})

test('only a pending row at the tail is touched: mid-list rows and foreign tails are identity', () => {
  const middle = aggregate([row('a', '/a'), row('b', '/repo/b'), row('c', '/c')])
  assert.equal(withoutPendingWorkspaceRemovals(middle, pending, 'c'),
    middle, 'a pending row still mid-list is never hidden (the authority owns the removal)')
  const foreignTail = aggregate([row('a', '/a'), row('c', '/c')])
  assert.equal(withoutPendingWorkspaceRemovals(foreignTail, pending, 'a'),
    foreignTail, 'a tail that is not the pending id is a plain reorder — never contradicted')
  assert.equal(withoutPendingWorkspaceRemovals(middle, undefined, 'c'), middle, 'no ledger slice')
  assert.equal(withoutPendingWorkspaceRemovals(middle, [], 'c'), middle, 'empty ledger')
  // 行用 pending 自己的 id：删掉实现里的 state guard 后这条断言会变红（旧 fixture 的 'a' 会让 guard 空转）。
  const notOk = aggregate([row('b', '/repo/b')], 'error')
  assert.equal(withoutPendingWorkspaceRemovals(notOk, pending, 'a'), notOk, 'a non-ok aggregate renders its own state')
})

test('the correction is idempotent inside the sink window', () => {
  // 下沉帧之后、remove 帧之前若再重算一次（另一个输入变化），上一次投影的真实尾部仍不是被删行
  // ⇒ 照旧摘掉，绝不把行放回尾部。
  const sunk = aggregate([row('a', '/a'), row('c', '/c'), row('b', '/repo/b')])
  const once = withoutPendingWorkspaceRemovals(sunk, pending, 'c')
  assert.deepEqual(once.workspaces.map(entry => entry.workspaceId), ['a', 'c'])
  // Fixpoint: feeding the CORRECTED projection back (with the corrected tail as
  // evidence) must neither remove anything else nor allocate a new projection.
  const twice = withoutPendingWorkspaceRemovals(once, pending, 'c')
  assert.deepEqual(twice.workspaces.map(entry => entry.workspaceId), ['a', 'c'])
  assert.equal(twice, once, 'a corrected projection passes through identity-preserving')
})

test('overlapping deletes: the whole trailing pending run is dropped in one pass', () => {
  // 两个删除的 order 帧重叠：第二条（c）在自己的帧里被宿主排到第一条（b）之后（都是 unranked），
  // 上一次投影的真实尾部是 d ⇒ 尾部连续 pending 段 [c,b] 一起摘掉，第二条不再滑到可见尾部。
  const two: readonly PendingWorkspaceRemoval[] = [
    { workspaceId: 'c', at: 1 },
    { workspaceId: 'b', at: 2 },
  ]
  const sunk = aggregate([row('a', '/a'), row('d', '/d'), row('c', '/c'), row('b', '/b')])
  const after = withoutPendingWorkspaceRemovals(sunk, two, 'd')
  assert.deepEqual(after.workspaces.map(entry => entry.workspaceId), ['a', 'd'])
  // 段在遇到第一个非 pending 行时停下（它前面的行绝不被动）。
  const mixed = aggregate([row('a', '/a'), row('p', '/p'), row('c', '/c')])
  assert.deepEqual(
    withoutPendingWorkspaceRemovals(mixed, [{ workspaceId: 'c', at: 1 }], 'a')
      .workspaces.map(entry => entry.workspaceId),
    ['a', 'p'],
  )
})

test('a run whose last row was already the previous tail proves no sink and drops nothing', () => {
  // 段尾就是上一次投影的尾部 ⇒ 整段没有位移（它本来就在尾部），交给权威 remove 帧。
  const two: readonly PendingWorkspaceRemoval[] = [
    { workspaceId: 'x', at: 1 },
    { workspaceId: 'y', at: 2 },
  ]
  const alreadyLast = aggregate([row('a', '/a'), row('x', '/x'), row('y', '/y')])
  assert.equal(withoutPendingWorkspaceRemovals(alreadyLast, two, 'y'), alreadyLast)
  // 段内更早的行先被权威排到尾部（段尾 y 是旧尾部、但 x 新沉下来）⇒ 只摘真正的沉没段 [x]。
  const xSunk = aggregate([row('a', '/a'), row('y', '/y'), row('x', '/x')])
  assert.deepEqual(
    withoutPendingWorkspaceRemovals(xSunk, two, 'y').workspaces.map(entry => entry.workspaceId),
    ['a', 'y'],
  )
})

test('boundary: a pending row someone else tails is dropped, a foreign tail stops the walk', () => {
  // 模块头注的确定性边界（有意为之）：pending 行自己在意图窗口内被他端拖拽 / 追加落点送到尾部
  // ⇒ 按已沉底摘掉、而不是跟手移动——行本就要删，意图退场（失败撤回 / 权威 remove / TTL）即恢复。
  const dragged = aggregate([row('a', '/a'), row('c', '/c'), row('b', '/repo/b')])
  assert.deepEqual(
    withoutPendingWorkspaceRemovals(dragged, pending, 'c').workspaces.map(entry => entry.workspaceId),
    ['a', 'c'],
  )
  // 段外行永不被违抗：一个非 pending 行成为尾部时，段在它停住，中间那个 pending 行原地不动。
  const foreignTail = aggregate([row('a', '/a'), row('b', '/repo/b'), row('c', '/c')])
  assert.equal(withoutPendingWorkspaceRemovals(foreignTail, pending, 'a'), foreignTail)
})

test('accepted boundary: a vanished previous tail drops the run even when nothing moved', () => {
  // design 05 §2.2.1 边界④（有意取舍，不是缺陷）：上一投影的尾部先离表（被别的删除/重排带走）
  // ⇒ 走查遇不到停止点，尾部 pending 段照摘；后果只是待删行提前一个 RPC 窗口消失，失败撤回即还原。
  const vanishedTail = aggregate([row('a', '/a'), row('b', '/repo/b')])
  assert.deepEqual(
    withoutPendingWorkspaceRemovals(vanishedTail, pending, 'p').workspaces.map(entry => entry.workspaceId),
    ['a'],
  )
  // run 变体：两个 pending 一起被摘；撤回段内一个（段尾不再是 pending）会把整段带回。
  const two: readonly PendingWorkspaceRemoval[] = [{ workspaceId: 'b', at: 1 }, { workspaceId: 'c', at: 2 }]
  const run = aggregate([row('a', '/a'), row('b', '/b'), row('c', '/c')])
  assert.deepEqual(
    withoutPendingWorkspaceRemovals(run, two, 'p').workspaces.map(entry => entry.workspaceId),
    ['a'],
  )
  assert.deepEqual(
    withoutPendingWorkspaceRemovals(run, [{ workspaceId: 'b', at: 1 }], 'p').workspaces.map(entry => entry.workspaceId),
    ['a', 'b', 'c'], 'withdrawing c breaks the run at the tail — every remaining row comes back',
  )
  // 永远不会误摘非 pending 行：段内只可能是 pending id。
  assert.deepEqual(
    withoutPendingWorkspaceRemovals(aggregate([row('a', '/a'), row('z', '/z')]), pending, 'p')
      .workspaces.map(entry => entry.workspaceId),
    ['a', 'z'],
  )
})

test('accepted boundary: frames coalesced after the previous tail left — the run still drops', () => {
  // 评审 A 的帧合并可达例：旧尾部 E 在别处消失且中间没有派生，随后 B/C 的意图与下沉帧在同一次
  // 派生里结算 ⇒ 走查遇不到旧尾部，整段 pending 一起摘（B 其实没动，只是提前一个 RPC 窗口消失；
  // 失败撤回自愈，且绝不误摘非 pending 行）。这是边界④的真实可达形态，用它钉住行为。
  const coalesced = aggregate([row('a', '/a'), row('b', '/b'), row('c', '/c')])
  const two: readonly PendingWorkspaceRemoval[] = [{ workspaceId: 'b', at: 1 }, { workspaceId: 'c', at: 2 }]
  assert.deepEqual(
    withoutPendingWorkspaceRemovals(coalesced, two, 'e').workspaces.map(entry => entry.workspaceId),
    ['a'],
  )
})

test('record: idempotent per host id and identity-preserving on a redundant re-record', () => {
  let ledger: WorkspaceRemovalLedger = {}
  ledger = recordPendingWorkspaceRemoval(ledger, 's', 'w1', 1_000)
  assert.equal(ledger.s?.length, 1)
  const same = recordPendingWorkspaceRemoval(ledger, 's', 'w1', 1_000)
  assert.equal(same, ledger, 'a byte-identical re-record changes nothing (the publish gate stays quiet)')
  ledger = recordPendingWorkspaceRemoval(ledger, 's', 'w1', 2_000)
  assert.equal(ledger.s?.length, 1, 'a re-record refreshes the TTL anchor instead of stacking')
  assert.equal(ledger.s?.[0]?.at, 2_000)
  const other = recordPendingWorkspaceRemoval(ledger, 's', 'w2', 2_000)
  assert.deepEqual(other.s?.map(entry => entry.workspaceId), ['w1', 'w2'], 'a second delete stacks its own entry')
  const isolated = recordPendingWorkspaceRemoval(ledger, 'other', 'w9', 5)
  assert.deepEqual(isolated.other, [{ workspaceId: 'w9', at: 5 }], 'per-source')
  assert.deepEqual(isolated.s, ledger.s, 'the other source\'s rows are untouched')
})

test('withdrawal, convergence, TTL and source retirement are the four ways out', () => {
  let ledger = recordPendingWorkspaceRemoval({}, 's', 'w1', 1_000)
  assert.deepEqual(removePendingWorkspaceRemoval(ledger, 's', 'w1'), {}, 'by host id')
  ledger = recordPendingWorkspaceRemoval({}, 's', 'w1', 1_000)
  assert.equal(removePendingWorkspaceRemoval(ledger, 's', 'other'), ledger,
    'a foreign id changes nothing (identity preserved)')
  // 撤回只按 id：同一次删除的另一个 id 条目绝不连坐（旧实现的路径次键会把同路径条目一起撤掉——
  // 宿主 id 不复用，同目录重新注册出的新 id 是另一条注册、另一条意图）。
  let two = recordPendingWorkspaceRemoval({}, 's', 'w1', 1_000)
  two = recordPendingWorkspaceRemoval(two, 's', 'w2', 1_000)
  assert.deepEqual(removePendingWorkspaceRemoval(two, 's', 'w1').s, [{ workspaceId: 'w2', at: 1_000 }],
    'withdrawing one intent leaves every other intent alone')
  // 权威收敛：列表仍列该 id ⇒ 保留；不再列 ⇒ 退休；空列表（部分/瞬时基线）判不了 ⇒ 保留。
  assert.equal(reconcilePendingRemovals(ledger, 's', [row('w1', '/p/a'), row('w2', '/p/b')]), ledger, 'still listed')
  assert.deepEqual(reconcilePendingRemovals(ledger, 's', [row('w2', '/p/b')]), {}, 'the remove frame converged')
  assert.equal(reconcilePendingRemovals(ledger, 's', []), ledger, 'an empty list is not evidence')
  assert.equal(reconcilePendingRemovals(ledger, 'other', []), ledger, 'per-source')
  assert.equal(sweepPendingRemovals(ledger, 1_000 + PENDING_REMOVAL_TTL_MS - 1), ledger, 'inside the TTL')
  assert.deepEqual(sweepPendingRemovals(ledger, 1_000 + PENDING_REMOVAL_TTL_MS), {}, 'at the TTL')
  assert.deepEqual(forgetPendingRemovals(ledger, new Set(['s'])), {}, 'source leave')
  assert.equal(forgetPendingRemovals(ledger, new Set(['other'])), ledger, 'identity preserved')
})

test('the delete funnel publishes the intent BEFORE its wire and the removal fact after it', async () => {
  const sourceId = 'removal-funnel-ok'
  const client = getInstanceClient(sourceId)
  const calls: unknown[] = []
  const order: string[] = []
  client.workspace.delete = async (payload: unknown): Promise<UnaryResult<unknown>> => {
    order.push('wire')
    calls.push(payload)
    // decodeWorkspaceDeleteValue 只认 { deleted: true }（未确认即 invalid-response）。
    return { ok: true, value: { deleted: true } }
  }
  const removing: unknown[] = []
  const offRemoving = chamberBridge.onWorkspaceRemoving(fact => { if (fact.sourceId === sourceId) { order.push('removing'); removing.push({ ...fact }) } })
  const offRemoved = chamberBridge.onWorkspaceRemoved(fact => { if (fact.sourceId === sourceId) order.push('removed') })
  const offFailed = chamberBridge.onWorkspaceRemovingFailed(fact => { if (fact.sourceId === sourceId) order.push('failed') })
  try {
    await deleteWorkspaceForSource(sourceId, 'w-del', '/p/w')
    assert.deepEqual(calls, [{ workspaceId: 'w-del' }], 'the wire payload carries the host id only')
    assert.deepEqual(removing, [{ sourceId, workspaceId: 'w-del' }], 'the intent fact is id-keyed (no path)')
    assert.deepEqual(order, ['removing', 'wire', 'removed'],
      'BEFORE the wire (the host emits the sink frame while the delete commits), success fact after it')
  } finally { offRemoving(); offRemoved(); offFailed(); releaseInstanceClient(sourceId) }
})

test('a rejected delete withdraws the intent and publishes no removal fact', async () => {
  const sourceId = 'removal-funnel-fail'
  const client = getInstanceClient(sourceId)
  client.workspace.delete = async () => { throw new Error('refused') }
  const order: string[] = []
  const offRemoving = chamberBridge.onWorkspaceRemoving(fact => { if (fact.sourceId === sourceId) order.push('removing') })
  const offRemoved = chamberBridge.onWorkspaceRemoved(fact => { if (fact.sourceId === sourceId) order.push('removed') })
  const offFailed = chamberBridge.onWorkspaceRemovingFailed(fact => { if (fact.sourceId === sourceId) order.push('failed') })
  try {
    await assert.rejects(() => deleteWorkspaceForSource(sourceId, 'w-del'), /refused/, 'the funnel rethrows the failure')
    assert.deepEqual(order, ['removing', 'failed'],
      'the failure side withdraws the intent; the echo fact would claim a removal that never committed')
  } finally { offRemoving(); offRemoved(); offFailed(); releaseInstanceClient(sourceId) }
})

test('wiring: the intent is published before the wire, withdrawn on failure, applied in the projection', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\s+/g, ' ')
  const funnel = read('../../../dsh-chamber-client-core/src/workspace-mutations.ts')
  const intentAt = funnel.indexOf('chamberBridge.reportWorkspaceRemoving({')
  const deleteWire = funnel.indexOf('await deleteWorkspace(getInstanceClient(sourceId), workspaceId)')
  const failedAt = funnel.indexOf('chamberBridge.reportWorkspaceRemovingFailed({')
  const removedAt = funnel.indexOf('chamberBridge.reportWorkspaceRemoved({ sourceId, workspaceId, path })')
  assert.notEqual(intentAt, -1, 'the delete funnel publishes the intent (every delete site is covered)')
  assert.notEqual(deleteWire, -1, 'the delete funnel still performs the wire call')
  assert.ok(intentAt < deleteWire, 'BEFORE the wire: the host emits the sink frame while the delete is still committing')
  assert.ok(failedAt > deleteWire && failedAt < removedAt,
    'the failure side withdraws it right after the rejected wire, before the success fact')
  const subscriptions = read('../../../renderer/src/app-hooks/use-bridge-subscriptions.ts')
  assert.match(subscriptions, /chamberBridge\.onWorkspaceRemoving\(/, 'the App records intents')
  assert.match(subscriptions, /chamberBridge\.onWorkspaceRemovingFailed\(/, 'the App withdraws them on failure')
  assert.match(subscriptions, /sweepPendingRemovals\(echoStore\.getSnapshot\(\)\.removal, Date\.now\(\)\)[\s\S]{0,200}?reconcilePendingRemovals\(swept, sourceId, snapshot\.workspaces\)/,
    'the mounted push sweeps AND reconciles the ledger against the authoritative list (the convergence point)')
  // 成功侧**刻意不撤**删除意图（RPC 回答可能先于下沉帧的渲染提交到达，早撤会把那一帧的纠正弄丢）：
  // 截取 onWorkspaceRemoved 的处理器片段，断言它绝不碰 removal 账本——未来把撤回塞进成功回调，
  // 会在该时序下静默退回闪烁，而其余锁全绿。
  const withdrawalHandlerAt = subscriptions.indexOf('chamberBridge.onWorkspaceRemoved(')
  assert.notEqual(withdrawalHandlerAt, -1, 'the echo-withdrawal handler must exist')
  const withdrawalHandler = subscriptions.slice(withdrawalHandlerAt, subscriptions.indexOf('}, [updateWorkspaceEcho])', withdrawalHandlerAt))
  assert.doesNotMatch(withdrawalHandler, /removePendingWorkspaceRemoval|updateRemoval/,
    'the success side never withdraws the removal intent (the authority remove frame is the convergence point)')
  assert.match(subscriptions, /recordPendingWorkspaceRemoval\(swept, sourceId, fact\.workspaceId, now\)/,
    'the record call keeps the host-id key shape (an object literal here silently disables the whole drop)')
  assert.match(subscriptions, /removePendingWorkspaceRemoval\(echoStore\.getSnapshot\(\)\.removal, sourceId, fact\.workspaceId\)/,
    'the withdrawal passes the host id, not a key object')
  // TTL 退场挂在三处时钟（删除事实 / 挂载 push / 30s unary 兜底）；删掉任一处，全部测试仍绿而
  // "权威永不收敛"的意图失去泄漏护栏——这里把两条 hook 时钟也锚住（App 时钟在下方）。
  assert.match(subscriptions, /sweepPendingRemovals\(echoStore\.getSnapshot\(\)\.removal, now\)/,
    'the removal-fact clock sweeps the ledger')
  assert.match(subscriptions, /sweepPendingRemovals\(echoStore\.getSnapshot\(\)\.removal, Date\.now\(\)\)/,
    'the mounted-push convergence clock sweeps the ledger too')
  const servers = read('../../../renderer/src/host/servers.ts')
  assert.match(servers, /withoutPendingWorkspaceRemovals\(/, 'the single projection pass applies the correction')
  // 承重顺序：删除意图必须是**最外层**嵌套（回声/位置/会话三步之后）。挪到内侧时，
  // create→delete 同窗（回声条目在 + 下沉帧到）会把已摘的 doomed 行重新 append 到尾部，
  // 恢复修复前的尾滑——这条断言钉住嵌套形状。
  assert.match(servers, /withoutPendingWorkspaceRemovals\(\s*withSessionEcho\(/,
    'the removal step wraps the echo/placement/session steps (outermost), so a re-added echo row cannot survive it')
  assert.match(servers, /workspaceRemovals\?\.\[id\], previousTailWorkspaceId, \)/,
    'the sink evidence rides the projection as the THIRD ARGUMENT of the call (an identifier in a comment cannot satisfy this)')
  assert.match(servers, /\{\} : \{ tailWorkspaceId: projectedTailWorkspaceId \}/,
    'and is recorded on the per-source cache entry as the conditional field VALUE (not a comment mention)')
  const app = read('../../../renderer/src/App.tsx')
  assert.match(app, /sessionFacts, projectionCaches\.servers, echoes\.placement, archivedFilters, echoes\.removal\)/,
    'the SAME deriveServers call carries BOTH the per-source cache (the sink evidence lives on its entry) and the removal ledger — dropping either silently degrades the correction to the old flicker; the cache parameter is the load-bearing half')
  assert.match(app, /updateRemoval\(sweepPendingRemovals\(echoStore\.getSnapshot\(\)\.removal, Date\.now\(\)\)\)/,
    'the removal ledger rides the shared TTL clock (a convergence that never arrives must still expire)')
  assert.match(app, /forgetPendingRemovals\(/, 'source retirement drops the previous generation\'s intents')
  // Git 插件的三个删除点没有类型面约束（saga 的 workspaceDelete 是注入回调）：任一处改回裸 unary
  // wrapper 会静默丢掉删除意图、重新引入尾滑，而 saga 测试全绿——这里照抄 sidebar 的文本锁。
  const coordinator = read('../../../dsh-chamber-client-ui-git/src/shared/coordinator.ts')
  assert.equal((coordinator.match(/deleteWorkspaceForSource\(/gu) ?? []).length, 3,
    'the three injected workspaceDelete callbacks (registered remove, unregistered remove, workspace-delete recovery) all route through the funnel')
  assert.doesNotMatch(coordinator, /deleteWorkspace\(getInstanceClient\(/,
    'no Git-plugin site calls the raw unary wrapper and silently drops the removal intent')
})
