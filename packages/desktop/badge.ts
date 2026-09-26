/**
 * Dock/taskbar unread badge count (pure logic, no electron): the renderer pushes its
 * 「完成未读」 merged count over `dsh-chamber:badge-count`; main adjudicates — payload
 * whitelist → notifications.badgeEnabled → platform gate → `app.setBadgeCount(n)`, 0 = clear.
 * SINGLE AUTHORITY: no ledger, no runtime-facts row, no per-source map; the holder is
 * replace-on-push, so the renderer reload fallback (push 0) clears the OS badge.
 * Platform honesty: OS-visible only on macOS (Dock) and Linux (Unity); GNOME/KDE show
 * nothing (never a fake success); Windows needs setOverlayIcon and is gated off loudly.
 */

/** 计数硬上限：会话数级别远小于此值，上限约束被攻破的 renderer 不能请求任意大数值；
 * 超上限 = 载荷非法（响亮拒绝，不静默截断——截断会把真实大计数伪装成小计数）。 */
export const MAX_BADGE_COUNT = 9999

/** IPC payload 白名单：`{ count: number }`，必须有限（结构化克隆可携带 NaN/Infinity）、
 * 非负、≤ MAX_BADGE_COUNT；小数按 Math.floor 归一，未知字段忽略。 */
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

/** 设置裁决：badgeEnabled 关闭时强制按 0 处理（清除）——renderer 始终推真实计数，
  * 主进程裁决归零；重新开启时 badgeTarget 经本函数（shell-core 的 reconcileBadgeCount）恢复。 */
export function adjudicateBadgeCount(
  settings: { badgeEnabled: boolean },
  count: number,
): number {
  return settings.badgeEnabled ? count : 0;
}

/** 平台能力门（v1）：setBadgeCount 只在 macOS（Dock）与 Linux（Unity launcher）有 OS 可见
 * 效果；win32 需要 setOverlayIcon 数字角标图，门控跳过并 loud 记一次日志，绝不假装成功。
 * 平台判断先于 API 可用性判断（win32 上该 API 恒 undefined，先查 API 会把专属原因吞成
 * 泛化的 API 缺失）。返回 true 表示已应用到 OS API，不是可见性保证。 */
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
