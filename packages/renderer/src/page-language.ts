/**
 * Page-language ownership (design 06 §4.6「页面语言归属」): the chamber mounts N instance
 * shells in ONE document, and every mounted shell's official locale service
 * writes the DOCUMENT-global `<html lang>` — at activation and on every
 * dictionary registration (`@deepseek-ai/dsh-client-locale` `apply()` →
 * `sync()` → `syncDocumentLanguage()`), with no teardown and no
 * active-source gate. The chamber's own chrome copy resolves through that
 * attribute (see `locales.ts`), so a prewarmed/background shell's write — and
 * in particular the browser-derived PROVISIONAL every shell writes before its
 * host settings answer — would otherwise flip the frame chrome between
 * languages for the whole boot train and let whichever shell wrote last own the
 * page.
 *
 * This module gives the page ONE owner:
 *
 *  - the page language is the language of the source ON SCREEN (`activeView`;
 *    the local instance by default — App.tsx publishes it);
 *  - and only once that source's settings surface has SETTLED (left the initial
 *    `loading` window). An UNRESOLVED provisional may never own the page, not
 *    even the on-screen one's; once settled, the instance's own effective
 *    language does — a stored preference, or (with none stored) the
 *    browser-derived value that instance's own UI keeps using;
 *  - no background shell may change it at all;
 *  - switching to a source whose settings have not answered keeps the current
 *    page language until they do (the switch waits for the instance to load).
 *
 * Framework-free on purpose: the rule is a pure projection over (current
 * language, on-screen source, per-source facts) so plain-node tests drive it
 * directly; {@link installPageLanguageOwner} is the DOM binding.
 */

import { DOCUMENT_LANGUAGE_ATTRIBUTE, FALLBACK_FRAME_LOCALE } from './locales.ts'

/**
 * Locale id → document language tag. Mirrors the vendor's own
 * `syncDocumentLanguage` (`snapshot.active === 'zh' ? 'zh-CN' : snapshot.active`)
 * so the page writes the tag the shell expected to write.
 * @param locale - a locale id from a shell's locale face (`zh` | `en`).
 * @returns the language tag for `<html lang>`.
 */
export function documentLanguageFor(locale: string): string {
  return locale === 'zh' ? 'zh-CN' : locale
}

/** The served markup's own default language (`index.html` `lang="zh-CN"`). */
export const SERVED_DOCUMENT_LANGUAGE = documentLanguageFor(FALLBACK_FRAME_LOCALE)

/** One mounted shell's language fact, reported by its own locale-service hook. */
export interface EntryLanguageFact {
  /** The entry's own effective locale id (its locale face's active value). */
  locale: string
  /**
   * True once this instance's settings surface settled (any status other than
   * the initial `loading`). Before that the face's value is the browser-derived
   * provisional, which must never own the page.
   */
  settled: boolean
}

/** The page-language state the owner projects over. */
export interface PageLanguageState {
  /** On-screen source id (`local` | `<kind>-<id>`); undefined until published. */
  activeSource?: string
  /** Per-source facts, keyed by source id. */
  facts: ReadonlyMap<string, EntryLanguageFact>
}

/**
 * Pure rule: the document language the page must show for one state, given the
 * language it currently shows. Returns `current` whenever no ON-SCREEN source
 * has a settled language yet — the served markup default on a cold load, or the
 * last sanctioned switch.
 * @param state - on-screen source plus every known per-source fact.
 * @param current - the language the page currently shows.
 * @returns the language the page must show.
 */
export function projectPageLanguage(state: PageLanguageState, current: string): string {
  const active = state.activeSource
  if (active === undefined) return current
  const fact = state.facts.get(active)
  if (fact === undefined || fact.settled !== true) return current
  return documentLanguageFor(fact.locale)
}

/** The document the owner reads and writes; injected so the rule stays testable. */
export interface PageLanguageHost {
  /** The document's current language attribute (empty string when unset). */
  read(): string
  /** Write the document's language attribute. */
  write(language: string): void
}

