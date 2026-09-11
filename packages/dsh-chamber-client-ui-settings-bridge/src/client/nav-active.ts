/**
 * Settings shell nav resolution (design 15 v1 flat form) — pure, testable.
 *
 * The nav rail has TWO groups: the SELECTED server's sections (that source's
 * OWN boot-ctx `settings.section` ledger — official families plus the source's
 * own plugin contributions, 2026-12 完整桥接修订) and the fixed chamber-GLOBAL
 * entries below the divider (connections / general — the update status lives
 * inside the General section, design 11). A server-section id that left the
 * ledger falls back to the first row.
 *
 * 2026-09 修订（用户拍板）：曾经的第三个固定入口 `__plugins`（该来源的设置
 * 组装诊断）**不再占用 nav 槽位**——它的 subject 是「当前选中的来源」而不是
 * chamber 全局，却又不是该来源账本里的贡献，放进任何一组都会破坏该组的语义。
 * **2026-12 完整桥接修订**：设置面不再二次装载插件，该诊断块连同它的生产端
 * （`toAssemblyReport`）整体退役——历史记录见 git 与 CHANGELOG，design 15 §1。
 *
 * 2026-12 修订（用户拍板）：网关编排分区从桌面设置页整体移除——审批/提问
 * 由侧边栏既有事实通道呈现，网关自有投影（会话/调度/worktree）归网关
 * 自有运维面 `/chamber/` 管理，桌面设置不重放。
 */

/** The fixed connections nav id (design 05 §5): chamber-global connection management. */
export const CONNECTIONS_SECTION_ID = '__connections'

/** The fixed general nav id (design 14 D7 / 15): chamber-global runtime settings. */
export const GENERAL_SECTION_ID = '__general'

/** Every chamber-owned fixed nav id (they never come from a ledger). */
export const FIXED_SECTION_IDS: readonly string[] = [
  CONNECTIONS_SECTION_ID,
  GENERAL_SECTION_ID,
]

/** One nav row of the SELECTED source's settings sections (its own boot-ctx ledger projection). */
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
