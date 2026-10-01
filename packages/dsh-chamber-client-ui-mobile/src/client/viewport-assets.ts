/**
 * Viewport asset surgery for the mobile entry: the touch tier's keyed viewport
 * tokens and the plugin's theme-color mirror. Extracted from index.ts (asset
 * lifecycle) and composer.ts (token surgery) so the whole thing is runnable
 * without a browser — the document face and the theme surface are injected.
 *
 * VIEWPORT TOKENS are keyed: entering the tier replaces a same-key token in
 * place, and leaving RESTORES, per key, the token value that was there BEFORE
 * the plugin's first in-tier write onto that node (a key with no original is
 * removed instead of restored). Retraction never writes through a detached
 * node: the cached meta is re-resolved against the live document first, so a
 * meta the official presenter replaced while the tier was active still gets
 * the plugin's keys retired from the LIVE node.
 *
 * THEME-COLOR mirrors the body surface while the tier is active. Every value
 * observed that is NOT the plugin's own last write is recorded as the official
 * baseline (a newer official write overwrites the older snapshot), and release
 * only restores while the meta still carries the plugin's value — a newer
 * official write is left alone, and the restoration uses the NEWEST baseline.
 */
import { VIEWPORT_TOKENS } from './styles.ts'

// ---- pure token surgery ----------------------------------------------------

/** The key half of a `key=value` viewport token (`viewport-fit=cover` →
 *  `viewport-fit`); a bare token is its own key. Pure — unit-tested. */
export function viewportTokenKey(token: string): string {
  const separator = token.indexOf('=')
  return (separator === -1 ? token : token.slice(0, separator)).trim().toLowerCase()
}

function splitViewportTokens(content: string): string[] {
  return content.split(',').map(part => part.trim()).filter(part => part !== '')
}

/** Replace/append `tokens` by KEY: a same-key token is overridden IN PLACE
 *  (never duplicated) and a new key is appended; every other part keeps its
 *  order and spelling. Pure — unit-tested. */
export function applyViewportTokens(content: string, tokens: readonly string[]): string {
  const parts = splitViewportTokens(content)
  for (const token of tokens) {
    const index = parts.findIndex(part => viewportTokenKey(part) === viewportTokenKey(token))
    if (index === -1) parts.push(token)
    else parts[index] = token
  }
  return parts.join(', ')
}

/** Remove exactly the keys `tokens` own; every other part survives. Pure. */
export function stripViewportTokens(content: string, tokens: readonly string[]): string {
  const keys = new Set(tokens.map(viewportTokenKey))
  return splitViewportTokens(content)
    .filter(part => !keys.has(viewportTokenKey(part)))
    .join(', ')
}

/** The token currently carrying `key`, or null when the key is absent. Pure. */
export function findViewportToken(content: string, key: string): string | null {
  for (const part of splitViewportTokens(content)) {
    if (viewportTokenKey(part) === key) return part
  }
  return null
}

/**
 * Retract the plugin's keys by KEY, given the before-image snapshot the plugin
 * took when it entered the tier: a key that HAD an original token is replaced
 * with that original IN PLACE; a key with no original (null) is removed; a key
 * that is not in the snapshot at all is left untouched. A key whose original
 * exists but that is ABSENT from `content` is not re-added — the plugin only
 * retracts what it can see, never resurrects a token the live document no
 * longer carries. Pure — unit-tested.
 */
export function restoreViewportTokens(
  content: string,
  originals: ReadonlyMap<string, string | null>,
): string {
  const out: string[] = []
  const emitted = new Set<string>()
  for (const part of splitViewportTokens(content)) {
    const key = viewportTokenKey(part)
    if (!originals.has(key)) {
      out.push(part)
      continue
    }
    if (emitted.has(key)) continue
    emitted.add(key)
    const original = originals.get(key)
    if (original !== undefined && original !== null) out.push(original)
  }
  return out.join(', ')
}

// ---- injectable document face ----------------------------------------------

/** The minimal meta-element face (a real HTMLMetaElement satisfies it). */
export interface MetaLike {
  readonly isConnected: boolean
  content: string
  setAttribute(name: string, value: string): void
  remove(): void
}

/** The minimal document face the asset sync needs: a meta query, a meta
 *  factory and <head>. A real Document satisfies it (cast through the entry),
 *  and the tests drive it with a plain object. */
export interface ViewportDocumentLike {
  querySelector(selector: string): MetaLike | null
  createElement(tagName: string): MetaLike
  readonly head: { appendChild(node: MetaLike): void }
}

// ---- stateful lifecycle ----------------------------------------------------

/** The live asset state: the metas the plugin currently holds, the viewport
 *  before-image snapshot, and the theme mirror bookkeeping. */
export interface ViewportAssetsState {
  viewportMeta: MetaLike | null
  /** TRUE when the plugin created the viewport meta (it must remove it). */
  viewportCreated: boolean
  /** The node the before-image snapshot was taken from (identity matters: a
   *  replaced node starts a fresh snapshot, never a cross-node restore). */
  viewportSnapshotNode: MetaLike | null
  /** key -> token present before the plugin's first write (null = absent). */
  viewportOriginals: Map<string, string | null> | null
  themeMeta: MetaLike | null
  themeCreated: boolean
  /** The value the plugin last wrote to theme-color. */
  themeWritten: string | null
  /** The newest observed non-plugin theme-color value (official baseline). */
  themeBaseline: string
}

export function createViewportAssetsState(): ViewportAssetsState {
  return {
    viewportMeta: null,
    viewportCreated: false,
    viewportSnapshotNode: null,
    viewportOriginals: null,
    themeMeta: null,
    themeCreated: false,
    themeWritten: null,
    themeBaseline: '',
  }
}

