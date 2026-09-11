/**
 * Settings-surface extension model (2026-12): the per-source plugin
 * contribution set derived from the source's OWN client plugin graph.
 *
 * WHY: the chamber settings shell renders the selected source's official
 * sections from a child cordis context, but that context used to mount a
 * hardcoded plugin subset — a plugin installed in the source's profile
 * contributed a `settings.section` on the source's own boot context and was
 * silently unrendered. The fix is to derive the contribution set from the
 * source's authoritative `clientGraph/graph` (design 09 §3.2 union table) and
 * mount every non-covered row into the child context, with an honest verdict
 * per plugin.
 *
 * This module holds the PURE part (row projection, namespace normalization,
 * fiber classification, seat attribution) so it is unit-testable in plain node
 * without a browser, a module table, or React; `bridge-context.ts` owns the
 * effectful assembly.
 */
import type { ClientPluginRow } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

/** cordis FiberState values (const enum, inlined at build). */
export const FIBER_PENDING = 0
export const FIBER_LOADING = 1
export const FIBER_ACTIVE = 2
export const FIBER_FAILED = 3

/**
 * The settings seats the chamber shell renders from a source's ledger. The
 * shell's own chrome replaces the official header/trigger/close/onboarding, so
 * contributions to those seats are reported instead of rendered (see
 * {@link OMITTED_SETTINGS_SEATS}).
 */
export const RENDERED_SETTINGS_SEATS: readonly string[] = [
  'settings.section',
  'settings.action',
]

/**
 * Seats the official SettingsRoot declares and renders but the chamber shell
 * deliberately does not (self-drawn chrome, no onboarding flow). A third-party
 * contribution here must never disappear silently — it is reported.
 */
export const OMITTED_SETTINGS_SEATS: readonly string[] = [
  'settings.trigger',
  'settings.header',
  'settings.close',
  'settings.onboarding',
]

/** Per-plugin contribution verdict (the honest answer to "why don't I see it?"). */
export type ContributionState = 'active' | 'inactive' | 'failed' | 'skipped'

export interface PluginContribution {
  /** Package id (== the graph row id == the fiber name we mount it under). */
  id: string
  state: ContributionState
  /** Required services that were never provided (inactive only). */
  missing?: readonly string[]
  /** Failure text (failed only). */
  error?: string
  /** Settings seats this plugin actually registered into. */
  seats?: readonly string[]
  /** Other sources whose child context already runs this page-level module instance. */
  sharedWith?: readonly string[]
  /**
   * Child-context capabilities this plugin asked for but the surface cannot
   * provide (2026-12): forwarded host events (`ctx.remote.$on`), a mounted
   * Remote contribution (`ctx.remote.$mount`) and a Remote stream
   * (`ctx.remote.$stream`) — the child context answers `$on` as a no-op and
   * the two channel members as named failures. A plugin relying on any of them
   * will not live-update (see {@link CAPABILITY_REMOTE_EVENTS} and friends).
   */
  capabilities?: readonly string[]
  /**
   * `contribution` (default) = a plugin installed in the source's profile;
   * `provider` = a chamber-covered package mounted ONLY to satisfy another
   * plugin's declared package dependency (optional closure expansion, 2026-12).
   * Provider outcomes are not reported as user-facing notices: the dependent
   * plugin's own `inactive` line already tells the honest story.
   */
  role?: 'contribution' | 'provider'
  /**
   * The page already runs another rev of this plugin id (first-load-wins):
   * `restart` = the same source rebuilt it (restart that instance to switch),
   * `version` = a DIFFERENT source claimed the id first (cross-instance dsh
   * runtime drift — align the runtimes). The section renders from the loaded
   * factory, but the fact is never hidden.
   */
  revConflict?: 'restart' | 'version'
}

/** The capability id for "subscribed to forwarded host events" (`remote.$on`). */
export const CAPABILITY_REMOTE_EVENTS = 'remote-events'

