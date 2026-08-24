/**
 * Notifications-settings helpers for the「通用」notifications control group
 * (design 19 §3.4, merged into General per the 2026-09 user decision). Pure
 * logic only — no React, no DOM — so it is node:test-runnable (same role as
 * update-gate.ts for the update button).
 */
import type { ChamberSettings } from '../ambient/settings-bridge.d.ts'

/** The notifications settings block (design 19 §3.4) — mirrors the renderer
 *  ChamberNotificationSettings shape (global.d.ts) and the desktop store
 *  (packages/desktop/chamber-settings.ts ChamberNotificationSettings). */
export interface NotificationsSettings {
  /** Master switch; default false (low disturbance — opt-in). */
  enabled: boolean
  /** 'hidden-only' (default) | 'always' (still exempts the session on screen). */
  mode: 'hidden-only' | 'always'
  /** Notify when a session completes; default true. */
  onComplete: boolean
  /** Notify when the agent asks a question; default true. */
  onAsk: boolean
  /** Notify when approval is requested; default true. */
  onRequest: boolean
}

/** Design defaults (design 19 §3.4) — must stay in sync with the desktop
 *  DEFAULT_CHAMBER_SETTINGS.notifications (chamber-settings.ts); the test
 *  file asserts the mirror. */
export const NOTIFICATIONS_DEFAULTS: NotificationsSettings = {
  enabled: false,
  mode: 'hidden-only',
  onComplete: true,
  onAsk: true,
  onRequest: true,
}

const KNOWN_KEYS: ReadonlyArray<keyof NotificationsSettings> = [
  'enabled',
  'mode',
  'onComplete',
  'onAsk',
  'onRequest',
]

/** Read the notifications block with defaults — optional chaining only, never
    a fabricated value (an absent block means "not yet stored": show the
    design defaults, not a fake off). Unknown future keys are filtered out:
    the main-process validatePatch rejects unknown nested keys, and a stored
    block may carry forward-compat keys from a newer build. */
export function notificationsOf(settings: ChamberSettings | undefined): NotificationsSettings {
  const value = settings?.notifications
  const result: NotificationsSettings = { ...NOTIFICATIONS_DEFAULTS }
  if (value === null || typeof value !== 'object') return result
  const record = value as unknown as Record<string, unknown>
  for (const key of KNOWN_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'boolean' && key !== 'mode') {
      result[key] = candidate
    } else if (key === 'mode' && (candidate === 'hidden-only' || candidate === 'always')) {
      result.mode = candidate
    }
  }
  return result
}

/** Build a PARTIAL nested notifications patch — the main-process
 *  validatePatch accepts partial nested keys and applySettingsPatch
 *  deep-merges them, so only the changed key rides the wire and sibling
 *  switches can never be clobbered by a stale full-object snapshot (N-ctx
 *  shells each own a settings panel in the same document). */
export function notificationsPatch(
  patch: Partial<NotificationsSettings>,
): Partial<ChamberSettings> {
  // Partial<NotificationsSettings> 的键全可选，与 ChamberSettings.notifications
  // （必填块）结构不匹配——经 Partial<ChamberSettings> 断言（partial 语义下
  // 主进程 deep-merge 接受缺键）。
  return { notifications: patch } as Partial<ChamberSettings>
}
