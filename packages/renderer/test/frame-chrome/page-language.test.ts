/**
 * Page-language ownership (design 06 §4.6「页面语言归属」).
 *
 * The defect this spec pins: N instance shells share ONE document, and every
 * mounted shell's official locale service writes the DOCUMENT-global
 * `<html lang>` at activation and on every dictionary registration (no
 * teardown, no active-source gate). The chamber frame's own copy resolves
 * through that attribute (`locales.ts`), so during the boot train the frame
 * chrome — the local source's display name among others — alternated between
 * languages, and whichever shell wrote last owned the page.
 *
 * `page-language.ts` is framework-free on purpose, so the rule and its state
 * machine are driven here directly through an injected document adapter (a fake
 * host makes "no write happened" provable). The WIRING — that the owner is
 * installed before React mounts, that App publishes the on-screen source, and
 * that the composite decorates the vendor locale mount with the ownership hook —
 * is pinned by source-text locks: these files render (or boot) the whole shell
 * and cannot be imported by a plain `node test/…` run.
 *
 * LIMITS, stated honestly: this spec proves the projection rule, the restore
 * behavior and the call sites; it does not boot a real shell, so the vendor's
 * own write timing is argued in `locale-ownership.ts` (documented against the
 * installed vendor package) rather than executed here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  documentLanguageFor,
  PageLanguageOwner,
  projectPageLanguage,
  SERVED_DOCUMENT_LANGUAGE,
  type EntryLanguageFact,
} from '../../src/page-language.ts'
import { resolveFrameLocale } from '../../src/locales.ts'
import { normalize, stripComments } from '../support/source-text.ts'

/** Comment-stripped, whitespace-collapsed source: the semantic text of a file. */
const read = (rel: string): string =>
  normalize(stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')))

/** A fake document: every write is recorded, so "no write" is provable. */
function fakeDocument(initial: string) {
  const writes: string[] = []
  let language = initial
  return {
    writes,
    language: () => language,
    host: {
      read: () => language,
      write: (next: string) => { language = next; writes.push(next) },
    },
    /** One shell's unconditional `document.documentElement.lang = …` write. */
    shellWrite: (next: string) => { language = next },
  }
}

// ── The pure rule ───────────────────────────────────────────────────────────

test('locale ids map to the language tags the vendor service writes', () => {
  assert.equal(documentLanguageFor('zh'), 'zh-CN')
  assert.equal(documentLanguageFor('en'), 'en')
  // The served markup's own default is the frame's fallback locale.
  assert.equal(SERVED_DOCUMENT_LANGUAGE, 'zh-CN')
})

test('the values the owner writes are the ones the frame chrome resolves', () => {
  // The owner writes a document language tag; the frame chrome reads it back
  // through resolveFrameLocale. Pin the pair so a mapping drift on either side
  // (e.g. writing a bare 'zh' the frame would still resolve, or a tag the frame
  // collapses to the wrong locale) is a visible failure here.
  assert.equal(resolveFrameLocale(SERVED_DOCUMENT_LANGUAGE), 'zh')
  assert.equal(resolveFrameLocale(documentLanguageFor('en')), 'en')
  assert.equal(resolveFrameLocale(documentLanguageFor('zh')), 'zh')
})

test('the page follows only the ON-SCREEN source, and only once its settings answered', () => {
  const facts = (entries: ReadonlyArray<readonly [string, EntryLanguageFact]>) => new Map(entries)
  // No on-screen source yet (owner installed, App has not published): keep.
  assert.equal(projectPageLanguage({ facts: facts([]) }, 'zh-CN'), 'zh-CN')
  // On-screen source without a fact (still booting): keep.
  assert.equal(projectPageLanguage({ activeSource: 'local', facts: facts([]) }, 'zh-CN'), 'zh-CN')
  // On-screen source whose host settings have NOT answered: its browser-derived
  // provisional must never own the page.
  assert.equal(
    projectPageLanguage({ activeSource: 'local', facts: facts([['local', { locale: 'en', settled: false }]]) }, 'zh-CN'),
    'zh-CN',
  )
  // On-screen source, answered: the page follows it.
  assert.equal(
    projectPageLanguage({ activeSource: 'local', facts: facts([['local', { locale: 'en', settled: true }]]) }, 'zh-CN'),
    'en',
  )
  // A BACKGROUND source, answered, can never move the page.
  assert.equal(
    projectPageLanguage({
      activeSource: 'local',
      facts: facts([['local', { locale: 'zh', settled: true }], ['gateway-a', { locale: 'en', settled: true }]]),
    }, 'zh-CN'),
    'zh-CN',
  )
})

// ── The state machine ───────────────────────────────────────────────────────

test('a cold start keeps the served language while the on-screen shell writes its provisional', () => {
  const doc = fakeDocument('zh-CN')
  const owner = new PageLanguageOwner(doc.host, 'zh-CN')
  owner.setActiveSource('local')
  // The shell's locale plugin activates: it writes the browser-derived
  // provisional (`en`, the chamber bundle ships en-US) before its host settings
  // answer — the write the reported flicker started with.
  doc.shellWrite('en')
  owner.report('local', { locale: 'en', settled: false })
  assert.equal(owner.languageOf(), 'zh-CN', 'a provisional language must never own the page')
  assert.equal(doc.language(), 'zh-CN', 'the unsanctioned write is restored')
  assert.deepEqual(doc.writes, ['zh-CN'], 'exactly one restore write, in the same synchronous task')
  // The host answers "zh": the page is already there — no write, no flicker.
  owner.report('local', { locale: 'zh', settled: true })
  assert.equal(owner.languageOf(), 'zh-CN')
  assert.deepEqual(doc.writes, ['zh-CN'])
})

test('an answered on-screen source switches the page exactly once', () => {
  const doc = fakeDocument('zh-CN')
  const owner = new PageLanguageOwner(doc.host, 'zh-CN')
  owner.setActiveSource('local')
  doc.shellWrite('en')
  owner.report('local', { locale: 'en', settled: false })
  assert.deepEqual(doc.writes, ['zh-CN'])
  // Host answers "en" for this instance: the on-screen source's SETTLED
  // language takes over — one clean switch, which is the language-setting
  // contract (design 05 §4), not a race.
  owner.report('local', { locale: 'en', settled: true })
  assert.equal(owner.languageOf(), 'en')
  assert.equal(doc.language(), 'en')
  assert.deepEqual(doc.writes, ['zh-CN', 'en'])
})

test('a background shell can never move the page, boot or late registration', () => {
  const doc = fakeDocument('zh-CN')
  const owner = new PageLanguageOwner(doc.host, 'zh-CN')
  owner.setActiveSource('local')
  owner.report('local', { locale: 'zh', settled: true })
  // A prewarmed remote boots with its own (en) settings and writes the document
  // on activation and on every dictionary registration.
  doc.shellWrite('en')
  owner.report('gateway-a', { locale: 'en', settled: true })
  assert.equal(owner.languageOf(), 'zh-CN')
  assert.equal(doc.language(), 'zh-CN')
  assert.deepEqual(doc.writes, ['zh-CN'])
  // …and every later registration is the same story.
  doc.shellWrite('en')
  owner.report('gateway-a', { locale: 'en', settled: true })
  assert.equal(doc.language(), 'zh-CN')
  assert.deepEqual(doc.writes, ['zh-CN', 'zh-CN'])
})

test('switching waits for a source that has not loaded, and is immediate for one that has', () => {
  const doc = fakeDocument('zh-CN')
  const owner = new PageLanguageOwner(doc.host, 'zh-CN')
  owner.setActiveSource('local')
  owner.report('local', { locale: 'zh', settled: true })
  // Already-known source: its settled language takes over immediately.
  owner.report('gateway-a', { locale: 'en', settled: true })
  owner.setActiveSource('gateway-a')
  assert.equal(owner.languageOf(), 'en')
  // Not-yet-loaded source: keep the current page language…
  owner.setActiveSource('gateway-b')
  assert.equal(owner.languageOf(), 'en')
  // …until it reports its own settled language (the instance "loaded").
  owner.report('gateway-b', { locale: 'zh', settled: true })
  assert.equal(owner.languageOf(), 'zh-CN')
  // Back to the local instance: known, so immediate.
  owner.setActiveSource('local')
  assert.equal(owner.languageOf(), 'zh-CN')
})

test('a retired entry drops its fact and the page keeps its current language', () => {
  const doc = fakeDocument('zh-CN')
  const owner = new PageLanguageOwner(doc.host, 'zh-CN')
  owner.setActiveSource('gateway-a')
  owner.report('gateway-a', { locale: 'en', settled: true })
  assert.equal(owner.languageOf(), 'en')
  owner.report('gateway-a', undefined)
  assert.equal(owner.languageOf(), 'en', 'no fact is not a language change')
  assert.equal(owner.activeSourceOf(), 'gateway-a')
})

test('a retiring mount cannot erase a newer mount\'s fact', () => {
  const doc = fakeDocument('zh-CN')
  const owner = new PageLanguageOwner(doc.host, 'zh-CN')
  owner.setActiveSource('gateway-a')
  // Mount 1 of the source is on screen and answers "en".
  owner.report('gateway-a', { locale: 'en', settled: true }, 1)
  assert.equal(owner.languageOf(), 'en')
  // The source is REMOUNTED (retry). Mount 2 reports "zh", and then mount 1's
  // teardown lands — it must not erase the live fact.
  owner.report('gateway-a', { locale: 'zh', settled: true }, 2)
  assert.equal(owner.languageOf(), 'zh-CN')
  owner.report('gateway-a', undefined, 1)
  // Prove the fact survived: move away and back — the page must return to the
  // live mount's language (an erased fact would leave it at "en").
  owner.setActiveSource('local')
  owner.report('local', { locale: 'en', settled: true }, 3)
  assert.equal(owner.languageOf(), 'en')
  owner.setActiveSource('gateway-a')
  assert.equal(owner.languageOf(), 'zh-CN', 'the live mount still owns the fact')
  // The live mount\'s own teardown (matching generation) DOES drop it.
  owner.report('gateway-a', undefined, 2)
  owner.setActiveSource('local')
  owner.setActiveSource('gateway-a')
  assert.equal(owner.languageOf(), 'en', 'a dropped fact is not a language change')
})

test('enforce restores any write the owner did not sanction', () => {
  const doc = fakeDocument('zh-CN')
  const owner = new PageLanguageOwner(doc.host, 'zh-CN')
  owner.setActiveSource('local')
  owner.report('local', { locale: 'zh', settled: true })
  doc.shellWrite('en')
  owner.enforce()
  assert.equal(doc.language(), 'zh-CN')
  assert.deepEqual(doc.writes, ['zh-CN'])
  // Sanctioned values read back identical: enforce costs no write.
  owner.enforce()
  assert.deepEqual(doc.writes, ['zh-CN'])
})

// ── Wiring locks (source text) ──────────────────────────────────────────────

test('the page-language owner is installed before React mounts', () => {
  const main = read('../../src/main.tsx')
  const installed = main.indexOf('installPageLanguageOwner()')
  const mounted = main.indexOf('createRoot(')
  assert.ok(installed >= 0, 'main.tsx must install the owner')
  assert.ok(mounted >= 0, 'main.tsx must still mount the app')
  assert.ok(installed < mounted, 'ownership must be taken BEFORE any shell can boot')
  assert.match(
    main,
    /import { installPageLanguageOwner } from '\.\/page-language\.ts'/,
    'the installer must come from the ownership module',
  )
})

test('App publishes the on-screen source to the page-language owner', () => {
  const app = read('../../src/App.tsx')
  // The same layout-effect commit that publishes "who is on screen" to the
  // page-wide bridge publishes it to the language owner: switching views must
  // not leave the page language behind for a frame. The body may carry SIBLING
  // document-global publications (the theme lock is written the same tolerant
  // way), so the effect is located first and both calls are asserted inside it.
  const effect = /useLayoutEffect\(\(\) => \{([\s\S]*?)\}, \[activeView\]\)/.exec(app)
  assert.ok(effect !== null, 'the active view must be published in a layout effect keyed on activeView')
  assert.match(effect[1]!, /chamberBridge\.setActiveSource\(activeView\)/, 'the page-wide bridge publish must stay')
  assert.match(effect[1]!, /setPageActiveSource\(activeView\)/, 'the page-language owner publish must stay')
})

test('the composite decorates the vendor locale mount with the ownership hook', () => {
  const entry = read('../../src/chamber-entry.ts')
  assert.match(
    entry,
    /const MOUNT_DECORATORS: Readonly<Record<string, \(plugin: object\) => object>> = \{ '@deepseek-ai\/dsh-client-locale': withLocaleOwnership, \}/,
    'the locale mount must carry the ownership hook',
  )
  assert.match(entry, /ctx\.plugin\(decorateMount\(id, plugin\)\)/, 'register() must mount the decorated namespace')
  // BOTH mount paths carry decorators: moving a decorated id into the deferred
  // cluster must not silently drop its hook.
  assert.match(
    entry,
    /ctx\.plugin\(decorateMount\(outcome\.id, \{ \.\.\.loaded, name: outcome\.id \}\)\)/,
    'the deferred mount must go through the decorators too',
  )
  // The roster audit resolves each id through its namespace import — the call
  // site must keep passing the imported namespace itself.
  assert.match(
    entry,
    /register\('@deepseek-ai\/dsh-client-locale', Locale\)/,
    'the locale registration call site must keep its namespace import',
  )
})

test('the owner is a page-global singleton, not a module-local binding', () => {
  const owner = read('../../src/page-language.ts')
  // The frame entry and the composite entry are separate chunks; a re-evaluation
  // or a future split build must still find the SAME owner (or reports vanish /
  // two observers fight).
  assert.match(owner, /const OWNER_SLOT = '__dshChamberPageLanguageOwner__'/)
  assert.match(owner, /pageGlobal\[OWNER_SLOT\] = owner/)
  assert.match(owner, /function existingOwner\(\): PageOwner \| undefined \{/)
  assert.match(owner, /function setPageActiveSource\(sourceId: string\): void \{ existingOwner\(\)\?\.setActiveSource\(sourceId\) \}/)
  assert.match(owner, /function reportPageLanguageEntry\(/, 'reports must reach the page-global owner')
})

test('the per-entry hook reads the vendor faces and fails open without them', () => {
  const hook = read('../../src/locale-ownership.ts')
  // The namespace mirrored from the vendor plugin (a HOST settings document key).
  assert.match(hook, /const LOCALE_SETTINGS_NAMESPACE = 'locale'/)
  // "The host answered" is the scope's own status, never a guess: the initial
  // 'loading' window is the ONLY unresolved state, and a settled 'ready' without
  // a stored preference is still that instance's own effective language.
  assert.match(hook, /const status = scope\.getSnapshot\(\)\?\.status return \{ locale: active, settled: status !== undefined && status !== 'loading' \}/)
  // Fail-open: without a per-entry identity the official single-shell shape is untouched.
  assert.match(hook, /const instanceId = ctx\.chamberInstanceId if \(typeof instanceId !== 'string' \|\| instanceId === ''\) return/)
  // The hook runs AFTER the vendor apply (same fiber, same synchronous task),
  // from a NORMAL function that preserves cordis's construct path and forwards
  // both \`this\` and the vendor\'s return value.
  assert.match(hook, /apply: function \(this: unknown, ctx: Context\): unknown \{/)
  assert.match(hook, /\(apply as \(this: unknown, ctx: Context\) => unknown\)\.call\(this, ctx\) installLocaleOwnership\(ctx\)/)
  // Facts carry this MOUNT's generation, so a retiring mount cannot erase a
  // newer mount's fact (owner-level cases live in page-language.test.ts).
  assert.match(hook, /const generation = \+\+mountGeneration/)
  assert.match(hook, /reportPageLanguageEntry\(instanceId, fact\(\), generation\)/)
  // A retired entry releases its fact — with its own generation.
  assert.match(hook, /reportPageLanguageEntry\(instanceId, undefined, generation\)/)
  // The bound settings scope is shape-checked like the locale face: a bad shape
  // must fail open, not throw inside the vendor fibre.
  assert.match(hook, /return isSettingsScope\(scope\) \? scope : undefined/)
  assert.match(hook, /function isSettingsScope\(value: unknown\): value is SettingsScopeFace \{/)
})
