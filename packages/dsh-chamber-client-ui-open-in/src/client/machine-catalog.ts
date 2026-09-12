/**
 * The machine's application catalog (design 20 §5, 2026-09-12 revision) — the
 * ONE page-level reader of "which apps are installed here, and what do their
 * icons look like".
 *
 * That question is a MACHINE fact, not a source fact. Upstream never separates
 * the two: one page is served by one host, so its client reads `apps` and
 * `icon/<id>` from `location.origin` and every source-shaped question (which
 * directory, which host) is answered by that same host. The chamber page
 * attaches N instances, which broke that identity — the catalog was read as
 * "the local SOURCE's pool", so a remote-ssh entry (whose own instance cannot
 * serve it: the host domain is `localOnly`, and upstream's resolver returns an
 * empty catalog under SSH anyway) had no icon source and fell back to a bundled
 * raster snapshot of one app.
 *
 * The fix restores upstream's own invariant for the machine half: the catalog
 * is read ONCE per page from the LOCAL instance's `openInApp/*` host domain
 * (the same domain, wire and trust fence the local source's entry uses) and
 * injected into every entry's Context. Each entry then only decides which of
 * those apps it can launch — the local channel on the machine itself, the
 * trusted IPC deeplink carrier for a remote target.
 *
 * This module owns the boot-level cache so that decision never re-reads the
 * host per source: catalog ids and icons are fetched at most once each per
 * page (failures cached too — a missing icon must not be re-requested on every
 * render), batches are serialized (a refresh during an in-flight batch must not
 * drop an id it discovered), and subscribers are notified as pixels arrive.
 * Callers re-probe it when it can have changed: each entry's boot and every
 * menu open (the page's main pool has its own window-focus release in
 * `coordinator.ts`; this catalog is not on that path).
 * `local-catalog.ts` below stays the pure wire parser; the transport is
 * injected, which in production is the page-level instance client for `local`.
 */
import type { OpenInApp } from '../shared/capabilities.ts'
import { createLocalCatalog, type LocalCatalogOptions } from './local-catalog.ts'

export interface MachineCatalog {
  /** Settled catalog snapshot; null before the first probe settles. */
  entries(): readonly OpenInApp[] | null
  /** Cached host icon `data:` URL for an app id; null while unknown or when the
   *  host serves none (the mark then draws its own fallback). */
  iconUrl(appId: string): string | null
  /** Re-probe the catalog (and prefetch any id the last probe did not answer).
   *  Concurrent callers share one probe — every entry asks the same question. */
  refresh(): Promise<void>
  subscribe(listener: () => void): () => void
  /** Launch one catalog app on one absolute directory path; rejects on failure. */
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
        // A subscriber must never poison the catalog: this notify runs inside
        // the probe and the icon flight, so a throw here would reject them and
        // silently stop every later batch from running. Listener failures are
        // the listener's own (the button's subscribers only set React state).
      }
    }
  }

  /**
   * Tail of the icon-fetch queue. Batches are SERIALIZED rather than coalesced
   * with a `??=` single-flight: a refresh during an in-flight batch can
   * discover an id the running batch does not carry, and coalescing would
   * silently drop it until the next refresh. Chaining keeps every discovered
   * id, and the re-check at run time still avoids a second fetch for an id the
   * previous batch answered. `LocalCatalog.icon` never rejects (it fails closed
   * to null), so the queue needs no rejection handling to stay alive.
   */
  let iconFlight: Promise<void> = Promise.resolve()

  /**
   * Fetch the icons of the given entries once per page, per id, in serialized
   * batches. Eager by design: the catalog is small (only apps the host actually
   * resolved), each id is fetched at most once, and having the pixels before
   * the first render is what keeps the button from flashing a fallback mark —
   * upstream instead lets each `<img>` load on demand and pops in.
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
   * The catalog read is single-flight, but ONLY the id read: every entry asks
   * the same question, so concurrent callers share one `apps()` call. The icon
   * batches are deliberately outside that window — they tail off asynchronously
   * and can take a while, and a refresh arriving during that tail (the chevron
   * re-probes on every menu open) must still re-read the ids rather than join a
   * probe whose app list was already decided.
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
    // Settle the icon queue as it stands now (this probe's batch included), so
    // an awaiting caller sees the same pixels a re-render would.
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
