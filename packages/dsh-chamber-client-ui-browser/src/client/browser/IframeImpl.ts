/** Iframe navigation provider with bounded application-known history. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IframePresentation } from '../view/IframePresentation.ts'
import { emptyBrowserFrame, type BrowserFrame, type BrowserFrameState, type BrowserLoadError, type BrowserSandboxControl } from './BrowserFrame.ts'
import type { BrowserPageOptions } from './BrowserPage.ts'
import { BrowserNavigation } from './BrowserNavigation.ts'
import type { BrowserTarget } from './url.ts'

/**
 * FORK SEAM (chamber only): the URL the iframe actually loads for one logical
 * target. Upstream loaded `target.url` directly. The chamber fork resolves a
 * remote `127.0.0.1` target through an SSH forward lease and returns main's
 * composed frameUrl; a local (or non-loopback) target returns `target.url`.
 * `undefined` means the attach failed and the upstream failure bar must show.
 */
export interface BrowserFrameSrcResolver {
  /**
   * @param target - the logical, already validated navigation target.
   * @returns the exact iframe src, or undefined when it cannot be provided.
   */
  resolve(target: BrowserTarget): Promise<string | undefined>
  /**
   * Whether resolving this target acquires a forward lease. A forwarded target's
   * external URL is unknown until the attach settles, and the logical
   * `target.url` is the REMOTE loopback (opening it locally would hit this
   * machine's service), so the external exit must stay disabled meanwhile.
   * @param target - the logical, already validated navigation target.
   */
  forwards(target: BrowserTarget): boolean
  /** Release every forward lease this resolver acquired; repeated calls are safe. */
  dispose(): Promise<void>
}

/** Owns iframe navigation; the view reports loads without reading cross-origin content. */
export class IframeImpl implements BrowserFrame {
  readonly sandbox: BrowserSandboxControl = { setEnabled: (enabled) => { this.setSandbox(enabled) } }
  private readonly navigation: BrowserNavigation
  private readonly store: SnapshotStore<BrowserFrameState>
  private sandboxed = true
  private error: BrowserLoadError | undefined
  /** FORK DIFF: see BrowserFrameState.externalUrl (forwarded pages only; null = disabled). */
  private externalUrl: string | null | undefined
  private disposed = false
  private disposal: Promise<void> | undefined
  /** FORK SEAM: identifies the newest load so a late resolution cannot render. */
  private loadGeneration = 0

  /**
   * @param options - initial checkpoint and persistence writer.
   * @param presentation - iframe DOM adapter.
   * @param resolver - FORK SEAM: logical target → exact iframe src (forward lease).
   */
  constructor(
    private readonly options: BrowserPageOptions,
    private readonly presentation: IframePresentation,
    private readonly resolver: BrowserFrameSrcResolver,
  ) {
    this.navigation = new BrowserNavigation(options.initial)
    this.store = createSnapshotStore({ ...emptyBrowserFrame(), sandboxEnabled: this.sandboxed })
  }

  /**
   * Record a controlled load or a later navigation to an unreadable address.
   * @param revision - document generation whose iframe emitted load.
   */
  handleLoaded(revision: number): void {
    if (this.disposed) return
    this.navigation.frameLoaded(revision)
    this.publish()
  }

  /**
   * Publish a failure only for the current document generation.
   * @param revision - document generation whose iframe reported failure.
   */
  handleLoadFailed(revision: number): void {
    if (this.disposed || this.navigation.snapshot.request?.revision !== revision) return
    this.error = { code: undefined, description: undefined }
    this.publish()
  }

  /** @returns immutable navigation state. */
  getSnapshot = (): BrowserFrameState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** @param target - validated address; submitting the current address reloads it. */
  loadUrl(target: BrowserTarget): void {
    if (this.disposed) return
    const request = BrowserNavigation.current(this.navigation.snapshot)?.url === target.url
      ? this.navigation.reload() : this.navigation.navigate(target)
    this.load(request)
  }

  /** Move through application-known history while the iframe address remains known. */
  goBack(): void { if (!this.disposed) this.load(this.navigation.back()) }
  /** Move through application-known history while the iframe address remains known. */
  goForward(): void { if (!this.disposed) this.load(this.navigation.forward()) }
  /** Reload the last application-known address. */
  reload(): void { if (!this.disposed) this.load(this.navigation.reload()) }

  /** @returns after the presentation and every forward lease are released; repeated calls join disposal. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.presentation.dispose()
    // FORK DIFF: the forward lease (an SSH listener) dies with the page/tab.
    this.disposal = Promise.resolve(this.resolver.dispose()).then(() => undefined, () => undefined)
    return this.disposal
  }

  private setSandbox(enabled: boolean): void {
    if (this.disposed || enabled === this.sandboxed) return
    this.sandboxed = enabled
    if (this.store.getSnapshot().target === undefined) {
      this.store.set({ ...this.store.getSnapshot(), sandboxEnabled: enabled })
      return
    }
    this.load(this.navigation.reload())
  }

  private load(request: ReturnType<BrowserNavigation['navigate']> | undefined): void {
    if (request === undefined) return
    this.error = undefined
    // FORK DIFF: a forwarded target has no usable external URL until its lease
    // settles; falling back to target.url in that window would open the REMOTE
    // loopback on this machine (a local service). Direct targets keep the
    // upstream target.url fallback.
    this.externalUrl = this.resolver.forwards(request.target) ? null : undefined
    this.publish()
    // FORK DIFF: the src resolution is asynchronous (a remote loopback target is
    // first attached through the SSH forward lease). The newest load wins; a
    // failed resolution publishes the UPSTREAM failure bar (load.failed).
    const generation = ++this.loadGeneration
    void this.resolveAndShow(request, generation)
  }

  /** Resolve one load's src, then render it if this load is still the newest. */
  private async resolveAndShow(
    request: NonNullable<ReturnType<BrowserNavigation['navigate']>>,
    generation: number,
  ): Promise<void> {
    let url: string | undefined
    try {
      url = await this.resolver.resolve(request.target)
    } catch {
      url = undefined
    }
    if (this.disposed || generation !== this.loadGeneration) return
    if (url === undefined) {
      // A failed forward must not leave the system-browser exit pointing at the
      // remote logical loopback (that would open a LOCAL service instead).
      this.externalUrl = null
      this.handleLoadFailed(request.revision)
      return
    }
    // A forwarded page's visible target stays logical; only the system-browser
    // exit needs the alias URL (the iframe already got it as `url`).
    this.externalUrl = url === request.target.url ? undefined : url
    this.publish()
    this.presentation.show({ target: request.target, url, revision: request.revision, sandboxed: this.sandboxed })
  }

  private snapshot(): BrowserFrameState {
    const state = this.navigation.snapshot
    const target = BrowserNavigation.current(state)
    return { target, address: target === undefined ? 'empty' : state.navigation.status === 'unknown' ? 'unknown' : 'requested',
      loading: state.navigation.status === 'loading' && this.error === undefined,
      canGoBack: this.navigation.canGoBack, canGoForward: this.navigation.canGoForward,
      error: this.error, sandboxEnabled: this.sandboxed, externalUrl: this.externalUrl }
  }

  private publish(): void {
    this.store.set(this.snapshot())
    this.options.persist(this.navigation.snapshot)
  }
}
