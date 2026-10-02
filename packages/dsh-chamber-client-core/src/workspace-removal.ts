/**
 * 工作区**删除意图**（removal intent）——工作区回声家族的删除半边，与创建侧的
 * 位置意图（workspace-placement.ts）对偶。
 *
 * WHY：宿主删除一个 workspace 会发**两条** follow 帧。registry 先把"不含该 id 的
 * workspaceIds"连同 pending-delete 标记落盘（`dsh-workspace` 的 `deleteKnown`），feed 在
 * 这次 state 变化上发布 `order` 帧；表行删除之后才发 `remove` 帧。而 pinned 的 client store
 * 的 `installOrder` 把新 order 未列的项一律排到最后（`rank.get(id) ?? Number.MAX_SAFE_INTEGER`），
 * 于是两帧之间那条被删的行**仍在 items 里、却站在列表末尾**。chamber 投影逐字保留 store 的
 * item 序，侧栏的 keyed 行动效便把它滑到最后一行，`remove` 帧到达时再淡出——这正是
 * "行先闪到本 section 最后一行、再消失"的成因。仅凭快照，投影无法把这次 tail 位移与一次
 * 真实的权威重排区分开：store 只交出不带 order 的 items。
 *
 * 本账本恰好补上这一窗：`deleteWorkspaceForSource` 在 `workspace/delete` wire **之前**发布
 * 意图（与 `reportWorkspacePlacement` 同一条"单一出口 + wire 前事实"纪律），App 记入本账本，
 * `withoutPendingWorkspaceRemovals` **只在观察到下沉时**才摘行：权威列表尾部那一段连续的
 * pending 行，向下走到"上一次投影的尾部"（仅当它仍在列表里时——说明这一帧没有把该行推到尾部）
 * 或第一个非 pending 行为止。
 *
 * 这条证据的**确定性边界**（有意为之，别当缺陷修）：①一次合法重排把**别的**行送到尾部时，
 * 段在那一行停住，段外的行永不被违抗；②若**意图命名的行自己**（他端拖拽 / 追加落点）在
 * 意图窗口内被送到尾部，它会被当作已沉底而摘掉，而不是跟手移动——行本就要删，意图退场
 * （失败撤回 / 权威 remove 帧 / TTL）即恢复；③段内任何 pending 行都按"将被删除"处理，哪怕
 * 它自己的 order 帧尚未被观察到（聚合行序区分不出"它沉底"与"它本来就在段内"）；④**上一次
 * 投影的尾部先离表**（被别的删除/重排带走，或**同 id 来源重建沿用了上一代的缓存尾部** ⇒ 它不在
 * 新列表里，走查根本遇不到停止点）时，尾部 pending 段照摘，哪怕它其实没动；⑤**投影自己追加到
 * 尾部的回声行**（无锚点 create / recovery 的 append）是非 pending 行，会挡住走查——被删行的纠正
 * 因此推迟到权威 `remove` 帧（`archivedFilter='only'` 丢回声行时可见形态与未修复同形；挂载 feed 单
 * FIFO + 回声在聚合已列同 id/路径时跳过，窗口窄，只影响外观，见 design 05 §2.2.1 登记）。③④⑤的
 * 代价都只是"提前一个 RPC 窗口消失或推迟一个窗口纠正"：删除未提交时由失败侧撤回还原（一次淡入），
 * 且**永远不会误摘非 pending 行**；投影只动 pending id。
 *
 * 多行 run 本身是**超协议的防御性覆盖**：vendor 的 `delete` 经 `enqueueOperation` 串行、follower
 * 单 FIFO，真实帧序恒为 order→remove 逐条交替，任意可观察状态最多一条已沉底 pending 行（单行
 * 实现已充分）；run 只对"两个帧在同一派生里结算"（帧合并 / 未来协议）提供廉价兜底。另：**派生
 * 中断也会让证据失效**——非 ok / 空列表的派生不写 `tailWorkspaceId`，下一次下沉帧因此无证据、不
 * 纠正；而那一帧未纠正的投影会成为**新基准**（该 pending 行被写成新 `tailWorkspaceId`），窗口内之后
 * 每次重算都在它处停住 —— 纠正被锁死到权威 `remove` 帧为止（对外与修复前同形、自愈；措辞是"这一
 * 窗内不再纠正"，不是"只差一帧"）。同族边缘：尾部 pending 段被**整段摘空**后派生列表已无真实行
 * （不写 `tailWorkspaceId`），其后任何无关重算都会让已摘掉的待删行回闪一次，直到权威 `remove` 帧。
 *
 * 只按宿主 id 记账：删除出口在 wire 之前就持有真实 workspace id（与创建侧的 pre-create
 * 意图不同——那边 create 回答未到、只能按请求路径记账），因此本账本没有路径次键。
 *
 * NOT a second source of truth：意图绝不造行、绝不插行、也绝不隐藏仍在列表中间的行；把行带走的
 * 始终是权威的 `remove` 帧（或本账本自己的失败侧撤回）。账本是渲染端 App 状态（不持久化 /
 * 不轮询 / 不写宿主）；权威列表不再列该 id、失败事实、来源退役与 TTL（"一个信号都没到"的
 * 泄漏护栏）是它的四条退场路径。
 */
import type { InstanceAggregate, WorkspaceRow } from './instance-api.ts'
import { filterLedgerRows, forgetLedgerSources, setLedgerRows, sweepLedger } from './ledger.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('workspace-removal')

