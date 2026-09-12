/**
 * Per-source open-in adapter (design 20 §5) — the single owner of
 *
 *  - **per-source dual-pool selection**: the instance-hosted application
 *    catalog (LOCAL sources only, served by the chamber host domain
 *    `openInApp/*` in `packages/dsh-chamber-seed-open-in`) merged with the
 *    page-wide desktop main-process pool through the pure view-model;
 *  - **per-entry channel routing**: local entries call that host domain over
 *    the entry's own connection carrier (its generic RPC already carries the
 *    per-instance base path, the browser-auth cookie and the trust fence);
 *    main entries ride the trusted preload IPC with the exact-boot source
 *    proof;
 *  - **the boot-level icon cache** keyed by app id, filled from the instance's
 *    own catalog: the host serves real bundle icons as base64 through the same
 *    channel, so each id is fetched at most once per boot (a failure is cached
 *    too — a missing icon must not be re-requested on every render) and the
 *    button keeps its fallback mark until the pixels arrive. The cache is read
 *    for EVERY channel (the main-process entry included): whichever channel
 *    launches an app, the mark is the host's own art when the instance could
 *    answer it (2026-09-12 thorough unification);
 *  - the persisted app choice.
 *
 * The React entry only consumes the resulting view-model plus this face, so the
 * routing rules are unit-testable without React, the DOM or a real instance.
 */
import {
  buildOpenInLaunchRequest,
  describeOpenInError,
  parseOpenInResult,
  type OpenInApp,
  type OpenInResult,
  type OpenInSource,
} from '../shared/capabilities.ts'
import {
  buildOpenInViewModel,
  type OpenInViewEntry,
  type OpenInViewModel,
} from '../shared/open-in-view-model.ts'
import { createLocalCatalog, type LocalCatalog, type OpenInAppRpcCall } from './local-catalog.ts'
import type { OpenInBridgeSurface, Translate } from '../shared/coordinator.ts'

/** The page-wide desktop main-process pool (the coordinator's shared probe). */
export interface OpenInMainPool {
  get(): readonly OpenInApp[] | null
  subscribe(listener: () => void): () => void
  refresh(): Promise<unknown>
}

/** The page-wide persisted choice store. */
export interface OpenInChoiceStore {
  get(): string
  set(appId: string): void
  subscribe(listener: () => void): () => void
}

export interface OpenInSourceAdapterDeps {
  readonly source: OpenInSource
  /** Exact-boot proof sent with every main-channel launch. */
  readonly sourceFingerprint: string
  readonly translate: Translate
  /**
   * This entry's generic-RPC carrier (`ctx.connection.rpc.call` with the
   * channel bound); absent = no instance channel, so LOCAL sources get no
   * catalog rather than a broken button.
   */
  readonly rpc?: OpenInAppRpcCall
  readonly mainPool: OpenInMainPool
  readonly choice: OpenInChoiceStore
  readonly platform?: string | null
  /** Test seam: local catalog factory (production: {@link createLocalCatalog}). */
  readonly createLocal?: (options: { call: OpenInAppRpcCall }) => LocalCatalog
  /** Test seam: preload bridge accessor (production: the window global). */
  readonly bridge?: () => OpenInBridgeSurface['dshChamber'] | undefined
}

export interface OpenInSourceAdapter {
  readonly source: OpenInSource
  readonly sourceFingerprint: string
  readonly platform: string | null
  getViewModel(): OpenInViewModel
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  launch(entry: OpenInViewEntry, path: string): Promise<OpenInResult>
  /** Cached host icon `data:` URL for an app id; null while unknown or when the
   *  instance serves none (the mark then uses its own fallback). */
  iconUrl(appId: string): string | null
  getChoice(): string
  choose(appId: string): void
  /** Release the pool subscriptions (plugin teardown). */
  dispose(): void
}

/**
 * Build the per-source adapter.
 * @param deps - per-entry source facts, the shared pools and test seams.
 * @returns the adapter face consumed by the header entry.
 */