/** The capability id for "mounts a Remote contribution" (`remote.$mount`). */
export const CAPABILITY_REMOTE_MOUNT = 'remote-mount'

/** The capability id for "opens a Remote stream" (`remote.$stream`). */
export const CAPABILITY_REMOTE_STREAM = 'remote-stream'

/** Every capability this surface reports, in diagnostic display order. */
export const REMOTE_CAPABILITIES: readonly string[] = [
  CAPABILITY_REMOTE_EVENTS,
  CAPABILITY_REMOTE_MOUNT,
  CAPABILITY_REMOTE_STREAM,
]

/**
 * Why `remote.$mount` cannot work on this surface: the child context mounts a
 * fixed plugin set of its own and has no Typert client to mount a generated
 * Host-for-Client contribution against.
 */
export const REMOTE_MOUNT_UNAVAILABLE = 'settings panel has no remote mount channel: this panel mounts a fixed '
  + 'plugin set on its own child context, so a generated Remote contribution cannot be mounted here'

/**
 * Why `remote.$stream` cannot work on this surface: there is no WebSocket
 * carrier behind the settings panel, so no logical stream can be opened.
 */
export const REMOTE_STREAM_UNAVAILABLE = 'settings panel has no remote stream channel: this panel has no '
  + 'WebSocket carrier, so forwarded host events and live streams are unavailable here'

/**
 * Caller-attributed capability requests observed on the child context:
 * capability id → (plugin id → the keys it asked for). Built by the stub
 * remote's services, which are caller-bound, so each request is attributed to
 * the fiber that made it.
 */
export type RemoteCapabilityUse = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>

/**
 * Stamp each contribution with the capabilities its plugin actually used.
 * @param contributions - the phase's verdicts.
 * @param use - caller-attributed capability requests (see {@link RemoteCapabilityUse}).
 * @returns the same verdicts with `capabilities` filled in, in {@link REMOTE_CAPABILITIES} order.
 */
export function decorateContributions(
  contributions: readonly PluginContribution[],
  use: RemoteCapabilityUse,
): PluginContribution[] {
  return contributions.map((contribution) => {
    const used = REMOTE_CAPABILITIES.filter(capability =>
      (use.get(capability)?.get(contribution.id)?.size ?? 0) > 0)
    if (used.length === 0) return contribution
    const merged = new Set([...(contribution.capabilities ?? []), ...used])
    return { ...contribution, capabilities: [...merged].sort(
      (a, b) => REMOTE_CAPABILITIES.indexOf(a) - REMOTE_CAPABILITIES.indexOf(b)) }
  })
}

/**
 * One contribution the chamber shell cannot render. Two kinds share the row:
 * a third-party entry registered into a SLOT the shell does not render, and
 * (2026-12 review 4b) a root standard-source compartment member contributed on
 * the child context, which the bridge outlet cannot seat — `seat` is then
 * `root.hooks.<name>` / `root.keyedHooks.<name>` / `root.props.<name>`.
 */
export interface OmittedSeatContribution {
  seat: string
  pluginId: string
  /**
   * `slot` (default) = an entry in an unrendered slot;
   * `root-standard-source` = a member of the root read face the outlet cannot
   * seat. The two report through different diagnostics lines.
   */
  kind?: 'slot' | 'root-standard-source'
}

/** One contributor's root standard-source seats, as recorded by the child registry. */
export interface RootSeatRecord {
  /** Compartment-qualified seat keys, in `hooks`, `keyedHooks`, `props` order. */
  seats: readonly string[]
  /** Fiber name of the contributing plugin (or `root` when the caller is unattributed). */
  owner: string
}

