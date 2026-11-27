/**
 * Optional profile-plugin adapters: load-time compatibility for THIRD-PARTY client
 * plugins that predate the chamber per-entry base-path contract (design 09 §4).
 *
 * WHY. The chamber page is ONE document for N dsh instances. A third-party plugin has
 * two independent failure modes there:
 *  (1) it resolves its host route against `document.baseURI`, which is the control-plane
 *      origin, so every instance's configuration/settings bridge lands on the control
 *      plane root (404) instead of its own instance; and
 *  (2) it keeps mutable state (caches, controllers, listeners) in the plugin FACTORY
 *      scope, while the page-level module table executes one factory per package id and
 *      every entry reuses the same exports object — so two mounted instances share that
 *      state and cross-write each other's configuration.
 * Reading `ctx.get('chamberBasePath')` (the public contract) is the correct long-term
 * fix for (1) and keeping per-mount state inside `apply(ctx)` is the correct fix for
 * (2); this module is the bounded compatibility layer for plugins that have not adopted
 * either yet. It is DATA-DRIVEN: this file carries the transforms and the policy, the
 * concrete package list lives in `profile-plugin-registry.ts`; no package id or version
 * belongs in this module (design 09 §4 negative rule).
 *
 * TRANSFORMS (all applied to the served classic combo text, before execution):
 *  - per-apply factory wrapper: the whole classic factory body is moved into a local
 *    `createInstance(__dshChamberBasePath)` function; the outer factory still registers once and
 *    returns a plugin object whose `apply(ctx, ...args)` instantiates one implementation
 *    for THIS context and delegates to it. Factory-scope state therefore becomes
 *    per-mount state, and every callback/component/slot of that mount closes over its
 *    own implementation. The wrapper injects `'use strict';` as the factory body's first
 *    statement (the instantiated body inherits it) so the classic-script execution keeps
 *    the module-strict semantics the served `<script type=module>` path would have had. Only OBJECT plugin forms are
 *    supported: a factory that returns a function/class cannot be delegated generically
 *    (Function.prototype.apply would be hit); the wrapper throws a loud error instead, so
 *    that extra row degrades without a silent mis-call and without a boot failure.
 *  - per-instance document base: every exact BARE `document.baseURI` token INSIDE the
 *    factory body is replaced by a per-instance `__dshChamberBaseUri` constant
 *    (`document.baseURI` on a native dsh page, `<origin><chamberBasePath>/` inside the
 *    chamber page). The expected bare-token count is declared by the adapter and must
 *    match exactly; QUALIFIED or aliased forms (`window.document.baseURI`,
 *    `mydoc.baseURI`) are not touched and make the rewrite refuse, because silently
 *    rewriting them to an undefined identifier would be worse than degrading. The scan
 *    is textual: a token inside a string/comment counts as well, so adapters must declare
 *    the artifact's real count (evidence script proves it on the real payload); a body that
 *    reads any other baseURI form without a declared transform refuses instead of silently
 *    keeping the control-plane origin. Bare tokens
 *    OUTSIDE the factory body (top-level statements, load-object fields such as meta,
 *    chunks) are left untouched: rewriting them would reference an identifier that does
 *    not exist at that scope and could turn a bootable plugin into a whole-instance boot
 *    failure. The evidence script reports such outside tokens as warnings.
 *  - explicit anchor rewrites: optional fallback for plugins whose host route is NOT
 *    derived from a bare `document.baseURI` (custom prefix constants, origin-root
 *    relative fetches, ...). Each anchor must match exactly once; anchors may not contain
 *    `document.baseURI` because the token transform owns that surface, so a QUALIFIED base
 *    read (`window.document.baseURI`) cannot be repaired by anchor rewrites — such a
 *    plugin must adopt `chamberBasePath` or expose a non-token seam. The rewrite must not
 *    destroy the factory anchors/witnesses (checked after apply).
 *
 * REGISTRATION TAIL. The default factory anchors target the bare shape
 * `factory: (require) => { ... },\n});` where the factory is the load object's last
 * field. A generated/real bundle that carries fields AFTER the factory (e.g. the
 * official preset's top-level `meta` stylesheet producer) must declare
 * `factoryAnchors.close` as the factory closing line only (e.g. `'\n  },'`): the wrapper
 * inserts its scaffolding BEFORE that anchor, so everything after it (meta, other load
 * fields, `});`) is preserved byte for byte. The default is therefore a SYNTHETIC-shape
 * default, not a claim about every served bundle: real published client.js (including the
 * pinned official payload family) is minified single-line `factory:require=>{`, so a real
 * adapter sets factoryAnchors.open/close explicitly and often closeOccurrence 'last'.
 *
 * OUTER METADATA. The wrapper re-exposes only the Cordis metadata declared by the adapter
 * (`metadata.inject` as a string array, `metadata.name`). It cannot discover arbitrary
 * extra exports without executing the plugin body twice, so a plugin that exports more
 * Cordis metadata (Config schema, reusable, ...) must not be registered until this layer
 * models it. The evidence script reports best-effort `exports.<name>` drift, but that is
 * a review aid, not a guarantee.
 *
 * ANCHOR-MISS POLICY. Optional profile rows use the loader's
 * `degrade-unpatched-optional` policy: a witness/anchor/base-token mismatch, a rewrite
 * failure or an unreadable served text falls back to the untouched script-element path.
 * A third-party optional row must never turn into a whole-instance boot failure
 * (unlike the official `refuse` rows), and a non-single-id combo for a registered
 * package also keeps the untouched script path. Officially covered rows never use this
 * layer.
 *
 * RESIDUALS (design 09 §4). The page-level module table is first-load-wins: when two
 * instances run different versions of the same third-party package, the first loaded
 * owner factory serves both (only a version-conflict diagnostic is emitted); an adapted
 * factory loaded first keeps the per-apply layer for later instances, an unadapted one
 * leaves them unadapted. Re-running the factory body per mount also re-runs factory-level
 * one-time side effects (e.g. `customElements.define`); plugins with such side effects
 * must move them into `apply` before being registered here.
 *
 * EVIDENCE. The registry is data; each registered adapter needs its own artifact
 * evidence (`packages/renderer/scripts/verify-profile-plugin-adapter.mjs --package <id>
 * --artifact <tarball|client.js>`). The renderer unit suite proves the transforms and
 * the policy against SYNTHETIC plugins, so the framework stays green without any real
 * package registered. Deletion condition: remove an adapter once the plugin reads
 * `chamberBasePath` / keeps state per `apply` (or the upstream page-prefix seam lands);
 * this module stays as the bounded mechanism for the class.
 */

