/**
 * Pure tone/status/label projections for the READ-ONLY plugin dialog: the dialog body keeps
 * orchestration and JSX. The retired write flows (apply/remove/undo outcome lines, diff row
 * kinds, the category/status filter vocabulary) are gone with the plugin write surfaces (D1).
 */
import clsx from 'clsx'
import type { SettingsConnectionsKey } from '../locales.ts'
import type { PluginRowRoleShape } from './plugin-model.ts'
import type { ChamberBadgeTone } from './plugin-inventory-text.ts'
import css from './ConnectionsSection.module.css'

/** Phase of one read surface (ssh manifest load / Loader inventory load). */
export type ViewPhase = 'loading' | 'error' | 'ready'

/** A LocalPluginManifest row's display category: active bundle layer / client plugin / plain dependency. */
export type InstalledCategory = 'bundle' | 'client' | 'plain'

/** A row's category badge: bundle / client / plain. */
export function categoryLabel(category: InstalledCategory): SettingsConnectionsKey {
  switch (category) {
    case 'bundle': return 'pluginsCatBundle'
    case 'client': return 'pluginsCatClient'
    default: return 'pluginsCatPlain'
  }
}

/** Row-role badge label key: the role is the BACKEND's projection (`rows[].role`) — the dialog
 *  renders it, never re-derives it. null for 'unknown': no label is invented for a role the
 *  backend could not classify (the row renders without a badge, still fully visible). */
export function roleLabel(role: PluginRowRoleShape): SettingsConnectionsKey | null {
  switch (role) {
    case 'composition': return 'pluginsRoleComposition'
    case 'seed': return 'pluginsRoleSeed'
    case 'layer': return 'pluginsRoleLayer'
    case 'third-party': return 'pluginsRoleThirdParty'
    case 'materialized': return 'pluginsRoleMaterialized'
    default: return null
  }
}

/** Role badge → the EXISTING category-badge CSS vocabulary (no new CSS): composition reuses the
 *  filled bundle tone, the chamber seed the warn-tint client tone, everything else the muted plain pill. */
export function roleBadgeClass(role: PluginRowRoleShape): string {
  switch (role) {
    case 'composition': return css.pluginKindBundle
    case 'seed': return css.pluginKindClient
    default: return css.pluginKindPlain
  }
}

/** Chamber badge tone → the shared .badge pill family (ok = filled success, warn = outlined warn,
 *  danger = filled error, muted = plain pill). */
export function chamberBadgeClass(tone: ChamberBadgeTone): string {
  switch (tone) {
    case 'ok': return clsx(css.badge, css.badgeOk)
    case 'warn': return clsx(css.badge, css.badgeWarn)
    case 'danger': return clsx(css.badge, css.badgeBad)
    default: return css.badge
  }
}

/**
 * The ssh remote-side chamber badge lives in plugin-inventory-text.ts (sshChamberBadge) — the row
 * derivation needs it, and that module is the locale-free projection the plain-node suite covers.
 */