/**
 * Ledger of the root standard sources contributed on the CHILD context
 * (`ctx.slots.provideRoot`), and of the fact that the bridge outlet seats
 * none of them.
 *
 * WHY this exists instead of reading the root binding: the binding is public
 * as a TYPE, but its only delivery channel is the renderer-installation
 * contract — `SlotRegistry.hostFace()` is private and the host reaches a
 * renderer through `renderSlot('root', …)`
 * (`vendor/harness-checkout/packages/client/ui-renderer/src/client/registry.ts:465`,
 * `:358`; `ui-slots/src/renderer.ts:127,189,208`), so a non-renderer consumer
 * can only reach it by installing itself as the child context's renderer. The
 * outlet therefore renders its own kit and this ledger makes the degradation
 * ADDRESSABLE: every seat a plugin provided and the shell cannot seat is
 * listed on the diagnostics page instead of disappearing.
 */
export class RootSeatLedger {
  private readonly byOwner = new Map<string, string[]>()

  /**
   * Record one contribution's seats, attributed to its contributor.
   * @param owner - the contributing plugin's fiber name (`root` when unattributed).
   * @param contribution - the `provideRoot` argument (unknown shape: only its compartment keys are read).
   */
  record(owner: string, contribution: unknown): void {
    const source = (contribution ?? {}) as Record<string, unknown>
    const seats: string[] = []
    for (const compartment of ['hooks', 'keyedHooks', 'props'] as const) {
      const members = source[compartment]
      if (typeof members !== 'object' || members === null) continue
      for (const name of Object.keys(members)) seats.push(`root.${compartment}.${name}`)
    }
    if (seats.length === 0) return
    const existing = this.byOwner.get(owner) ?? []
    const merged = new Set([...existing, ...seats])
    this.byOwner.set(owner, [...merged])
  }

  /**
   * The recorded contributions.
   * @returns one record per contributor, in first-contribution order.
   */
  entries(): RootSeatRecord[] {
    return [...this.byOwner].map(([owner, seats]) => ({ owner, seats: [...seats] }))
  }

  /**
   * The diagnostics rows: one per seat a plugin provided that this shell does
   * not seat. Base-plugin contributions are excluded, exactly like the other
   * omitted-seat rows (the chamber's own set is mounted under explicit ids).
   * @param isBasePluginId - predicate identifying the chamber's own base plugins.
   * @returns the omitted-seat rows, in contribution order.
   */
  omittedSeats(isBasePluginId: (id: string) => boolean): OmittedSeatContribution[] {
    const rows: OmittedSeatContribution[] = []
    for (const record of this.entries()) {
      if (isBasePluginId(record.owner)) continue
      for (const seat of record.seats) rows.push({ seat, pluginId: record.owner, kind: 'root-standard-source' })
    }
    return rows
  }
}

/** One entry-render crash observed on the child context (`slots.onEntryError`). */
export interface EntryCrash {
  seat: string
  pluginId?: string
  detail: string
}

/** Extension-phase lifecycle for one source. */
export type ExtensionState = 'pending' | 'loading' | 'ready' | 'unavailable'

/** Immutable snapshot the shell renders (uSES source). */
export interface ExtensionSnapshot {
  state: ExtensionState
  /** Why the phase produced nothing (unavailable only). */
  reason?: string
  /** Kept rows (after covered filtering + URL safety) considered by this phase. */
  total: number
  contributions: readonly PluginContribution[]
  /** Contributions the shell cannot render: unrendered slot seats + unseated root standard sources. */
  omittedSeats: readonly OmittedSeatContribution[]
  crashes: readonly EntryCrash[]
  /** Sorted id set of the kept rows (rebuild/reconcile key). */
  signature: string
}

/** The empty snapshot (before the phase starts / after a total channel failure). */
export const EMPTY_EXTENSION_SNAPSHOT: ExtensionSnapshot = {
  state: 'pending',
  total: 0,
  contributions: [],
  omittedSeats: [],
  crashes: [],
  signature: '',
}

/** One dropped row (unsafe URL) — reported, never silently merged. */
export interface DroppedRow {
  id: string
  reason: string
}

/** Result of projecting raw graph rows into mountable extension rows. */
export interface ExtensionRowProjection {
  rows: ClientPluginRow[]
  dropped: DroppedRow[]
}

