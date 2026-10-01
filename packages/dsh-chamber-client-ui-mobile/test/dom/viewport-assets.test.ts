/**
 * Viewport asset lifecycle tests: the keyed token surgery, the before-image
 * restore on leaving the tier, the detached-node re-query and the theme-color
 * baseline bookkeeping. The module takes a document-like face, so the whole
 * lifecycle runs in plain node — no DOM environment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VIEWPORT_TOKENS } from '../../src/client/styles.ts'
import {
  applyViewportTokens, createViewportAssets, createViewportAssetsState, findViewportToken,
  releaseThemeColor, releaseViewportAssets, restoreViewportTokens, stripViewportTokens,
  syncThemeColor, syncViewportAssets, viewportTokenKey,
  type MetaLike, type ViewportDocumentLike,
} from '../../src/client/viewport-assets.ts'

/** The meta-element double: attributes, connectivity and removal counting. */
class FakeMeta {
  name: string
  content = ''
  removed = 0
  connected = true
  constructor(name: string) { this.name = name }
  get isConnected(): boolean { return this.connected }
  setAttribute(name: string, value: string): void {
    if (name === 'name') this.name = value
  }
  remove(): void {
    this.removed += 1
    this.connected = false
  }
  /** Test hook: the official presenter dropping the node without remove(). */
  detach(): void { this.connected = false }
}

/** The document double: a tiny meta registry plus <head>. */
class FakeDocument implements ViewportDocumentLike {
  /** Every node appended through head.appendChild (creation order). */
  readonly appended: FakeMeta[] = []
  readonly head = {
    appendChild: (node: MetaLike): void => {
      const meta = node as FakeMeta
      if (meta.name !== '') this.metas.set(meta.name, meta)
      this.appended.push(meta)
      meta.connected = true
    },
  }
  private readonly metas = new Map<string, FakeMeta>()
  querySelector(selector: string): FakeMeta | null {
    const match = /^meta\[name="([^"]+)"\]$/.exec(selector)
    assert.ok(match !== null, 'the fake document speaks meta[name="…"] only, got ' + selector)
    const meta = this.metas.get(match[1] as string)
    // A real Document.querySelector never returns a detached node.
    return meta !== undefined && meta.connected ? meta : null
  }
  createElement(): FakeMeta { return new FakeMeta('') }
  /** Install (or replace) the official meta with this name. */
  setMeta(name: string, content: string): FakeMeta {
    const previous = this.metas.get(name)
    previous?.detach()
    const meta = new FakeMeta(name)
    meta.content = content
    this.metas.set(name, meta)
    this.appended.push(meta)
    return meta
  }
}

const viewportOf = (doc: FakeDocument): FakeMeta => {
  const meta = doc.querySelector('meta[name="viewport"]')
  assert.ok(meta !== null, 'the viewport meta must exist')
  return meta
}
const themeOf = (doc: FakeDocument): FakeMeta => {
  const meta = doc.querySelector('meta[name="theme-color"]')
  assert.ok(meta !== null, 'the theme-color meta must exist')
  return meta
}

// ---------------------------------------------------------------------------
// Pure token surgery (moved here from composer.ts).
// ---------------------------------------------------------------------------

test('viewport tokens: entering the tier replaces by key, never duplicates', () => {
  assert.equal(viewportTokenKey('viewport-fit=cover'), 'viewport-fit')
  assert.equal(viewportTokenKey('interactive-widget=resizes-content'), 'interactive-widget')
  assert.equal(viewportTokenKey('width=device-width'), 'width')
  assert.equal(
    applyViewportTokens('width=device-width, initial-scale=1', VIEWPORT_TOKENS),
    'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
  )
  // A stale same-key token is REPLACED in place: no duplicate key survives.
  assert.equal(
    applyViewportTokens('width=device-width, viewport-fit=contain, interactive-widget=overlays-content', VIEWPORT_TOKENS),
    'width=device-width, viewport-fit=cover, interactive-widget=resizes-content',
  )
  const once = applyViewportTokens('width=device-width, initial-scale=1', VIEWPORT_TOKENS)
  assert.equal(applyViewportTokens(once, VIEWPORT_TOKENS), once, 'a re-entering sync is idempotent')
})

