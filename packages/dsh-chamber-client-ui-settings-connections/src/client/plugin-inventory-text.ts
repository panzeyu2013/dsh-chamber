/**
 * Plugin-inventory display helpers: pure, UI-free projections for PluginDialog's
 * inventory-backed zones, mirroring the SSH plugin row semantics (plugin-diff.ts
 * split). Kept free of .tsx so the plain-node test suite covers the projections.
 */

import type { SettingsConnectionsKey } from '../locales.ts'
import type { PluginFiberPhase, PluginInventorySnapshot } from './plugin-inventory-api.ts'

/** The chamber-injected host package names: the registry-derived expected rows the
 *  plugin view surfaces. CLIENT-side mirror of the control-plane registry
 *  (host-graph-seed.ts CHAMBER_HOST_PACKAGES) — a client package cannot import the
 *  Node-side module, so the drift test pins the NAME SET against the registry source
 *  text (a new registry row must fail there, never be silently ignored). */
export const HOST_GRAPH_PACKAGE = '@dsh-chamber/dsh-chamber-seed-client-graph'
export const GIT_WORKTREE_PACKAGE = '@dsh-chamber/dsh-chamber-seed-git-worktree'
/** Archived-session cleanup host domain. */
export const ARCHIVE_CLEANUP_PACKAGE = '@dsh-chamber/dsh-chamber-seed-archive-cleanup'
/** Open-in host domain — the fork of upstream's open-in host half. It is
 *  `localOnly` in the registry: it exists for the local instance shape alone, so every
 *  non-local target's chamber table omits its row outright — never a "not injected"
 *  claim for a package that can never be seeded there. */
export const OPEN_IN_PACKAGE = '@dsh-chamber/dsh-chamber-seed-open-in'

/** The gateway-packaged mobile client entry (the single packaged exception —
 *  mobile access is bound to the gateway and has no desktop in the chain). */
export const MOBILE_PACKAGE = '@dsh-chamber/dsh-client-ui-mobile'

/** Official (built-in) package scope: never a third-party row. */
const OFFICIAL_SCOPE = '@deepseek-ai/'

/** Raw cordis patch-insert syntax prefix: the gateway's cordis.patch.yml insert
 *  rows are reported by the host inventory under this prefix. Stripped before classification. */
const CORDIS_INCLUDE_PREFIX = 'cordis:include '

/** One inventory entry's package class. `chamber-client` = a chamber CLIENT plugin
 *  that is not the packaged mobile entry: still a chamber row, with no dedicated copy. */
export type InventoryEntryKind =
  | 'chamber-host-graph'
  | 'chamber-git-worktree'
  | 'chamber-archive-cleanup'
  | 'chamber-open-in'
  | 'chamber-mobile'
  | 'chamber-client'
  | 'official'
  | 'third-party'

/** Strip the raw patch-insert syntax the gateway's cordis.patch.yml rows are reported under. */
function stripCordisInclude(moduleName: string): string {
  return moduleName.startsWith(CORDIS_INCLUDE_PREFIX)
    ? moduleName.slice(CORDIS_INCLUDE_PREFIX.length)
    : moduleName
}

/** Chamber CLIENT plugin scope: classification is scope-based — never a literal
 *  list — so a future chamber client plugin is a chamber row automatically. */
const CHAMBER_CLIENT_PREFIX = '@dsh-chamber/dsh-client-ui-'

/** Classification of a chamber CLIENT plugin: 'chamber-mobile' is the packaged
 *  gateway exception (dedicated localized copy), 'chamber-client' any other. */
export type ChamberClientKind = 'chamber-mobile' | 'chamber-client'

/** Classify a module specifier as a chamber CLIENT plugin (patch-insert prefix
 *  stripped first) — the single source of truth for "is this a chamber client row". */
export function classifyChamberClientPlugin(moduleName: string): ChamberClientKind | null {
  const name = stripCordisInclude(moduleName)
  if (!name.startsWith(CHAMBER_CLIENT_PREFIX)) return null
  return name === MOBILE_PACKAGE ? 'chamber-mobile' : 'chamber-client'
}

/**
 * Classify one inventory entry's module specifier: patch-insert prefix stripped first,
 * then the plain name decides — chamber host package, chamber client plugin, official
 * `@deepseek-ai/*` scope, or third-party.
 */
