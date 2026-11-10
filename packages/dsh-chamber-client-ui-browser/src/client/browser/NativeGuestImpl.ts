/**
 * Native guest carrier provider (design 28 v3 §4, ADR-0004; R3 review fixes).
 *
 * The guest is a child WKWebView owned by the Swift shell. The renderer keeps the
 * upstream chrome and sends intents: `acquire` → `navigate`/`command`/`frame`,
 * and consumes pushed `state`/`openRequested`/`input`/`forwardNeeded`.
 *
 * Third-round rules (pure logic in `guest-state.ts`, tested there and in the
 * carrier integration suite):
 *  - an acquire that settles after dispose releases its minted lease, and a FAILED
 *    acquire is retryable (the next navigation/reload re-attempts it);
 *  - the live lease is mirrored onto the placeholder as
 *    `data-chamber-browser-lease` (the input replay targets it) and cleared on
 *    release/dispose (D12);
 *  - the snapshot is PROJECTED from the application history/cursor, never from the
 *    last bridge payload: a requested load shows its entry before the navigate
 *    invoke, and a forwarded page keeps its LOGICAL target while the guest sits on
 *    main's alias origin (D14);
 *  - a pushed address/title only ADOPTS on a SETTLED push (`loading:false`, the
 *    commit/finish boundary): a late loading push may still carry the PREVIOUS
 *    page's URL (Swift didStartProvisionalNavigation), so adopting it would roll
 *    the requested target back to A after the user asked for B (D14 fix 2);
 *  - an empty pushed url never adopts anything and keeps the forwarded projection
 *    and alias exit;
 *  - a non-empty pushed title on a settled push updates the current history entry
 *    and is persisted (D15);
 *  - the external exit is DISABLED (`null`) while a target resolves and after a
 *    forwarded target fails: the logical address of a remote-loopback page is never
 *    handed to THIS machine's system browser (design 28 §3). A direct page keeps
 *    its logical URL as the exit (`undefined`) and only a failed direct ack leaves
 *    that fallback in place;
 *  - a refused navigate ack surfaces the failure bar and drops the alias exit;
 *  - a late forward negotiation only lands when the same generation/lease is still
 *    current; the pushed URL is the SUSPENDED target (never the address on screen),
 *    so it is gated by class (loopback target), not by equality;
 *  - an accepted negotiation records that target as the logical address;
 *  - back/forward moves the application-history cursor instead of appending;
 *  - a frame ack and a keymap ack are silent (background edges must not flash a
 *    failure bar).
 */
import type { BrowserFrame, BrowserFrameState, BrowserLoadError } from './BrowserFrame.ts'
import type { BrowserPageOptions } from './BrowserPage.ts'
import type { BrowserTarget } from './url.ts'
import type { BrowserFrameReport, BrowserGuestState, BrowserKeyCombo, NativeGuestCarrier } from './BrowserBridge.ts'
import { parseBrowserForwardNeeded, parseBrowserGuestState, parseBrowserOpenRequest } from './BrowserBridge.ts'
import type { BrowserTargetRefResolver, BrowserTargetRef } from './ForwardFrameResolver.ts'
import { planKeymapPush } from './keymap-push.ts'
import { shouldReportGuestFrame } from './guest-geometry.ts'
import { createSnapshotStore, type SnapshotStore } from './snapshot-store.ts'
import {
  acceptsForwardNegotiation,
  acceptsStatePush,
  canonicalOrigin,
  historyAdoptAction,
  planLeaseSettle,
  projectAckFailure,
  isLoopbackNegotiationTarget,
  transitionForwarded,
} from './guest-state.ts'
import type { BrowserGuestTarget } from './BrowserBridge.ts'
import type { NativeGuestPresentation } from '../view/NativeGuestPresentation.ts'

/** One authenticated guest target (the address bar / history entry). */
interface HistoryEntry {
  readonly kind: 'http' | 'https'
  readonly url: string
  readonly title: string
}

