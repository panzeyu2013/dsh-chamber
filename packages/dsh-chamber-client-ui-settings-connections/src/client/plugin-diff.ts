/**
 * Plugin diff pure function (design 13 §6, derive style): local plugin
 * manifest projection + remote plugin manifest projection → the sync row set.
 *
 * This package only computes the view — it never executes, never reaches the
 * network, never re-implements `dsh plugin`. The main process is the only
 * authority for install/remove/restart; here we classify each local spec into
 * a syncable shape and compare against the remote dependencies.
 *
 * Row categories (§5.3):
 *   missing      local has, remote lacks (registry spec, default-checked)
 *   update       both have but spec strings differ (registry rows only)
 *   extra        remote has, local lacks (the "remove" row, default-unchecked)
 *   materialize  local file:/link:/relative/absolute path → pack & transfer
 *   unsyncable   workspace:/git+/URL/range/alias → grayed, never passed
 *   consistent   both sides agree (registry spec equal, or materialized)
 *
 * The materialize rule is deliberately name-based, NOT string-based: a local
 * `file:../p` and a remote `file:/home/.../p.tgz` necessarily differ as
 * strings but are the same plugin once chamber materialized it (§4.5) — so a
 * local file: dep whose name is already a file: dep on the remote is judged
 * "materialized/consistent", never a phantom update.
 */

import { hasXWildcard, isMaterializedValue } from '@dsh-chamber/dsh-chamber-client-core/plugin-manifest'
import type { LocalPluginManifest, RemotePluginManifest } from '../global.d.ts'

// The dependency-value grammars are THE single definition in the neutral wire
// package (design 21 §3 readManifest / §6.2 掩码纪律), reached through
// client-core's browser face because this package's dependency list is frozen
// for this batch. Re-exported so this module's public surface is unchanged.
export { hasXWildcard }

/** Sync row kind (the actionable four + unsyncable + consistent). */
export type PluginRowKind = 'missing' | 'update' | 'extra' | 'materialize' | 'unsyncable' | 'consistent'

/** Display category: active bundle layer / client plugin / plain dependency. */
export type PluginCategory = 'bundle' | 'client' | 'plain'

/** One diff row (a single package). */
export interface PluginRow {
  name: string
  kind: PluginRowKind
  category: PluginCategory
  /** Local spec string; null for remote-only (extra) rows. */
  localSpec: string | null
  /** Remote spec string; null when the remote lacks the name. */
  remoteSpec: string | null
  /** Local spec is a bare name (no version) → "install latest" hint. */
  unlocked: boolean
  /** Classification reason for unsyncable rows; null otherwise. */
  reason: string | null
}

/** The full diff: the combined, ordered row set. Every row carries its own
 *  `kind` (§5.3), so a per-kind view is a filter over `rows`; pre-filtered
 *  arrays would be write-only and cost one extra full scan + allocation per
 *  kind. */
export interface PluginDiff {
  rows: PluginRow[]
}

/** A safe registry version spec (§7.2): a pinned range (`^1.2.3`, `~1.2.3`,
 *  `1.2.3`, `1.2.3-beta.1`) or a floating tag (`latest`, `next`) — no
 *  `:`/`<`/`>`/`*`/`||`/space/comma. The dependency NAME is the map key; this
 *  matches only the VALUE. */
const REGISTRY_SPEC = /^[~^]?[0-9A-Za-z][0-9A-Za-z._+-]*$/

/** A pinned version (starts with an optional ^/~ then a digit, tolerating a
 *  `v` prefix: `1.2.3` / `^1.2.3` / `~1.2.3` / `v1.2.3` / `^v1.2.3` / `~v1.2.3`). */
const PINNED = /^[~^]?v?\d/

// Local-path classification = the shared mask ruler `isMaterializedValue`
// (wire): file:/link:, relative (./ ../ — including bare . / .. and backslash
// separators), absolute (/ \\ C:\) and home-relative (~ ~/x ~\x) values all
// name a machine-local path. A bare `.foo` is NOT a path, and a bare `~1.2.3`
// is a tilde RANGE, not a home path — both stay unsyncable. The rule is
// deliberately the WIDER shared ruler (design 21 decision 18): the desktop
// main converges onto the same function in R6 phase 2, so the UI can never
// offer a materialize row for a value the backend masks/classifies differently.

