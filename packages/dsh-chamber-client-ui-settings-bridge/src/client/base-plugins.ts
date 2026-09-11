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
 * the UPSTREAM official settings family, plus — by npm scope, see
 * {@link CHAMBER_SCOPE} — every chamber-owned package.
 *
 * The stamp being compared is the registrant FIBER's name (ui-renderer
 * `SlotRegistry._register`: `options.registrant ?? ctx.fiber.name`), and cordis
 * names an UNNAMED fiber after its nearest NAMED ancestor (`Fiber.name`), so a
 * row mounted bare is stamped with its mount context, not its own package. A
 * registrant can therefore arrive under several DIFFERENT strings for the same
 * package, depending on the path that mounted it:
 * - a graph row the instance's host serves (an installed PLUGIN) is mounted by
 *   the shell loader as `loader.create({ name: row.id })`, and the row id IS the
 *   package name (vendor `dsh-client-modules` `graphRow(packageName, …)`) → the
 *   package id ✔;
 * - a row the chamber's own composite mounts is mounted by
 *   `chamber-entry.ts registerDeferred` with `name: <row id>` (2026-09-11 fix —
 *   it used to be unnamed, so every composite-provided section was stamped
 *   `@dsh-chamber/app` and mislabelled「插件」) ✔;
 * - the chamber's own client-UI packages ALSO ship `dsh.client` manifests, so in
 *   a shape where the composite is not the one serving them (the instance's own
 *   frontend, the mobile/gateway shape) the same package arrives as an instance
 *   row instead — same package, different mount, still chamber-owned ✔;
 * - anything the composite mounts bare inherits `@dsh-chamber/app`.
 *
 * That is why chamber ownership is decided by SCOPE, not by enumerating ids: an
 * enumeration only covers the paths someone remembered. Only UPSTREAM ids are
 * listed explicitly — the chamber's own ids are covered by the scope rule, and
 * the npm scope is ownable by construction (nobody else can publish
 * `@dsh-chamber/*`).
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
  // Unnamed registrations (the declaration chain's inert entries) are stamped
  // 'root' by cordis; they never occupy a settings seat.
  'root',
]

/**
 * The chamber's own npm scope. Every package under it is OURS by construction —
 * the composite's app mount context (`@dsh-chamber/app`), the client-UI
 * packages (`@dsh-chamber/dsh-chamber-client-ui-*`), the instance-side seeds —
 * whichever mounting path produced the registrant stamp. A third-party plugin
 * can never acquire this prefix, so it is the reliable half of the
 * classification; the upstream list above is the part that must be maintained by
 * hand when the settings family grows.
 */
const CHAMBER_SCOPE = '@dsh-chamber/'

const OFFICIAL_SET = new Set(OFFICIAL_SECTION_REGISTRANTS)

/**
 * True for a registrant the shell renders as an official/chamber section: an
 * upstream official id, `root`, or ANY id under the chamber's own npm scope —
 * the last one regardless of which mounting path produced the stamp (composite
 * mount context, an instance row serving a chamber client-UI package, a seed).
 * @param id - the registrant stamp (a cordis fiber name).
 * @returns true when the row must not be marked "plugin".
 */
export function isBasePluginId(id: string): boolean {
  return OFFICIAL_SET.has(id) || id.startsWith(CHAMBER_SCOPE)
}