import { bundleComboResourceTokens, bundlePackageIdOf } from './client-plugin-patches.ts'

/**
 * The synthetic-shape classic combo factory opening line (the dsh pretty classic output).
 * Real artifacts with another builder shape override it through `factoryAnchors.open`.
 */
export const PROFILE_FACTORY_OPEN = 'factory: (require) => {'

/**
 * The synthetic-shape factory closing lines for a load object whose factory is its last
 * field. A bundle with load-object fields after the factory (e.g. a top-level `meta`)
 * declares `factoryAnchors.close` as the factory closing line only; the wrapper inserts
 * before that anchor and leaves the rest of the registration untouched.
 */
export const PROFILE_FACTORY_CLOSE = '\n  },\n});'

/** The document-relative base token third-party plugins overuse for host routes. */
export const PROFILE_DOCUMENT_BASE_URI = 'document.baseURI'

/** Per-instance replacement constant injected by the wrapper. */
export const PROFILE_BASE_URI_LOCAL = '__dshChamberBaseUri'

/**
 * The instance-scope parameter name injected by the wrapper. It is deliberately unique so
 * a factory body that declares its own `basePath` cannot collide; explicit anchor rewrites
 * may reference it to receive the per-instance base path.
 */
export const PROFILE_BASE_PATH_PARAM = '__dshChamberBasePath'

/** Idempotency marker: a patched text carrying it is never patched twice. */
export const PROFILE_WRAPPER_MARKER = 'const createInstance = (' + PROFILE_BASE_PATH_PARAM + ') => {'

/** One adapter's optional factory-anchor override (non-default served formatting). */
export interface ProfilePluginFactoryAnchors {
  readonly open: string
  /**
   * The factory-closing text. Minified bundles frequently end several nested constructs
   * with the same short tail (e.g. `}});`); `last` picks the LAST occurrence, which is
   * the factory/registration close for that shape.
   */
  readonly close: string
  /** Which close occurrence to anchor on (default 'first'; minified-shape adapters use 'last'). */
  readonly closeOccurrence?: 'first' | 'last'
}

