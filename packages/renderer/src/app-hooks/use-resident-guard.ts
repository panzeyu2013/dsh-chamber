/**
 * Resident guard hook — the runtime half of the keep-all (resident shells) policy.
 *
 * One owner for: (a) per-shell last-active / last-input observations, (b) the page-level
 * resident snapshot published to the settings panel, (c) hard-cap release, (d) manual
 * release requests from the panel, and (e) the v1.1 memory-pressure valve (armed only
 * while more than one shell is mounted and the document visible; it probes the host
 * memory snapshot through settings.get and degrades to no-op when the platform cannot
 * answer).
 *
 * The policy itself is pure (../resident-policy.ts) and the published projection is a pure
 * builder too (../resident-snapshot.ts, node-tested directly): this hook only observes,
 * decides WHICH shell (one at a time, staggered), and calls the single disposal entry
 * (App's reclaimView). Decisions read the LIVE view store and the two live target refs
 * (pending switch / settings-panel target) — never a render-time mirror — so the guard
 * and the disposal entry agree on who is protected. Releases write the existing
 * prewarmSuppressed mark inside reclaimView so the background slot cannot immediately
 * re-boot what the user (or the valve) just released.
 *
 * Performance budget: the steady state installs no timer (the pressure valve is the only
 * periodic task and exists only while >1 shell is mounted and visible); DOM node counts
 * are collected ONLY while the settings panel is subscribed, and the snapshot is built at
 * most once per relevant React commit (one dedicated publish effect).
 */
import { useCallback, useEffect, useRef } from 'react'
import { useInputActivity } from './use-input-activity.ts'
import {
  residentBridge,
  type ResidentReleaseFact,
} from '@dsh-chamber/dsh-chamber-client-core'
import {
  classifyPressure,
  pickHardCapRelease,
  pickPressureReleases,
  RESIDENT_HARD_CAP,
  type PressureDecision,
  type ReleaseContext,
} from '../resident-policy.ts'
import { buildResidentSnapshot } from '../resident-snapshot.ts'

/** Minimal structural shell-state shape the guard needs (avoids importing shell.ts). */
export interface ResidentShellStateLike {
  readonly booted: boolean
  readonly error: string | null
}

/** Live view snapshot the guard reads at decision time (App's viewStore). */
export interface ResidentViewSnapshot {
  readonly active: string
  readonly painted: string
}

export interface ResidentGuardDeps {
  readonly mountedViews: readonly string[]
  readonly activeView: string
  readonly paintedView: string
  /** Live active/painted authority (viewStore.getSnapshot()); decisions must not use a stale mirror. */
  readonly viewStore: { getSnapshot(): ResidentViewSnapshot }
  /** In-flight switch target (live ref). */
  readonly pendingView: { readonly current: string | null }
  /** Settings-panel target source while the panel is open (live ref). */
  readonly settingsTarget: { readonly current: string | undefined }
  readonly shellStates: Readonly<Record<string, ResidentShellStateLike>>
  readonly localId: string
  /** Auto-prewarmed (system speculative) shell set; released first under the cap. */
  readonly autoPrewarmed: { has(id: string): boolean }
  /** Roster label per source id (local included). */
  readonly labels: Readonly<Record<string, string>>
  /** The single disposal entry (App's reclaimView). */
  readonly reclaimView: (id: string, reason?: 'release' | 'harvest') => void
}

/** Switch-settle delay before an automatic release: never race a View Transition. */
const AUTO_RELEASE_SETTLE_MS = 1_500
/** Pressure sampling cadence while armed (visible + more than one mounted shell). */
const PRESSURE_POLL_MS = 30_000
/** Stagger between two automatic releases so teardown never lands in one long task. */
const RELEASE_STAGGER_MS = 250
/** Hard-cap retry cadence when a pass made no progress (all candidates protected / disposal refused). */
const CAP_RETRY_MS = 10_000

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function isSettledShell(state: ResidentShellStateLike | undefined): boolean {
  return state !== undefined && (state.booted || state.error !== null)
}

function liveView(deps: ResidentGuardDeps): ResidentViewSnapshot {
  return deps.viewStore.getSnapshot()
}

/**
 * One shell's DOM node count (subtree only; the shell root itself is excluded). CSS.escape is
 * the selector authority (same discipline as the reveal gate); any selector throw reads as
 * "unavailable" and must never break an effect.
 */
function shellDomNodes(id: string): number | undefined {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return undefined
  try {
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id
    const root = document.querySelector('.instance-view[data-instance="' + escaped + '"]')
    if (root === null) return undefined
    // Scoped live collection: the engine answers length without materializing a NodeList of
    // every descendant (querySelectorAll would allocate one per publish while the panel is open).
    const nodes = root.getElementsByTagName('*').length
    return nodes > 0 ? nodes : undefined
  } catch {
    return undefined
  }
}

