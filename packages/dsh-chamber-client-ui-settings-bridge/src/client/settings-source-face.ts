/**
 * Per-instance settings-source face (design 05 §5, 2026-12 完整桥接修订).
 *
 * WHY: the settings panel used to serve the SELECTED source by re-assembling a
 * reduced copy of that source's frontend in a detached cordis context
 * (`new Context()` + a fixed base set + the source's graph rows). Every
 * degradation the panel reported — plugins whose settings never activated, a
 * root standard source nobody seated, a `remote` without an event stream, the
 * 13 Remote namespaces it could not reach — followed from that copy existing.
 *
 * The complete bridge is the source's OWN surface: the settings panel renders
 * the `settings.section` ledger of the source's own boot ctx (the ctx whose
 * React tree already renders that instance's frontend) with the standard seats
 * the renderer bound inside THAT ctx. Nothing is mounted twice, no service is
 * stubbed, and the panel is live because the ctx is the live one.
 *
 * This module is the SINGLETON page seam between the two publishers and the
 * reader:
 * - the bridge plugin's `apply` runs once per instance boot ctx and publishes
 *   the ctx's `slots` registry, `locale` face and authoritative
 *   `chamberSourceFingerprint` (`publishSettingsSourceRuntime`);
 * - that instance's settings shell component — the ONE chamber entry the
 *   renderer hands the complete standard kit to, because it occupies
 *   `sidebar.settings` on that same ctx — publishes those seats
 *   (`publishSettingsSourceSeats`);
 * - the panel (rendered by whichever instance is on screen) reads the SELECTED
 *   source's face and renders that source's ledger with that source's seats.
 *
 * The page module table serves one module instance per plugin id to every
 * source (first-load-wins), so this registry is page-global by construction —
 * the same page-global fact that makes a single `chamberBridge` projection
 * visible to every instance's shell. Publisher and reader are both this
 * package's own client bundle, so no cross-package shared face is needed.
 */

/** One registered entry of a slots ledger (structural: no upstream type import). */
export interface SettingsSourceEntry {
  component: unknown
  options: {
    key?: string
    id?: string
    order?: number
    label?: string | (() => string)
    priority?: number
  }
  inject?: ((...args: never[]) => Record<string, unknown>) | undefined
  children?: Readonly<Record<string, { kind: SettingsSlotKind; scope: SettingsSlotScope }>> | undefined
  store?: { create(): SettingsSourceStore } | undefined
  locale?: string | undefined
  registrant?: string | undefined
}

/** Slot kinds/scopes a ledger declares (the upstream unions, spelled out). */
export type SettingsSlotKind = 'single' | 'list' | 'keyed' | 'chain'
export type SettingsSlotScope = 'root' | 'session-maybe' | 'session'

/** Store instance contract of a registered entry. */
export interface SettingsSourceStore {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
  readonly actions: Record<string, (...params: never[]) => void>
}

/** Read/observe face of one instance's slot registry (public methods only). */
export interface SettingsSourceSlots {
  entries(key: string): readonly SettingsSourceEntry[]
  entriesOfSlot(key: string): readonly SettingsSourceEntry[]
  getVersion(key: string): number
  subscribe(key: string, fn: () => void): () => void
  spec(key: string): { kind: SettingsSlotKind; scope: SettingsSlotScope } | undefined
  onEntryError(fn: (key: string, entry: SettingsSourceEntry, error: unknown, info: { abdicated: boolean }) => void): () => void
}

/** Locale face of one instance's ctx (the `t` seat source for its entries). */
export interface SettingsSourceLocale {
  getSnapshot(): { revision: number }
  subscribe(listener: () => void): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}

/**
 * Standard seats the renderer bound for one ctx's root scope. Every member is
 * optional: the face publishes whatever the renderer actually handed over, and
 * a missing member is a fact the panel must not invent a substitute for.
 */
export interface SettingsSourceSeats {
  /** Selector hook over that ctx's session list (`sessions.list`). */
  useSessions?: unknown
  /** Selector hook over that ctx's workspace list (`workspaces.list`). */
  useWorkspaces?: unknown
  /** Selector hook over that ctx's panel selection (`layout`). */
  usePanelInfo?: unknown
  /** Keyed hook over that ctx's resource registry (`keyedHooks.resource`). */
  useResource?: unknown
  /** Selector hook over that ctx's pending interactions (ui-session). */
  useSessionPendingInteraction?: unknown
  /** Root `props` compartment members (e.g. `chamberFileApiBase`). */
  props?: Record<string, unknown>
}

