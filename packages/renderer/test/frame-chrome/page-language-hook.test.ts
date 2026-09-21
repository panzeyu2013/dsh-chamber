/**
 * Page-language ownership END TO END with a stubbed DOM (design 06 §4.6
 * 「页面语言归属」): the real page owner (`page-language.ts`) plus the real
 * per-entry mount decorator (`locale-ownership.ts`) driven by a fake entry
 * context and a stand-in vendor locale plugin.
 *
 * This is the single page-language spec (the injected-host spec was retired in
 * the second trim round; its unique wiring locks moved here, its pure-rule and
 * state-machine cases are the end-to-end cases below): it proves that the
 * decorator runs the ownership hook after the vendor body, that the hook reads
 * the faces it claims to read, and that a background entry's write is restored
 * in the same synchronous task. Here the real modules run: `withLocaleOwnership` wraps a stand-in plugin
 * whose `apply` writes `<html lang>` exactly where `syncDocumentLanguage`
 * does, and `installPageLanguageOwner` runs against a stubbed
 * document/MutationObserver — the same global-stub idiom
 * `page-read-path-lockstep.test.ts` uses for `fetch`.
 *
 * The stub observer DELIVERS its records (a microtask, like the real one), so
 * the unowned cases below pin the production truth the 2026-12 reviews asked
 * for: an unowned shell's write is reverted by the page backstop before paint
 * while its language is never adopted. Every assertion BEFORE an `await` pins
 * the stronger guarantee the per-entry hook provides — a write reverted in the
 * same synchronous task, with no backstop involved.
 *
 * The page owner is a PAGE SINGLETON, so tests share it: every case starts from
 * the deterministic state `resetPageToChinese()` establishes (local on screen,
 * answered in Chinese) instead of assuming the previous case's end state.
 *
 * LIMITS, stated honestly: the vendor plugin here is a stand-in reproducing the
 * write timing argued in `locale-ownership.ts`, not the vendor code itself (the
 * vendor tree is not importable from a plain node run).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  installPageLanguageOwner,
  PageLanguageOwner,
  setPageActiveSource,
} from '../../src/page-language.ts'
import { withLocaleOwnership } from '../../src/locale-ownership.ts'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

/** Comment-stripped, whitespace-collapsed source: the semantic text of a file. */
const read = (rel: string): string =>
  normalize(stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')))

// ── A stubbed document (installed before the owner takes over) ──────────────

interface StubDocument {
  attributes: Map<string, string>
  /** The document's own write path — observer records included, as in the DOM. */
  write(language: string): void
  /** How many observers were installed on the document. */
  observerCount(): number
}

function installDocumentStub(initialLanguage: string): StubDocument {
  const attributes = new Map<string, string>([['lang', initialLanguage]])
  const observerCallbacks: Array<() => void> = []
  const root = {
    getAttribute: (name: string): string | null => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string): void => {
      // A real `setAttribute` only mutates on a value CHANGE, and its observer
      // fires a microtask later — both matter to the cases below.
      if (attributes.get(name) === value) return
      attributes.set(name, value)
      for (const callback of [...observerCallbacks]) queueMicrotask(callback)
    },
  }
  const globals = globalThis as Record<string, unknown>
  globals.document = { documentElement: root }
  globals.MutationObserver = class {
    constructor(callback: () => void) { observerCallbacks.push(callback) }
    observe(): void {}
    disconnect(): void {}
  }
  return {
    attributes,
    write: (language: string): void => { root.setAttribute('lang', language) },
    observerCount: () => observerCallbacks.length,
  }
}

const documentLanguage = (doc: StubDocument): string | undefined => doc.attributes.get('lang')

// ── A fake entry context (only the faces the hook reads) ────────────────────

interface FakeEntryOptions {
  chamberInstanceId?: string
  /** The locale face's starting value (the browser-derived provisional at activation). */
  active: string
  /** The settings scope's starting status ('loading' = the host has not answered). */
  status: string
  /** Make `ctx.settingsScope.bind` throw (service activation failure). */
  bindThrows?: boolean
  /** Bind a scope without the getSnapshot/subscribe pair the hook needs. */
  scopeShapeBroken?: boolean
  /** Hide the face from the service door so the slot door must answer. */
  serviceMissesFace?: boolean
}

