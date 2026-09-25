/**
 * Browser-side face of the single plugin-manifest definition in the neutral wire package
 * (`@dsh-chamber/dsh-chamber-wire/plugin-manifest`). The browser consumer may only import
 * packages it declares, so the model is re-exported HERE BY NAME: one implementation, one face.
 *
 * HARD DISCIPLINE: this file declares nothing — a wire-face change updates this name list and
 * nothing else. No `export *`: the `verify-no-dead-exports` gate resolves named re-exports only.
 */
export {
  hasXWildcard,
  isMaterializedValue,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
export type {
  PluginManifestModel,
  PluginProfileRefusalCode,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