/** One explicit anchor rewrite (for host routes not derived from `document.baseURI`). */
export interface ProfilePluginAnchorRewrite {
  readonly anchor: string
  readonly replacement: string
}

/** The Cordis metadata the wrapper re-exposes on the outer plugin object. */
export interface ProfilePluginAdapterMetadata {
  readonly inject?: readonly string[]
  readonly name?: string
}

/** One registered third-party client-plugin adapter (data, not code branches). */
export interface ProfilePluginAdapter {
  /** npm package id as it appears in the single-id combo resource (`<id>/client.js`). */
  readonly packageId: string
  /** Cordis metadata re-exposed on the outer wrapper object (only string[] inject/name). */
  readonly metadata?: ProfilePluginAdapterMetadata
  /**
   * Rewrite every BARE `document.baseURI` token in the served text to the per-instance
   * base; `expectedCount` is the exact bare-token count in the served artifact.
   */
  readonly baseUri?: { readonly expectedCount: number }
  /** Explicit anchor rewrites for plugins whose host route is not baseURI-derived. */
  readonly anchorRewrites?: readonly ProfilePluginAnchorRewrite[]
  /** Structural strings that must each appear exactly once (guards + evidence). */
  readonly witnesses: readonly string[]
  /** Why this adapter exists and when it can be deleted (diagnostics + review). */
  readonly reason: string
  /**
   * Optional published-artifact identity recorded at registration time (release re-run
   * pin): the evidence script defaults its sha256 check to it. Data only; never read at
   * runtime.
   */
  readonly evidence?: { readonly sha256?: string; readonly artifact?: string }
  /** Non-default factory anchors; defaults to {@link PROFILE_FACTORY_OPEN}/{@link PROFILE_FACTORY_CLOSE}. */
  readonly factoryAnchors?: ProfilePluginFactoryAnchors
}

/** The loader-facing patch produced from one registered adapter. */
export interface ProfilePluginPatch {
  readonly packageId: string
  readonly reason: string
  readonly anchors: number
  readonly anchorMiss: 'degrade-unpatched-optional'
  readonly apply: (text: string) => string | null
}

/** The dispatch decision for one bundle URL against the profile registry. */
export type ProfilePluginBundleMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'patch'; readonly patch: ProfilePluginPatch }
  /**
   * A registered package appears in a combo that is not a single-id
   * `<package>/client.js` resource (batch/malformed/other resource). Optional rows keep
   * the untouched script path instead of refusing to load (fail-open by policy).
   */
  | { readonly kind: 'unpatched'; readonly adapter: ProfilePluginAdapter; readonly message: string }

