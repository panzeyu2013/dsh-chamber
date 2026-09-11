/**
 * Registrant provenance for the chamber settings shell (2026-12 完整桥接修订).
 *
 * The panel renders the SELECTED source's own boot-ctx `settings.section`
 * ledger, so a nav row's registrant is a cordis fiber name: an official
 * settings-family package, the chamber's own shell/runtime section, or a
 * third-party plugin. Rows whose registrant is NOT listed here are marked as
 * plugin-provided in the nav — the honest provenance mark, not a mount list.
 *
 * History: this module used to carry `BASE_PLUGIN_IDS` — the fixed plugin set
 * the detached child context mounted. That context is gone (nothing is mounted
 * twice and no service is stubbed any more), so the list is now only a
 * CLASSIFICATION set; it no longer constrains what may be mounted.
 */

/** The chamber's own per-instance「dsh 运行时」section id (registered by this package). */
export const RUNTIME_SECTION_ID = 'dsh-runtime'

/**
 * The registrants the shell renders as OFFICIAL (never marked "plugin"):
 * the official settings family mounted by the chamber composite plus the
 * chamber's own shell/section registrations.
 */
export const OFFICIAL_SECTION_REGISTRANTS: readonly string[] = [
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@dsh-chamber/dsh-chamber-client-ui-settings-bridge',
  // Unnamed registrations (the declaration chain's inert entries) are stamped
  // 'root' by cordis; they never occupy a settings seat.
  'root',
]

const OFFICIAL_SET = new Set(OFFICIAL_SECTION_REGISTRANTS)

/** True for a registrant the shell renders as an official/chamber section. */
export function isBasePluginId(id: string): boolean {
  return OFFICIAL_SET.has(id)
}
