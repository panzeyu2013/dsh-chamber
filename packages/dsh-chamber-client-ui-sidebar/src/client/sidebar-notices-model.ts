/**
 * 来源级普通警示的**框架无关模型**（design 06 §3.4）：类型、TTL 与断连裁剪规则。
 * hook（sidebar-root-notices.ts）只负责计时与 React 状态；规则在这里可独立单测
 * （本包测试跑在 plain node 下，没有 React/DOM 环境）。
 *
 * 这里只剩「点击归档行不可打开」这一条普通警示：归档成功 / 停止并归档的就地
 * 提示条（上游 RowActionToast 的 archived / stoppedAndArchived 两态，撤销 + 筛选
 * 动作）已按用户裁决移除（design 06 §3.4 的 Rejected alternatives），归档反馈不再
 * 由侧栏承担；恢复入口留在视图选项「全部对话（显示已归档）」与行/管理器上，但
 * **归档集就绪前（未挂载的降级来源）这三条都不可用**——刚归档的行由本地墓碑撤下后
 * 要等该来源挂载、基线到达才能恢复（design 06 §3.4 登记的已知代价）。
 */

/** Per-source transient warning set: one flag per source id (always `true`). */
export type SourceNotices = Readonly<Record<string, true>>

/** 上游 Toast 的默认 hold（普通警示 3s）。 */
export const SOURCE_NOTICE_TTL_MS = 3_000

/**
 * Drop notices whose source disconnected or left the projection: the notice is
 * gated on `server.connected` in the render, so a reconnect inside the TTL must
 * not make a notice the user believes gone pop back. Identity-preserving when
 * nothing is dropped (the caller can skip setState).
 */
export function retainConnectedNoticeSources(
  notices: SourceNotices,
  connectedSourceIds: ReadonlySet<string>,
): SourceNotices {
  let changed = false
  const next: Record<string, true> = {}
  for (const [sourceId, notice] of Object.entries(notices)) {
    if (connectedSourceIds.has(sourceId)) next[sourceId] = notice
    else changed = true
  }
  return changed ? next : notices
}