/** Resolve the live viewport meta, adopting an official one when the cached
 *  node is gone and creating one (plugin-owned) when none exists. */
function ensureViewportMeta(state: ViewportAssetsState, doc: ViewportDocumentLike): MetaLike {
  const cached = state.viewportMeta
  if (cached !== null && cached.isConnected) return cached
  const live = doc.querySelector('meta[name="viewport"]')
  if (live !== null) {
    state.viewportMeta = live
    state.viewportCreated = false
    return live
  }
  const created = doc.createElement('meta')
  created.setAttribute('name', 'viewport')
  // Empty content: the snapshot below must see the state BEFORE the plugin's
  // tokens, so the created node's originals are all "absent".
  created.content = ''
  doc.head.appendChild(created)
  state.viewportMeta = created
  state.viewportCreated = true
  return created
}

/** Apply the plugin's viewport tokens by key, snapshotting the before-image
 *  once per node. Idempotent while the same node stays live. */
export function syncViewportAssets(
  state: ViewportAssetsState,
  doc: ViewportDocumentLike,
  tokens: readonly string[] = VIEWPORT_TOKENS,
): void {
  const meta = ensureViewportMeta(state, doc)
  if (state.viewportSnapshotNode !== meta || state.viewportOriginals === null) {
    const originals = new Map<string, string | null>()
    for (const token of tokens) {
      const key = viewportTokenKey(token)
      originals.set(key, findViewportToken(meta.content, key))
    }
    state.viewportOriginals = originals
    state.viewportSnapshotNode = meta
  }
  meta.content = applyViewportTokens(meta.content, tokens)
}

/**
 * Retract the plugin's viewport tokens. A plugin-created meta is removed (a
 * detached one is already gone — a foreign live node is never touched). An
 * adopted official meta is restored from the before-image snapshot, re-querying
 * the live node first when the cached one was detached.
 */
export function releaseViewportAssets(state: ViewportAssetsState, doc: ViewportDocumentLike): void {
  const target = state.viewportSnapshotNode ?? state.viewportMeta
  const created = state.viewportCreated
  const originals = state.viewportOriginals
  state.viewportMeta = null
  state.viewportCreated = false
  state.viewportSnapshotNode = null
  state.viewportOriginals = null
  if (target === null) return
  if (created) {
    if (target.isConnected) target.remove()
    return
  }
  const live = target.isConnected ? target : doc.querySelector('meta[name="viewport"]')
  if (live === null || originals === null) return
  live.content = restoreViewportTokens(live.content, originals)
}

/** Resolve the live theme-color meta, adopting an official one (recording its
 *  content as the newest baseline) or creating a plugin-owned one. */
function ensureThemeMeta(state: ViewportAssetsState, doc: ViewportDocumentLike): MetaLike {
  const cached = state.themeMeta
  if (cached !== null && cached.isConnected) return cached
  const live = doc.querySelector('meta[name="theme-color"]')
  if (live !== null) {
    // A different node means the plugin's write went with the old one: its
    // written value must not be mistaken for the new node's own content.
    if (live !== cached) state.themeWritten = null
    state.themeMeta = live
    state.themeCreated = false
    state.themeBaseline = live.content
    return live
  }
  const created = doc.createElement('meta')
  created.setAttribute('name', 'theme-color')
  created.content = ''
  doc.head.appendChild(created)
  state.themeMeta = created
  state.themeCreated = true
  return created
}

/** Mirror the body surface into theme-color, recording every observed
 *  non-plugin value as the official baseline before overwriting it. */
export function syncThemeColor(
  state: ViewportAssetsState,
  doc: ViewportDocumentLike,
  surfaceColor: () => string,
): void {
  const meta = ensureThemeMeta(state, doc)
  if (meta.content !== state.themeWritten) state.themeBaseline = meta.content
  const surface = surfaceColor()
  const written = surface === '' ? '#ffffff' : surface
  state.themeWritten = written
  meta.content = written
}

/** Retract the theme-color mirror: remove a plugin-created meta, and restore
 *  the newest baseline only while the live meta still carries the plugin's
 *  value (a newer official write stays untouched). */
export function releaseThemeColor(state: ViewportAssetsState, doc: ViewportDocumentLike): void {
  const target = state.themeMeta
  const created = state.themeCreated
  const written = state.themeWritten
  const baseline = state.themeBaseline
  state.themeMeta = null
  state.themeCreated = false
  state.themeWritten = null
  state.themeBaseline = ''
  if (target === null) return
  if (created) {
    if (target.isConnected) target.remove()
    return
  }
  const live = target.isConnected ? target : doc.querySelector('meta[name="theme-color"]')
  if (live === null || written === null || live.content !== written) return
  live.content = baseline
}

// ---- composed facade (the entry's only import) -----------------------------

export interface ViewportAssets {
  /** Enter the tier: apply the viewport tokens AND mirror theme-color. */
  sync(): void
  /** Re-mirror theme-color alone (the body-attribute theme flip channel). */
  syncTheme(): void
  /** Leave the tier: retract both assets by the rules above. */
  release(): void
}

export function createViewportAssets(
  doc: ViewportDocumentLike,
  surfaceColor: () => string,
): ViewportAssets {
  const state = createViewportAssetsState()
  return {
    sync: (): void => {
      syncViewportAssets(state, doc)
      syncThemeColor(state, doc, surfaceColor)
    },
    syncTheme: (): void => syncThemeColor(state, doc, surfaceColor),
    release: (): void => {
      releaseViewportAssets(state, doc)
      releaseThemeColor(state, doc)
    },
  }
}