/** Count non-overlapping literal occurrences of one string. */
function count(text: string, needle: string): number {
  let total = 0
  let at = text.indexOf(needle)
  while (at >= 0) {
    total += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return total
}

/** Whether one character can extend an identifier-ish token on either side. */
function isIdentifierChar(character: string | undefined): boolean {
  return character !== undefined && character !== '' && /[\p{ID_Continue}$]/u.test(character)
}

/**
 * Count bare `document.baseURI` property accesses in one text: a token preceded by an
 * identifier character or `.` (`window.document.baseURI`) or followed by an identifier
 * character is qualified/extended and is NOT rewritten.
 * @param text - served classic bundle text.
 * @returns total literal occurrences and the bare subset.
 */
export function scanDocumentBaseUri(text: string): { total: number; bare: number } {
  let total = 0
  let bare = 0
  let at = text.indexOf(PROFILE_DOCUMENT_BASE_URI)
  while (at >= 0) {
    total += 1
    const previous = at === 0 ? undefined : text.charAt(at - 1)
    const next = text.charAt(at + PROFILE_DOCUMENT_BASE_URI.length)
    if (!isIdentifierChar(previous) && previous !== '.' && previous !== '#' && !isIdentifierChar(next)) bare += 1
    at = text.indexOf(PROFILE_DOCUMENT_BASE_URI, at + PROFILE_DOCUMENT_BASE_URI.length)
  }
  return { total, bare }
}

/**
 * Validate one adapter's data shape (used by the unit suite and the evidence script;
 * a malformed registry entry must fail loudly instead of silently never matching).
 * @param adapter - candidate registry entry.
 * @returns problems; an empty array means the entry is usable.
 */
export function validateProfileAdapter(adapter: ProfilePluginAdapter): string[] {
  const problems: string[] = []
  if (typeof adapter?.packageId !== 'string' || adapter.packageId.trim() === '') {
    problems.push('packageId must be a non-empty string')
  } else if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(adapter.packageId)) {
    problems.push('packageId must be a valid npm package name addressable as a combo resource (no whitespace or extra slashes)')
  }
  if (typeof adapter?.reason !== 'string' || adapter.reason.trim() === '') {
    problems.push('reason must be a non-empty string')
  }
  const witnesses = adapter?.witnesses
  if (!Array.isArray(witnesses) || witnesses.length === 0) {
    problems.push('witnesses must be a non-empty array of non-empty strings')
  } else {
    const seen = new Set<string>()
    for (const witness of witnesses) {
      if (typeof witness !== 'string' || witness === '') problems.push('witnesses must be non-empty strings')
      else if (seen.has(witness)) problems.push('duplicate witness ' + JSON.stringify(witness))
      seen.add(witness)
    }
  }
  const metadata = adapter?.metadata
  if (metadata !== undefined) {
    if (metadata.inject !== undefined) {
      if (!Array.isArray(metadata.inject) || metadata.inject.some(name => typeof name !== 'string' || name === '')) {
        problems.push('metadata.inject must be an array of non-empty strings')
      }
    }
    if (metadata.name !== undefined && (typeof metadata.name !== 'string' || metadata.name === '')) {
      problems.push('metadata.name must be a non-empty string')
    }
  }
  const baseUri = adapter?.baseUri
  if (baseUri !== undefined) {
    if (!Number.isInteger(baseUri.expectedCount) || baseUri.expectedCount < 1) {
      problems.push('baseUri.expectedCount must be an integer >= 1')
    }
  }
  const rewrites = adapter?.anchorRewrites
  if (rewrites !== undefined) {
    if (!Array.isArray(rewrites)) problems.push('anchorRewrites must be an array')
    else {
      const seen = new Set<string>()
      for (const rewrite of rewrites) {
        if (typeof rewrite?.anchor !== 'string' || rewrite.anchor === '') problems.push('anchorRewrites[].anchor must be a non-empty string')
        else if (rewrite.anchor.includes(PROFILE_DOCUMENT_BASE_URI)) problems.push('anchorRewrites[].anchor must not contain ' + PROFILE_DOCUMENT_BASE_URI + ' (owned by the baseUri transform)')
        else if (seen.has(rewrite.anchor)) problems.push('duplicate anchorRewrite ' + JSON.stringify(rewrite.anchor))
        if (typeof rewrite?.replacement !== 'string') problems.push('anchorRewrites[].replacement must be a string')
        else if (rewrite.replacement.includes(PROFILE_DOCUMENT_BASE_URI)) problems.push('anchorRewrites[].replacement must not reintroduce ' + PROFILE_DOCUMENT_BASE_URI + ' (the patched text would still hit the control-plane root)')
        seen.add(rewrite?.anchor ?? '')
      }
    }
  }
  const anchors = adapter?.factoryAnchors
  if (anchors !== undefined) {
    if (typeof anchors.open !== 'string' || anchors.open === '') problems.push('factoryAnchors.open must be a non-empty string')
    if (typeof anchors.close !== 'string' || anchors.close === '') problems.push('factoryAnchors.close must be a non-empty string')
    if (anchors.closeOccurrence !== undefined && anchors.closeOccurrence !== 'first' && anchors.closeOccurrence !== 'last') problems.push('factoryAnchors.closeOccurrence must be "first" or "last"')
  }
  if (rewrites !== undefined && Array.isArray(rewrites)) {
    for (let left = 0; left < rewrites.length; left += 1) {
      for (let right = left + 1; right < rewrites.length; right += 1) {
        const a = rewrites[left]?.anchor
        const b = rewrites[right]?.anchor
        if (typeof a !== 'string' || typeof b !== 'string') continue
        if (a === b) continue
        if (a.includes(b) || b.includes(a)) problems.push('anchorRewrites[].anchors must not be substrings of each other: ' + JSON.stringify(a) + ' / ' + JSON.stringify(b))
      }
    }
    for (const rewrite of rewrites) {
      if (typeof rewrite?.anchor === 'string' && typeof rewrite?.replacement === 'string' && rewrite.anchor === rewrite.replacement) {
        problems.push('anchorRewrites[].replacement must differ from its anchor')
      }
    }
  }
  return problems
}

