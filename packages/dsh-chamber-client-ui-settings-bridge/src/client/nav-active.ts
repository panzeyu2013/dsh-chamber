/**
 * Settings shell nav resolution (design 15 v1 flat form) — pure, testable.
 *
 * The nav rail has three groups: the SELECTED server's sections (the child-ctx
 * ledger — official families plus the source's own plugin contributions,
 * 2026-12), the fixed chamber-GLOBAL entries below the divider (connections /
 * general — the update status lives inside the General section, design 11), and
 * the plugin-diagnostics entry (rendered only when there is something to say).
 * A server-section id that left the ledger falls back to the first row.
 *
 * 2026-12 修订（用户拍板）：网关编排分区从桌面设置页整体移除——审批/提问
 * 由侧边栏既有事实通道呈现，网关自有投影（会话/调度/worktree）归网关
 * 自有运维面 `/chamber/` 管理，桌面设置不重放。
 */

/** The fixed connections nav id (design 05 §5): chamber-global connection management. */
export const CONNECTIONS_SECTION_ID = '__connections'

/** The fixed general nav id (design 14 D7 / 15): chamber-global runtime settings. */
export const GENERAL_SECTION_ID = '__general'

/** The fixed plugin-diagnostics nav id (2026-12): the source's plugin contributions report. */
export const PLUGINS_SECTION_ID = '__plugins'

/** Every chamber-owned fixed nav id (they never come from a ledger). */
export const FIXED_SECTION_IDS: readonly string[] = [
  CONNECTIONS_SECTION_ID,
  GENERAL_SECTION_ID,
  PLUGINS_SECTION_ID,
]

/** One nav row of the SELECTED server's settings sections (child ctx ledger projection). */
export interface SectionNavRow {
  id: string
  order: number
  label: string
  /** The registrant stamp (cordis fiber name); a non-base value = plugin-provided. */
  registrant?: string
}

/**
 * Active-section resolution: chamber-global fixed ids win; otherwise the
 * selected id when it is still in the server's ledger, else the first row.
 */
export function resolveActiveSection(
  activeId: string | undefined,
  rows: readonly SectionNavRow[],
): string | undefined {
  if (activeId !== undefined && FIXED_SECTION_IDS.includes(activeId)) return activeId
  return activeId !== undefined && rows.some(row => row.id === activeId) ? activeId : rows[0]?.id
}

/** Whether a nav id belongs to the chamber-owned fixed entries. */
export function isFixedSectionId(id: string | undefined): boolean {
  return id !== undefined && FIXED_SECTION_IDS.includes(id)
}