/**
 * Project a source's raw graph rows into the rows the child context may mount:
 * drop the chamber-covered ids (double registration is fatal), drop rows whose
 * bundle URL is not root-relative (a poisoned host graph must never steer the
 * script loader to an external origin), and prefix the source's proxy base
 * path so the script element fetches same-origin.
 * @param raw - the source's raw graph rows.
 * @param covered - the covered ids (composite registration + page-own rows).
 * @param basePath - the source's per-instance proxy prefix ('/api/i/<id>').
 * @returns the mountable rows plus every dropped row with its reason.
 */
export function projectExtensionRows(
  raw: readonly ClientPluginRow[],
  covered: readonly string[],
  basePath: string,
): ExtensionRowProjection {
  const coveredIds = new Set(covered)
  const rows: ClientPluginRow[] = []
  const dropped: DroppedRow[] = []
  for (const row of raw) {
    if (coveredIds.has(row.id)) continue
    if (!row.url.startsWith('/') || row.url.startsWith('//')) {
      dropped.push({ id: row.id, reason: `bundle url is not root-relative: ${row.url}` })
      continue
    }
    rows.push({
      id: row.id,
      url: `${basePath}${row.url}`,
      rev: row.rev,
      ...(row.inject === undefined ? {} : { inject: row.inject }),
    })
  }
  return { rows, dropped }
}

/**
 * Validate the `clientGraph/graph` Remote value and project its rows. Fails
 * loud on malformed data (mirror of the renderer's graph parser: a wrong graph
 * is a mount hazard, never a candidate for guesswork).
 * @param value - the Remote result value.
 * @returns the raw rows.
 */
export function parseClientGraphRows(value: unknown): ClientPluginRow[] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('settings-bridge: clientGraph/graph value is not an object')
  }
  const entries = (value as { entries?: unknown }).entries
  if (!Array.isArray(entries)) {
    throw new Error('settings-bridge: clientGraph/graph value.entries must be an array')
  }
  const rows: ClientPluginRow[] = []
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('settings-bridge: clientGraph entry is not an object')
    }
    const row = raw as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.rev !== 'string') {
      throw new Error(`settings-bridge: clientGraph entry ${JSON.stringify(row)} must carry string id/url/rev`)
    }
    rows.push({
      id: row.id,
      url: row.url,
      rev: row.rev,
      // Package-level dependency edges are informational for mounting, but
      // material for the optional dependency-closure expansion below.
      ...(Array.isArray(row.inject) && row.inject.every(entry => typeof entry === 'string')
        ? { inject: row.inject as string[] }
        : {}),
    })
  }
  return rows
}

/**
 * OPTIONAL dependency-closure expansion (2026-12, gated by the caller).
 *
 * A plugin may depend on an official package the chamber composite already
 * covers (e.g. `@deepseek-ai/dsh-client-ui-commands`): its client half is on
 * the page module table, so the provider can be mounted into the SAME child
 * context, letting the dependent plugin's services resolve instead of leaving
 * it `inactive`. The mechanism is deliberately policy-free: it returns the
 * provider ids to mount, and the caller decides whether to use them (the
 * default is OFF — mounting speculative providers widens the surface for no
 * proven benefit, and the dependent plugin's `inactive` report already names
 * the missing service).
 * @param rows - the projected extension rows (their `inject` edges).
 * @param covered - the composite-covered ids (the only ones with page factories).
 * @param mounted - ids already mounted in this child context.
 * @returns the covered provider ids to mount first, in first-seen order.
 */
export function dependencyClosureProviders(
  rows: readonly ClientPluginRow[],
  covered: readonly string[],
  mounted: readonly string[],
): string[] {
  const coveredIds = new Set(covered)
  const already = new Set(mounted)
  const providers: string[] = []
  for (const row of rows) {
    for (const dependency of row.inject ?? []) {
      if (!coveredIds.has(dependency) || already.has(dependency) || providers.includes(dependency)) continue
      providers.push(dependency)
    }
  }
  return providers
}

