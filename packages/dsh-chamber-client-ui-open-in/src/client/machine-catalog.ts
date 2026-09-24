/**
 * The machine’s application catalog — the ONE page-level reader of "which apps
 * are installed here, and what do their icons look like".
 *
 * That question is a MACHINE fact, not a source fact. Upstream never separates
 * the two (one page = one host), but the chamber page attaches N instances and a
 * remote-ssh entry has no icon source of its own (the host domain is
 * `localOnly`). The catalog is therefore read ONCE per page from the LOCAL
 * instance's `openInApp/*` host domain and injected into every entry's Context;
 * each entry only decides which apps it can launch.
 *
 * Owns the boot-level cache so that decision never re-reads the host per source:
 * ids and icons are fetched at most once each per page (failures cached too),
 * batches are serialized so a refresh cannot drop an id it discovered, and
 * subscribers are notified as pixels arrive. `local-catalog.ts` is the pure wire
 * parser; the transport is injected.
 */
import type { OpenInApp } from '../shared/capabilities.ts'
import { createLocalCatalog, type LocalCatalogOptions } from './local-catalog.ts'

export interface MachineCatalog {
  /** Settled catalog snapshot; null before the first probe settles. */
  entries(): readonly OpenInApp[] | null
  /** Cached host icon `data:` URL for an app id; null while unknown or when the
   *  host serves none (the mark then draws its own fallback). */
  iconUrl(appId: string): string | null
  /** Re-probe the catalog and prefetch any unanswered id. Concurrent callers
   *  share one probe — every entry asks the same question. */
  refresh(): Promise<void>
  subscribe(listener: () => void): () => void
  launch(appId: string, path: string): Promise<void>
}

/**
 * Build the page's machine catalog over one transport.
 * @param options - the injected call (see `LocalCatalogOptions`).
 * @returns the cached, subscribable catalog face handed to every entry.
 */
export function createMachineCatalog(options: LocalCatalogOptions): MachineCatalog {
  const catalog = createLocalCatalog(options)

  let entries: readonly OpenInApp[] | null = null
  /** Boot-level icon cache: app id → data URL (null = the host serves none). */
  const icons = new Map<string, string | null>()
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A subscriber must never poison the catalog: this notify runs inside the
        // probe and the icon flight, so a throw here would stop every later batch.
      }
    }
  }

  /**
 * Tail of the icon-fetch queue. Batches are SERIALIZED rather than coalesced:
   * a refresh during an in-flight batch can discover an id that batch does not
   * carry, and coalescing would silently drop it until the next refresh. The
   * re-check at run time still avoids a second fetch for an answered id.
   */
  let iconFlight: Promise<void> = Promise.resolve()

  /**
 * Fetch the icons of the given entries once per page, per id, in serialized
   * batches. Eager by design: having the pixels before the first render keeps the
   * button from flashing a fallback mark.
   */
  const prefetchIcons = (list: readonly OpenInApp[]): Promise<void> => {
    const wanted = list.filter(entry => !icons.has(entry.id))
    if (wanted.length === 0) return Promise.resolve()
    iconFlight = iconFlight.then(async () => {
      // Re-check at run time: a queued batch may find its ids already answered.
      const pending = wanted.filter(entry => !icons.has(entry.id))
      if (pending.length === 0) return
      await Promise.all(pending.map(async (entry) => {
        icons.set(entry.id, await catalog.icon(entry.id))
      }))
      emit()
    })
    return iconFlight
  }

  /**
 * The catalog read is single-flight, but ONLY the id read: concurrent callers
   * share one `apps()` call. The icon batches are deliberately outside that
   * window — they tail off asynchronously, and a refresh arriving during that
   * tail must re-read the ids rather than join a decided app list.
   */
  let probing: Promise<void> | null = null
  const probeCatalog = (): Promise<void> => {
    probing ??= catalog.load().then((list) => {
      entries = list
      emit()
      void prefetchIcons(list)
    }).finally(() => { probing = null })
    return probing
  }

  const refresh = async (): Promise<void> => {
    await probeCatalog()
    // Settle the icon queue as it stands now (this probe’s batch included).
    await iconFlight
  }

  // Initial probe: the page wants the machine's apps as soon as it boots, and
  // every entry that subscribes later reads the settled snapshot.
  void refresh()

  return {
    entries: () => entries,
    iconUrl: appId => icons.get(appId) ?? null,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    launch: (appId, path) => catalog.launch(appId, path),
  }
}
