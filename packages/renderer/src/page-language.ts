/**
 * Page-language ownership: the chamber mounts N instance shells in ONE document,
 * and every mounted shell's official locale service writes the DOCUMENT-global
 * `<html lang>` (activation + every dictionary registration, no teardown, no
 * active-source gate). The chamber's chrome copy resolves through that attribute
 * (`locales.ts`), so a prewarmed shell's write — in particular the browser-derived
 * PROVISIONAL every shell writes before its host settings answer — would otherwise
 * flip the page chrome between languages (last-writer-wins).
 *
 * This module gives the page ONE owner: the language of the source ON SCREEN
 * (`activeView`), and only once that source's settings surface has SETTLED (left
 * the initial `loading`). No background shell may change it; switching to a source
 * whose settings have not answered keeps the current language until they do. The
 * rule is a pure projection; {@link installPageLanguageOwner} is the DOM binding.
 */

import { DOCUMENT_LANGUAGE_ATTRIBUTE, FALLBACK_FRAME_LOCALE } from './locales.ts'

/** Locale id → document language tag, mirroring the vendor's own `syncDocumentLanguage` (`zh` → `zh-CN`). */
export function documentLanguageFor(locale: string): string {
  return locale === 'zh' ? 'zh-CN' : locale
}

/** The served markup's own default language (`index.html` `lang="zh-CN"`). */
export const SERVED_DOCUMENT_LANGUAGE = documentLanguageFor(FALLBACK_FRAME_LOCALE)

/** One mounted shell's language fact, reported by its own locale-service hook. */
export interface EntryLanguageFact {
  /** The entry's own effective locale id (its locale face's active value). */
  locale: string
  /** True once the instance's settings surface settled (any status except `loading`); before that the value is the browser-derived provisional. */
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
 * Pure rule: the document language for one state, given the language it currently
 * shows. Returns `current` until an ON-SCREEN source has a settled language — the
 * served markup default on a cold load, or the last sanctioned switch.
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
 * The page-language state machine: owns exactly ONE value and restores it after
 * every unsanctioned write. Writes are reported from the same synchronous task
 * that produced them, so the attribute never survives a paint in the wrong
 * language; one vendor path (the settings-row callback calling `sync()` directly)
 * publishes nothing and is caught by the install-time backstop observer.
 */
export class PageLanguageOwner {
  private readonly host: PageLanguageHost
  private language: string
  private activeSource: string | undefined
  private readonly facts = new Map<string, EntryLanguageFact>()
  /** Reporting MOUNT generation per source (see {@link report}). */
  private readonly generations = new Map<string, number>()

  /** @param servedLanguage - the language the document shows before ownership (the served markup's default, read at install time). */
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
   * Declare which source is on screen; its settled language takes over immediately
   * when known, otherwise the current language is kept until that source reports.
   */
  setActiveSource(sourceId: string): void {
    this.activeSource = sourceId
    this.recompute()
  }

  /**
   * Record (or clear) one mounted shell's language fact.
   *
   * A source can be MOUNTED more than once per session (remount after retry or
   * reclaim), so the per-entry hook reports its mount generation: a stale mount's
   * report or teardown must never overwrite or erase a newer mount's fact.
   * `serial` omitted = no mount identity — always applies but **never pins** the
   * generation.
   */
  report(sourceId: string, fact: EntryLanguageFact | undefined, serial?: number): void {
    // 无身份的报送不得把世代钉死（写入 Infinity 会永久丢弃该来源此后所有真实挂载
    // 的报送与拆除）：总是生效、且不动已记的世代；有身份的报送仍按世代排序。
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

  /** Restore the owned language after an unsanctioned write; sanctioned writes read back identical. */
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
 * The owner surface this module drives. Structural (not `instanceof`): the frame
 * entry (main.tsx) and the composite entry (chamber-entry.ts) are separate chunks
 * that must find the SAME owner across re-evaluation or a future split build, or
 * reports would silently vanish / two owners' observers would fight.
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
 * Take ownership of `<html lang>`; MUST run before any shell boots (main.tsx,
 * before React mounts) — the value then in the document is the cold-start
 * language. Idempotent across calls and module evaluations; DOM-less process =
 * no-op.
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
    // Backstop for any writer that is not this owner's projection (the vendor's
    // direct sync() from its settings-row callback, a future global writer, a
    // doctored page): sanctioned writes land in the same synchronous task, so this
    // never sees a value that survived a paint.
    new MutationObserver(() => { owner.enforce() }).observe(root, {
      attributes: true,
      attributeFilter: [DOCUMENT_LANGUAGE_ATTRIBUTE],
    })
  }
}

/** Publish the on-screen source (App is the only writer, in the same layout-effect commit that publishes it to chamberBridge). */
export function setPageActiveSource(sourceId: string): void {
  existingOwner()?.setActiveSource(sourceId)
}

/** Report one mounted shell's language fact (the per-entry ownership hook). */
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
