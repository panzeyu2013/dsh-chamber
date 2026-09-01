/**
 * Settings shell nav resolution (design 15 v1 flat form) — pure, testable.
 *
 * The nav rail has two groups: the SELECTED server's official sections
 * (child-ctx ledger rows) and the fixed chamber-GLOBAL entries below the
 * divider (connections / general — the update status lives inside the
 * General section, design 11). A server-section id that left the ledger
 * falls back to the first row.
 *
 * 2026-12 修订（用户拍板）：网关编排分区从桌面设置页整体移除——审批/提问
 * 由侧边栏既有事实通道呈现，网关自有投影（会话/调度/worktree）归网关
 * 自有运维面 `/chamber/` 管理，桌面设置不重放。
 */

/** The fixed connections nav id (design 05 §5): chamber-global connection management. */
export const CONNECTIONS_SECTION_ID = '__connections'

/** The fixed general nav id (design 14 D7 / 15): chamber-global runtime settings. */
export const GENERAL_SECTION_ID = '__general'

/** One nav row of the SELECTED server's settings sections (child ctx ledger projection). */
export interface SectionNavRow {
  id: string
  order: number
  label: string
}

/**
 * Active-section resolution: chamber-global fixed ids win; otherwise the
 * selected id when it is still in the server's ledger, else the first row.
 */
export function resolveActiveSection(
  activeId: string | undefined,
  rows: readonly SectionNavRow[],
): string | undefined {
  if (activeId === CONNECTIONS_SECTION_ID) return CONNECTIONS_SECTION_ID
  if (activeId === GENERAL_SECTION_ID) return GENERAL_SECTION_ID
  return activeId !== undefined && rows.some(row => row.id === activeId) ? activeId : rows[0]?.id
}