/** Structural fiber face used for classification (no cordis import: pure + testable). */
export interface FiberLike {
  state: number
  /** Required services (name → intercept config). */
  inject?: Record<string, unknown>
  ctx: { get(name: string): unknown }
  parent?: { fiber?: FiberLike }
}

/**
 * The required services a pending fiber is still waiting for. All child-context
 * providers are synchronous, so an unsatisfied name is simply absent from the
 * context registry — no timing guesswork involved.
 * @param fiber - the pending fiber.
 * @returns the missing service names (declaration order).
 */
export function missingInjectNames(fiber: FiberLike): string[] {
  const declared = Object.keys(fiber.inject ?? {})
  const missing: string[] = []
  for (const name of declared) {
    let provided: unknown
    try {
      provided = fiber.ctx.get(name)
    } catch {
      provided = undefined
    }
    if (provided === undefined) missing.push(name)
  }
  return missing
}

/**
 * The fibers created UNDER one plugin's fiber (a plugin may register its
 * settings contribution inside a nested `ctx.inject([...], …)` callback, whose
 * fiber belongs to a different runtime record — a root-only check would report
 * such a plugin "active" while nothing ever renders).
 * @param root - the plugin's root fiber.
 * @param all - every fiber observed on the child context.
 * @returns the descendant fibers (root excluded).
 */
export function descendantFibers<T extends FiberLike>(root: T, all: readonly FiberLike[]): FiberLike[] {
  return all.filter((candidate) => {
    if (candidate === root) return false
    let current: FiberLike | undefined = candidate.parent?.fiber
    // Cordis terminates its parent chain at a SELF-PARENTED root, not at
    // `undefined` (`vendor/harness-checkout/vendor/cordis/src/fiber.ts` — cordis is
    // vendored inside the pinned dsh checkout — `Fiber.name` walks with
    // `do { … } while (fiber !== fiber.parent.fiber)`), so a walk that stops only
    // on `undefined` never stops at all: classifying any fiber that is NOT a
    // descendant climbs to the root and spins on its self-loop forever. That is
    // what froze the renderer — opening the settings shell against a connected
    // instance pinned one core for as long as the panel stayed mounted, while the
    // instance itself stayed healthy and every host-side log looked normal
    // (2026-09 acceptance; located via a V8 tick profile of the frozen renderer).
    // A chain that revisits a node cannot reach `root` through its remaining
    // edges, so "not a descendant" is the honest bounded answer — the same
    // terminator cordis uses — and the classification keeps every other verdict
    // it can still prove.
    const seen = new Set<FiberLike>([candidate])
    while (current !== undefined) {
      if (current === root) return true
      if (seen.has(current)) return false
      seen.add(current)
      current = current.parent?.fiber
    }
    return false
  })
}

/**
 * Classify one mounted plugin from its fiber tree.
 * @param root - the plugin's root fiber.
 * @param all - every fiber observed on the child context since the mount began.
 * @param error - the rejection `fiber.await()` surfaced, when any.
 * @returns the contribution verdict (without the seat/sharing facts).
 */