/** Human-readable reason for a refused spec (§7.2). */
function unsyncableReason(spec: string): string {
  if (spec.startsWith('workspace:')) return 'workspace protocol'
  if (/^(git|git\+|git\+ssh|git\+https?|github:)/.test(spec) || /^[a-z][a-z0-9+.-]*:\/\//.test(spec)) return 'git/URL dependency'
  if (spec.startsWith('npm:')) return 'alias spec'
  if (/[<>*|]|\s|,/.test(spec)) return 'version range / wildcard'
  return 'unsupported spec'
}

type SpecClass =
  | { type: 'registry'; unlocked: boolean }
  | { type: 'materialize' }
  | { type: 'unsyncable'; reason: string }

/** Classify a dependency spec VALUE into syncable / materialize / refused. */
export function classifySpec(spec: string): SpecClass {
  if (isMaterializedValue(spec)) return { type: 'materialize' }
  if (REGISTRY_SPEC.test(spec)) {
    if (hasXWildcard(spec)) {
      return { type: 'unsyncable', reason: 'x-wildcard version is a range, not a locked version (use an exact version)' }
    }
    return { type: 'registry', unlocked: !PINNED.test(spec) }
  }
  return { type: 'unsyncable', reason: unsyncableReason(spec) }
}

/** Local-row display category: active bundle → client → plain. */
function localCategory(name: string, local: LocalPluginManifest): PluginCategory {
  if (local.bundles.includes(name)) return 'bundle'
  if (local.clientLines.includes(name)) return 'client'
  return 'plain'
}

/** Remote-row display category: the active bundle layer is the only remote
 *  signal (client classification is local-only, §4.4). */
function remoteCategory(name: string, remote: RemotePluginManifest): PluginCategory {
  return remote.bundles.includes(name) ? 'bundle' : 'plain'
}

const KIND_ORDER: Record<PluginRowKind, number> = {
  missing: 0,
  update: 1,
  materialize: 2,
  extra: 3,
  unsyncable: 4,
  consistent: 5,
}

function compareRows(a: PluginRow, b: PluginRow): number {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  return byKind !== 0 ? byKind : a.name.localeCompare(b.name)
}

/**
 * Compute the plugin sync diff.
 * @param local - local manifest projection.
 * @param remote - remote manifest projection.
 * @returns categorized rows + the combined ordered list.
 */
export function computePluginDiff(local: LocalPluginManifest, remote: RemotePluginManifest): PluginDiff {
  const rows: PluginRow[] = []

  for (const [name, localSpec] of Object.entries(local.dependencies)) {
    const cls = classifySpec(localSpec)
    const category = localCategory(name, local)
    const remoteSpec = remote.dependencies[name]

    if (cls.type === 'unsyncable') {
      rows.push({
        name, kind: 'unsyncable', category, localSpec, remoteSpec: remoteSpec ?? null,
        unlocked: false, reason: cls.reason,
      })
      continue
    }

    if (cls.type === 'materialize') {
      // Name-based match: remote already holds a local-path spec for this name
      // (every masking backend projects the shared mask, which keeps a `file:`
      // prefix) → done.
      const materialized = remoteSpec !== undefined && isMaterializedValue(remoteSpec)
      rows.push({
        name,
        kind: materialized ? 'consistent' : 'materialize',
        category,
        localSpec,
        remoteSpec: remoteSpec ?? null,
        unlocked: false,
        reason: null,
      })
      continue
    }

    // Registry spec.
    if (remoteSpec === undefined) {
      rows.push({
        name, kind: 'missing', category, localSpec, remoteSpec: null,
        unlocked: cls.unlocked, reason: null,
      })
    } else if (remoteSpec === localSpec) {
      rows.push({
        name, kind: 'consistent', category, localSpec, remoteSpec,
        unlocked: cls.unlocked, reason: null,
      })
    } else {
      rows.push({
        name, kind: 'update', category, localSpec, remoteSpec,
        unlocked: cls.unlocked, reason: null,
      })
    }
  }

  for (const [name, remoteSpec] of Object.entries(remote.dependencies)) {
    if (name in local.dependencies) continue
    rows.push({
      name, kind: 'extra', category: remoteCategory(name, remote), localSpec: null, remoteSpec,
      unlocked: false, reason: null,
    })
  }

  rows.sort(compareRows)

  return { rows }
}

/** Whether a row participates in a diff (i.e. shown under the default
 *  "differences only" filter). */
export function isDifferenceRow(kind: PluginRowKind): boolean {
  return kind === 'missing' || kind === 'update' || kind === 'extra' || kind === 'materialize'
}

/** Default checkbox state for an actionable row (§5.3): remove (extra) is
 *  unchecked; everything else the user can act on is checked. */
export function defaultChecked(kind: PluginRowKind): boolean {
  return kind === 'missing' || kind === 'update' || kind === 'materialize'
}

/** The `add` argument for one checked REGISTRY row (missing/update): pass
 *  name@spec to pin the local version; a bare-name spec passes just the name
 *  (install latest). Materialize rows never reach this — the renderer sends
 *  only the dependency name and MAIN resolves its authoritative path (§4.6). */
export function rowAddArg(row: PluginRow): string {
  if (row.unlocked || row.localSpec === null) return row.name
  return `${row.name}@${row.localSpec}`
}
