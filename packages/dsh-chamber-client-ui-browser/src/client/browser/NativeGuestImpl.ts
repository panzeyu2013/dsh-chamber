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
    this.store = createSnapshotStore({ ...emptyFrame(), address: this.cursor < 0 ? 'empty' : 'requested' })
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
    const report = this.pendingFrame ?? { frame: { x: 0, y: 0, width: 0, height: 0 }, visible: false, occluded: true }
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
          this.publish()
        }
        // Retryable: the next start() (navigation/reload) attempts a fresh acquire.
        if (this.acquiring === attempt) this.acquiring = undefined
        return false
      }
      this.lease = plan.adopt as string
      this.scheduleKeymap()
      return true
    }).catch(() => {
      if (!this.disposed) {
        this.error = { code: undefined, description: 'unavailable' }
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

  /** Release the current lease once (idempotent). */
  private async releaseLease(): Promise<void> {
    const lease = this.lease
    this.lease = undefined
    this.lastKeymap = undefined
    if (lease === undefined) return
    await this.carrier.bridge.release({ tabId: this.options.tabId, lease }).catch(() => undefined)
  }

  /** Project one refused ack into the failure bar and clear loading. */
  private projectAck(ack: { readonly ok: boolean; readonly code?: string }): void {
    const failure = projectAckFailure(ack)
    if (failure === undefined) return
    this.error = failure
    const current = this.store.getSnapshot()
    this.store.set({ ...current, loading: false, error: failure })
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
    this.publish()
    const generation = ++this.generation
    await this.resolveAndNavigate({ revision: ++this.requestRevision, target }, generation)
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
      this.publish()
      return
    }
    const started = await this.start()
    if (this.disposed || generation !== this.generation) return
    if (!started || this.lease === undefined) return
    this.applyTargetRef(ref)
    this.publish()
    const ack = await this.carrier.bridge.navigate({ tabId: this.options.tabId, lease: this.lease, target: toGuestTarget(ref) })
      .catch(() => ({ ok: false as const, code: 'unavailable' }))
    if (this.disposed || generation !== this.generation) return
    if (!ack.ok) this.externalUrl = undefined
    this.projectAck(ack)
  }

  /** Adopt one resolved target ref (forwarded alias projection or direct). */
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

  private applyState(value: BrowserGuestState): void {
    if (!acceptsStatePush(this.disposed, this.options.tabId, value, this.lease)) return
    // Symmetric occlusion projection (R3B-04): an explicit occluded wins; a
    // visibility-only push means visible:false hides and visible:true clears.
    const occluded = value.occluded ?? (value.visible === undefined ? undefined : !value.visible)
    if (occluded !== undefined) this.presentation.setOccluded(occluded)
    this.error = value.error === undefined ? undefined : { code: value.error.code, description: value.error.description }
    const current = this.store.getSnapshot()
    const transition = transitionForwarded(this.forwarded, this.forwardedOrigin, value.url)
    this.forwarded = transition.forwarded
    this.forwardedOrigin = transition.origin
    if (!transition.forwarded) this.externalUrl = undefined
    const target = transition.forwarded && current.target !== undefined ? current.target : this.adopt(value.url)
    this.store.set({
      target,
      address: target === undefined ? 'empty' : 'observed',
      loading: value.loading,
      canGoBack: value.canGoBack,
      canGoForward: value.canGoForward,
      error: this.error,
      externalUrl: this.externalUrl,
    })
  }

  /** Adopt a guest-reported URL: cursor moves on an existing entry (R2-B). */
  private adopt(url: string): BrowserTarget | undefined {
    if (canonicalOrigin(url) === undefined) return undefined
    let parsed: URL
    try { parsed = new URL(url) } catch { return undefined }
    const entry: HistoryEntry = { kind: parsed.protocol === 'https:' ? 'https' : 'http', url: parsed.toString(), title: parsed.host }
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
    const generation = this.generation
    const entry: HistoryEntry = { kind: url.startsWith('https:') ? 'https' : 'http', url, title: '' }
    const ref = await this.resolver.resolve({ kind: entry.kind, url, title: entry.title }).catch(() => undefined)
    if (!acceptsForwardNegotiation({
      disposed: this.disposed,
      generationMatches: generation === this.generation,
      leaseMatches: this.lease !== undefined && (lease === undefined || lease === this.lease),
    })) return
    if (ref === undefined) {
      this.error = { code: undefined, description: 'forward-unavailable' }
      this.externalUrl = null
      this.publish()
      return
    }
    const started = await this.start()
    if (!started || this.lease === undefined || this.disposed) return
    // The negotiation IS the navigation intent: record B before loading its alias,
    // so the address bar and history show B instead of the page the link lived on.
    this.adopt(url)
    this.applyTargetRef(ref)
    this.publish()
    const ack = await this.carrier.bridge.navigate({ tabId: this.options.tabId, lease: this.lease, target: toGuestTarget(ref) })
      .catch(() => ({ ok: false as const, code: 'unavailable' }))
    if (!ack.ok) this.externalUrl = undefined
    this.projectAck(ack)
  }

  private currentEntry(): HistoryEntry | undefined {
    return this.cursor >= 0 ? this.history[this.cursor] : undefined
  }

  private publish(): void {
    this.store.set(this.store.getSnapshot())
    this.options.persist({
      entries: [...this.history],
      index: this.cursor,
      request: this.currentEntry() === undefined ? undefined : { revision: this.requestRevision, target: this.currentEntry() as BrowserTarget },
      navigation: this.cursor < 0 ? { status: 'empty' } : { status: 'known', revision: this.requestRevision },
      failure: undefined,
    })
  }
}

/** Map the resolver's target ref onto the bridge payload. */
function toGuestTarget(ref: BrowserTargetRef): BrowserGuestTarget {
  return ref.kind === 'direct'
    ? { kind: 'direct', url: ref.url }
    : { kind: 'forward', recordId: ref.recordId, path: ref.path }
}

/** Idle state for a tab that has not navigated yet. */
function emptyFrame(): BrowserFrameState {
  return {
    target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false,
    error: undefined, externalUrl: undefined,
  }
}