/** The live face of one source's own settings surface. */
export interface SettingsSourceFace {
  instanceId: string
  /** Authoritative incarnation proof bound into that ctx by the shell. */
  sourceFingerprint?: string
  slots?: SettingsSourceSlots
  locale?: SettingsSourceLocale
  seats?: SettingsSourceSeats
}

/** A face whose ledger and seats are both published — what the panel renders with. */
export interface RenderableSettingsSourceFace extends SettingsSourceFace {
  slots: SettingsSourceSlots
  seats: SettingsSourceSeats
}

type Listener = () => void

const faces = new Map<string, SettingsSourceFace>()
const listeners = new Set<Listener>()
let revision = 0

/** Monotonic face revision (uSES pairing for every panel that reads the registry). */
export function settingsSourceFaceRevision(): number {
  return revision
}

/**
 * Fan out one registry change. Per-listener isolation on EVERY path (publish
 * and retraction alike): one throwing reader must not starve its siblings —
 * the same discipline the chamberBridge projection fan-out uses.
 */
function notify(): void {
  revision += 1
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[dsh-chamber] settings-source-face subscriber threw:', error)
    }
  }
}

/** Immutable republish: same content keeps the same object so uSES reads are stable. */
function publish(next: SettingsSourceFace): void {
  const previous = faces.get(next.instanceId)
  if (previous !== undefined
    && previous.sourceFingerprint === next.sourceFingerprint
    && previous.slots === next.slots
    && previous.locale === next.locale
    && previous.seats === next.seats) return
  faces.set(next.instanceId, next)
  notify()
}

/**
 * Publish the ctx-side part of one source's face (slots + locale + identity).
 * @param instanceId - the source id ('local' | '<kind>-<id>').
 * @param runtime - the live ctx faces; `slots` is required, `locale` may arrive later.
 * @returns disposer that retracts THIS publication (a later publisher of the other part keeps its own).
 */
export function publishSettingsSourceRuntime(
  instanceId: string,
  runtime: {
    slots: SettingsSourceSlots
    locale?: SettingsSourceLocale
    sourceFingerprint?: string
  },
): () => void {
  const seats = faces.get(instanceId)?.seats
  publish({
    instanceId,
    ...(runtime.sourceFingerprint === undefined ? {} : { sourceFingerprint: runtime.sourceFingerprint }),
    slots: runtime.slots,
    ...(runtime.locale === undefined ? {} : { locale: runtime.locale }),
    ...(seats === undefined ? {} : { seats }),
  })
  return () => {
    const current = faces.get(instanceId)
    if (current === undefined || current.slots !== runtime.slots) return
    faces.delete(instanceId)
    notify()
  }
}

/**
 * Publish the seat part of one source's face (the renderer-bound standard kit).
 * @param instanceId - the source id whose ctx the seats belong to.
 * @param seats - the seats the renderer handed to that ctx's settings shell.
 * @returns disposer that retracts this publication.
 */
export function publishSettingsSourceSeats(instanceId: string, seats: SettingsSourceSeats): () => void {
  const current = faces.get(instanceId)
  publish({ instanceId, ...current, seats })
  return () => {
    const live = faces.get(instanceId)
    if (live === undefined || live.seats !== seats) return
    const { seats: _dropped, ...rest } = live
    publish(rest)
  }
}

/**
 * Read one source's published face.
 * @param instanceId - the source id.
 * @returns the face, or undefined while that source has no mounted shell.
 */
export function getSettingsSourceFace(instanceId: string | undefined): SettingsSourceFace | undefined {
  return instanceId === undefined ? undefined : faces.get(instanceId)
}

/**
 * Subscribe to face publications/retractions (any source).
 * @param listener - invoked after the registry changed.
 * @returns unsubscribe.
 */
export function subscribeSettingsSourceFaces(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Whether a face is complete enough to render that source's settings: its
 * ledger AND the standard seats its entries are rendered with.
 * @param face - the face to test.
 * @returns true (narrowing) when the panel can render that source.
 */
export function settingsSourceFaceReady(
  face: SettingsSourceFace | undefined,
): face is RenderableSettingsSourceFace {
  return face !== undefined && face.slots !== undefined && face.seats !== undefined
}
