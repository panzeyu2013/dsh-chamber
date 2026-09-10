/**
 * Per-source open-in adapter (Batch 3 Phase 2, plan §5.2) — the single owner of
 *
 *  - **per-source dual-pool selection**: the instance's official host catalog
 *    (LOCAL sources only) merged with the page-wide desktop main-process pool
 *    through the pure view-model;
 *  - **basePath remapping**: every official catalog/icon/launch URL is scoped to
 *    this entry's per-instance proxy prefix (`<basePath>/open-in-app/*`);
 *  - **per-entry channel routing**: official entries POST to the instance's own
 *    host route (the instance performs the launch); main entries ride the
 *    trusted preload IPC with the exact-boot source proof;
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
import { createOfficialCatalog, type OfficialCatalog } from './official-catalog.ts'
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
  /** Per-entry proxy prefix; undefined or '' = stock origin (no official channel for non-local sources). */
  readonly basePath: string | undefined
  readonly mainPool: OpenInMainPool
  readonly choice: OpenInChoiceStore
  readonly platform?: string | null
  /** Test seam: official catalog factory (production: {@link createOfficialCatalog}). */
  readonly createCatalog?: (options: { basePath: string }) => OfficialCatalog
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
  /** Host-served icon URL for an official entry; null when this source has no official channel. */
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
  // The official channel exists for LOCAL sources only, and only when the
  // entry Context carries a base path (per-instance proxy prefix).
  const catalog = deps.source.local && typeof deps.basePath === 'string'
    ? (deps.createCatalog ?? createOfficialCatalog)({ basePath: deps.basePath })
    : null

  let official: OpenInApp[] | null = null
  let officialProbe: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const loadOfficial = (): Promise<void> => {
    if (catalog === null) return Promise.resolve()
    officialProbe ??= catalog.load().then((entries) => {
      official = entries
      emit()
    })
    return officialProbe
  }

  const refresh = async (): Promise<void> => {
    officialProbe = null
    await Promise.all([deps.mainPool.refresh(), loadOfficial()])
  }

  const unsubscribeMain = deps.mainPool.subscribe(emit)
  const unsubscribeChoice = deps.choice.subscribe(emit)
  // Initial probe: both pools (the main pool's own single-flight probe may
  // already be warm; the official read is this ctx's own).
  void refresh()

  const getViewModel = (): OpenInViewModel => buildOpenInViewModel({
    source: deps.source,
    officialEntries: official,
    mainEntries: deps.mainPool.get(),
  })

  const bridgeAccessor = deps.bridge ?? ((): OpenInBridgeSurface['dshChamber'] => (
    window as unknown as OpenInBridgeSurface
  ).dshChamber)

  const launch = async (entry: OpenInViewEntry, path: string): Promise<OpenInResult> => {
    if (entry.channel === 'official') {
      if (catalog === null) return { ok: false, error: 'official catalog unavailable' }
      try {
        await catalog.launch(entry.id, path)
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
    iconUrl: appId => catalog?.iconUrl(appId) ?? null,
    getChoice: () => deps.choice.get(),
    choose: appId => { deps.choice.set(appId) },
    dispose: () => {
      unsubscribeMain()
      unsubscribeChoice()
      listeners.clear()
    },
  }
}
