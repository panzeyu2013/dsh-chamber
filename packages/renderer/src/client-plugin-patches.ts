/**
 * Page-level runtime patch table for host-graph client plugin bundles.
 *
 * WHY. The chamber N-ctx page is ONE document for N instances: a plugin that resolves
 * its host route against `document.baseURI` (the upstream chat-import upload does) lands
 * on the control-plane origin instead of its instance, which drives the owner-only
 * upload route to the management API (404 JSON). The chamber per-entry contract for
 * client plugins is `ctx.get('chamberBasePath')` (design 09 §4); a plugin that predates
 * that contract cannot be fixed in the shell's own packages without patching the
 * published bundle text. This module is the PURE declaration half of that mechanism
 * (zero imports, so the upgrade-time verifier imports this file directly): the patch
 * table, the URL classification, the two-anchor rewriter, the sourceURL sanitizer and
 * the fail-closed refusal decision. The loading half (page-budget text read, 30s loader
 * contract, execution) lives in `patched-bundle-load.ts`; the shell only dispatches.
 *
 * EXECUTION MODEL (what the loading half does with `apply` output). The registered
 * bundle is a classic script that self-registers through `window.__ModuleLoader__.load`;
 * it is executed with `new Function(text + '//# sourceURL=…')()`. That is a FUNCTION-BODY
 * scope: top-level `var/let/const/function` declarations stay local to the function
 * body (no page-global pollution), and the body is sloppy-mode (the upstream stock
 * loader's classic-script semantics) rather than the module-script strict mode the
 * script-element path uses. Equivalence for the one registered bundle is checked by the
 * upsteam payload verifier (no `'use strict'`, no top-level `this`, no ESM syntax);
 * module-only syntax would be a SyntaxError here and the load is refused (visible).
 * `new Function` depends on the page CSP's `script-src 'unsafe-eval'` (the control-plane
 * page sends it); a CSP tightening that drops it breaks this mechanism loudly.
 *
 * FAIL-CLOSED, BLAST RADIUS. Both anchors must appear exactly once. A registered bundle
 * whose shape no longer matches is REFUSED (never loaded unpatched); the refusal is a
 * plain load failure, so the existing loader semantics apply: the row reports
 * `bundle-load-failed` (pluginId + message with this patch's reason and anchor count),
 * and a kept-row load failure makes that instance's WHOLE shell boot fail (the boot page
 * shows the failure overlay) — NOT merely that one row going missing. This is the
 * intended trade-off: silently uploading to the control-plane root is worse.
 *
 * DELETE CONDITION. Remove an entry once upstream exposes a host-route base seam on the
 * page transport (or the plugin reads the chamber context key itself); the current pin
 * does not need the patch (design 09 §4, runtime base backfill).
 */

/** One registered served-bundle patch. */
export interface ClientPluginPatch {
  /** npm package id as it appears in the single-id combo bundle URL. */
  readonly packageId: string
  /** Exact anchor count the patch requires (also carried by refusals/diagnostics). */
  readonly anchors: number
  /** Why this patch exists and when it may be deleted (carried by refusals/diagnostics). */
  readonly reason: string
  /** The exact literal anchors, in served-text order (the upgrade verifier greps these). */
  readonly anchorTexts: readonly string[]
  /**
   * Rewrite one served bundle text.
   * @param text - the served combo script text.
   * @returns the patched text, or null when the anchors do not match exactly (fail-closed).
   */
  apply(text: string): string | null
}

/**
 * The base expression the patched upload uses: an injected per-entry base path wins,
 * an absent one falls back to the document base (native dsh page). Kept identical to
 * the text spliced into the bundle so the unit suite can pin the URL semantics.
 */
export const PATCHED_UPLOAD_BASE_EXPRESSION = 'basePath===void 0?document.baseURI:new URL(basePath+`/`,document.baseURI).href'

/** The DeepSeek chat export importer (optional, enabled per instance). */
export const CHAT_IMPORT_PACKAGE_ID = '@deepseek-ai/dsh-deepseek-chat-import'

/**
 * The uploaded URL construction in the published bundle (0.2.2-rc.3, tsdown classic
 * script): one occurrence, asserted by the unit suite and by the upgrade-time verifier
 * on the real published artifact.
 */
export const CHAT_IMPORT_UPLOAD_ANCHOR =
  'function uploadArchive(file,workspaceId,onProgress,signal){const url=new URL(`${UPLOAD_ROUTE}?${new URLSearchParams({workspaceId}).toString()}`,document.baseURI)'

/** The one call site inside `registerUi(ctx)`, where the per-entry Context is in scope. */
export const CHAT_IMPORT_CALL_ANCHOR = 'const answer=await uploadArchive(file,workspaceId,onProgress,signal);'

/** Count non-overlapping literal occurrences of one anchor. */
function anchorCount(text: string, anchor: string): number {
  let count = 0
  let at = text.indexOf(anchor)
  while (at >= 0) {
    count += 1
    at = text.indexOf(anchor, at + anchor.length)
  }
  return count
}

/**
 * Fill the chat-import upload route's missing per-entry base into one served bundle.
 * The upload function takes the base as an argument and the call site passes the
 * plugin Context's `chamberBasePath` (absent on a native dsh page → document base).
 * @param text - the served combo script text.
 * @returns the patched text, or null when either anchor is missing or duplicated.
 */
