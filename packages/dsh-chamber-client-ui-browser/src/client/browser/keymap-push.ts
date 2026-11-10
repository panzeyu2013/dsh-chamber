/**
 * Keymap push planning for the native guest (design 28 v3 §4.5).
 *
 * The shell KeyboardBridge needs the shell's effective shortcut combinations so a
 * focused guest forwards exactly those keys; the renderer pushes them through
 * `browser.keymap`. This module owns the pure decision (when to send), keeping it
 * testable without a DOM or the browser package's vendor imports.
 */
import type { BrowserKeyCombo } from './BrowserBridge.ts'

/** One push decision. */
export interface KeymapPushPlan {
  /** True when the caller must invoke `browser.keymap`. */
  readonly send: boolean
  /** Serialized combination set to remember (undefined = keep the previous value). */
  readonly remembered?: string
  /** Payload to send when `send` is true. */
  readonly combos?: readonly BrowserKeyCombo[]
}

/** Stable serialization of a combination set (order-insensitive per row, row order kept). */
export function serializeCombos(combos: readonly BrowserKeyCombo[]): string {
  return JSON.stringify(combos.map(combo => [combo.code, combo.primary, combo.alt, combo.shift, combo.control]))
}

/**
 * Decide one keymap push.
 *
 * Rules: never send without a live lease / a `keymap` face / a combo source
 * (fail-safe — the guest keys stay inert, they are never swallowed); never resend
 * an unchanged serialization; an EMPTY table is pushed only when the shell was
 * previously non-empty (it clears the stale map), and never for a first push.
 *
 * @param ready - lease live, bridge not disposed, both `keymap` and `combos` present.
 * @param previous - serialization remembered from the last successful commit.
 * @param combos - current effective combinations (may throw upstream: caller guards).
 * @returns the plan.
 */
export function planKeymapPush(
  ready: boolean,
  previous: string | undefined,
  combos: readonly BrowserKeyCombo[],
): KeymapPushPlan {
  if (!ready) return { send: false }
  const serialized = serializeCombos(combos)
  if (serialized === previous) return { send: false }
  // First push of an empty table has nothing to clear.
  if (combos.length === 0 && previous === undefined) return { send: false }
  return { send: true, remembered: serialized, combos }
}
