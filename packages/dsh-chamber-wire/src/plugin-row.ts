/**
 * The read-face plugin-row wire contract (design 21): THE single definition of
 * the row shape every plugin-read backend projects and every consumer reads
 * (the control-plane producer re-exports it; desktop preload/renderer reach it
 * through client-core's browser pass-through face, and settings-connections
 * renames it at the module edge without re-declaring it).
 *
 * PURE + TYPE-ONLY: zero runtime exports, zero dependencies.
 */

/** Row role (read-face projection; the renderer renders, never derives). */
export type PluginRowRole =
  | 'composition'
  | 'seed'
  | 'layer'
  | 'third-party'
  | 'materialized'
  | 'unknown'

/** One installed-fact row (design 21 wire shape). */
export interface PluginRow {
  name: string
  /** Declared dependency value (each backend applies its own masking); a
   *  projected row always comes from the dependency table, so only an explicit
   *  null from the masker makes it null. */
  spec: string | null
  /** Installed version (only when readable from a node_modules manifest), else null. */
  version: string | null
  role: PluginRowRole
  protected: boolean
  owner?: 'installation' | 'chamber' | 'user'
}
