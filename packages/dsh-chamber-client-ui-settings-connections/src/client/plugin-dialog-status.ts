/**
 * Pure tone/status/label projections for the plugin dialog (2026-12 audit
 * phase 3): moved verbatim out of PluginDialog.tsx so the dialog body keeps
 * orchestration and JSX. ADD_SPEC stays in PluginDialog.tsx — the gateway
 * plugin-spec lockstep test pins it there by path.
 */
import clsx from 'clsx'
import type { SettingsConnectionsKey } from '../locales.ts'
import { isDifferenceRow, type PluginRow, type PluginRowKind } from './plugin-diff.ts'
import type { PluginRowRoleShape } from './plugin-model.ts'
import type { ChamberBadgeTone } from './plugin-inventory-text.ts'
import css from './ConnectionsSection.module.css'

export type PluginPhase = 'loading' | 'error' | 'ready' | 'applying' | 'done'
export type CategoryFilter = 'all' | 'bundle' | 'plain' | 'client'
export type StatusFilter = 'diff' | 'all'
export type ViewPhase = 'loading' | 'error' | 'ready'

/** Tone of the remote-list operation status line (design 21 §6.6 list tab). */
export type RemoteListTone = 'ok' | 'warn' | 'error'

/** One operation outcome line (undo / row-remove executed outcomes). */
export interface RemoteListStatus {
  tone: RemoteListTone
  text: string
}

/** Remote-list status tone → the shared copy class it renders with. */
export function remoteStatusClass(tone: RemoteListTone): string {
  switch (tone) {
    case 'ok': return css.hint
    case 'warn': return css.pluginWarn
    default: return css.error
  }
}

/** Tone of the gateway management-zone operation status line (remove /
 *  undo outcomes — the ssh modal's RemoteListTone equivalent). */
export type ManageTone = 'ok' | 'warn' | 'error'

/** One management-zone outcome line (row remove / undo executed outcomes). */
export interface ManageStatus {
  tone: ManageTone
  text: string
}

/** Tone of the restart-to-apply outcome line (two-tone pair, mirroring the
 *  connection card's restart note): 'error' renders css.error + role="alert";
 *  'ok' renders css.hint + role="status". */
export type RestartNote = { tone: 'ok' | 'error'; text: string }

/** Management status tone → the shared copy class it renders with. */
export function manageStatusClass(tone: ManageTone): string {
  switch (tone) {
    case 'ok': return css.hint
    case 'warn': return css.pluginWarn
    default: return css.error
  }
}

/** Row-kind → localized label key. */
export function kindLabel(kind: PluginRowKind): SettingsConnectionsKey {
  switch (kind) {
    case 'missing': return 'pluginsRowAdd'
    case 'update': return 'pluginsRowUpdate'
    case 'extra': return 'pluginsRowRemove'
    case 'materialize': return 'pluginsRowMaterialize'
    case 'unsyncable': return 'pluginsRowUnsyncable'
    default: return 'pluginsConsistent'
  }
}

/** A row's category badge: bundle / client / plain. */
export function categoryLabel(category: PluginRow['category']): SettingsConnectionsKey {
  switch (category) {
    case 'bundle': return 'pluginsCatBundle'
    case 'client': return 'pluginsCatClient'
    default: return 'pluginsCatPlain'
  }
}

/** Row-role badge label key (design 21 §6.11.5): the role is the BACKEND's
 *  projection (`rows[].role`) — the dialog renders it, never re-derives it.
 *  null for 'unknown': no label is invented for a role the backend could not
 *  classify (such a row renders without a role badge, still fully visible). */
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

/** Role badge → the EXISTING category-badge CSS vocabulary (no new CSS):
 *  composition reuses the filled bundle tone, the chamber seed the warn-tint
 *  client tone, everything else the muted plain pill. */
export function roleBadgeClass(role: PluginRowRoleShape): string {
  switch (role) {
    case 'composition': return css.pluginKindBundle
    case 'seed': return css.pluginKindClient
    default: return css.pluginKindPlain
  }
}

/** Whether a row has a checkbox (the four actionable kinds). */
export function isActionable(kind: PluginRowKind): boolean {
  return isDifferenceRow(kind)
}

/** Chamber badge tone → the shared .badge pill family (plan 24 B1.5 reuses
 *  the .badge vocabulary: ok = filled success, warn = outlined warn, danger =
 *  filled error, muted = plain pill). */
export function chamberBadgeClass(tone: ChamberBadgeTone): string {
  switch (tone) {
    case 'ok': return clsx(css.badge, css.badgeOk)
    case 'warn': return clsx(css.badge, css.badgeWarn)
    case 'danger': return clsx(css.badge, css.badgeBad)
    default: return css.badge
  }
}

/**
 * The ssh remote-side chamber badge now lives in plugin-inventory-text.ts
 * (sshChamberBadge) — the row derivation needs it, and that module is the
 * locale-free projection the plain-node suite covers.
 */

/** The dialog target descriptor the four card kinds build (plan 24 B1.1). */