export function classifyInventoryEntry(moduleName: string): InventoryEntryKind {
  const name = stripCordisInclude(moduleName)
  const clientKind = classifyChamberClientPlugin(name)
  if (clientKind !== null) return clientKind
  if (name === HOST_GRAPH_PACKAGE) return 'chamber-host-graph'
  if (name === GIT_WORKTREE_PACKAGE) return 'chamber-git-worktree'
  if (name === ARCHIVE_CLEANUP_PACKAGE) return 'chamber-archive-cleanup'
  if (name === OPEN_IN_PACKAGE) return 'chamber-open-in'
  if (name.startsWith(OFFICIAL_SCOPE)) return 'official'
  return 'third-party'
}

/**
 * Third-party projection: loaded entries that classify as neither official
 * (`@deepseek-ai/*`) nor any chamber row (registry host packages, chamber client
 * plugins, or any name in `expectedChamberNames`).
 * `expectedChamberNames` is the REGISTRY-DERIVED expected list of the current view: the
 * literal constants only know four names, so the caller's list is what keeps a future
 * registry package from leaking into this zone. Defaults to [] for the pure tests.
 */
export function thirdPartyEntries(
  snapshot: Pick<PluginInventorySnapshot, 'entries'>,
  expectedChamberNames: readonly string[] = [],
): PluginInventorySnapshot['entries'] {
  const chamberNames = new Set(expectedChamberNames)
  return snapshot.entries.filter(entry => {
    const name = stripCordisInclude(entry.moduleName)
    if (chamberNames.has(name)) return false
    return classifyInventoryEntry(entry.moduleName) === 'third-party'
  })
}

/** Map a chamber package name to its inventory-entry kind: the reverse of
 *  classifyInventoryEntry, derived FROM it. Its 'official'/'third-party' answers are
 *  folded together so the caller's exact-name fallback keys on one non-chamber answer. */
function chamberKindOf(packageName: string): InventoryEntryKind {
  const kind = classifyInventoryEntry(packageName)
  return kind === 'official' || kind === 'third-party' ? 'third-party' : kind
}

/** The ONE Loader-liveness fact for one snapshot entry (no presentation). */
export type LoaderLivenessFact = 'absent' | 'disabled' | 'active' | 'failed' | 'starting'

/**
 * Classify one Loader entry by the actual load outcome — presence, enablement and
 * root-fiber phase only, never a constant claim; every projection reads THIS function.
 * @returns absent / disabled / active / failed / starting.
 */
export function entryLiveness(
  entry: { enabled: boolean; fiberPhase: PluginFiberPhase } | undefined,
): LoaderLivenessFact {
  if (entry === undefined) return 'absent'
  if (!entry.enabled) return 'disabled'
  if (entry.fiberPhase === 'active') return 'active'
  if (entry.fiberPhase === 'failed') return 'failed'
  return 'starting'
}

export function chamberRemoteKey(
  entries: readonly { moduleName: string; enabled: boolean; fiberPhase: PluginFiberPhase }[],
  packageName: string,
): SettingsConnectionsKey {
  // Classification-aware match: gateway patch-insert rows (the mobile entry) are
  // reported under the raw 'cordis:include <name>' prefix; non-chamber names keep exact-name equality.
  const kind = chamberKindOf(packageName)
  const entry = kind === 'third-party'
    ? entries.find(candidate => candidate.moduleName === packageName)
    : entries.find(candidate => classifyInventoryEntry(candidate.moduleName) === kind)
  switch (entryLiveness(entry)) {
    case 'absent': return 'chamberRemoteNotInjected'
    case 'active': return 'chamberRemoteLive'
    case 'failed': return 'chamberRemoteFailed'
    // disabled / starting: presence is a fact, effectiveness is not.
    default: return 'chamberRemoteInjectedUnknown'
  }
}

/* ---- Third-party row live state (Loader-derived) ----
 * The installed-row lists render each third-party row's live state from the managed
 * instance's Loader snapshot — the profile manifest alone can never claim liveness.
 * Chamber rows never reach this projection (their badges are remoteChamberBadge). */

