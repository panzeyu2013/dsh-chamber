/**
 * Chamber settings-shell seat contract (2026-12).
 *
 * The chamber settings shell replaces the official `SettingsRoot` in the
 * `sidebar.settings` slot by registering at a LOWER priority (the slot core
 * renders the lowest-priority winner; same-priority occupancy throws). That
 * mechanism is deliberately one-directional: it must never be possible for a
 * third-party plugin to displace the chamber shell by accident, because the
 * shell is the only renderer of the chamber-global connections/general pages
 * and of every per-source plugin settings section.
 *
 * The constants live in this neutral shared face so the two packages that must
 * agree on them cannot drift: the settings-bridge plugin (the registrant) and
 * the sidebar plugin (the watchdog that reports a takeover). See
 * `watchSettingsShellOccupant` below for the detection contract.
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('settings-shell')

/** The chamber settings shell's `sidebar.settings` entry id. */
export const SETTINGS_SHELL_ENTRY_ID = 'chamber-shell'

/**
 * The reserved shadow priority. Any value at or above this range is shadowed
 * by the chamber shell; a registrant BELOW it would take the seat over.
 * Documented as reserved so plugin authors never pick it by accident.
 */
export const SETTINGS_SHELL_SHADOW_PRIORITY = -1000

/** Minimal entry face the watchdog needs (structural: no dsh type dependency). */
export interface SettingsSeatOccupant {
  options: { id?: string; priority?: number }
}

/** The watchdog's verdict for one `sidebar.settings` cell winner. */
export type SettingsSeatVerdict = 'chamber' | 'pending' | 'taken-over'

/**
 * Classify the `sidebar.settings` winner.
 *
 * - `chamber`: the chamber shell owns the seat.
 * - `pending`: no occupant yet, or an occupant at a priority ABOVE the
 *   reserved range (the official `SettingsRoot` at 0 during the deferred
 *   settings-cluster window, or any ordinary composition) — the chamber shell
 *   simply has not registered yet or legitimately outranks it. Never reported.
 * - `taken-over`: an occupant registered BELOW the reserved priority range,
 *   which the slot rule renders INSTEAD of the chamber shell. The chamber
 *   settings surface is gone; the sidebar reports it (detection only — the
 *   sidebar cannot safely re-pin a slot cell).
 * @param winner - the cell winner (`entriesOfSlot(...)[0]`), or undefined.
 * @returns the verdict.
 */
export function classifySettingsSeatOccupant(winner: SettingsSeatOccupant | undefined): SettingsSeatVerdict {
  if (winner === undefined) return 'pending'
  if (winner.options.id === SETTINGS_SHELL_ENTRY_ID) return 'chamber'
  const priority = winner.options.priority ?? 0
  return priority < SETTINGS_SHELL_SHADOW_PRIORITY ? 'taken-over' : 'pending'
}

/** The takeover report text (one place, both the console watchdog and tests). */
export function settingsSeatTakeoverMessage(occupantId: string): string {
  return `[dsh-chamber] sidebar.settings 被 "${occupantId}" 取代（预期 "${SETTINGS_SHELL_ENTRY_ID}"）：`
    + '桌面设置壳（服务器下拉 + 每实例插件设置）不会渲染。请检查第三方插件是否注册了低于保留区间'
    + `（${SETTINGS_SHELL_SHADOW_PRIORITY}）的 sidebar.settings。`
}