/** One pending workspace-removal intent (see the module header). */
export interface PendingWorkspaceRemoval {
  /** 宿主 workspace id —— 主键（`deleteWorkspaceForSource` 在 wire 之前就持有它）。 */
  workspaceId: string
  /** 记录时刻（epoch ms），TTL 锚点。 */
  at: number
}

/** Pending removal intents keyed by source id. Absent key = nothing pending. */
export type WorkspaceRemovalLedger = Readonly<Record<string, readonly PendingWorkspaceRemoval[]>>

/**
 * 一条意图最多按住多久。它覆盖的只是**一次删除的 unary RPC 窗口**（意图在 wire 前发布，权威
 * `remove` 帧在 RPC 返回前后到达），与位置意图同量级；TTL 只兜"一个信号都没到"的泄漏，
 * 不是收敛预算。
 */
export const PENDING_REMOVAL_TTL_MS = 120_000

/**
 * Record one removal intent by host id. Idempotent: a re-record refreshes the TTL anchor instead
 * of stacking a second entry, and a byte-identical re-record returns the ledger unchanged (the
 * publish signature gate stays quiet for a redundant fact).
 */
export function recordPendingWorkspaceRemoval(
  ledger: WorkspaceRemovalLedger,
  sourceId: string,
  workspaceId: string,
  now: number,
): WorkspaceRemovalLedger {
  const rows = ledger[sourceId] ?? []
  const existing = rows.find(row => row.workspaceId === workspaceId)
  if (existing !== undefined && existing.at === now) return ledger
  const kept = rows.filter(row => row.workspaceId !== workspaceId)
  return setLedgerRows(ledger, sourceId, [...kept, { workspaceId, at: now }])
}

/** Drop intents older than the TTL (identity-preserving when nothing expired). */
export function sweepPendingRemovals(ledger: WorkspaceRemovalLedger, now: number): WorkspaceRemovalLedger {
  return sweepLedger(ledger, row => now - row.at >= PENDING_REMOVAL_TTL_MS)
}

/**
 * Retire one intent by host id — the failure side (the delete never committed, so there is
 * nothing to hold) and the explicit withdrawal path. Identity-preserving when the id is
 * absent from the ledger.
 */
export function removePendingWorkspaceRemoval(
  ledger: WorkspaceRemovalLedger,
  sourceId: string,
  workspaceId: string,
): WorkspaceRemovalLedger {
  return filterLedgerRows(ledger, sourceId, row => row.workspaceId !== workspaceId)
}

/**
 * Retire every intent the AUTHORITATIVE workspace list no longer lists — the convergence
 * point (the host's `remove` frame replaces the list without the id). An EMPTY list is not
 * evidence: a partial/transient baseline must not retire an intent whose row the store may
 * still carry (the TTL is the leak guard). Identity-preserving when nothing converges.
 */
export function reconcilePendingRemovals(
  ledger: WorkspaceRemovalLedger,
  sourceId: string,
  authoritative: readonly WorkspaceRow[],
): WorkspaceRemovalLedger {
  if (ledger[sourceId] === undefined || authoritative.length === 0) return ledger
  const listed = new Set(authoritative.map(row => row.workspaceId))
  return filterLedgerRows(ledger, sourceId, row => listed.has(row.workspaceId))
}

/** Retire the intents of sources that left the registry (same-id re-add = new generation). */
export function forgetPendingRemovals(
  ledger: WorkspaceRemovalLedger,
  retired: ReadonlySet<string>,
): WorkspaceRemovalLedger {
  return forgetLedgerSources(ledger, retired)
}

/**
 * Project one aggregate WITHOUT an observed removal transient. Pure — the aggregate is never
 * mutated, and identity is preserved unless the observed sink is actually corrected.
 *
 * The ONLY correction, and its exact evidence, are stated once in the module header: drop the
 * trailing RUN of pending rows, stopping at `previousTailWorkspaceId` (the tail of the previous
 * projection — the sink proof) or at the first row that is not pending. Without that evidence
 * (no cache — tests, or a first derive) the step cannot prove the sink and stays a no-op; rows
 * are unmounted where they already stand, so no FLIP glides a doomed row to the tail.
 */
export function withoutPendingWorkspaceRemovals(
  aggregate: InstanceAggregate,
  pending: readonly PendingWorkspaceRemoval[] | undefined,
  /** 上一次投影的真实尾部；必填（显式传 `undefined` = 没有证据）——默认参数会让漏传静默退化成 no-op。 */
  previousTailWorkspaceId: string | undefined,
): InstanceAggregate {
  if (pending === undefined || pending.length === 0) return aggregate
  // Only a committed ok aggregate carries a real workspace list.
  if (aggregate.state !== 'ok') return aggregate
  const rows = aggregate.workspaces
  if (rows.length === 0) return aggregate
  // No previous tail = no evidence of a sink; the rows at the tail may be there by the
  // authority's own order (a legitimate append), so nothing is corrected.
  if (previousTailWorkspaceId === undefined) return aggregate
  const doomed = new Set(pending.map(entry => entry.workspaceId))
  let keep = rows.length
  while (keep > 0) {
    const row = rows[keep - 1]
    if (row === undefined || !doomed.has(row.workspaceId)) break
    // A row the previous projection already ended with never moved; it (and everything
    // before it) is left to the authority's own remove frame.
    if (row.workspaceId === previousTailWorkspaceId) break
    keep -= 1
  }
  if (keep === rows.length) return aggregate
  return { ...aggregate, workspaces: rows.slice(0, keep) }
}
