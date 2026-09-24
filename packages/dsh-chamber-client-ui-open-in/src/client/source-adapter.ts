/**
 * Per-source open-in adapter — the single owner of
 *
 *  - **the rendered set**: the page’s machine catalog (LOCAL instance’s
 *    `openInApp/*` host domain, read once per page and injected into every
 *    entry) merged with the page-wide main-process pool through the pure
 *    view-model. A remote-ssh source keeps only what the main provider declares
 *    `remoteCapable`;
 *  - **per-entry channel routing**: local entries call the host domain over the
 *    machine catalog’s transport (same wire and trust fence as the local
 *    source’s own entry); main entries ride trusted preload IPC with the
 *    exact-boot source proof;
 *  - the persisted app choice.
 *
 * Icons are NOT cached here: ids and icons are machine facts, owned by the
 * page-level catalog — a per-source copy would re-fetch the same pixels.
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
import type { MachineCatalog } from './machine-catalog.ts'
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
   * The page’s machine catalog, built once by the renderer shell for the LOCAL
   * instance and shared by every entry. Absent = no machine reader on this page,
   * so the local pool stays empty instead of the button breaking.
   */
  readonly machineCatalog?: MachineCatalog | null
  readonly mainPool: OpenInMainPool
  readonly choice: OpenInChoiceStore
  readonly platform?: string | null
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
  /** Cached machine icon `data:` URL for an app id; null while unknown or unserved. */
  iconUrl(appId: string): string | null
  getChoice(): string
  choose(appId: string): void
  /** Release the pool subscriptions (plugin teardown). */
  dispose(): void
}

/** Build the per-source adapter: per-entry source facts, shared pools and test seams. */
export function createOpenInSourceAdapter(deps: OpenInSourceAdapterDeps): OpenInSourceAdapter {
  const machine = deps.machineCatalog ?? null

  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const refresh = async (): Promise<void> => {
    await Promise.all([
      deps.mainPool.refresh(),
      machine === null ? Promise.resolve() : machine.refresh(),
    ])
  }

  const unsubscribeMain = deps.mainPool.subscribe(emit)
  const unsubscribeChoice = deps.choice.subscribe(emit)
  const unsubscribeMachine = machine === null ? null : machine.subscribe(emit)
  // Initial probe: the main pool’s single-flight probe may already be warm;
  // the machine catalog’s is shared by every entry and coalesced there.
  void refresh()

  const getViewModel = (): OpenInViewModel => buildOpenInViewModel({
    source: deps.source,
    localEntries: machine === null ? null : machine.entries(),
    mainEntries: deps.mainPool.get(),
  })

  const bridgeAccessor = deps.bridge ?? ((): OpenInBridgeSurface['dshChamber'] => (
    window as unknown as OpenInBridgeSurface
  ).dshChamber)

  const launch = async (entry: OpenInViewEntry, path: string): Promise<OpenInResult> => {
    if (entry.channel === 'local') {
      if (machine === null) return { ok: false, error: deps.translate('catalogUnavailable') }
      try {
        await machine.launch(entry.id, path)
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
    iconUrl: appId => (machine === null ? null : machine.iconUrl(appId)),
    getChoice: () => deps.choice.get(),
    choose: appId => { deps.choice.set(appId) },
    dispose: () => {
      unsubscribeMain()
      unsubscribeChoice()
      unsubscribeMachine?.()
      listeners.clear()
    },
  }
}
