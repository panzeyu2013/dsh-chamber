/**
 * Browser-side face of the single plugin-manifest definition
 * (`@dsh-chamber/dsh-chamber-wire/plugin-manifest`, design 21 §3
 * `readManifest` / §6.2 掩码纪律).
 *
 * Why this pass-through exists: the definition lives in the neutral wire
 * package, but the browser consumer (settings-connections) may only import
 * packages it declares, and this batch deliberately does not grow that
 * package's dependency list. client-core already depends on wire, so the model
 * is re-exported HERE BY NAME — one implementation, one browser face.
 *
 * HARD DISCIPLINE: this file declares nothing. It is a name list, not a
 * second definition; a wire-face change updates this list and nothing else.
 * (No `export *`: the dead-export gate resolves named re-exports to real
 * consumers, which a star re-export would hide.)
 */
export {
  hasXWildcard,
  isMaterializedValue,
  maskMaterializedDependencies,
  parsePluginManifest,
  PLUGIN_MATERIALIZED_VALUE_MASK,
  readManifestVersion,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
export type {
  PluginManifestFault,
  PluginManifestModel,
  PluginManifestParseResult,
  PluginProfileRefusalCode,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