/**
 * The page-language state machine. It owns exactly ONE value — the language the
 * page must show — and restores it after every write it did not sanction: a
 * shell's `<html lang>` write is REPORTED here (the per-entry hook,
 * `locale-ownership.ts`) from the same synchronous task that produced it, so
 * the attribute never survives a paint in the wrong language. One vendor path
 * publishes nothing — the locale plugin's settings-row callback calls its
 * `sync()` directly — and is re-asserted by the install-time backstop observer
 * instead (a microtask later, still before paint).
 */
export class PageLanguageOwner {
  private readonly host: PageLanguageHost
  private language: string
  private activeSource: string | undefined
  private readonly facts = new Map<string, EntryLanguageFact>()
  /** Reporting MOUNT generation per source (see {@link report}). */
  private readonly generations = new Map<string, number>()

  /**
   * @param host - document adapter.
   * @param servedLanguage - the language the document shows before ownership
   * (the served markup's own default, read at install time).
   */
  constructor(host: PageLanguageHost, servedLanguage: string) {
    this.host = host
    this.language = servedLanguage
  }

  /** The language the page must show (observability/tests). */
  languageOf(): string {
    return this.language
  }

  /** The on-screen source the owner knows (observability/tests). */
  activeSourceOf(): string | undefined {
    return this.activeSource
  }

  /**
   * Declare which source is on screen. Its settled language takes over
   * immediately when known; otherwise the current language is kept until that
   * source reports one.
   * @param sourceId - the source id the App activated.
   */
  setActiveSource(sourceId: string): void {
    this.activeSource = sourceId
    this.recompute()
  }

  /**
   * Record (or clear) one mounted shell's language fact.
   *
   * Facts are keyed by source id, but a source can be MOUNTED more than once
   * over a session (a remount after a retry or a reclaim): the per-entry hook
   * therefore reports its mount generation, and a stale mount's report — or its
   * teardown — must never overwrite or erase the fact of a newer mount. Without
   * it, a retiring same-id mount could delete the live fact and the page would
   * keep the previous language until that shell's next locale event (the shell
   * invariant that would otherwise be load-bearing is "teardown precedes any
   * successor mount", design 05 §4).
   * @param sourceId - the reporting entry's source id.
   * @param fact - the fact, or undefined when that mount is gone.
   * @param serial - the reporting mount's generation; omitted = no mount
   * identity (direct callers, e.g. tests) — such a report always applies but
   * **never pins** the generation.
   */
  report(sourceId: string, fact: EntryLanguageFact | undefined, serial?: number): void {
    // 无身份的报送不得把世代钉死：写入 Infinity 会让此后该来源所有真实挂载
    // （有限世代）的报送与拆除被永久丢弃——一个 serial 缺省的 clear 之后，真挂载
    // 再报也不生效。语义 = 总是生效、
    // 且不动已记的世代（有身份的报送仍按世代排序）。
    if (serial === undefined) {
      if (fact === undefined) {
        this.generations.delete(sourceId)
        this.facts.delete(sourceId)
      } else {
        this.facts.set(sourceId, fact)
      }
      this.recompute()
      return
    }
    const generation = serial
    const current = this.generations.get(sourceId)
    if (current !== undefined && generation < current) return
    if (fact === undefined) {
      this.generations.delete(sourceId)
      this.facts.delete(sourceId)
    } else {
      this.generations.set(sourceId, generation)
      this.facts.set(sourceId, fact)
    }
    this.recompute()
  }

  /**
   * Restore the owned language after a write this owner did not sanction.
   * Sanctioned writes (this owner's own) read back identical and cost nothing.
   */
  enforce(): void {
    if (this.host.read() !== this.language) this.host.write(this.language)
  }

  /** Re-project the owned language; writes only on change. */
  private recompute(): void {
    const next = projectPageLanguage(
      { ...(this.activeSource === undefined ? {} : { activeSource: this.activeSource }), facts: this.facts },
      this.language,
    )
    if (next === this.language) {
      // A shell may have written a language this owner does not sanction in the
      // same task as the report (a dictionary registration): restore it now.
      this.enforce()
      return
    }
    this.language = next
    this.host.write(next)
  }
}

