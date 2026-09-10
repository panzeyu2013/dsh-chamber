/**
 * The chamber settings surface's BASE plugin ids (2026-12).
 *
 * Pure data on purpose — NO cordis import: the child-context assembly
 * (`bridge-context.ts`) mounts these packages, and the lockstep test asserts
 * them against the renderer's composite-covered set
 * (`packages/renderer/src/chamber-covered.ts`).
 *
 * THE INVARIANT (load-bearing): every id here must be in `CHAMBER_COVERED_IDS`.
 * A base plugin that is NOT covered would also arrive in the source's extension
 * set (graph rows minus covered), i.e. the same package would be mounted twice
 * on one child context — cordis rejects the duplicate service/slot registration
 * and the plugin is reported failed for no reason. `base-plugins-lockstep.test.ts`
 * enforces the subset relation mechanically.
 */

/** The chamber's lazy agent-preset section id (its bundle is a deferred chunk). */
export const AGENT_PRESET_ID = '@deepseek-ai/dsh-client-ui-agent-preset'

/** The chamber-owned per-source runtime section pseudo-id (attributed as base). */
export const RUNTIME_SECTION_ID = 'dsh-chamber:runtime-section'

/**
 * The BASE plugin set ids the child context mounts (infrastructure + the
 * official settings families + the chamber replacements + the per-source
 * runtime section). The SELECTED SOURCE's own plugins are the EXTENSION set and
 * never appear here.
 */
export const BASE_PLUGIN_IDS: readonly string[] = [
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@dsh-chamber/dsh-chamber-client-ui-settings-bridge',
  AGENT_PRESET_ID,
  RUNTIME_SECTION_ID,
  // Unnamed registrations (the declaration chain's inert entries) are stamped
  // 'root' by cordis; they never occupy a settings seat.
  'root',
]

const BASE_ID_SET = new Set(BASE_PLUGIN_IDS)

/** True for the chamber's own base registrations (used to filter seat reports). */
export function isBasePluginId(id: string): boolean {
  return BASE_ID_SET.has(id)
}