/**
 * Build the loader-facing patch for one adapter. Every field is derived from the
 * adapter data plus the pure transform below; the loader owns the policy behavior.
 * @param adapter - registered profile adapter.
 * @returns the patch the loader can dispatch.
 */
export function profilePluginPatch(adapter: ProfilePluginAdapter): ProfilePluginPatch {
  const witnesses = Array.isArray(adapter.witnesses) ? adapter.witnesses : []
  const anchorRewrites = Array.isArray(adapter.anchorRewrites) ? adapter.anchorRewrites : []
  const anchors = witnesses.length
    + (adapter.baseUri === undefined ? 0 : 1)
    + anchorRewrites.length
  return {
    packageId: adapter.packageId,
    reason: adapter.reason,
    anchors,
    anchorMiss: 'degrade-unpatched-optional',
    apply: (text: string): string | null => applyProfileAdapter(text, adapter),
  }
}

/**
 * Rewrite one served classic bundle through the generic per-apply wrapper.
 *
 * Structure of the produced text (the factory body is byte-preserved between the
 * anchors; only the wrapper scaffolding, the injected strict directive and the bare
 * baseURI tokens change; everything after the close anchor is left untouched):
 *
 *   window.__ModuleLoader__.load({ id: "...", factory: (require) => {
 *     'use strict';
 *     const createInstance = (__dshChamberBasePath) => {
 *       const __dshChamberBaseUri = __dshChamberBasePath === undefined ? document.baseURI : new URL(__dshChamberBasePath + '/', window.location.origin).href;
 *       ...original factory body...
 *     };
 *     const apply = (ctx, ...args) => { ...validate chamber keys...; const instance = createInstance(chamberBasePath); ...; return instance.apply(ctx, ...args) }
 *     return { apply, inject?, name? };
 *   },\n});
 *
 * @param text - the served combo script text.
 * @param adapter - registered profile adapter.
 * @returns the rewired text, or null when any witness/anchor/token/structural guard fails.
 */