/** One third-party row's live-state chip: a localized label plus the shared badge tone vocabulary. */
export interface ThirdPartyLiveState {
  labelKey: SettingsConnectionsKey
  tone: ChamberBadgeTone
}

/**
 * Live-state for one INSTALLED row: a protected composition/seed row is part of the
 * installation baseline (a host-side boot layer), never a Loader client entry — asking
 * for one would paint a false "restart to take effect" warning on an active row. Such
 * rows reach this list only when the profile declares them as dependencies.
 * @param snapshot - Loader snapshot; null (read failed / not reachable) → null, never a state claim.
 */
export function installedRowLiveState(
  snapshot: Pick<PluginInventorySnapshot, 'entries'> | null,
  row: { name: string; protected: boolean; role: string },
): ThirdPartyLiveState | null {
  if (row.protected || row.role === 'composition' || row.role === 'seed') return null
  return thirdPartyLiveState(snapshot, row.name)
}

/**
 * Live state of one installed package, derived from the managed instance's Loader
 * snapshot (exact-name match — a profile dependency that mounts as a Loader entry keeps
 * the package name as its module name). Each state stays under its honesty ceiling, a
 * live claim only from an enabled + active fiber: no entry → null (neutral cell);
 * disabled → 已停用; enabled + active → 生效中; failed → 加载失败; any other phase → 加载中.
 * A missing entry is neutral for EVERY row, a `dsh.profile.bundles` layer included: the
 * layer mounts the rows its patch inserts, never an entry named after the bundle, so a
 * "no entry + bundle layer → 重启后生效" branch would fire for every bundle layer of an
 * already-restarted instance. The bundle's insert names live only in its cordis.patch.yml,
 * which no renderer fact carries — until a host fact supplies them, neutral is the ceiling.
 */
export function thirdPartyLiveState(
  snapshot: Pick<PluginInventorySnapshot, 'entries'> | null,
  packageName: string,
): ThirdPartyLiveState | null {
  if (snapshot === null) return null
  const entry = snapshot.entries.find(candidate => candidate.moduleName === packageName)
  switch (entryLiveness(entry)) {
    case 'absent': return null
    case 'disabled': return { labelKey: 'pluginDisabled', tone: 'muted' }
    case 'active': return { labelKey: 'thirdPartyLiveActive', tone: 'ok' }
    // The failed-load label is the shared badge copy; the tone carries the danger color.
    case 'failed': return { labelKey: 'chamberBadgeFailed', tone: 'danger' }
    default: return { labelKey: 'thirdPartyLiveStarting', tone: 'muted' }
  }
}

/* ---- Chamber row badges (short label + tone the renderer colors) ---- */

/** Tone of one chamber row badge: 'ok' = injected and effective, 'muted' = absent /
 *  not proven live / unknown, 'warn' = degraded, 'danger' = load failure. */
export type ChamberBadgeTone = 'ok' | 'muted' | 'warn' | 'danger'

/** One chamber row badge: a localized label plus its tone. */
export interface ChamberBadge {
  labelKey: SettingsConnectionsKey
  tone: ChamberBadgeTone
}

/**
 * Local-side badge for one chamber package: the desktop's own profile manifest truth.
 * `injected` = boot row installed and patched (the strongest local claim; no separate
 * live probe exists). null = unknown: still loading (muted), or the local manifest was
 * unreadable (`failed` → 'warn', never a silent "not injected").
 */
export function localChamberBadge(injected: boolean | null, failed: boolean): ChamberBadge {
  if (injected === true) return { labelKey: 'chamberBadgeInjected', tone: 'ok' }
  if (injected === false) return { labelKey: 'chamberBadgeNotInjected', tone: 'muted' }
  return failed
    ? { labelKey: 'chamberBadgeUnknown', tone: 'warn' }
    : { labelKey: 'chamberBadgeUnknown', tone: 'muted' }
}

/**
 * Remote-side badge for one chamber package, reusing chamberRemoteKey's live-Loader
 * semantics: present + enabled + active = live (ok); failed = danger; absent = not
 * injected; anything else claims presence only (muted, never a live claim).
 */