/** Owns one guest lease; the presentation reports its placeholder geometry. */
export class NativeGuestImpl implements BrowserFrame {
  private readonly options: BrowserPageOptions
  private readonly carrier: NativeGuestCarrier
  private readonly presentation: NativeGuestPresentation
  private readonly resolver: BrowserTargetRefResolver
  // Carrier-local store: this occurrence's bridge-driven frame snapshot (node-testable);
  // BrowserController keeps the vendor store for its UI-facing controller state.
  private readonly store: SnapshotStore<BrowserFrameState>
  private history: HistoryEntry[] = []
  private cursor = -1
  private requestRevision = 0
  private lease: string | undefined
  private acquiring: Promise<boolean> | undefined
  private generation = 0
  private error: BrowserLoadError | undefined
  private externalUrl: string | null | undefined
  private forwarded = false
  private forwardedOrigin: string | undefined
  /** Whether the projected target is a requested navigation or an observed URL. */
  private addressMode: 'requested' | 'observed' = 'requested'
  private loading = false
  private canGoBack = false
  private canGoForward = false
  private pendingFrame: BrowserFrameReport | undefined
  private keymapScheduled = false
  private lastKeymap: string | undefined
  private readonly unsubscribe: (() => void)[] = []
  private disposed = false
  private disposal: Promise<void> | undefined

  /**
   * @param options - checkpoint, persistence writer and source-tab callbacks.
   * @param carrier - the bridge and the boot-bound lease identity.
   * @param presentation - placeholder measurement adapter.
   * @param resolver - logical target → guest target (owns the forward lease).
   */
  constructor(
    options: BrowserPageOptions,
    carrier: NativeGuestCarrier,
    presentation: NativeGuestPresentation,
    resolver: BrowserTargetRefResolver,
  ) {
    this.options = options
    this.carrier = carrier
    this.presentation = presentation
    this.resolver = resolver
    if (options.initial !== undefined) {
      this.history = options.initial.entries.map(entry => ({ kind: entry.kind, url: entry.url, title: entry.title }))
      this.cursor = options.initial.index
    }
    // D14: the snapshot is a projection of the application history/cursor.
    this.store = createSnapshotStore(this.projectState())
    this.observePushes()
    const combos = this.carrier.bridge.combos
    if (combos !== undefined) {
      try { this.unsubscribe.push(combos.subscribe(() => { this.scheduleKeymap() })) } catch { /* fail-safe */ }
    }
  }