export function applyProfileAdapter(text: string, adapter: ProfilePluginAdapter): string | null {
  if (typeof text !== 'string' || text === '') return null
  if (validateProfileAdapter(adapter).length > 0) return null
  if (text.includes(PROFILE_WRAPPER_MARKER)) return null
  if (text.includes(PROFILE_BASE_PATH_PARAM)) return null
  const open = adapter.factoryAnchors?.open ?? PROFILE_FACTORY_OPEN
  const close = adapter.factoryAnchors?.close ?? PROFILE_FACTORY_CLOSE
  const closeOccurrence = adapter.factoryAnchors?.closeOccurrence ?? 'first'
  const openCount = count(text, open)
  const closeCount = count(text, close)
  if (openCount !== 1) return null
  if (closeOccurrence === 'last' ? closeCount < 1 : closeCount !== 1) return null
  for (const witness of adapter.witnesses) {
    if (count(text, witness) !== 1) return null
  }
  const rewrites = adapter.anchorRewrites ?? []
  for (const rewrite of rewrites) {
    if (count(text, rewrite.anchor) !== 1) return null
  }
  const originalBodyStart = text.indexOf(open) + open.length
  const originalCloseAt = closeOccurrence === 'last' ? text.lastIndexOf(close) : text.indexOf(close)
  if (originalCloseAt <= originalBodyStart) return null
  for (const rewrite of rewrites) {
    const at = text.indexOf(rewrite.anchor)
    if (at < originalBodyStart || at + rewrite.anchor.length > originalCloseAt) return null
  }

  let out = text
  for (const rewrite of rewrites) {
    const before = out
    out = out.replace(rewrite.anchor, () => rewrite.replacement)
    if (out === before) return null
  }
  for (const rewrite of rewrites) {
    if (out.includes(rewrite.anchor)) return null
  }
  if (count(out, open) !== 1) return null
  if (closeOccurrence === 'last' ? count(out, close) < 1 : count(out, close) !== 1) return null
  for (const witness of adapter.witnesses) {
    if (count(out, witness) !== 1) return null
  }

  const bodyStart = out.indexOf(open) + open.length
  const bodyEnd = closeOccurrence === 'last' ? out.lastIndexOf(close) : out.indexOf(close)
  if (bodyEnd <= bodyStart) return null
  const body = out.slice(bodyStart, bodyEnd)
  const bodyScan = scanDocumentBaseUri(body)
  const bodyBaseUriWords = count(body, 'baseURI')
  const wholeScan = scanDocumentBaseUri(out)
  const baseUri = adapter.baseUri
  if (baseUri === undefined) {
    // A body that still reads a `baseURI` word without a declared transform would keep the
    // control-plane origin (or read an undefined identifier after a partial rewrite); refuse
    // instead of pretending the adapter covers it. Counting the word (not `document.baseURI`)
    // also covers qualified/computed accesses the token transform could not rewrite; it
    // subsumes the bare literal count, so this is one condition, not two.
    if (bodyBaseUriWords > 0) return null
  } else {
    if (bodyScan.total !== bodyScan.bare) return null
    if (bodyScan.bare !== baseUri.expectedCount) return null
    // Any baseURI access form the textual token transform cannot count is uncovered.
    if (bodyBaseUriWords !== bodyScan.total) return null
    if (out.includes(PROFILE_BASE_URI_LOCAL)) return null
    out = out.slice(0, bodyStart) + body.split(PROFILE_DOCUMENT_BASE_URI).join(PROFILE_BASE_URI_LOCAL) + out.slice(bodyEnd)
  }

  const metadata = adapter.metadata
  const injectLiteral = metadata?.inject === undefined ? undefined : JSON.stringify(metadata.inject)
  const nameLiteral = metadata?.name === undefined ? undefined : JSON.stringify(metadata.name)
  const declarations = ["'use strict';", PROFILE_WRAPPER_MARKER]
  if (baseUri !== undefined) {
    declarations.push('const ' + PROFILE_BASE_URI_LOCAL + ' = ' + PROFILE_BASE_PATH_PARAM + " === undefined ? globalThis.document.baseURI : new globalThis.URL(" + PROFILE_BASE_PATH_PARAM + " + '/', globalThis.location.origin).href;")
  }
  out = out.replace(open, () => open + '\n    ' + declarations.join('\n    '))

  const unsupported = 'dsh-chamber: optional profile adapter for ' + adapter.packageId
    + ' requires the plugin factory to return an object with apply(ctx, ...args); function/class Cordis plugin forms are not supported by this layer'
  const outer: string[] = [
    '    };',
    '    const apply = (ctx, ...args) => {',
    "      const chamberInstanceId = ctx.get('chamberInstanceId');",
    "      const chamberBasePath = ctx.get('chamberBasePath');",
    '      if (chamberInstanceId !== undefined && chamberBasePath === undefined) {',
    '        throw new Error(' + JSON.stringify('dsh-chamber: optional profile adapter for ' + adapter.packageId + ' cannot resolve its per-entry base path (chamberInstanceId present without chamberBasePath)') + ');',
    '      }',
    "      if (chamberBasePath !== undefined && (typeof chamberBasePath !== 'string' || chamberBasePath.charAt(0) !== '/' || chamberBasePath.charAt(1) === '/' || chamberBasePath.endsWith('/') || chamberBasePath.includes('?') || chamberBasePath.includes('#'))) {",
    '        throw new Error(' + JSON.stringify('dsh-chamber: optional profile adapter for ' + adapter.packageId + ' received an invalid chamberBasePath: ') + ' + JSON.stringify(chamberBasePath));',
    '      }',
    "      if (chamberInstanceId !== undefined && chamberBasePath !== '/api/i/' + chamberInstanceId) {",
    '        throw new Error(' + JSON.stringify('dsh-chamber: optional profile adapter for ' + adapter.packageId + ' received a chamberBasePath that does not belong to its instance: ') + ' + JSON.stringify(chamberBasePath));',
    '      }',
    '      const instance = createInstance(chamberBasePath);',
    "      if (instance === null || typeof instance !== 'object' || typeof instance.apply !== 'function') {",
    '        throw new Error(' + JSON.stringify(unsupported) + ');',
    '      }',
    '      return instance.apply(ctx, ...args);',
    '    }',
  ]
  if (injectLiteral !== undefined) outer.push('    const inject = ' + injectLiteral + ';')
  if (nameLiteral !== undefined) outer.push('    const name = ' + nameLiteral + ';')
  const wrapperReturnLine = '    return { apply' + (injectLiteral === undefined ? '' : ', inject') + (nameLiteral === undefined ? '' : ', name') + ' };'
  outer.push(wrapperReturnLine)
  const injectedText = declarations.join('\n') + '\n' + outer.join('\n')
  const openBefore = count(text, open)
  const closeBefore = count(text, close)
  const finalCloseAt = closeOccurrence === 'last' ? out.lastIndexOf(close) : out.indexOf(close)
  if (finalCloseAt < 0) return null
  out = out.slice(0, finalCloseAt) + '\n' + outer.join('\n') + close + out.slice(finalCloseAt + close.length)
  if (out === text) return null
  if (count(out, PROFILE_WRAPPER_MARKER) !== count(text, PROFILE_WRAPPER_MARKER) + count(injectedText, PROFILE_WRAPPER_MARKER)) return null
  if (count(out, open) !== openBefore) return null
  if (count(out, close) !== closeBefore) return null
  if (count(out, 'const instance = createInstance(chamberBasePath);') !== 1) return null
  if (count(out, 'return instance.apply(ctx, ...args);') !== 1) return null
  if (count(out, 'const apply = (ctx, ...args) => {') !== 1) return null
  if (count(out, wrapperReturnLine) !== count(text, wrapperReturnLine) + 1) return null
  for (const witness of adapter.witnesses) {
    if (count(out, witness) !== 1 + count(injectedText, witness)) return null
  }
  if (baseUri !== undefined) {
    const expectedTokens = wholeScan.total - bodyScan.bare + 1
    if (count(out, PROFILE_DOCUMENT_BASE_URI) !== expectedTokens) return null
    if (count(out, PROFILE_BASE_URI_LOCAL) !== bodyScan.bare + 1) return null
  }
  return out
}
/**
 * Find the registered adapter for one bundle URL (single-id combo only).
 * @param url - served bundle URL.
 * @param adapters - profile registry.
 * @returns the adapter, or null when the URL names no registered package.
 */