export function remoteChamberBadge(
  entries: readonly { moduleName: string; enabled: boolean; fiberPhase: PluginFiberPhase }[],
  packageName: string,
): ChamberBadge {
  switch (chamberRemoteKey(entries, packageName)) {
    case 'chamberRemoteLive':
      return { labelKey: 'chamberBadgeLive', tone: 'ok' }
    case 'chamberRemoteFailed':
      return { labelKey: 'chamberBadgeFailed', tone: 'danger' }
    case 'chamberRemoteNotInjected':
      return { labelKey: 'chamberBadgeNotInjected', tone: 'muted' }
    default:
      // chamberRemoteInjectedUnknown: presence is a fact, effectiveness is not.
      return { labelKey: 'chamberBadgeInjected', tone: 'muted' }
  }
}

/* ---- Gateway chamber seed-cache drift (A0 read side) ----
 * The manual chamber sync reads the desktop's own local chamber versions (the versions
 * it would upload) against the gateway's seed cache; the comparison below is the pure
 * drift the view renders and the「立即同步」action resolves. */

/** Per-package local ↔ gateway-cache comparison state. */
export type ChamberSeedDriftState = 'drift' | 'match' | 'absent-cache' | 'absent-local'

/** One package's state: a cache missing the package/version dominates ('absent-cache');
 *  an unknown LOCAL version next to a cached package is 'absent-local' (never a mismatch
 *  claim); only both-known inequality is a real drift. */
function chamberSeedState(localVersion: string | null, cachedVersion: string | null): ChamberSeedDriftState {
  if (cachedVersion === null) return 'absent-cache'
  if (localVersion === null) return 'absent-local'
  return localVersion === cachedVersion ? 'match' : 'drift'
}

/** Compare the local chamber versions against the gateway seed cache (keyed by package
 *  name). Cache entries the map does not name count as absent-cache; unknown names are ignored. */
export function chamberSeedDrift(
  local: readonly { readonly name: string; readonly version: string | null }[],
  cached: Record<string, string | null>,
): Record<string, ChamberSeedDriftState> {
  return Object.fromEntries(
    local.map(pkg => [pkg.name, chamberSeedState(pkg.version, cached[pkg.name] ?? null)]),
  )
}

/* ---- Chamber table row derivation ----
 * The table's rows are DERIVED here, never assembled inline in the component: the
 * derivation encodes the per-target data-source matrix (which read feeds the expected
 * list, the local column and the version column). Locale-free: rows carry label KEYS and
 * version STRINGS, never JSX or localized text. */

/** The plugin dialog's four backends (plan 24 B1.1). */
export type ChamberTarget = 'local' | 'ssh' | 'gateway' | 'http'

/** One derived chamber table row. */
export interface ChamberRowDescriptor {
  /** Stable React key: the registry insert id, or the derived client row's package name. */
  readonly key: string
  /** Package name; null ONLY for the inventory-unavailable client row — an unknown state never renders a hardcoded name. */
  readonly name: string | null
  /** Name-cell label key rendered in front of the package name (derived client rows only). */
  readonly nameLabelKey: SettingsConnectionsKey | null
  readonly localBadge: ChamberBadge | null
  readonly remoteBadge: ChamberBadge | null
  /** Local-side version text (`v1.2.3`); null = unknown (the view renders —). */
  readonly versionText: string | null
  /** Version-cell hint key for a derived client row (no version applies). */
  readonly versionHintKey: SettingsConnectionsKey | null
  /** Gateway arm: the seed-cache version text, null = not cached or cache never read. */
  readonly cacheVersionText: string | null
  /** Gateway arm: the cache was read AND lacks this package (render 未同步). */
  readonly cacheNotSynced: boolean
  /** Gateway arm: the cache was read and holds NONE of the expected packages — suppresses
   *  every per-row 未同步 marker. Never true for an EMPTY expected list. */
  readonly cacheAbsent: boolean
  /** Gateway arm: this package's local ↔ cache comparison (null = not read). */
  readonly driftState: ChamberSeedDriftState | null
}

/** One chamber host package's state as the desktop projects it (structural SUBSET of
 *  global.d.ts ChamberHostPackageState, kept importable by the plain-node suite). */