export function applyChatImportUploadBasePatch(text: string): string | null {
  const anchors = [CHAT_IMPORT_UPLOAD_ANCHOR, CHAT_IMPORT_CALL_ANCHOR] as const
  for (const anchor of anchors) {
    if (anchorCount(text, anchor) !== 1) return null
  }
  const patched = text
    .replace(CHAT_IMPORT_UPLOAD_ANCHOR,
      'function uploadArchive(file,workspaceId,onProgress,signal,basePath){const url=new URL(`${UPLOAD_ROUTE}?${new URLSearchParams({workspaceId}).toString()}`,'
      + PATCHED_UPLOAD_BASE_EXPRESSION + ')')
    .replace(CHAT_IMPORT_CALL_ANCHOR,
      'const answer=await uploadArchive(file,workspaceId,onProgress,signal,ctx.get(`chamberBasePath`));')
  // Structural re-check: both anchors are gone and the parameterized call exists once.
  for (const anchor of anchors) {
    if (patched.includes(anchor)) return null
  }
  if (anchorCount(patched, 'uploadArchive(file,workspaceId,onProgress,signal,ctx.get(`chamberBasePath`))') !== 1) return null
  return patched
}

/** The registered served-bundle patches, in bundle-url matching order. */
export const CLIENT_PLUGIN_PATCHES: readonly ClientPluginPatch[] = Object.freeze([
  {
    packageId: CHAT_IMPORT_PACKAGE_ID,
    anchors: 2,
    reason: 'chat-import resolves its owner-only upload route against document.baseURI; the N-ctx page needs the per-entry chamberBasePath (design 09 §4). Delete when upstream reads a page-transport host base or the plugin reads the chamber context key.',
    anchorTexts: Object.freeze([CHAT_IMPORT_UPLOAD_ANCHOR, CHAT_IMPORT_CALL_ANCHOR]) as readonly string[],
    apply: applyChatImportUploadBasePatch,
  },
])

/** The single-id combo marker every host-graph client bundle URL carries. */
const COMBO_MARKER = '/plugins/??'

/** One combo resource token: `<package>/client.js` (chunks/assets/batches never match). */
const COMBO_RESOURCE = /^((?:@[^/]+\/)?[^/]+)\/client\.js$/

/**
 * Parse the package id of a single-id combo bundle URL
 * (`<base>/plugins/??<id>/client.js&rev=<rev>` or the `?rev=` spelling). Batches,
 * chunk URLs and non-plugin assets name no single package and answer null.
 * @param url - the bundle URL the loader received.
 * @returns the package id, or null when the URL is not a single-id combo.
 */
export function bundlePackageIdOf(url: string): string | null {
  if (typeof url !== 'string' || url === '') return null
  const markerAt = url.indexOf(COMBO_MARKER)
  if (markerAt < 0) return null
  const tail = url.slice(markerAt + COMBO_MARKER.length)
  const revAt = firstRevisionIndex(tail)
  const resources = (revAt < 0 ? tail : tail.slice(0, revAt)).split(',')
  if (resources.length !== 1) return null
  return COMBO_RESOURCE.exec(resources[0] ?? '')?.[1] ?? null
}

/** First `&rev=` / `?rev=` index in one combo tail; -1 when absent. */
function firstRevisionIndex(tail: string): number {
  const ampersand = tail.indexOf('&rev=')
  const question = tail.indexOf('?rev=')
  if (ampersand < 0) return question
  if (question < 0) return ampersand
  return Math.min(ampersand, question)
}

/** The loader dispatch decision for one bundle URL. */
export type ClientPluginBundleMatch =
  /** Not a registered bundle: keep the untouched script-element path. */
  | { readonly kind: 'none' }
  /** A registered package addressed as a single-id combo: load it patched. */
  | { readonly kind: 'patch'; readonly patch: ClientPluginPatch }
  /**
   * A registered package appears in the URL but the combo is NOT a single-id
   * `<id>/client.js` resource (batch/malformed/other resource name): refuse the load
   * instead of silently running it unpatched (fail-closed).
   */
  | { readonly kind: 'refuse'; readonly patch: ClientPluginPatch; readonly message: string }

/**
 * Classify one bundle URL against the patch table.
 * @param url - the bundle URL the loader received.
 * @returns the dispatch decision; `refuse` carries the diagnostic message.
 */
export function classifyClientPluginBundle(url: string): ClientPluginBundleMatch {
  const patch = findClientPluginPatch(url)
  if (patch !== null) return { kind: 'patch', patch }
  if (url.indexOf(COMBO_MARKER) >= 0) {
    for (const patch of CLIENT_PLUGIN_PATCHES) {
      if (!url.includes(patch.packageId)) continue
      return {
        kind: 'refuse',
        patch,
        message: 'dsh-chamber: the registered bundle URL for ' + patch.packageId
          + ' is not a single-id \`<package>/client.js\` combo (' + url + '); refusing to load the unpatched bundle — '
          + patch.reason + ' (anchors: ' + String(patch.anchors) + ')',
      }
    }
  }
  return { kind: 'none' }
}

/**
 * Find the registered patch for one served bundle URL (thin lookup; `classify` owns
 * the refuse decision).
 * @param url - the bundle URL the loader received.
 * @returns the patch to apply, or null to keep the untouched script path.
 */
export function findClientPluginPatch(url: string): ClientPluginPatch | null {
  const packageId = bundlePackageIdOf(url)
  if (packageId === null) return null
  return CLIENT_PLUGIN_PATCHES.find(entry => entry.packageId === packageId) ?? null
}

/** Every ECMAScript LineTerminator that could close a `//# sourceURL=` comment. */
const LINE_TERMINATOR = /[\r\n\u2028\u2029]/g

/**
 * Strip the characters that could terminate the appended `//# sourceURL=` comment.
 * Without this a URL carrying U+2028/U+2029 would end the comment early and its tail
 * would execute as code (an eval-injection surface this module must not have).
 * @param url - the bundle URL used for stack attribution.
 * @returns the same URL without line terminators.
 */
export function sanitizeSourceUrl(url: string): string {
  return url.replace(LINE_TERMINATOR, '')
}