  /** @returns immutable navigation state. */
  getSnapshot = (): BrowserFrameState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** Acquire the lease once; a failed acquire stays retryable (R2-B). */
  start(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.acquiring !== undefined) return this.acquiring
    const report = this.pendingFrame ?? IDLE_FRAME_REPORT
    const key = this.carrier.resolveWorkspaceKey === undefined
      ? Promise.resolve(this.carrier.workspaceKey)
      : this.carrier.resolveWorkspaceKey().catch(() => this.carrier.workspaceKey)
    const attempt = key.then(workspaceKey => this.carrier.bridge.acquire({
      tabId: this.options.tabId,
      sessionId: this.carrier.sessionId,
      sourceId: this.carrier.sourceId,
      sourceFingerprint: this.carrier.sourceFingerprint,
      workspaceKey,
      frame: report.frame,
      visible: report.visible,
      occluded: report.occluded,
    })).then((result) => {
      const plan = planLeaseSettle(this.disposed, result)
      if (plan.release !== undefined) {
        void this.carrier.bridge.release({ tabId: this.options.tabId, lease: plan.release }).catch(() => undefined)
        return false
      }
      if (plan.failure !== undefined) {
        if (!this.disposed) {
          this.error = { code: undefined, description: plan.failure }
          this.loading = false
          this.publish()
        }
        // Retryable: the next start() (navigation/reload) attempts a fresh acquire.
        if (this.acquiring === attempt) this.acquiring = undefined
        return false
      }
      this.lease = plan.adopt as string
      // D12: the input replay finds this occurrence's placeholder by its lease.
      this.presentation.setLease(this.lease)
      this.scheduleKeymap()
      this.sendAcquiredPendingFrame(report)
      return true
    }).catch(() => {
      if (!this.disposed) {
        this.error = { code: undefined, description: 'unavailable' }
        this.loading = false
        this.publish()
      }
      if (this.acquiring === attempt) this.acquiring = undefined
      return false
    })
    this.acquiring = attempt
    return attempt
  }

  /** @param target - validated address; submitting the current address reloads it. */
  loadUrl(target: BrowserTarget): void {
    if (this.disposed) return
    const current = this.currentEntry()
    if (current?.url === target.url) { void this.load(current, true); return }
    void this.load(target as HistoryEntry, false)
  }

  /** Move backward through the guest's native history. */
  goBack(): void { void this.command('goBack') }
  /** Move forward through the guest's native history. */
  goForward(): void { void this.command('goForward') }
  /** Reload the current address (also retries a failed acquire). */
  reload(): void {
    const current = this.currentEntry()
    if (current !== undefined) void this.load(current, true)
  }

  /** @returns after the lease and every forward consumer are released. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.presentation.dispose()
    for (const stop of this.unsubscribe.splice(0)) stop()
    const settled = this.acquiring === undefined ? Promise.resolve() : this.acquiring.then(() => undefined, () => undefined)
    this.disposal = settled
      .then(() => this.releaseLease())
      .then(() => this.resolver.dispose().then(() => undefined, () => undefined))
    return this.disposal
  }

  /** Report the placeholder geometry; a refused frame ack is silent (RT-12). */
  reportFrame(report: BrowserFrameReport): void {
    if (this.disposed) return
    this.pendingFrame = report
    const lease = this.lease
    if (lease === undefined) { void this.start(); return }
    void this.carrier.bridge.frame({
      tabId: this.options.tabId, lease,
      frame: report.frame, visible: report.visible, occluded: report.occluded,
    }).catch(() => undefined)
  }

  /**
   * D16: the acquire carried the report captured when it started. A placeholder
   * report that changed while the acquire was in flight is sent immediately after
   * the lease lands — otherwise the guest keeps a stale frame until the next
   * geometry change.
   */
  private sendAcquiredPendingFrame(acquiredWith: BrowserFrameReport): void {
    const latest = this.pendingFrame
    const lease = this.lease
    if (latest === undefined || lease === undefined) return
    if (!shouldReportGuestFrame(acquiredWith, latest)) return
    void this.carrier.bridge.frame({
      tabId: this.options.tabId, lease,
      frame: latest.frame, visible: latest.visible, occluded: latest.occluded,
    }).catch(() => undefined)
  }

  /** Release the current lease once (idempotent). */
  private async releaseLease(): Promise<void> {
    const lease = this.lease
    this.lease = undefined
    this.lastKeymap = undefined
    this.presentation.setLease(undefined)
    if (lease === undefined) return
    await this.carrier.bridge.release({ tabId: this.options.tabId, lease }).catch(() => undefined)
  }

  /** Project one refused ack into the failure bar and clear loading. */
  private projectAck(ack: { readonly ok: boolean; readonly code?: string }): void {
    const failure = projectAckFailure(ack)
    if (failure === undefined) return
    this.error = failure
    this.loading = false
    this.publish()
  }

  /** Load one logical entry (append-on-change; reload keeps the cursor). */
  private async load(entry: HistoryEntry, reload: boolean): Promise<void> {
    if (this.disposed) return
    if (!reload) {
      const urls = this.history.map(item => item.url)
      const action = historyAdoptAction(urls, this.cursor, entry.url)
      if (action.kind === 'reuse') this.cursor = action.index
      // Append ONLY the new entry: the retained entries keep their own kind/title (R3B-02).
      else { this.history = [...this.history.slice(0, this.cursor + 1), entry]; this.cursor = this.history.length - 1 }
    }
    const target: BrowserTarget = { kind: entry.kind, url: entry.url, title: entry.title }
    this.error = undefined
    // D14: project the requested target BEFORE the navigate invoke and persist it,
    // so the address bar/title never show a stale page while the target resolves.
    // The external exit is disabled while resolving: a forwarded target's logical
    // URL (a remote loopback) must never reach this machine's system browser.
    const revision = ++this.requestRevision
    this.loading = true
    this.addressMode = 'requested'
    this.externalUrl = null
    this.publish()
    const generation = ++this.generation
    await this.resolveAndNavigate({ revision, target }, generation)
  }

  private async resolveAndNavigate(
    request: { readonly revision: number; readonly target: BrowserTarget },
    generation: number,
  ): Promise<void> {
    const ref = await this.resolver.resolve(request.target).catch(() => undefined)
    if (this.disposed || generation !== this.generation) return
    if (ref === undefined) {
      this.externalUrl = null
      this.forwarded = false
      this.forwardedOrigin = undefined
      this.error = { code: undefined, description: 'forward-unavailable' }
      this.loading = false
      this.publish()
      return
    }
    const started = await this.start()
    if (this.disposed || generation !== this.generation) return
    if (!started || this.lease === undefined) return
    this.applyTargetRef(ref)
    // D14: externalUrl is part of the projected snapshot (the external exit).
    this.publish()
    const ack = await this.carrier.bridge.navigate({ tabId: this.options.tabId, lease: this.lease, target: toGuestTarget(ref) })
      .catch(() => ({ ok: false as const, code: 'unavailable' }))
    if (this.disposed || generation !== this.generation) return
    // A failed FORWARD keeps the exit disabled; a failed DIRECT page keeps the
    // logical URL fallback so it can still be opened in the system browser.
    if (!ack.ok) this.externalUrl = this.forwarded ? null : undefined
    this.projectAck(ack)
  }

  /**
   * Adopt one resolved target ref (forwarded alias projection or direct).
   * The CALLER publishes afterwards, so `externalUrl` enters the snapshot.
   */
  private applyTargetRef(ref: BrowserTargetRef): void {
    if (ref.kind === 'forward') {
      this.forwarded = true
      this.forwardedOrigin = canonicalOrigin(ref.externalUrl)
      this.externalUrl = ref.externalUrl
      return
    }
    this.forwarded = false
    this.forwardedOrigin = undefined
    this.externalUrl = undefined
  }

  /** Coalesce a keymap push: one send per burst, and only a changed combination set. */
  private scheduleKeymap(): void {
    if (this.keymapScheduled || this.disposed || this.lease === undefined) return
    this.keymapScheduled = true
    const flush = (): void => { this.keymapScheduled = false; void this.pushKeymap() }
    if (typeof queueMicrotask === 'function') queueMicrotask(flush)
    else setTimeout(flush, 0)
  }

  /** Send the effective combinations once; a read/throw failure is a no-op. */
  private async pushKeymap(): Promise<void> {
    const lease = this.lease
    const bridge = this.carrier.bridge
    const send = bridge.keymap
    const combos = bridge.combos
    if (this.disposed || lease === undefined || send === undefined || combos === undefined) return
    let next: readonly BrowserKeyCombo[]
    try { next = combos.read() } catch { return }
    const plan = planKeymapPush(true, this.lastKeymap, next)
    if (!plan.send || plan.combos === undefined) return
    let ack: { readonly ok: boolean; readonly code?: string }
    try { ack = await send.call(bridge, { tabId: this.options.tabId, lease, combos: plan.combos }) } catch { return }
    if (ack.ok && plan.remembered !== undefined && this.lease === lease) this.lastKeymap = plan.remembered
    // A refused keymap ack is a background edge (lease rotation/registry change):
    // stay as silent as the frame ack — it must never flash the load-failure bar.
    if (!ack.ok) console.debug('[chamber-browser] keymap push refused: ' + (ack.code ?? 'unknown'))
  }

  /** Guest command with a generation guard (RT-2 / R2-B). */
  private async command(command: 'goBack' | 'goForward' | 'reload' | 'stop'): Promise<void> {
    const lease = this.lease
    if (this.disposed || lease === undefined) return
    const generation = this.generation
    const ack = await this.carrier.bridge.command({ tabId: this.options.tabId, lease, command })
      .catch(() => ({ ok: false as const, code: 'unavailable' }))
    if (this.disposed || generation !== this.generation) return
    this.projectAck(ack)
  }

  /** Subscribe to the pushes; only this tab's lease is consumed. */
  private observePushes(): void {
    const events = this.carrier.bridge.events
    this.unsubscribe.push(events.state((value) => {
      const parsed = parseBrowserGuestState(value)
      if (parsed !== null) this.applyState(parsed)
    }))
    this.unsubscribe.push(events.openRequested((value) => {
      const parsed = parseBrowserOpenRequest(value)
      if (parsed === null || parsed.tabId !== this.options.tabId) return
      // RT-11: the push carries the opener occurrence's lease. A mismatching lease
      // is a stale/foreign occurrence (the opener's guest was replaced) and must
      // not open a tab; absent = older shim, accepted for compatibility.
      if (parsed.lease !== undefined && this.lease !== undefined && parsed.lease !== this.lease) return
      this.options.openRequested(parsed.url)
    }))
    this.unsubscribe.push(events.forwardNeeded((value) => {
      const parsed = parseBrowserForwardNeeded(value)
      if (parsed !== null) void this.handleForwardNeeded(parsed.tabId, parsed.url, parsed.lease)
    }))
  }

  /**
   * Project one accepted state push (D14/D15).
   *
   * Only a SETTLED (`loading:false`) push is a commit boundary: it adopts a
   * non-empty URL and its title. A `loading:true` push describes a provisional
   * navigation and may still carry the PREVIOUS page's URL (Swift publishes on
   * didStartProvisionalNavigation), so it must never move the target backwards —
   * the requested projection from load() stays authoritative until the finish
   * push. While the guest stays on a forwarded alias origin the LOGICAL target is
   * kept on screen; an empty URL never adopts.
   */
  private applyState(value: BrowserGuestState): void {
    if (!acceptsStatePush(this.disposed, this.options.tabId, value, this.lease)) return
    // Symmetric occlusion projection (R3B-04): an explicit occluded wins; a
    // visibility-only push means visible:false hides and visible:true clears.
    const occluded = value.occluded ?? (value.visible === undefined ? undefined : !value.visible)
    if (occluded !== undefined) this.presentation.setOccluded(occluded)
    this.error = value.error === undefined ? undefined : { code: value.error.code, description: value.error.description }
    this.loading = value.loading
    this.canGoBack = value.canGoBack
    this.canGoForward = value.canGoForward
    // D14 fix 2: only the finish/commit push may adopt. A late loading push that
    // carries page A must not roll the requested target B back to A.
    if (!value.loading) {
      if (value.url !== '') {
        const transition = transitionForwarded(this.forwarded, this.forwardedOrigin, value.url)
        this.forwarded = transition.forwarded
        this.forwardedOrigin = transition.origin
        if (transition.forwarded) {
          // The alias origin won the push: keep showing the logical target.
          if (this.currentEntry() !== undefined) this.addressMode = 'observed'
        } else {
          this.externalUrl = undefined
          if (this.adopt(value.url, value.title) !== undefined) this.addressMode = 'observed'
        }
      }
      this.applyTitle(value.title)
    }
    // publish() persists: the adopted address/title must survive a restart (D15).
    this.publish()
  }

  /**
   * Project a pushed title onto the current history entry (D15): only a REAL
   * change replaces the entry; the entry is immutable, so a new object is stored.
   */
  private applyTitle(title: string): void {
    if (title === '') return
    const entry = this.currentEntry()
    if (entry === undefined || entry.title === title) return
    this.history[this.cursor] = { ...entry, title }
  }

  /** Adopt a guest-reported URL: cursor moves on an existing entry (R2-B). */
  private adopt(url: string, pushedTitle?: string): BrowserTarget | undefined {
    if (url === '') return undefined
    if (canonicalOrigin(url) === undefined) return undefined
    let parsed: URL
    try { parsed = new URL(url) } catch { return undefined }
    const title = pushedTitle !== undefined && pushedTitle !== '' ? pushedTitle : parsed.host
    const entry: HistoryEntry = { kind: parsed.protocol === 'https:' ? 'https' : 'http', url: parsed.toString(), title }
    const action = historyAdoptAction(this.history.map(item => item.url), this.cursor, entry.url)
    if (action.kind === 'reuse') {
      this.cursor = action.index
      return this.history[action.index]
    }
    this.history = [...this.history.slice(0, this.cursor + 1), entry]
    this.cursor = this.history.length - 1
    return entry
  }

  /** Main suspended a guest main-frame navigation to a loopback target (design 28 §2.10). */
  private async handleForwardNeeded(tabId: string, url: string, lease: string | undefined): Promise<void> {
    if (this.disposed || tabId !== this.options.tabId) return
    // EDGE: the negotiation belongs to the CURRENT lease; a stale push is dropped.
    if (lease !== undefined && (this.lease === undefined || lease !== this.lease)) return
    // The push carries the SUSPENDED target B; the address on screen is the page
    // the link lives on (A). A != B is the normal case, so the URL is gated by
    // class (loopback target), never by equality with the current address (R4-01).
    if (!isLoopbackNegotiationTarget(url)) return
    // D14: the negotiation is a NEW navigation intent — bump the generation and the
    // request revision immediately, so an in-flight older load can never land.
    const generation = ++this.generation
    this.requestRevision += 1
    const entry: HistoryEntry = { kind: url.startsWith('https:') ? 'https' : 'http', url, title: '' }
    // The exit is disabled while the negotiation resolves (see load()).
    this.externalUrl = null
    const ref = await this.resolver.resolve({ kind: entry.kind, url, title: entry.title }).catch(() => undefined)
    if (!acceptsForwardNegotiation({
      disposed: this.disposed,
      generationMatches: generation === this.generation,
      leaseMatches: this.lease !== undefined && (lease === undefined || lease === this.lease),
    })) return
    if (ref === undefined) {
      this.error = { code: undefined, description: 'forward-unavailable' }
      this.externalUrl = null
      this.loading = false
      this.publish()
      return
    }
    const started = await this.start()
    // D14: re-verify AFTER the acquire await — disposed, a newer navigation or a
    // rotated lease must all drop this negotiation.
    if (!started || this.disposed || this.lease === undefined || generation !== this.generation) return
    if (lease !== undefined && lease !== this.lease) return
    // The negotiation IS the navigation intent: record B before loading its alias,
    // so the address bar and history show B instead of the page the link lived on.
    this.adopt(url)
    this.error = undefined
    this.loading = true
    this.addressMode = 'requested'
    this.applyTargetRef(ref)
    this.publish()
    const ack = await this.carrier.bridge.navigate({ tabId: this.options.tabId, lease: this.lease, target: toGuestTarget(ref) })
      .catch(() => ({ ok: false as const, code: 'unavailable' }))
    if (this.disposed || generation !== this.generation) return
    // The negotiation's target is a remote loopback: a failure must leave the
    // exit DISABLED, never fall back to the logical URL.
    if (!ack.ok) this.externalUrl = null
    this.projectAck(ack)
  }

  private currentEntry(): HistoryEntry | undefined {
    return this.cursor >= 0 ? this.history[this.cursor] : undefined
  }

  /** Write the projected snapshot and the persisted navigation checkpoint. */
  private publish(): void {
    this.store.set(this.projectState())
    this.options.persist({
      entries: [...this.history],
      index: this.cursor,
      request: this.currentEntry() === undefined ? undefined : { revision: this.requestRevision, target: this.currentEntry() as BrowserTarget },
      navigation: this.cursor < 0 ? { status: 'empty' } : { status: 'known', revision: this.requestRevision },
      failure: undefined,
    })
  }

  /** Project the snapshot from the application history/cursor (D14). */
  private projectState(): BrowserFrameState {
    const target = this.currentEntry()
    return {
      target,
      address: target === undefined ? 'empty' : this.addressMode,
      loading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      error: this.error,
      externalUrl: this.externalUrl,
    }
  }
}

/** Map the resolver's target ref onto the bridge payload. */
function toGuestTarget(ref: BrowserTargetRef): BrowserGuestTarget {
  return ref.kind === 'direct'
    ? { kind: 'direct', url: ref.url }
    : { kind: 'forward', recordId: ref.recordId, path: ref.path }
}

/** Idle placeholder report used when the acquire starts before the first report. */
const IDLE_FRAME_REPORT: BrowserFrameReport = {
  frame: { x: 0, y: 0, width: 0, height: 0 },
  visible: false,
  occluded: true,
}