test('viewport tokens: strip removes exactly the plugin keys', () => {
  const official = 'width=device-width, initial-scale=1'
  const stamped = applyViewportTokens(official, VIEWPORT_TOKENS)
  assert.equal(stripViewportTokens(stamped, VIEWPORT_TOKENS), official)
  // Key equality, not substring: an official token sharing a prefix survives.
  assert.equal(
    stripViewportTokens('width=device-width, viewport-fit-extra=1, viewport-fit=cover', VIEWPORT_TOKENS),
    'width=device-width, viewport-fit-extra=1',
  )
  assert.equal(stripViewportTokens(VIEWPORT_TOKENS.join(', '), VIEWPORT_TOKENS), '')
  assert.equal(findViewportToken('width=device-width, viewport-fit=cover', 'viewport-fit'), 'viewport-fit=cover')
  assert.equal(findViewportToken('width=device-width', 'viewport-fit'), null)
})

test('restoreViewportTokens: originals come back in place, no-original keys go, absent keys never resurrect', () => {
  const originals = new Map<string, string | null>([
    ['viewport-fit', 'viewport-fit=contain'],
    ['interactive-widget', null],
  ])
  assert.equal(
    restoreViewportTokens('width=device-width, viewport-fit=cover, interactive-widget=resizes-content', originals),
    'width=device-width, viewport-fit=contain',
    'a displaced official value is restored in place; a plugin-only key is removed',
  )
  // The live document no longer carries the key: the plugin retracts what it
  // sees and never re-adds a token the official presenter dropped meanwhile.
  assert.equal(restoreViewportTokens('width=device-width', originals), 'width=device-width')
  // Keys outside the snapshot are untouched.
  assert.equal(restoreViewportTokens('width=device-width, foo=1', originals), 'width=device-width, foo=1')
  // Duplicates of an original key collapse to the single restored token.
  assert.equal(restoreViewportTokens('viewport-fit=cover, viewport-fit=cover', originals), 'viewport-fit=contain')
})

// ---------------------------------------------------------------------------
// The stateful lifecycle.
// ---------------------------------------------------------------------------

test('sync applies the tokens; release restores the pre-entry values by key', () => {
  const doc = new FakeDocument()
  doc.setMeta('viewport', 'width=device-width, viewport-fit=contain')
  const state = createViewportAssetsState()
  syncViewportAssets(state, doc)
  assert.equal(
    viewportOf(doc).content,
    'width=device-width, viewport-fit=cover, interactive-widget=resizes-content',
  )
  releaseViewportAssets(state, doc)
  assert.equal(viewportOf(doc).content, 'width=device-width, viewport-fit=contain',
    'the official viewport-fit value is RESTORED, not deleted (the old strip removed it)')
  assert.equal(viewportOf(doc).removed, 0, 'an adopted official meta is never removed')
})

test('sync is idempotent per node and never snapshots the plugin values as originals', () => {
  const doc = new FakeDocument()
  doc.setMeta('viewport', 'width=device-width, viewport-fit=contain')
  const state = createViewportAssetsState()
  syncViewportAssets(state, doc)
  syncViewportAssets(state, doc)
  releaseViewportAssets(state, doc)
  assert.equal(viewportOf(doc).content, 'width=device-width, viewport-fit=contain')
})

test('a plugin-created viewport meta is removed on release', () => {
  const doc = new FakeDocument()
  const state = createViewportAssetsState()
  syncViewportAssets(state, doc)
  const created = viewportOf(doc)
  assert.equal(created.content, VIEWPORT_TOKENS.join(', '), 'created empty, then stamped by key')
  releaseViewportAssets(state, doc)
  assert.equal(created.removed, 1)
  assert.equal(doc.querySelector('meta[name="viewport"]'), null)
})

test('release re-queries the LIVE viewport meta when the cached node was replaced', () => {
  const doc = new FakeDocument()
  doc.setMeta('viewport', 'width=device-width, viewport-fit=contain')
  const state = createViewportAssetsState()
  syncViewportAssets(state, doc)
  const stale = viewportOf(doc)
  // The presenter replaces the node while the tier is active.
  const replacement = doc.setMeta('viewport', 'width=device-width, viewport-fit=cover, interactive-widget=resizes-content')
  assert.equal(stale.isConnected, false)
  releaseViewportAssets(state, doc)
  assert.equal(replacement.content, 'width=device-width, viewport-fit=contain',
    'the retraction lands on the LIVE node, never on the detached one')
  assert.equal(replacement.removed, 0)
})