/**
 * The owner surface this module drives. Structural (not `instanceof`) because
 * the owner outlives this module instance: the frame entry (main.tsx) and the
 * composite entry (chamber-entry.ts) are separate chunks that share this module
 * only because today's single Rollup build hoists it into one shared chunk — a
 * re-evaluation (Vite HMR) or a future split build must still find the SAME
 * owner, or reports would silently vanish (frame stuck at the served language)
 * or two owners' observers would fight.
 */
interface PageOwner {
  setActiveSource(sourceId: string): void
  report(sourceId: string, fact: EntryLanguageFact | undefined, serial?: number): void
  enforce(): void
  languageOf(): string
  activeSourceOf(): string | undefined
}

/** Page-global slot holding {@link PageOwner} (one document, one owner). */
const OWNER_SLOT = '__dshChamberPageLanguageOwner__'

const pageGlobal = globalThis as unknown as Record<string, unknown>

/** Structural check for an owner installed by another evaluation of this module. */
function isPageOwner(value: unknown): value is PageOwner {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PageOwner>
  return typeof candidate.setActiveSource === 'function'
    && typeof candidate.report === 'function'
    && typeof candidate.enforce === 'function'
}

/** The page's owner, whoever installed it. */
function existingOwner(): PageOwner | undefined {
  const value = pageGlobal[OWNER_SLOT]
  return isPageOwner(value) ? value : undefined
}

/** One-shot diagnosis: a shell reported a language but no owner was installed. */
let missingOwnerWarned = false
function warnMissingOwner(): void {
  if (missingOwnerWarned || typeof document === 'undefined') return
  missingOwnerWarned = true
  console.warn(
    '[renderer] <html lang> ownership is not installed: a shell reported a language while no page owner exists '
    + '(main.tsx must call installPageLanguageOwner() before any shell boots)',
  )
}

/**
 * Take ownership of `<html lang>` for this page. MUST run before any instance
 * shell boots (main.tsx, before React mounts): the value the document carries
 * at that moment — the served markup's own default — is the page's cold-start
 * language, and every later shell write goes through the owner.
 *
 * Idempotent across calls AND module evaluations (the page-global slot is
 * adopted if it already holds an owner); a DOM-less process (plain-node
 * imports) is a no-op.
 */
export function installPageLanguageOwner(): void {
  if (existingOwner() !== undefined || typeof document === 'undefined') return
  const root = document.documentElement
  const served = (root.getAttribute(DOCUMENT_LANGUAGE_ATTRIBUTE) ?? '').trim()
  const owner = new PageLanguageOwner(
    {
      read: () => root.getAttribute(DOCUMENT_LANGUAGE_ATTRIBUTE) ?? '',
      write: language => { root.setAttribute(DOCUMENT_LANGUAGE_ATTRIBUTE, language) },
    },
    served === '' ? SERVED_DOCUMENT_LANGUAGE : served,
  )
  pageGlobal[OWNER_SLOT] = owner
  if (typeof MutationObserver !== 'undefined') {
    // Backstop for any writer that is not this owner's own projection: the
    // vendor's direct `sync()` from its settings-row callback (no locale-face
    // publish, so no report), a future document-global writer, a doctored page.
    // Sanctioned writes land in the same synchronous task as the shell's own
    // write, so this observer never sees a value that survived a paint.
    new MutationObserver(() => { owner.enforce() }).observe(root, {
      attributes: true,
      attributeFilter: [DOCUMENT_LANGUAGE_ATTRIBUTE],
    })
  }
}

/**
 * Publish the on-screen source (App is its only writer, in the same
 * layout-effect commit that publishes it to the page-wide chamberBridge).
 * @param sourceId - the App's active view id.
 */
export function setPageActiveSource(sourceId: string): void {
  existingOwner()?.setActiveSource(sourceId)
}

/**
 * Report one mounted shell's language fact (the per-entry ownership hook).
 * @param sourceId - the reporting entry's source id.
 * @param fact - the fact, or undefined when that mount's ctx is gone.
 * @param serial - the reporting mount's generation (see {@link PageLanguageOwner.report}).
 */
export function reportPageLanguageEntry(
  sourceId: string,
  fact: EntryLanguageFact | undefined,
  serial?: number,
): void {
  const owner = existingOwner()
  if (owner === undefined) {
    warnMissingOwner()
    return
  }
  owner.report(sourceId, fact, serial)
}
