/**
 * Browser-side face of the single plugin-row definition
 * (`@dsh-chamber/dsh-chamber-wire/plugin-row`, design 21 §6.11.5).
 *
 * Why this pass-through exists: the definition lives in the neutral wire
 * package, but the browser consumers (settings-connections), the desktop
 * preload and the renderer may only import packages they declare, and this
 * batch deliberately does not grow those dependency lists. client-core already
 * depends on wire — and is already the declared dependency of all three — so
 * the row contract is re-exported HERE BY NAME: one implementation, one
 * browser-side face.
 *
 * HARD DISCIPLINE: this file declares nothing. It is a name list, not a
 * second definition; a wire-face change updates this list and nothing else.
 */
export type { PluginRow, PluginRowRole } from '@dsh-chamber/dsh-chamber-wire/plugin-row'