/** One fake entry ctx plus the levers a test drives it with. */
function fakeEntry(options: FakeEntryOptions) {
  const faceListeners = new Set<() => void>()
  const scopeListeners = new Set<() => void>()
  const disposers: Array<() => void> = []
  let active = options.active
  let status = options.status
  const face = {
    getSnapshot: () => ({ active }),
    subscribe: (listener: () => void) => {
      faceListeners.add(listener)
      return () => { faceListeners.delete(listener) }
    },
  }
  const ctx = {
    chamberInstanceId: options.chamberInstanceId ?? 'local',
    get: (name: string): unknown => (name === 'locale' && options.serviceMissesFace !== true ? face : undefined),
    slots: { hostFace: () => ({ locale: face }) },
    settingsScope: {
      bind: (): unknown => {
        if (options.bindThrows === true) throw new Error('settings scope unavailable')
        if (options.scopeShapeBroken === true) return { status }
        return {
          getSnapshot: () => ({ status }),
          subscribe: (listener: () => void) => {
            scopeListeners.add(listener)
            return () => { scopeListeners.delete(listener) }
          },
        }
      },
    },
    effect: (fn: () => (() => void) | void): void => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  return {
    ctx,
    /** The vendor's adoption: its locale face publishes the host language. */
    adopt: (language: string): void => {
      active = language
      for (const listener of [...faceListeners]) listener()
    },
    /** A later dictionary registration: the face publishes again. */
    register: (): void => { for (const listener of [...faceListeners]) listener() },
    /** The settings mirror landing. */
    settle: (next: string): void => {
      status = next
      for (const listener of [...scopeListeners]) listener()
    },
    dispose: (): void => { for (const dispose of disposers.splice(0)) dispose() },
    listenerCounts: () => ({ face: faceListeners.size, scope: scopeListeners.size }),
  }
}

/** Mount one fake shell through the real decorator, stand-in vendor write included. */
function mountShell(entry: ReturnType<typeof fakeEntry>, write: string): void {
  const plugin = {
    inject: ['slots', 'remote', 'settingsScope'],
    apply: (): void => { doc.write(write) },
  }
  const decorated = withLocaleOwnership(plugin) as { inject?: unknown; apply: (ctx: unknown) => void }
  assert.deepEqual(decorated.inject, plugin.inject, 'the decorator must preserve the inject face')
  decorated.apply(entry.ctx)
}

// The owner is a page singleton: install it ONCE with the stub, then drive it.
const doc = installDocumentStub('zh-CN')
installPageLanguageOwner()

/** Deterministic start: the local instance is on screen and answered in Chinese. */
function resetPageToChinese(): ReturnType<typeof fakeEntry> {
  setPageActiveSource('local')
  const local = fakeEntry({ chamberInstanceId: 'local', active: 'zh', status: 'ready' })
  mountShell(local, 'zh-CN')
  assert.equal(documentLanguage(doc), 'zh-CN')
  return local
}

// ── The mount decorator: vendor apply, then the ownership hook ──────────────

test('the decorator keeps the provisional from owning the page while the host has not answered', () => {
  const local = resetPageToChinese()
  const entry = fakeEntry({ chamberInstanceId: 'local', active: 'en', status: 'loading' })
  mountShell(entry, 'en')
  assert.equal(documentLanguage(doc), 'zh-CN', 'the provisional must never own the page')
  assert.deepEqual(entry.listenerCounts(), { face: 1, scope: 1 }, 'the hook must subscribe to both faces')

  // The host answers Chinese: the vendor adopts and the page is already there —
  // no write, no flicker.
  entry.adopt('zh')
  entry.settle('ready')
  assert.equal(documentLanguage(doc), 'zh-CN')

  // A later dictionary registration republishes the same value: still nothing.
  entry.register()
  assert.equal(documentLanguage(doc), 'zh-CN')

  // The entry retires: facts are released, the page keeps its language.
  entry.dispose()
  assert.deepEqual(entry.listenerCounts(), { face: 0, scope: 0 })
  local.dispose()
})

test('the settings scope settling at "unavailable" is still this instance\u2019s own language', () => {
  const local = resetPageToChinese()
  setPageActiveSource('gateway-u')
  const entry = fakeEntry({ chamberInstanceId: 'gateway-u', active: 'en', status: 'loading' })
  mountShell(entry, 'en')
  assert.equal(documentLanguage(doc), 'zh-CN', 'unresolved: keep the current page language')
  // 'unavailable' = the host answered but serves no locale namespace (or the
  // page runs memory persistence); the face's value IS this instance's language.
  entry.settle('unavailable')
  assert.equal(documentLanguage(doc), 'en', 'a settled surface adopts the instance\u2019s effective language')
  entry.dispose()
  local.dispose()
})

test('an on-screen instance that answers in another language switches the page once', () => {
  const local = resetPageToChinese()
  setPageActiveSource('gateway-a')
  assert.equal(documentLanguage(doc), 'zh-CN', 'an unknown source keeps the current language')
  const entry = fakeEntry({ chamberInstanceId: 'gateway-a', active: 'en', status: 'loading' })
  mountShell(entry, 'en')
  assert.equal(documentLanguage(doc), 'zh-CN', 'not yet answered: keep the current page language')
  entry.adopt('en')
  entry.settle('ready')
  assert.equal(documentLanguage(doc), 'en', 'the on-screen source\u2019s settled language owns the page')
  entry.dispose()
  local.dispose()
})

test('a background shell can never move the page, however often it writes', () => {
  const local = resetPageToChinese()
  const remote = fakeEntry({ chamberInstanceId: 'gateway-b', active: 'en', status: 'ready' })
  mountShell(remote, 'en')
  assert.equal(documentLanguage(doc), 'zh-CN', 'its activation write must be restored in the same task')
  remote.register()
  remote.register()
  assert.equal(documentLanguage(doc), 'zh-CN')
  // Switching to it (loaded and settled) switches the page — once.
  setPageActiveSource('gateway-b')
  assert.equal(documentLanguage(doc), 'en')
  setPageActiveSource('local')
  assert.equal(documentLanguage(doc), 'zh-CN')
  remote.dispose()
  local.dispose()
})

test('switching to a not-yet-loaded source keeps the current language until it answers', () => {
  const local = resetPageToChinese()
  const late = fakeEntry({ chamberInstanceId: 'gateway-c', active: 'en', status: 'loading' })
  mountShell(late, 'en')
  setPageActiveSource('gateway-c')
  assert.equal(documentLanguage(doc), 'zh-CN', 'a source that has not answered must not flip the page')
  late.adopt('zh')
  late.settle('ready')
  assert.equal(documentLanguage(doc), 'zh-CN')
  late.adopt('en')
  assert.equal(documentLanguage(doc), 'en', 'its own later language change still lands')
  late.dispose()
  local.dispose()
})

test('a remount outranks the mount it replaces, even when the old one retires later', () => {
  const first = resetPageToChinese()
  // The source is remounted (retry): the new mount answers English.
  const second = fakeEntry({ chamberInstanceId: 'local', active: 'en', status: 'ready' })
  mountShell(second, 'en')
  assert.equal(documentLanguage(doc), 'en')
  // The OLD mount's teardown lands after the new mount claimed the slot: it must
  // not erase the live fact (proved by switching away and back).
  first.dispose()
  setPageActiveSource('gateway-r')
  const other = fakeEntry({ chamberInstanceId: 'gateway-r', active: 'zh', status: 'ready' })
  mountShell(other, 'zh-CN')
  assert.equal(documentLanguage(doc), 'zh-CN')
  setPageActiveSource('local')
  assert.equal(documentLanguage(doc), 'en', 'the live mount still owns the fact')
  second.dispose()
  other.dispose()
})

// ── Unowned / degraded shapes ───────────────────────────────────────────────

test('an unowned shell is reverted by the page backstop, but its language is never adopted', async () => {
  const local = resetPageToChinese()
  const entry = fakeEntry({ chamberInstanceId: '', active: 'en', status: 'loading' })
  mountShell(entry, 'en')
  assert.deepEqual(entry.listenerCounts(), { face: 0, scope: 0 }, 'no ownership hook without a chamber entry')
  assert.equal(documentLanguage(doc), 'en', 'without the hook the vendor write lands…')
  await Promise.resolve()
  assert.equal(documentLanguage(doc), 'zh-CN', '…and the page backstop reverts it before paint')
  local.dispose()
  entry.dispose()
})

test('a settings scope that cannot be bound disables the hook instead of guessing', async () => {
  const local = resetPageToChinese()
  const entry = fakeEntry({ chamberInstanceId: 'local', active: 'en', status: 'loading', bindThrows: true })
  mountShell(entry, 'en')
  assert.deepEqual(entry.listenerCounts(), { face: 0, scope: 0 })
  await Promise.resolve()
  assert.equal(documentLanguage(doc), 'zh-CN', 'fail-open = unowned (never adopted), still reverted')
  local.dispose()
  entry.dispose()
})

test('a settings scope with a broken shape disables the hook instead of throwing', async () => {
  const local = resetPageToChinese()
  const entry = fakeEntry({ chamberInstanceId: 'local', active: 'en', status: 'loading', scopeShapeBroken: true })
  // The whole point: no throw escapes the decorated vendor apply (which would
  // fail the locale fibre and surface a degraded-boot notice).
  mountShell(entry, 'en')
  assert.deepEqual(entry.listenerCounts(), { face: 0, scope: 0 })
  await Promise.resolve()
  assert.equal(documentLanguage(doc), 'zh-CN')
  local.dispose()
  entry.dispose()
})

test('the hook also reads the face through the slot service when the service read misses', () => {
  const local = resetPageToChinese()
  const entry = fakeEntry({ chamberInstanceId: 'local', active: 'en', status: 'loading', serviceMissesFace: true })
  mountShell(entry, 'en')
  assert.deepEqual(entry.listenerCounts(), { face: 1, scope: 1 }, 'the slot-installed face must be found')
  assert.equal(documentLanguage(doc), 'zh-CN', 'and the hook still owns the write')
  local.dispose()
  entry.dispose()
})

// ── The page singleton and its backstop ─────────────────────────────────────

test('installing the owner twice is a no-op: one owner, one observer', () => {
  const observersBefore = doc.observerCount()
  const languageBefore = documentLanguage(doc)
  installPageLanguageOwner()
  assert.equal(doc.observerCount(), observersBefore, 'no second owner/observer may be installed')
  assert.equal(documentLanguage(doc), languageBefore)
})

test('the stubbed document really is the page the owner reads (guard against a vacuous run)', async () => {
  // If the stub were not installed, the assertions above would compare against
  // an undefined document and could pass vacuously; this pins the fixture.
  assert.equal(doc.observerCount() > 0, true, 'the install must have attached its backstop')
  const owner = new PageLanguageOwner(
    {
      read: () => documentLanguage(doc) ?? '',
      write: language => { doc.attributes.set('lang', language) },
    },
    'zh-CN',
  )
  owner.setActiveSource('local')
  doc.write('en')
  owner.enforce()
  assert.equal(documentLanguage(doc), 'zh-CN')
  // A write nobody sanctioned is reverted by the installed backstop too.
  doc.write('en')
  await Promise.resolve()
  assert.equal(documentLanguage(doc), 'zh-CN')
})

// ── Wiring locks (source text; moved from the retired page-language.test.ts) ─
//
// main.tsx renders, App.tsx renders, and chamber-entry.ts boots the whole
// shell, so none of them can be imported by a plain `node test/…` run; the
// invariants below are pinned by comment-stripped source text.

test('enforce costs no write on an already-sanctioned page, and a retired fact is not a language change', () => {
  const writes: string[] = []
  let language = 'zh-CN'
  const owner = new PageLanguageOwner(
    { read: () => language, write: next => { language = next; writes.push(next) } },
    'zh-CN',
  )
  owner.setActiveSource('local')
  owner.report('local', { locale: 'zh', settled: true })
  // One shell's unconditional `document.documentElement.lang = …` write.
  language = 'en'
  owner.enforce()
  assert.equal(language, 'zh-CN')
  assert.deepEqual(writes, ['zh-CN'])
  // Sanctioned values read back identical: enforce costs no write.
  owner.enforce()
  assert.deepEqual(writes, ['zh-CN'])
  // A retired entry drops its fact (the page keeps the language) and the active
  // source accessor keeps answering.
  owner.report('gateway-a', { locale: 'en', settled: true })
  owner.setActiveSource('gateway-a')
  assert.equal(owner.languageOf(), 'en')
  owner.report('gateway-a', undefined)
  assert.equal(owner.languageOf(), 'en', 'no fact is not a language change')
  assert.equal(owner.activeSourceOf(), 'gateway-a')
})

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