export function useResidentGuard(deps: ResidentGuardDeps): { releaseSource: (id: string, reason?: ResidentReleaseFact['reason']) => boolean } {
  const { lastInputAt, clearInput } = useInputActivity()
  const depsRef = useRef(deps)
  depsRef.current = deps
  const lastActiveAtRef = useRef<Record<string, number>>({})
  const lastSwitchAtRef = useRef(0)
  const everMountedRef = useRef<Set<string>>(new Set())
  const wasMountedRef = useRef<Set<string>>(new Set())
  const releasedRef = useRef<Set<string>>(new Set())
  const inFlightRef = useRef<Set<string>>(new Set())
  const lastReleaseRef = useRef<ResidentReleaseFact | undefined>(undefined)
  const pressureRef = useRef<PressureDecision | null>(null)

  /** Last-input timestamps for mounted sources (budget: mounted only). */
  const buildLastInputRecord = useCallback((d: ResidentGuardDeps): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const id of d.mountedViews) {
      const at = lastInputAt(id)
      if (at !== undefined) out[id] = at
    }
    return out
  }, [lastInputAt])

  /** Build the current release context from the latest live facts (pure input). */
  const buildContext = useCallback((): ReleaseContext => {
    const d = depsRef.current
    const view = liveView(d)
    const booting = new Set<string>()
    const resident = new Set<string>()
    const autoPrewarmed = new Set<string>()
    for (const id of d.mountedViews) {
      if (id === d.localId) continue
      const state = d.shellStates[id]
      if (!isSettledShell(state)) booting.add(id)
      else resident.add(id)
      if (d.autoPrewarmed.has(id)) autoPrewarmed.add(id)
    }
    return {
      mountedIds: d.mountedViews,
      activeId: view.active,
      paintedId: view.painted,
      pendingId: d.pendingView.current,
      settingsTargetId: d.settingsTarget.current ?? null,
      bootingIds: booting,
      autoPrewarmedIds: autoPrewarmed,
      residentIds: resident,
      lastActiveAt: lastActiveAtRef.current,
      lastInputAt: buildLastInputRecord(d),
      now: monotonicNow(),
    }
  }, [])

  /** Publish the page-level snapshot (pure projection; DOM counts only while the panel subscribes). */
  const publish = useCallback(() => {
    const d = depsRef.current
    const view = liveView(d)
    const releasedIds = new Set<string>()
    for (const id of releasedRef.current) {
      if (Object.prototype.hasOwnProperty.call(d.labels, id)) releasedIds.add(id)
    }
    const collectDomNodes = residentBridge.subscriberCount() > 0
    residentBridge.publish(buildResidentSnapshot({
      mountedIds: d.mountedViews,
      activeId: view.active,
      paintedId: view.painted,
      shellStates: d.shellStates,
      labels: d.labels,
      releasedIds,
      autoPrewarmed: d.autoPrewarmed,
      lastActiveAt: lastActiveAtRef.current,
      now: monotonicNow(),
      settingsTargetId: d.settingsTarget.current ?? null,
      ...(collectDomNodes ? { domNodes: shellDomNodes } : {}),
      ...(lastReleaseRef.current === undefined ? {} : { lastRelease: lastReleaseRef.current }),
    }))
  }, [])

  const releaseSource = useCallback((id: string, reason: ResidentReleaseFact['reason'] = 'manual'): boolean => {
    const d = depsRef.current
    const view = liveView(d)
    if (id === d.localId || inFlightRef.current.has(id)) return false
    if (!d.mountedViews.includes(id)) return false
    if (id === view.active || id === view.painted) return false
    if (id === d.pendingView.current || id === d.settingsTarget.current) return false
    if (!isSettledShell(d.shellStates[id])) return false
    inFlightRef.current.add(id)
    try {
      d.reclaimView(id, 'release')
    } finally {
      inFlightRef.current.delete(id)
    }
    lastReleaseRef.current = { sourceId: id, reason, at: monotonicNow() }
    return true
  }, [])

  // Observe the painted shell for the LRU clock and the auto-release settle gate.
  useEffect(() => {
    const d = depsRef.current
    if (d.paintedView === '') return
    lastActiveAtRef.current[d.paintedView] = monotonicNow()
    lastSwitchAtRef.current = monotonicNow()
  }, [deps.paintedView])

  // Track mount/unmount, released history, input cleanup, and the hard-cap release chain.
  // The chain re-arms while the mount count stays over the cap: a switch inside the settle
  // window, a fully protected candidate set, or a disposal refusal must never wedge the cap.
  useEffect(() => {
    const d = depsRef.current
    for (const id of d.mountedViews) {
      everMountedRef.current.add(id)
      const wasReleased = releasedRef.current.delete(id)
      // A remount is a fresh use: stale activity would make it the immediate LRU candidate
      // and would show a bogus hidden duration in the panel.
      if (wasReleased || lastActiveAtRef.current[id] === undefined) lastActiveAtRef.current[id] = monotonicNow()
    }
    // Input protection only applies while a shell is mounted; released/deleted shells drop it.
    for (const id of wasMountedRef.current) {
      if (!d.mountedViews.includes(id)) clearInput(id)
    }
    wasMountedRef.current = new Set(d.mountedViews)
    // Released history is bounded by the registry: a deleted source leaves both sets.
    for (const id of [...everMountedRef.current]) {
      if (!d.mountedViews.includes(id) && !Object.prototype.hasOwnProperty.call(d.labels, id)) everMountedRef.current.delete(id)
    }
    for (const id of [...everMountedRef.current]) {
      if (!d.mountedViews.includes(id) && Object.prototype.hasOwnProperty.call(d.labels, id)) releasedRef.current.add(id)
    }
    for (const id of [...releasedRef.current]) {
      if (!Object.prototype.hasOwnProperty.call(d.labels, id)) releasedRef.current.delete(id)
    }
    for (const id of Object.keys(lastActiveAtRef.current)) {
      if (!d.mountedViews.includes(id) && !Object.prototype.hasOwnProperty.call(d.labels, id)) delete lastActiveAtRef.current[id]
    }
    if (d.mountedViews.length <= RESIDENT_HARD_CAP) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (delayMs: number): void => {
      timer = setTimeout(() => {
        const current = depsRef.current
        if (current.mountedViews.length <= RESIDENT_HARD_CAP) return
        if (monotonicNow() - lastSwitchAtRef.current < AUTO_RELEASE_SETTLE_MS) {
          arm(AUTO_RELEASE_SETTLE_MS)
          return
        }
        const candidate = pickHardCapRelease(buildContext())
        if (candidate === null || !releaseSource(candidate, 'cap')) {
          arm(CAP_RETRY_MS)
          return
        }
        // Success removes the mount, which re-runs this effect (cleaning this timer) and arms
        // the next pass after a fresh settle window; the arm below only covers a silent no-op.
        arm(AUTO_RELEASE_SETTLE_MS)
      }, delayMs)
    }
    arm(AUTO_RELEASE_SETTLE_MS)
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [deps.mountedViews, deps.labels, deps.shellStates, deps.activeView, deps.paintedView, buildContext, releaseSource, clearInput])

  // Manual release requests from the settings panel (page-level command channel).
  useEffect(() => residentBridge.onReleaseRequest((sourceId) => { releaseSource(sourceId, 'manual') }), [releaseSource])

  // Panel opened: republish now that DOM counts are worth collecting (the panel subscribes first).
  useEffect(() => residentBridge.onRefresh(() => { publish() }), [publish])

  // v1.1 pressure valve: armed only while visible with more than one mounted shell. The
  // dependency is the boolean, not the count: 2→3 mounts must not rebuild the interval.
  const pressureArmed = deps.mountedViews.length > 1
  useEffect(() => {
    if (!pressureArmed) return
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    let stopped = false
    let sampling = false
    const poll = async (): Promise<void> => {
      if (stopped || sampling || document.visibilityState !== 'visible') return
      if (depsRef.current.mountedViews.length <= 1) return
      const settings = (window as unknown as { dshChamber?: { settings?: { get?: () => Promise<unknown> } } }).dshChamber?.settings
      if (settings?.get === undefined) return
      sampling = true
      try {
        const status = await settings.get() as { system?: { availableBytes?: unknown; totalBytes?: unknown } } | null
        const available = status?.system?.availableBytes
        const total = status?.system?.totalBytes
        const freeRatio = typeof available === 'number' && typeof total === 'number' && total > 0 ? available / total : null
        const decision = classifyPressure({ freeRatio, previous: pressureRef.current, now: monotonicNow() })
        pressureRef.current = decision
        if (decision.band === 'normal') return
        // The document may have been hidden while the snapshot was in flight: a hidden
        // window must not start tearing shells down.
        if (stopped || document.visibilityState !== 'visible') return
        const releases = pickPressureReleases(buildContext(), decision.band)
        releases.forEach((id, index) => {
          setTimeout(() => { if (!stopped) releaseSource(id, 'pressure') }, index * RELEASE_STAGGER_MS)
        })
      } catch { /* unavailable snapshot: stay on the hard-cap path only */ }
      finally { sampling = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, PRESSURE_POLL_MS)
    const onVisibility = (): void => { if (document.visibilityState === 'visible') void poll() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pressureArmed, buildContext, releaseSource])

  // ONE publish per relevant commit: mount/label/shell-state/active/painted changes all land here.
  // (Keeping a single effect avoids the former two-publish-per-state-change duplicate projection.)
  useEffect(() => {
    publish()
  }, [deps.mountedViews, deps.labels, deps.shellStates, deps.activeView, deps.paintedView, publish])

  return { releaseSource }
}
