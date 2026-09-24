/**
 * 会话待办区（sidebar todo area）settings helpers for the「通用」control group — pure
 * logic only, no React/DOM, node:test-runnable (same role as
 * notifications-settings.ts).
 *
 * Defaults are ALL ON: the todo area is a PASSIVE presentation (renders only while it
 * has entries), unlike the opt-in notifications master switch.
 */
import type { ChamberSettings } from '../ambient/settings-bridge.d.ts'

/** The sessionTodo settings block — mirrors the renderer shape and the desktop store
 *  (chamber-settings.ts ChamberSessionTodoSettings). */
export interface SessionTodoSettings {
  /** Master switch; default true (passive presentation — renders only while non-empty). */
  enabled: boolean
  /** 会话完成未读时（默认 true）。 */
  onComplete: boolean
  onAsk: boolean
  onRequest: boolean
}

/** Design defaults — must stay in sync with the desktop DEFAULT_CHAMBER_SETTINGS.sessionTodo
 *  (chamber-settings.ts; test-asserted). */
export const SESSION_TODO_DEFAULTS: SessionTodoSettings = {
  enabled: true,
  onComplete: true,
  onAsk: true,
  onRequest: true,
}

const KNOWN_KEYS: ReadonlyArray<keyof SessionTodoSettings> = [
  'enabled',
  'onComplete',
  'onAsk',
  'onRequest',
]

/** Read the sessionTodo block with defaults — optional chaining only, never a
 *  fabricated value (an absent block means "not yet stored": show the design defaults
 *  — here ALL ON, never a fake off). Unknown future keys are filtered out (a stored
 *  block may carry forward-compat keys); array blocks are rejected up-front like the
 *  desktop normalizer — guard parity, not behavior. */
export function sessionTodoOf(settings: ChamberSettings | undefined): SessionTodoSettings {
  const value = settings?.sessionTodo
  const result: SessionTodoSettings = { ...SESSION_TODO_DEFAULTS }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result
  const record = value as unknown as Record<string, unknown>
  for (const key of KNOWN_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'boolean') result[key] = candidate
  }
  return result
}

/** Build a PARTIAL nested sessionTodo patch — validatePatch accepts partial nested
 *  keys and applySettingsPatch deep-merges them, so only the changed key rides the wire
 *  and sibling switches can never be clobbered by a stale full-object snapshot. */
export function sessionTodoPatch(
  patch: Partial<SessionTodoSettings>,
): Partial<ChamberSettings> {
  // Partial<SessionTodoSettings> 的键全可选，与 ChamberSettings.sessionTodo
  return { sessionTodo: patch } as Partial<ChamberSettings>
}
