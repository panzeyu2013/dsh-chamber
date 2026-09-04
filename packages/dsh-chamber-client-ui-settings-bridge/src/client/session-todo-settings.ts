/**
 * 会话待办区（sidebar todo area）settings helpers for the「通用」new control
 * group — pure logic only, no React/DOM, node:test-runnable (same role as
 * notifications-settings.ts for the notifications group).
 *
 * Defaults are ALL ON: the todo area is a PASSIVE presentation (it renders
 * only while it has entries, zero footprint otherwise), unlike the desktop
 * notifications master switch which is opt-in.
 */
import type { ChamberSettings } from '../ambient/settings-bridge.d.ts'

/** The sessionTodo settings block — mirrors the renderer
 *  ChamberSessionTodoSettings shape (global.d.ts) and the desktop store
 *  (packages/desktop/chamber-settings.ts ChamberSessionTodoSettings). */
export interface SessionTodoSettings {
  /** Master switch; default true (passive presentation — renders only while non-empty). */
  enabled: boolean
  /** 会话完成未读时（默认 true）。 */
  onComplete: boolean
  /** 代理提问等待回答（pending 'question'）时（默认 true）。 */
  onAsk: boolean
  /** 工具调用/计划审批请求（pending 'approval' | 'plan-review'）时（默认 true）。 */
  onRequest: boolean
}

/** Design defaults — must stay in sync with the desktop
 *  DEFAULT_CHAMBER_SETTINGS.sessionTodo (chamber-settings.ts); the test file
 *  asserts the mirror. */
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
 *  fabricated value (an absent block means "not yet stored": show the design
 *  defaults — here ALL ON, never a fake off). Unknown future keys are
 *  filtered out: the main-process validatePatch rejects unknown nested keys,
 *  and a stored block may carry forward-compat keys from a newer build.
 *  Array blocks are rejected up-front like the desktop normalizer
 *  (normalizeSessionTodoSettings) — guard parity, not behavior. */
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

/** Build a PARTIAL nested sessionTodo patch — the main-process validatePatch
 *  accepts partial nested keys and applySettingsPatch deep-merges them, so
 *  only the changed key rides the wire and sibling switches can never be
 *  clobbered by a stale full-object snapshot (N-ctx shells each own a
 *  settings panel in the same document). */
export function sessionTodoPatch(
  patch: Partial<SessionTodoSettings>,
): Partial<ChamberSettings> {
  // Partial<SessionTodoSettings> 的键全可选，与 ChamberSettings.sessionTodo
  // （必填块）结构不匹配——经 Partial<ChamberSettings> 断言（partial 语义下
  // 主进程 deep-merge 接受缺键）。
  return { sessionTodo: patch } as Partial<ChamberSettings>
}
