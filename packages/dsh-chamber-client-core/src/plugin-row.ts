/**
 * Browser-side face of the single plugin-row definition in the neutral wire package
 * (`@dsh-chamber/dsh-chamber-wire/plugin-row`). The three consumers (settings-connections,
 * desktop preload, renderer) may only import packages they declare, so the contract is
 * re-exported HERE BY NAME. HARD DISCIPLINE: this file declares nothing — a wire-face change
 * updates this name list and nothing else.
 */
export type { PluginRow, PluginRowRole } from '@dsh-chamber/dsh-chamber-wire/plugin-row'
