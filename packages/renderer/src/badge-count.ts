/**
 * 未读徽标计数投影（design 19 §3.7）——pure logic, no React/DOM, node:test
 * runnable (see test/badge-count.test.ts).
 *
 * The count is a PROJECTION of the App-owned「完成未读」blue-dot set
 * (`completedBySource`, App.tsx / 06 §4.1) — never a second state machine:
 * the same running→idle arming and reading-disarm rules that drive the
 * in-window dots drive the OS badge, so the two surfaces can never disagree.
 * Semantics mirror OpenChamber's `dockBadgeCount` (chats with unseen
 * activity, not the number of notifications): one unit per unseen session,
 * 0 = clear the badge.
 */

/**
 * 跨来源求「完成未读」会话数：对每个来源的蓝点集里值为 true 的会话计数。
 * 0 = 无未读（主进程清除徽标）。空集/缺来源/undefined 均安全返回 0
 * （纯投影对全域 total，任何调用点都不需要自行判空）。
 */
export function projectBadgeCount(
  completedBySource: Record<string, Record<string, boolean>> | undefined,
): number {
  if (completedBySource === undefined) return 0
  let count = 0
  for (const sessions of Object.values(completedBySource)) {
    for (const armed of Object.values(sessions)) {
      if (armed === true) count += 1
    }
  }
  return count
}