export function createOpenInSourceAdapter(deps: OpenInSourceAdapterDeps): OpenInSourceAdapter {
  // The instance-hosted channel exists for LOCAL sources only, and only when
  // this entry carries a connection carrier.
  const local = deps.source.local && deps.rpc !== undefined
    ? (deps.createLocal ?? createLocalCatalog)({ call: deps.rpc })
    : null

  let localEntries: OpenInApp[] | null = null
  let localProbe: Promise<void> | null = null
  /** Boot-level icon cache: app id → data URL (null = the host serves none). */
  const icons = new Map<string, string | null>()
  /**
   * Tail of the icon-fetch queue. Batches are SERIALIZED rather than coalesced
   * with a `??=` single-flight: a refresh during an in-flight batch (the chevron
   * re-probes on every menu open and on window focus) can discover an id the
   * running batch does not carry, and coalescing would silently drop it until
   * the next refresh. Chaining keeps every discovered id, and the re-check at
   * run time still avoids a second fetch for an id the previous batch answered.
   * `LocalCatalog.icon` never rejects (it fails closed to null), so the queue
   * needs no rejection handling to stay alive.
   */
  let iconFlight: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }

  /**
   * Fetch the icons of the given entries once per boot, per id, in serialized
   * batches. Eager by design (design 20 §5): the catalog is small (only apps the
   * host actually resolved), each id is fetched at most once, and having the
   * pixels before the first render is what keeps the button from flashing a
   * fallback mark — upstream instead lets each `<img>` load on demand and pops
   * in. The eager set is exactly what the view-model can render.
   */
  const prefetchIcons = (entries: readonly OpenInApp[]): Promise<void> => {
    if (local === null) return Promise.resolve()
    const wanted = entries.filter(entry => !icons.has(entry.id))
    if (wanted.length === 0) return Promise.resolve()
    iconFlight = iconFlight.then(async () => {
      // Re-check at run time: a queued batch may find its ids already answered.
      const pending = wanted.filter(entry => !icons.has(entry.id))
      if (pending.length === 0) return
      await Promise.all(pending.map(async (entry) => {
        icons.set(entry.id, await local.icon(entry.id))
      }))
      emit()
    })
    return iconFlight
  }

  const loadLocal = (): Promise<void> => {
    if (local === null) return Promise.resolve()
    localProbe ??= local.load().then(async (entries) => {
      localEntries = entries
      emit()
      await prefetchIcons(entries)
    })
    return localProbe
  }

  const refresh = async (): Promise<void> => {
    localProbe = null
    await Promise.all([deps.mainPool.refresh(), loadLocal()])
  }

  const unsubscribeMain = deps.mainPool.subscribe(emit)
  const unsubscribeChoice = deps.choice.subscribe(emit)
  // Initial probe: both pools (the main pool's own single-flight probe may
  // already be warm; the instance read is this ctx's own).
  void refresh()

  const getViewModel = (): OpenInViewModel => buildOpenInViewModel({
    source: deps.source,
    localEntries,
    mainEntries: deps.mainPool.get(),
  })

  const bridgeAccessor = deps.bridge ?? ((): OpenInBridgeSurface['dshChamber'] => (
    window as unknown as OpenInBridgeSurface
  ).dshChamber)

  const launch = async (entry: OpenInViewEntry, path: string): Promise<OpenInResult> => {
    if (entry.channel === 'local') {
      if (local === null) return { ok: false, error: deps.translate('catalogUnavailable') }
      try {
        await local.launch(entry.id, path)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: describeOpenInError(error) }
      }
    }
    const bridge = bridgeAccessor()?.openIn
    if (bridge === undefined) return { ok: false, error: deps.translate('bridgeUnavailable') }
    const request = buildOpenInLaunchRequest(entry.id, deps.source, path, deps.sourceFingerprint)
    try {
      const raw = await bridge.open(request.appId, request.instanceId, request.path, request.sourceFingerprint)
      const result = parseOpenInResult(raw)
      return result ?? { ok: false, error: deps.translate('invalidResponse') }
    } catch (error) {
      return { ok: false, error: describeOpenInError(error) }
    }
  }

  return {
    source: deps.source,
    sourceFingerprint: deps.sourceFingerprint,
    platform: deps.platform ?? null,
    getViewModel,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh,
    launch,
    iconUrl: appId => icons.get(appId) ?? null,
    getChoice: () => deps.choice.get(),
    choose: appId => { deps.choice.set(appId) },
    dispose: () => {
      unsubscribeMain()
      unsubscribeChoice()
      listeners.clear()
    },
  }
}
