/**
 * Settings nav projection over a live `settings.section` ledger.
 *
 * The ledger is the SELECTED SOURCE's own boot-ctx registry: official families,
 * third-party plugins and the chamber's per-instance「dsh 运行时」section all register
 * there. This module only projects those registrations into nav rows — it mounts
 * nothing and owns no lifecycle.
 *
 * A row carries id / order / label and NOTHING else, matching what the official
 * shell renders. Upstream carries the registrant stamp for DIAGNOSTICS only and never
 * renders it, so neither do we: a plugin-provided section looks exactly like an
 * official one. The label fallback is upstream's EXPORTED `resolveSlotLabel`, the same
 * projection upstream's own ledger→row code uses.
 */
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { SectionNavRow } from './nav-active.ts'

/** Structural read face of a slots ledger (the registry's public read API). */
export interface SectionLedger {
  entries(key: string): readonly {
    options: { id?: string; order?: number; label?: string | (() => string) }
  }[]
}

/**
 * Project one source's `settings.section` ledger into ordered nav rows.
 * @returns the nav rows, ledger order first then `order` (stable).
 */
export function sectionRows(slots: SectionLedger): SectionNavRow[] {
  return slots.entries('settings.section')
    .map(entry => {
      const label = resolveSlotLabel(entry.options.label)
      return {
        id: entry.options.id ?? '',
        order: entry.options.order ?? 0,
        label: label ?? '',
      }
    })
    .sort((a, b) => a.order - b.order)
}