export function classifyContribution(
  id: string,
  root: FiberLike,
  all: readonly FiberLike[],
  error: unknown,
): PluginContribution {
  if (error !== undefined && error !== null) {
    return { id, state: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  if (root.state === FIBER_FAILED) {
    return { id, state: 'failed', error: 'plugin apply failed (fiber FAILED)' }
  }
  const pending = [root, ...descendantFibers(root, all)].filter(fiber => fiber.state !== FIBER_ACTIVE)
  if (pending.length > 0) {
    const missing = [...new Set(pending.flatMap(fiber => missingInjectNames(fiber)))]
    // A fiber that is neither active nor waiting on a service is still
    // applying (LOADING): report it as inactive-without-reason rather than
    // pretending it contributed nothing.
    return missing.length > 0
      ? { id, state: 'inactive', missing }
      : { id, state: 'inactive' }
  }
  return { id, state: 'active' }
}

/**
 * Merge a FRESH classification into an existing contribution verdict, keeping
 * the attribution facts (role / seats / sharing / capabilities / rev conflict)
 * and dropping stale failure fields.
 *
 * WHY: the extension phase mounts plugins sequentially, so a plugin whose
 * service is provided by ANOTHER extension plugin mounted later in the same
 * phase is `inactive` at its first verdict and activates moments afterwards.
 * The report must follow the live fiber truth instead of freezing that first
 * verdict (2026-12 review finding).
 * @param previous - the contribution as last reported.
 * @param fresh - the current classification of its fiber tree.
 * @param seats - the seats it currently occupies.
 * @returns the merged verdict.
 */
export function mergeContributionVerdict(
  previous: PluginContribution,
  fresh: PluginContribution,
  seats: readonly string[],
): PluginContribution {
  const next: PluginContribution = { ...previous, state: fresh.state, seats: [...seats] }
  if (fresh.missing !== undefined && fresh.missing.length > 0) next.missing = fresh.missing
  else delete next.missing
  if (fresh.error !== undefined) next.error = fresh.error
  else delete next.error
  return next
}

/** Structural slots face (read-only) used for attribution. */
export interface SlotLedgerFace {
  /** Entries carry the cordis fiber-name stamp at the entry top level (`registrant`). */
  entries(key: string): readonly { registrant?: string }[]
}

/**
 * The settings seats a plugin actually contributed to, attributed by the
 * cordis fiber-name stamp the slot registry writes on every entry
 * (`entry.registrant`, vendor ui-slots index.ts + renderer registry.ts) —
 * exact, not a diff heuristic.
 * @param slots - the child context's slot ledger face.
 * @param pluginId - the plugin id (== the fiber name we mount it under).
 * @returns the contributed seat keys, in {@link RENDERED_SETTINGS_SEATS} order.
 */
export function contributedSeats(slots: SlotLedgerFace, pluginId: string): string[] {
  const seats: string[] = []
  for (const seat of [...RENDERED_SETTINGS_SEATS, ...OMITTED_SETTINGS_SEATS]) {
    if (slots.entries(seat).some(entry => entry.registrant === pluginId)) seats.push(seat)
  }
  return seats
}

/**
 * Third-party contributions that landed in seats the chamber shell does not
 * render. Official/base entries are excluded by registrant (the base set is
 * mounted under explicit ids), so this reports ONLY plugin-authored entries —
 * never the official chrome the child context always registers.
 * @param slots - the child context's slot ledger face.
 * @param isBasePluginId - predicate identifying the chamber's own base plugins.
 * @returns one record per omitted-seat entry.
 */
export function omittedSeatContributions(
  slots: SlotLedgerFace,
  isBasePluginId: (id: string) => boolean,
): OmittedSeatContribution[] {
  const out: OmittedSeatContribution[] = []
  for (const seat of OMITTED_SETTINGS_SEATS) {
    for (const entry of slots.entries(seat)) {
      const registrant = entry.registrant
      if (registrant === undefined || isBasePluginId(registrant)) continue
      out.push({ seat, pluginId: registrant })
    }
  }
  return out
}

/** Plugin entrypoint shapes a client bundle may export. */
export interface NormalizedPlugin {
  /** The cordis plugin object/constructor to pass to `ctx.plugin()`. */
  plugin: unknown
  /** Whether a display name could be attached (object form). */
  nameable: boolean
}

/**
 * Normalize a materialized client-bundle namespace into a cordis plugin.
 * dsh client packages export `apply` (+ `inject`); a bundle that exports a
 * class/function as `default` is accepted as-is; anything else is not a plugin
 * and must be skipped (a platform-word bundle is never an error).
 * @param namespace - the module-table exports.
 * @returns the plugin to mount, or null when the bundle is not a plugin.
 */
export function normalizePluginNamespace(namespace: unknown): NormalizedPlugin | null {
  if (typeof namespace === 'function') return { plugin: namespace, nameable: false }
  if (typeof namespace !== 'object' || namespace === null) return null
  const record = namespace as Record<string, unknown>
  if (typeof record.apply === 'function') return { plugin: record, nameable: true }
  const fallback = record.default
  if (typeof fallback === 'function') return { plugin: fallback, nameable: false }
  if (typeof fallback === 'object' && fallback !== null
    && typeof (fallback as { apply?: unknown }).apply === 'function') {
    return { plugin: fallback, nameable: true }
  }
  return null
}

/** Dictionary keys the diagnostics view renders (asserted against the namespace at the shell). */
export type SettingsNoticeKey =
  | 'pluginsUnavailable'
  | 'noticeInactive'
  | 'noticeFailed'
  | 'noticeOmittedSeat'
  | 'noticeRootSeat'
  | 'noticeCrash'
  | 'noticeShared'
  | 'noticeCapability'
  | 'noticeRevConflict'

/** One rendered diagnostic line. */
export interface SettingsNotice {
  key: SettingsNoticeKey
  /** `{param}` interpolation values (plugin / missing / seat / detail / sources / error). */
  params?: Record<string, string>
}

/**
 * Project an extension snapshot into the honest, human-readable notice list.
 * Nothing that failed to render may stay invisible: every inactive/failed/
 * skipped contribution, every omitted-seat registration (including the root
 * standard sources this surface cannot seat), every contained render crash and
 * every cross-source module-sharing fact becomes one line.
 * @param snapshot - the live extension snapshot.
 * @returns the notices, in a stable reading order.
 */
export function extensionNotices(snapshot: ExtensionSnapshot): SettingsNotice[] {
  const notices: SettingsNotice[] = []
  if (snapshot.state === 'unavailable') {
    notices.push({ key: 'pluginsUnavailable', params: { error: snapshot.reason ?? 'unknown' } })
  }
  for (const contribution of snapshot.contributions) {
    if (contribution.role === 'provider') continue
    if (contribution.state === 'failed') {
      notices.push({
        key: 'noticeFailed',
        params: { plugin: contribution.id, detail: contribution.error ?? 'unknown' },
      })
      continue
    }
    if (contribution.state === 'inactive') {
      notices.push({
        key: 'noticeInactive',
        params: {
          plugin: contribution.id,
          missing: (contribution.missing ?? []).join(', ') || 'unknown',
        },
      })
      continue
    }
    if (contribution.sharedWith !== undefined && contribution.sharedWith.length > 0) {
      notices.push({
        key: 'noticeShared',
        params: { plugin: contribution.id, sources: contribution.sharedWith.join(', ') },
      })
    }
    if (contribution.capabilities !== undefined && contribution.capabilities.length > 0) {
      notices.push({
        key: 'noticeCapability',
        params: { plugin: contribution.id, capability: contribution.capabilities.join(', ') },
      })
    }
    if (contribution.revConflict !== undefined) {
      notices.push({
        key: 'noticeRevConflict',
        params: { plugin: contribution.id, kind: contribution.revConflict },
      })
    }
  }
  for (const omitted of snapshot.omittedSeats) {
    notices.push(omitted.kind === 'root-standard-source'
      ? { key: 'noticeRootSeat', params: { plugin: omitted.pluginId, seat: omitted.seat } }
      : { key: 'noticeOmittedSeat', params: { plugin: omitted.pluginId, seat: omitted.seat } })
  }
  for (const crash of snapshot.crashes) {
    notices.push({
      key: 'noticeCrash',
      params: { plugin: crash.pluginId ?? crash.seat, detail: crash.detail },
    })
  }
  return notices
}

/**
 * The provenance of one nav row: a non-base registrant means a plugin (not the
 * chamber's own base set) provided this section, and the UI marks it as such.
 * @param row - the projected nav row.
 * @param isBasePluginId - the base-id predicate.
 * @returns true when a plugin (not the chamber base set) contributed the row.
 */
export function isPluginProvidedRow(
  row: { registrant?: string },
  isBasePluginId: (id: string) => boolean,
): boolean {
  return row.registrant !== undefined && !isBasePluginId(row.registrant)
}