export interface ChamberPackageState {
  readonly insertId: string
  readonly name: string
  readonly installed: boolean
  readonly patched: boolean
  readonly version: string | null
  readonly live: boolean | null
  /** The registry row is meaningful for the LOCAL instance shape only. The ssh PROBE
   *  reports it as installed:false/patched:false without ever asking the remote ("not
   *  asked", never "the target lacks it"), so every non-local table omits it rather than
   *  rendering "not injected". */
  readonly localOnly?: boolean
}

/** The ssh remote probe result (design 13 §6), structurally. */
export type ChamberProbeState =
  | { readonly ok: true; readonly packages: readonly ChamberPackageState[] }
  | { readonly ok: false; readonly error: string }

/** One Loader inventory entry (the subset the derivation reads). */
export interface ChamberInventoryEntry {
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/**
 * The ssh remote-side chamber badge: the probed tri-state mapped onto the shared badge
 * vocabulary — present + enabled + live = 已生效; present but not proven live = 已注入
 * (muted); present without the boot layer = 已注入 (warn); absent = 未注入; failure = 未知.
 * Never a live claim from a file probe.
 */
export function sshChamberBadge(state: ChamberPackageState | null | undefined): ChamberBadge {
  if (state === undefined) return { labelKey: 'chamberBadgeUnknown', tone: 'muted' }
  if (state === null) return { labelKey: 'chamberBadgeUnknown', tone: 'warn' }
  if (state.installed && state.patched) {
    if (state.live === true) return { labelKey: 'chamberBadgeLive', tone: 'ok' }
    return { labelKey: 'chamberBadgeInjected', tone: 'muted' }
  }
  if (state.installed) return { labelKey: 'chamberBadgeInjected', tone: 'warn' }
  return { labelKey: 'chamberBadgeNotInjected', tone: 'muted' }
}

/** A Loader entry's own badge: present + enabled + active = live; failed = danger; anything else claims presence only. */
function chamberEntryBadge(entry: ChamberInventoryEntry): ChamberBadge {
  if (!entry.enabled) return { labelKey: 'chamberBadgeInjected', tone: 'muted' }
  if (entry.fiberPhase === 'active') return { labelKey: 'chamberBadgeLive', tone: 'ok' }
  if (entry.fiberPhase === 'failed') return { labelKey: 'chamberBadgeFailed', tone: 'danger' }
  return { labelKey: 'chamberBadgeInjected', tone: 'muted' }
}

/** The localized copy of a derived client row, keyed by classification: only the
 *  packaged mobile entry has dedicated keys; any other renders its package name. */
function chamberClientCopy(kind: ChamberClientKind): {
  labelKey: SettingsConnectionsKey | null
  hintKey: SettingsConnectionsKey | null
} {
  return kind === 'chamber-mobile'
    ? { labelKey: 'chamberMobileRow', hintKey: 'chamberMobileHint' }
    : { labelKey: null, hintKey: null }
}

/**
 * Gateway client-plugin rows, derived from the Loader inventory: every entry whose
 * moduleName classifies as a chamber CLIENT plugin, deduplicated by package name.
 * Never a hardcoded package name. Two honest fallbacks keep the row present:
 *  - inventory UNAVAILABLE (null) → ONE unknown-state row;
 *  - inventory readable but no chamber-client entry → ONE muted 未注入 row (rendering
 *    nothing would let a dropped/disabled client package look like "no such row exists").
 */
function chamberClientRows(entries: readonly ChamberInventoryEntry[] | null): ChamberRowDescriptor[] {
  if (entries === null) {
    return [{
      key: 'chamber-client-unknown',
      name: null,
      nameLabelKey: 'chamberMobileRow',
      localBadge: null,
      remoteBadge: { labelKey: 'chamberBadgeUnknown', tone: 'muted' },
      versionText: null,
      versionHintKey: 'chamberMobileHint',
      cacheVersionText: null,
      cacheNotSynced: false,
      cacheAbsent: false,
      driftState: null,
    }]
  }
  const seen = new Set<string>()
  const rows: ChamberRowDescriptor[] = []
  for (const entry of entries) {
    const kind = classifyChamberClientPlugin(entry.moduleName)
    if (kind === null) continue
    const name = stripCordisInclude(entry.moduleName)
    if (seen.has(name)) continue
    seen.add(name)
    const copy = chamberClientCopy(kind)
    rows.push({
      key: `chamber-client:${name}`,
      name,
      nameLabelKey: copy.labelKey,
      localBadge: null,
      remoteBadge: chamberEntryBadge(entry),
      versionText: null,
      versionHintKey: copy.hintKey,
      cacheVersionText: null,
      cacheNotSynced: false,
      cacheAbsent: false,
      driftState: null,
    })
  }
  if (rows.length === 0) {
    return [{
      key: 'chamber-client-absent',
      name: null,
      nameLabelKey: 'chamberMobileRow',
      localBadge: null,
      remoteBadge: { labelKey: 'chamberBadgeNotInjected', tone: 'muted' },
      versionText: null,
      versionHintKey: 'chamberMobileHint',
      cacheVersionText: null,
      cacheNotSynced: false,
      cacheAbsent: false,
      driftState: null,
    }]
  }
  return rows
}

/**
 * The registry rows that APPLY to one target shape: a `localOnly` row exists for the
 * local instance alone, so a remote/gateway/http table does not list it at all. DROP, not
 * badge: a row that can never exist there is not a state. The filter reads the REGISTRY
 * flag, never observed state — a not-yet-seeded target must still list its missing rows
 * (that 未注入 row justifies the sync action). Generic over the row shape: the rule needs
 * nothing but the `localOnly` flag.
 * @returns the same list for the local target, else the non-`localOnly` rows in input order.
 */
export function applicableChamberPackages<T extends { readonly localOnly?: boolean }>(
  target: ChamberTarget,
  packages: readonly T[],
): readonly T[] {
  return target === 'local' ? packages : packages.filter(pkg => pkg.localOnly !== true)
}

/** The two ssh target-level gates from the remote probe. The pair is a partition: a
 *  target either needs a seed or it is fully injected (some rows possibly not live). */
export interface ChamberProbeGates {
  /** At least one APPLICABLE registry row is not fully injected (or the probe could not be read) — the 「注入」 action's justification. */
  readonly needsSeed: boolean
  /** Every applicable row IS injected and at least one is not live yet — the
   *  restart-to-apply state. Never true together with `needsSeed`: a half-injected target
   *  asks for a seed (restarting alone cannot add a missing row). */
  readonly injectedNotLive: boolean
}

/**
 * Derive the two ssh gates from the remote probe in ONE place. Both are target-level
 * decisions over exactly the rows the table lists: a `localOnly` row is not part of a
 * remote contract, and the probe reports it as a synthesized installed:false without
 * asking the remote — folding it in would pin `needsSeed` true forever and make the
 * restart branch unreachable. null/undefined = the probe has not answered (both gates
 * false); ok:false is an ANSWERED but unreadable probe — a re-seed may repair it, so that
 * arm asks for the seed, never a pending restart.
 * @returns the two gate booleans — never a claim beyond the probe's own.
 */
export function sshChamberGates(probe: ChamberProbeState | null | undefined): ChamberProbeGates {
  if (probe === null || probe === undefined) return { needsSeed: false, injectedNotLive: false }
  if (probe.ok !== true) return { needsSeed: true, injectedNotLive: false }
  const applicable = applicableChamberPackages('ssh', probe.packages)
  const needsSeed = applicable.some(pkg => !(pkg.installed && pkg.patched))
  return {
    needsSeed,
    // Strict on purpose: the restart hint owns only the state where nothing is missing.
    injectedNotLive: !needsSeed && applicable.some(pkg => pkg.installed && pkg.patched && pkg.live === false),
  }
}

/** The full input matrix of the chamber table (see deriveChamberRows). */
export interface ChamberRowsInput {
  readonly target: ChamberTarget
  /** The TARGET's own expected registry list (LOCAL: its own profile manifest;
   *  ssh/gateway/http: the desktop's projection). null = unreadable / not loaded yet. */
  readonly expected: readonly ChamberPackageState[] | null
  /** The DESKTOP's local manifest projection — the LOCAL side column of a remote target. null = unreadable / not loaded yet. */
  readonly localManifestChamber: readonly ChamberPackageState[] | null
  /** The ssh remote probe (design 13 §6); null for other targets. */
  readonly remoteChamber: ChamberProbeState | null
  /** The managed instance's Loader inventory (remote badge + gateway client rows). null = not read yet / read failed. */
  readonly inventory: { readonly entries: readonly ChamberInventoryEntry[] } | null
  /** The gateway seed cache: package name → version | null. null = never read. */
  readonly seedCache: Record<string, string | null> | null
  /** The LOCAL manifest read failed (a degradation → warn, never a silent "not injected"). */
  readonly localSideFailed: boolean
}

/**
 * Derive the chamber table's rows for one target. Data sources (the matrix this function
 * exists to pin): expected list — ssh prefers the remote probe's own list when it
 * succeeded, otherwise the caller's (a remote-only read failure must stay visible);
 * LOCAL column — the local target reads ITS OWN profile manifest, remote targets the
 * desktop projection; version — ssh reads the probe's, everything else the local list's
 * (gateway additionally renders the seed-cache comparison). A `localOnly` registry row is
 * DROPPED on non-local targets before any state is derived; an EMPTY expected list yields
 * no rows and can never claim a seed-cache state.
 * @returns the registry rows plus, for the gateway, the inventory-derived client rows.
 */
export function deriveChamberRows(input: ChamberRowsInput): ChamberRowDescriptor[] {
  const { target, expected, localManifestChamber, remoteChamber, inventory, seedCache, localSideFailed } = input
  const isLocal = target === 'local'
  const isSsh = target === 'ssh'
  const isGateway = target === 'gateway'
  const remoteExpected = isSsh && remoteChamber?.ok === true ? remoteChamber.packages : null
  // Applicability filter FIRST, so neither the row set nor any target-level state below
  // can be influenced by a row that does not apply (the probe synthesizes installed:false without asking).
  const expectedList = applicableChamberPackages(target, remoteExpected ?? expected ?? [])
  // The LOCAL column of a remote target reads the desktop's projection through the same filter; null = unreadable.
  const localList = isLocal
    ? expectedList
    : localManifestChamber === null
      ? null
      : applicableChamberPackages(target, localManifestChamber)
  const localByName = new Map((localList ?? []).map(pkg => [pkg.name, pkg]))
  const remoteByName = new Map((remoteExpected ?? []).map(pkg => [pkg.name, pkg]))
  const entries = inventory === null ? null : inventory.entries
  // A KNOWN, non-empty expected set is a precondition: an unreadable manifest must never
  // claim "the gateway has nothing synced". Read over the APPLICABLE rows — a local-only
  // row is never cached, so a stray cache entry for one must not suppress this claim.
  const cacheAbsent = isGateway && seedCache !== null && expectedList.length > 0
    && expectedList.every(pkg => (seedCache[pkg.name] ?? null) === null)
  const driftStates = isGateway && seedCache !== null && localList !== null
    ? chamberSeedDrift(localList, seedCache)
    : null
  const unknownBadge: ChamberBadge = { labelKey: 'chamberBadgeUnknown', tone: 'muted' }
  const versionTextOf = (version: string | null): string | null => version === null ? null : `v${version}`

  const rows = expectedList.map((pkg): ChamberRowDescriptor => {
    const local = localByName.get(pkg.name)
    const remote = remoteByName.get(pkg.name)
    const cached = seedCache === null ? null : (seedCache[pkg.name] ?? null)
    return {
      key: pkg.insertId,
      name: pkg.name,
      nameLabelKey: null,
      localBadge: isLocal
        ? localChamberBadge(pkg.installed && pkg.patched, false)
        : localChamberBadge(local === undefined ? null : local.installed && local.patched, localSideFailed),
      remoteBadge: isSsh
        ? sshChamberBadge(remote ?? null)
        : isGateway || target === 'http'
          ? (entries === null ? unknownBadge : remoteChamberBadge(entries, pkg.name))
          : null,
      versionText: versionTextOf(isSsh ? (remote?.version ?? null) : (local?.version ?? null)),
      versionHintKey: null,
      cacheVersionText: isGateway ? versionTextOf(cached) : null,
      cacheNotSynced: isGateway && seedCache !== null && cached === null && !cacheAbsent,
      cacheAbsent,
      driftState: isGateway ? (driftStates?.[pkg.name] ?? null) : null,
    }
  })
  if (isGateway) rows.push(...chamberClientRows(entries))
  return rows
}
