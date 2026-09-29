/**
 * 来源级归档提示条的**框架无关模型**（design 06 §3.4，D5）：类型、TTL 与断连裁剪规则。
 * hook（sidebar-root-notices.ts）只负责计时与 React 状态；规则在这里可独立单测
 * （本包测试跑在 plain node 下，没有 React/DOM 环境）。
 */
export type SourceNoticeKind = 'archived' | 'stoppedAndArchived' | 'archivedNotOpenable'

export interface SourceNotice {
  kind: SourceNoticeKind
  /** 触发它的会话（撤销 / 筛选动作的目标；notOpenable 仅用于文案归属）。 */
  sessionId: string
}

/** 归档两类沿用上游 RowActionToast 的 6s hold（足够点「撤销」）。 */
export const SOURCE_NOTICE_TTL_MS = 6_000

/** `archivedNotOpenable` 是普通警示：上游走 Toast 的默认 3s。 */
export const SOURCE_NOTICE_PLAIN_TTL_MS = 3_000

/** Per-kind auto-dismiss window (upstream parity: 6s archive notices, 3s plain). */
export function sourceNoticeTtl(kind: SourceNoticeKind): number {
  return kind === 'archivedNotOpenable' ? SOURCE_NOTICE_PLAIN_TTL_MS : SOURCE_NOTICE_TTL_MS
}

/**
 * Drop notices whose source disconnected or left the projection: the notice is
 * gated on `server.connected` in the render, so a reconnect inside the TTL must
 * not make a notice the user believes gone pop back. Identity-preserving when
 * nothing is dropped (the caller can skip setState).
 */
export function retainConnectedNoticeSources(
  notices: Readonly<Record<string, SourceNotice>>,
  connectedSourceIds: ReadonlySet<string>,
): Readonly<Record<string, SourceNotice>> {
  let changed = false
  const next: Record<string, SourceNotice> = {}
  for (const [sourceId, notice] of Object.entries(notices)) {
    if (connectedSourceIds.has(sourceId)) next[sourceId] = notice
    else changed = true
  }
  return changed ? next : notices
}
