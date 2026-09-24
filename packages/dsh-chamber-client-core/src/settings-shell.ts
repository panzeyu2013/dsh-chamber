/**
 * Chamber settings-shell seat contract: the shell takes the `sidebar.settings`
 * slot from the official `SettingsRoot` by registering at a LOWER priority (the
 * slot renders the lowest-priority winner; same-priority occupancy throws). It
 * must never be possible for a third-party plugin to displace the shell by
 * accident — the shell is the only renderer of the chamber-global pages and of
 * every per-source plugin settings section. The constants live here so the
 * registrant (settings-bridge) and the watchdog (sidebar) cannot drift.
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('settings-shell')

/** The chamber settings shell's `sidebar.settings` entry id. */
export const SETTINGS_SHELL_ENTRY_ID = 'chamber-shell'

/** The reserved shadow priority: a registrant BELOW this value takes the seat
 *  from the shell (reserved so plugin authors never pick it by accident). */
export const SETTINGS_SHELL_SHADOW_PRIORITY = -1000

/** Minimal entry face the watchdog needs (structural: no dsh type dependency). */
export interface SettingsSeatOccupant {
  options: { id?: string; priority?: number }
}

/** The watchdog's verdict for one `sidebar.settings` cell winner. */
export type SettingsSeatVerdict = 'chamber' | 'pending' | 'taken-over'

/** Classify the `sidebar.settings` winner: `chamber` = the shell owns the seat;
 *  `pending` = no occupant yet or one ABOVE the reserved range (the official
 *  `SettingsRoot` at 0, or any ordinary composition) — never reported;
 *  `taken-over` = an occupant BELOW the range, which the slot renders INSTEAD of
 *  the shell: the chamber settings surface is gone; the sidebar reports it
 *  (detection only — it cannot safely re-pin a slot cell).
 *  @param winner - the cell winner (`entriesOfSlot(...)[0]`), or undefined. */
export function classifySettingsSeatOccupant(winner: SettingsSeatOccupant | undefined): SettingsSeatVerdict {
  if (winner === undefined) return 'pending'
  if (winner.options.id === SETTINGS_SHELL_ENTRY_ID) return 'chamber'
  const priority = winner.options.priority ?? 0
  return priority < SETTINGS_SHELL_SHADOW_PRIORITY ? 'taken-over' : 'pending'
}

/** The takeover report text (single source for the console watchdog). */
export function settingsSeatTakeoverMessage(occupantId: string): string {
  return `[dsh-chamber] sidebar.settings 被 "${occupantId}" 取代（预期 "${SETTINGS_SHELL_ENTRY_ID}"）：`
    + '桌面设置壳（服务器下拉 + 每实例插件设置）不会渲染。请检查第三方插件是否注册了低于保留区间'
    + `（${SETTINGS_SHELL_SHADOW_PRIORITY}）的 sidebar.settings。`
}