export function findProfilePluginAdapter(
  url: string,
  adapters: readonly ProfilePluginAdapter[],
): ProfilePluginAdapter | null {
  const packageId = bundlePackageIdOf(url)
  if (packageId === null) return null
  return adapters.find(adapter => adapter.packageId === packageId) ?? null
}

/**
 * Classify one bundle URL against the profile registry.
 * Single-id combo of a registered package → patch; a registered package named inside a
 * non-single-id combo → keep the untouched script path (optional rows never refuse);
 * anything else → none.
 * @param url - served bundle URL.
 * @param adapters - profile registry.
 * @returns the dispatch decision.
 */
export function classifyProfilePluginBundle(
  url: string,
  adapters: readonly ProfilePluginAdapter[],
): ProfilePluginBundleMatch {
  // Empty registry is the normal framework-only state: zero behaviour change, zero work.
  if (adapters.length === 0) return { kind: 'none' }
  const adapter = findProfilePluginAdapter(url, adapters)
  if (adapter !== null) return { kind: 'patch', patch: profilePluginPatch(adapter) }
  const resources = bundleComboResourceTokens(url)
  if (resources.length > 0) {
    for (const candidate of adapters) {
      const namespace = candidate.packageId + '/'
      if (!resources.some(resource => resource.startsWith(namespace))) continue
      return {
        kind: 'unpatched',
        adapter: candidate,
        message: 'dsh-chamber: the registered optional profile package ' + candidate.packageId
          + ' appears in a combo resource that is not a single-id client.js bundle; keeping the untouched script path — ' + candidate.reason,
      }
    }
  }
  return { kind: 'none' }
}