test('a detached plugin-created meta is not chased: the foreign live node stays untouched', () => {
  const doc = new FakeDocument()
  const state = createViewportAssetsState()
  syncViewportAssets(state, doc)
  const created = viewportOf(doc)
  created.detach()
  const foreign = doc.setMeta('viewport', 'width=device-width, viewport-fit=cover')
  releaseViewportAssets(state, doc)
  assert.equal(foreign.content, 'width=device-width, viewport-fit=cover',
    'once the created node is gone the plugin has nothing to retract on a foreign node')
  assert.equal(foreign.removed, 0)
})

// ---------------------------------------------------------------------------
// Theme-color mirror.
// ---------------------------------------------------------------------------

test('theme mirror: release restores the NEWEST observed official baseline', () => {
  const doc = new FakeDocument()
  const official = doc.setMeta('theme-color', '#123456')
  const state = createViewportAssetsState()
  syncThemeColor(state, doc, () => '#abcdef')
  assert.equal(official.content, '#abcdef')
  // A newer official write arrives while the tier is active; the next sync
  // records it as the baseline before re-mirroring.
  official.content = '#654321'
  syncThemeColor(state, doc, () => '#abcdef')
  assert.equal(official.content, '#abcdef', 'the plugin re-mirrors the body surface')
  releaseThemeColor(state, doc)
  assert.equal(official.content, '#654321', 'the newest baseline wins over the entry snapshot')
})

test('theme mirror: a newer official write that the observer never saw is left alone', () => {
  const doc = new FakeDocument()
  const official = doc.setMeta('theme-color', '#123456')
  const state = createViewportAssetsState()
  syncThemeColor(state, doc, () => '#abcdef')
  official.content = '#newer'
  releaseThemeColor(state, doc)
  assert.equal(official.content, '#newer', 'only the plugin\'s own value may be retracted')
})

test('theme mirror: a plugin-created meta is removed and an empty surface falls back to white', () => {
  const doc = new FakeDocument()
  const state = createViewportAssetsState()
  syncThemeColor(state, doc, () => '')
  const created = themeOf(doc)
  assert.equal(created.content, '#ffffff')
  releaseThemeColor(state, doc)
  assert.equal(created.removed, 1)
  assert.equal(doc.querySelector('meta[name="theme-color"]'), null)
})

test('theme mirror: re-queries a replaced meta and restores there if it still carries the plugin value', () => {
  const doc = new FakeDocument()
  doc.setMeta('theme-color', '#111111')
  const state = createViewportAssetsState()
  syncThemeColor(state, doc, () => '#abcdef')
  const stale = themeOf(doc)
  const replacement = doc.setMeta('theme-color', '#abcdef')
  assert.equal(stale.isConnected, false)
  releaseThemeColor(state, doc)
  assert.equal(replacement.content, '#111111', 'the live node is retracted against the newest baseline')
  assert.equal(replacement.removed, 0)

  // When the live replacement does NOT carry the plugin value, it stays.
  const other = new FakeDocument()
  other.setMeta('theme-color', '#111111')
  const otherState = createViewportAssetsState()
  syncThemeColor(otherState, other, () => '#abcdef')
  const otherReplacement = other.setMeta('theme-color', '#222222')
  releaseThemeColor(otherState, other)
  assert.equal(otherReplacement.content, '#222222')
})

// ---------------------------------------------------------------------------
// The composed facade the entry consumes.
// ---------------------------------------------------------------------------

test('createViewportAssets: sync/syncTheme/release own both assets together', () => {
  const doc = new FakeDocument()
  doc.setMeta('viewport', 'width=device-width')
  doc.setMeta('theme-color', '#101010')
  const assets = createViewportAssets(doc, () => '#abcdef')
  assets.sync()
  assert.equal(
    viewportOf(doc).content,
    'width=device-width, viewport-fit=cover, interactive-widget=resizes-content',
  )
  assert.equal(themeOf(doc).content, '#abcdef')
  assets.syncTheme()
  assert.equal(themeOf(doc).content, '#abcdef', 'the theme-only channel is idempotent')
  assets.release()
  assert.equal(viewportOf(doc).content, 'width=device-width')
  assert.equal(themeOf(doc).content, '#101010')
})
