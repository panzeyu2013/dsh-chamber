/**
 * 位置锚点规则（Git worktree 定位）。
 *
 * 宿主 `workspace.create` 把新 workspace **prepend** 到列表头部；要把它放到主 checkout 之后，
 * coordinator 在 create 提交后调 `workspace.insertBefore`，而它锚定的是"必须排在**被搬行之后**
 * 的那个 workspace"——锚定主 checkout 本身会把新行放到它**上面**。
 *
 * 关键约束（本模块存在的唯一理由）：读序来自**发布投影**，而那里新行已经被回声与位置意图放在
 * 锚点之后了（宿主此刻仍是头部 PREPEND）。因此"正在被搬的那一行"必须显式跳过，否则会发出
 * `insertBefore(id, id)`——宿主对 `beforeId === id` 直接早退（vendor
 * `packages/workspace/workspace/src/index.ts`：`if (beforeId === id) return state.workspaceIds`），
 * 不写 state 也不广播：注册表序永不收敛（磁盘上该 worktree 永久排在 main 上面），位置意图也
 * 永不按位置退休（只能等 TTL 把行放回头部）。
 */

/** `order` 里 `anchorWorkspaceId` 之后的第一个 id，跳过 `movedWorkspaceId`（见模块头）。 */
export function workspaceAfterAnchor(
  order: readonly string[],
  anchorWorkspaceId: string | undefined,
  movedWorkspaceId: string,
): string | undefined {
  if (anchorWorkspaceId === undefined) return undefined
  const anchorIndex = order.indexOf(anchorWorkspaceId)
  if (anchorIndex === -1) return undefined
  return order.slice(anchorIndex + 1).find(id => id !== movedWorkspaceId)
}
