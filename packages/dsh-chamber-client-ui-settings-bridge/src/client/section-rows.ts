/**
 * Settings nav projection over a live `settings.section` ledger (design 15 v1
 * flat form).
 *
 * The ledger is the SELECTED SOURCE's own boot-ctx registry (design 05 §5,
 * 2026-12 完整桥接修订): official families register there through the chamber
 * composite, third-party plugins through their own bundles, and the chamber's
 * per-instance「dsh 运行时」section through the settings-bridge plugin running
 * in that same ctx. This module only projects those registrations into nav
 * rows — it mounts nothing and owns no lifecycle.
 *
 * A row carries id / order / label and NOTHING else, matching what the official
 * shell renders (`ui-settings-general` SettingsRoot: `navIcon(row.id)` + the
 * label). Upstream carries the registrant stamp for DIAGNOSTICS only and never
 * renders it, so neither do we: a plugin-provided section looks exactly like an
 * official one here, as it does in the instance's own frontend (2026-09-11
 * decision — the old chamber-side「插件」provenance tag is gone).
 */
import type { SectionNavRow } from './nav-active.ts'

/** Structural read face of a slots ledger (the registry's public read API). */
export interface SectionLedger {
  entries(key: string): readonly {
    options: { id?: string; order?: number; label?: string | (() => string) }
  }[]
}

/**
 * Project one source's `settings.section` ledger into ordered nav rows.
 * @param slots - that source's slot registry (read face).
 * @returns the nav rows, ledger order first then `order` (stable).
 */
export function sectionRows(slots: SectionLedger): SectionNavRow[] {
  return slots.entries('settings.section')
    .map(entry => {
      const raw = typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
      return {
        id: entry.options.id ?? '',
        order: entry.options.order ?? 0,
        label: raw === undefined || raw === null ? '' : String(raw),
      }
    })
    .sort((a, b) => a.order - b.order)
}
