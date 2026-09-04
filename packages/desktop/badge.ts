/**
 * Dock/taskbar unread badge count (design 19 §3.7) — pure logic, no electron,
 * unit-testable with plain node:test (see badge.test.ts).
 *
 * The renderer projects its「完成未读」blue-dot set into a single non-negative
 * integer and pushes it over `dsh-chamber:badge-count`; the main process is
 * the authority for presentation: payload whitelist → settings adjudication
 * (notifications.badgeEnabled, chamber-settings.json) → platform gate →
 * `app.setBadgeCount(n)` (macOS Dock / Linux Unity launcher). 0 = clear.
 *
 * Platform honesty: `app.setBadgeCount` only has an OS-visible effect on
 * macOS (Dock badge) and Linux (Unity launcher); GNOME/KDE show nothing —
 * a documented platform limit, not a silent fake success. Windows needs the
 * `setOverlayIcon` taskbar overlay (a generated numeric image) and is gated
 * off in v1 with a loud log (design 23 real-machine matrix).
 */

/** 计数硬上限：会话数级别的计数远小于此值；上限约束被攻破的 renderer 不能
 *  请求任意大数值（Dock 渲染极端值无意义）。超上限 = 载荷非法（响亮拒绝，
 *  不静默截断——截断会把真实的大计数伪装成小计数）。 */
export const MAX_BADGE_COUNT = 9999

/** IPC payload 白名单校验：`{ count: number }`。必须为有限数（结构化克隆可
 *  携带 NaN/Infinity，必须显式拒绝）、非负、≤ MAX_BADGE_COUNT；小数按
 *  Math.floor 归一（与 OpenChamber 同款容忍）。未知/多余字段忽略。 */
export function validateBadgeRequest(
  raw: unknown,
): { ok: true; count: number } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'badge request must be an object' };
  }
  const record = raw as Record<string, unknown>;
  const count = record.count;
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return { ok: false, error: 'badge count must be a finite number' };
  }
  const floored = Math.floor(count);
  if (floored < 0) {
    return { ok: false, error: 'badge count must be non-negative' };
  }
  if (floored > MAX_BADGE_COUNT) {
    return { ok: false, error: `badge count exceeds the ${MAX_BADGE_COUNT} hard cap` };
  }
  return { ok: true, count: floored };
}

/** 设置裁决（design 19 §3.7）：badgeEnabled 关闭时强制按 0 处理（清除）——
 *  renderer 始终推真实计数，主进程裁决归零，开关一切立即清零，行为诚实。
 *  重新开启时 pendingBadgeCount 经本函数恢复（main.ts 的 reconcileBadge）。 */
export function adjudicateBadgeCount(
  settings: { badgeEnabled: boolean },
  count: number,
): number {
  return settings.badgeEnabled ? count : 0;
}

/** 平台能力门（v1）：app.setBadgeCount 只在 macOS（Dock 红气泡）与 Linux
 *  （Unity launcher DBus API；GNOME 的 Dash to Dock 等消费同一 API 的扩展同样
 *  可见）有 OS 可见效果；win32 需要 setOverlayIcon 数字角标图（后续排期）——
 *  门控跳过并 loud 记一次日志，绝不假装成功。平台判断先于 API 可用性判断：
 *  win32 上 setBadgeCount 恒为 undefined，若先查 API 会把设计 23 的专属原因
 *  吞成泛化的「API 缺失」。返回 true 表示已应用到 OS API，不是可见性保证
 *  （GNOME/KDE 无消费方的桌面环境无可见效果——文档化平台限制）。 */
export function badgePlatformGate(
  platform: string,
  setBadgeCountAvailable: boolean,
): { supported: boolean; reason: string } {
  if (platform === 'darwin') {
    return setBadgeCountAvailable
      ? { supported: true, reason: '' }
      : { supported: false, reason: 'app.setBadgeCount is unavailable on this Electron build' };
  }
  if (platform === 'linux') {
    return setBadgeCountAvailable
      ? { supported: true, reason: '' }
      : { supported: false, reason: 'app.setBadgeCount is unavailable on this Electron build' };
  }
  if (platform === 'win32') {
    return { supported: false, reason: 'Windows taskbar overlay badge is not wired in v1 (design 23 follow-up)' };
  }
  return { supported: false, reason: `unsupported platform for badge presentation: ${platform}` };
}
