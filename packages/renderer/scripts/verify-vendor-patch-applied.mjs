/**
 * Build-time proof that the registered vendor patches landed in the emitted
 * chamber bundle (design 09 §3.6).
 *
 * THREE LAYERS, ONE JOB:
 *  - the renderer's vite plugin accumulates `applyVendorPatches`' `applied`
 *    coverage and fails the build when a registered vendor file was never
 *    patched (an id-form mistake is otherwise a silent no-op),
 *  - this artifact check proves each patch's marker SURVIVED into an asset the
 *    browser is served, and
 *  - the sourcemap check proves every patched module still rides the emitted
 *    chunk maps. A transform that returns code without a map only WARNS
 *    (rollup SOURCEMAP_BROKEN) while silently dropping the module from every
 *    .map, so the warning is turned into a failing build here (design 09 §3.6).
 *
 * Minimal by design: one present marker per registered vendor file, plus the
 * layout fork's root prop (the chamber half the ui-chat patch consumes). A
 * route patch is bound to the asset declaring its route literal, so a marker
 * in an unrelated chunk can never vouch for a missing copy (X1/X3). CSS
 * patches are checked against the emitted CSS assets as well as the JS ones.
 *
 * Runs as the last step of `build:renderer`, after `gen-boot-manifest.mjs` has
 * written dist/web/manifest.json.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { VENDOR_PATCHES, countSourcemapSegments } from './vendor-patches.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WEB = join(ROOT, 'desktop', 'dist', 'web')

/**
 * One minifier-stable present marker per registered patch file. `route` binds
 * the marker to the asset declaring that route literal (module identity); the
 * layout marker has no vendor file — it is the chamber half of the ui-chat
 * patch (the N-ctx layout fork publishes the prop the patched resolver reads).
 * @type {readonly { vendorFile?: string, what: string, present: RegExp, route?: string }[]}
 */
export const VENDOR_PATCH_MARKERS = [
  {
    vendorFile: 'dsh-client-ui-settings-account/src/client/index.ts',
    what: 'the desktop onboarding overlay AND its onboarding-visible flag are gated off',
    // Patched: `if (desktop && (globalThis as {...}).__dshChamberAccountOverlay === true)`.
    // The property name exists nowhere upstream, so its presence next to the equality
    // proves the patch reached the chunk; the minifier keeps the literal as `!0` or `true`.
    present: /__dshChamberAccountOverlay\s*===\s*(?:!0|true)/,
  },
  {
    vendorFile: 'dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx',
    what: 'ui-chat file-API base carries the per-entry base path',
    // Patched: `const base = chamberFileApiBase === undefined || chamberFileApiBase === ''
    // ? document.baseURI : new URL(`\${chamberFileApiBase}/`, document.baseURI).href`, then a
    // resolver that passes THAT const as the FIRST argument of its URL builder. The
    // backreference pins the minified names across the guard, the template and that argument
    // position, so a bundle that computes the prefix and then resolves against document.baseURI
    // cannot satisfy this marker. The callee is only shape-bound (a plain call or the
    // `(0, callee)(...)` sequence form a different minifier may emit); no vendor helper
    // name is bound (the chunk minifier renames
    // those); disjointness from the sibling ChatView marker comes from the const+return shape,
    // which that inline-argument site never has.
    present: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*===\s*void 0\s*\|\|\s*\2\s*===\s*(?:"{2}|'{2})\s*\?\s*document\.baseURI\s*:\s*new URL\(`\$\{\2\}\/`,?\s*document\.baseURI\)\.href\s*;?\s*return\s*\{\s*resolve:\s*[^}]{0,40}?=>\s*(?:\(\s*0\s*,\s*[A-Za-z_$][\w$]*\s*\)|[A-Za-z_$][\w$]*)\(\s*\1\s*,/,
  },
  {
    vendorFile: 'dsh-client-ui-chat/src/client/chat/ChatView.tsx',
    what: 'ui-chat chat-view file images carry the per-entry base path',
    // Patched: the fileImages resolver inlines the same guarded ternary inside the
    // imported fileMediaUrl(...) helper. The helper name is minifier-renamed, so the
    // marker cannot bind the callee; disjointness from the AssistantMarkdown marker
    // (same package chunk) comes from the `"image.open"` labels block only the chat
    // view carries, which the guard must still precede.
    present: /([A-Za-z_$][\w$]*)\s*===\s*void 0\s*\|\|\s*\1\s*===\s*(?:"{2}|'{2})\s*\?\s*document\.baseURI\s*:\s*new URL\(`\$\{\1\}\/`,?\s*document\.baseURI\)\.href[\s\S]{0,120}?"image\.open"/,
  },
  {
    vendorFile: 'dsh-client-file-upload/src/client/runtime.ts',
    what: 'file-upload upload URL carries the per-entry base path',
    // Patched: the `ctx.get('chamberBasePath')` read sits beside the
    // `__DSH_FILE_UPLOAD__` transport selection it prefixes.
    present: /__DSH_FILE_UPLOAD__[^;{}]{0,100}chamberBasePath/,
  },
  {
    vendorFile: 'dsh-session-log-export/src/client/controller.ts',
    what: 'session-log export URL carries the per-entry base path',
    // Patched: ``\${this.chamberFileApiBase}\${SESSION_LOG_EXPORT_ROUTE}?\${query}``.
    present: /\$\{this\.chamberFileApiBase\}\$\{[A-Za-z_$][\w$]*\}\?\$\{/,
    // Chunk identity: the asset declaring this route literal must own the marker.
    route: '/api/session.export',
  },
  {
    vendorFile: 'dsh-session-log-export/src/client/index.ts',
    what: 'session-log export plugin hands the controller its base path',
    // Patched: `controller.chamberFileApiBase = basePath === undefined ? '' : `\${basePath}/``.
    present: /chamberFileApiBase\s*=\s*([A-Za-z_$][\w$]*)\s*===\s*void 0\s*\|\|\s*\1\s*===\s*""\s*\?\s*""\s*:\s*\`/,
  },
  {
    vendorFile: 'dsh-client-ui-deliverables/src/client/present-open.ts',
    what: 'ui-deliverables present routes carry the per-entry base path',
    // Patched: BOTH routes carry the prefix - the host read
    // (`fetch(`\${this.chamberFileApiBase}\${ROUTE}`, { signal })` consumed by `.ok` +
    // `.json()`) and the POST open (`{ method: "POST" }`). The window is the measured
    // 463-character gap between the two sites (host-read `.json()` to the prefixed POST)
    // plus margin: it must stay tight so a foreign prefixed POST further out cannot join.
    // A join across the sibling store classes is excluded by the host-read tail above.
    // An impostor inserted INSIDE the `.json()`-to-POST gap is not excluded by the window:
    // only the executed fixture covers that mutation — the window bounds reach, not class.
    present: /fetch\(\`\$\{this\.chamberFileApiBase\}\$\{[A-Za-z_$][\w$]*\}`,?\s*\{\s*signal[^}]{0,40}\}\)[\s\S]{0,60}?\.json\(\)[\s\S]{0,550}?fetch\(\`\$\{this\.chamberFileApiBase\}\$\{[A-Za-z_$][\w$]*\}`,?\s*\{\s*method:\s*"POST"/,
    route: '/api/present.host',
  },
  {
    vendorFile: 'dsh-client-ui-deliverables/src/client/index.ts',
    what: 'ui-deliverables plugin hands the controller its base path',
    // Patched: `new PresentedOpenController((ctx.get('chamberBasePath') as string | undefined) ?? '')`.
    present: /new\s+[A-Za-z_$][\w$]*\s*\(\s*[A-Za-z_$][\w$]*\.get\("chamberBasePath"\)\s*\?\?\s*""\s*\)/,
  },
  {
    vendorFile: 'dsh-client-ui-workspace/src/client/navigation.ts',
    what: 'ui-workspace selection persist key carries the per-entry instance scope',
    // Patched: the store name concatenates chamberSelectionScope(this.ctx).
    present: /dsh\.sessions\.current["']?\s*\+\s*[A-Za-z_$][\w$]*\(/,
  },
  {
    vendorFile: 'dsh-client-ui-workspace/src/client/index.ts',
    what: 'the three session-row seat declarations are owned by the chamber sidebar, not the workspace-browser registration (ownership transfer)',
    // Patched: the children map closes right after `…session.row.action`, so the
    // three seat keys are gone (trailing is 0.2.2's third seat); an unpatched bundle carries
    // `"sidebar.session.row.leading"` at exactly this seam. Minified variable
    // names after `store:` are irrelevant.
    present: /sidebar\.workspaces\.session\.row\.action":\{kind:"list",scope:"root"\}\},store:/,
  },
  {
    vendorFile: 'dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx',
    what: 'ui-chat node view forwards the file-API base prop',
    // Patched: the node view FORWARDS the base into the AssistantMarkdown element, as the prop that
    // closes that element's prop object right after `t`. The destructured parameter list carries the
    // same name, but that mention is this patch's own first edit — binding the call site instead keeps
    // the marker on the forwarding step, which is what would silently go missing.
    present: /mentions\s*:\s*[A-Za-z_$][\w$]*,t\s*:\s*[A-Za-z_$][\w$]*,chamberFileApiBase\s*:\s*[A-Za-z_$][\w$]*\}/u,
  },
  {
    vendorFile: 'dsh-client-ui-conversation/src/client/conversation/assembly.ts',
    what: 'conversation scheduler carries the 80 ms slice state',
    // Patched: the slice scheduler's monotonic timestamps are a NEW PAIR of class fields
    // (declared flush-then-publish). Binding both in order keeps the marker off the
    // scheduler reads, which mention the same names in the other order. Unrelated to the
    // file-route base goal: tightened in the same batch because the old single-name marker
    // was the only marker a future upstream same-name read could satisfy falsely.
    present: /lastFlushAt[^\n]{0,40}?lastPublishAt/,
  },
  {
    vendorFile: 'dsh-client-ui-chat/src/client/chat/use-chat-reading.ts',
    what: 'the sampled settle re-pins the tail while the follow is still owned',
    // Patched: the settle calls `this.followTail()` under the bare result of
    // `this.follow.sample(...)`, where upstream guards it with
    // `!scroll.movedByReader &&`. The backreference tolerates minified locals.
    present: /this\.follow\.sample\([^)]*\)[\s\S]{0,200}?if\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*this\.followTail\s*\(\)/,
  },
  {
    what: 'layout fork publishes the chamberFileApiBase root standard prop',
    // Chamber-package half of the ui-chat patch (not a vendor file): without
    // the prop the patched resolver falls back to document.baseURI, which is
    // correct for an official-layout deployment but means the N-ctx fix did
    // not land. Presence-only: the prop has no unpatched token of its own.
    present: /props:\s*[A-Za-z_$][\w$]*\s*===\s*void 0\s*\?\s*\{\}\s*:\s*\{\s*chamberFileApiBase\s*:\s*[A-Za-z_$][\w$]*\s*\}/,
  },
  {
    vendorFile: 'dsh-client-ui-deliverables/src/client/Deliverables.tsx',
    what: 'ui-deliverables delivery-card file actions carry the per-entry base path',
    // Patched: the call site hands the consumer a prefixed owner route; an absent
    // base stays upstream. The base is a destructured local (the minifier renames
    // it), so the marker binds the prop name to the SAME local the prefix ternary
    // reads, then the slot-name literal that owns this call site.
    present: /chamberFileApiBase\s*:\s*([A-Za-z_$][\w$]*)[\s\S]{0,4000}?["']deliverables\.file\.actions["'],\s*\{\s*actionUrl:\s*\(\s*\1\s*===\s*void 0\s*\|\|\s*\1\s*===\s*(?:"{2}|'{2})\s*\?\s*(?:"{2}|'{2})\s*:\s*`\$\{\1\}\/`\s*\)\s*\+\s*[A-Za-z_$][\w$]*\(/,
    route: '/api/present.open',
  },
  {
    vendorFile: 'dsh-client-ui-deliverables/src/client/ReviewTab.tsx',
    what: 'ui-deliverables review file actions carry the per-entry base path',
    // Same prop-to-local binding; the slot-name literal (`deliverables.review.file.actions`)
    // keeps the two same-chunk markers disjoint without leaning on an expression
    // the minifier may reorder.
    present: /chamberFileApiBase\s*:\s*([A-Za-z_$][\w$]*)[\s\S]{0,4000}?["']deliverables\.review\.file\.actions["'],\s*\{\s*actionUrl:\s*\(\s*\1\s*===\s*void 0\s*\|\|\s*\1\s*===\s*(?:"{2}|'{2})\s*\?\s*(?:"{2}|'{2})\s*:\s*`\$\{\1\}\/`\s*\)\s*\+\s*[A-Za-z_$][\w$]*\(/,
    route: '/api/changes.open',
  },
  {
    vendorFile: 'dsh-client-ui-deliverables/src/client/host-read-store.ts',
    what: 'ui-deliverables summary and diff reads carry the per-entry base path',
    // Patched: `this.policy.decode(await fetch(`${this.chamberFileApiBase}${url}`, { signal }))`
    // - `policy`, `decode` and `chamberFileApiBase` are properties, never minified.
    present: /this\.policy\.decode\(await fetch\(`\$\{this\.chamberFileApiBase\}\$\{/,
    route: '/api/changes.summary',
  },
  {
    vendorFile: 'dsh-client-ui-attachment/src/client/drop-events.ts',
    what: 'the drop intake is contained to the attachment view its listener belongs to',
    // Patched shape: target instanceof Element ? target : (target instanceof Node ? target.parentElement : null),
    // then the null guard and owner.contains(node). Element/Node are environment globals
    // (never renamed); the unpatched module has no contains() call.
    present: /instanceof Element\s*\?[\s\S]{0,80}instanceof Node\s*\?[\s\S]{0,60}\.parentElement[\s\S]{0,60}:\s*null[\s\S]{0,240}\.contains\([\s\S]{0,500}?(?:&&\s*[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)|if\s*\(!\s*[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\s*\)\s*return)/u,
  },
  {
    vendorFile: 'dsh-client-ui-attachment/src/client/ComposerAttachments.tsx',
    what: 'the attachment view resolves its own [data-instance] subtree for the containment check',
    // A string literal survives minification; only the patched component carries it.
    // Six arguments after the 0.2.2 upstream signature: canAcceptDrop, onAddFiles, dragDepth,
    // setDragActive, readFileDrag, then the chamber owner resolver.
    present: /closest\((["'])\[data-instance\]\1\)[\s\S]{0,700}?=>\s*\{?\s*(?:return\s+)?[A-Za-z_$][\w$]*\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)/u,
  },
]

/** Registered vendor files with no marker above — every patch needs one. */
function uncoveredVendorFiles() {
  return VENDOR_PATCHES
    .filter((patch) => !VENDOR_PATCH_MARKERS.some((marker) => marker.vendorFile === patch.vendorFile))
    .map((patch) => patch.vendorFile)
}

/** Assets carrying a route literal (leading slash optional) = chunk identity. */
function routeOwned(assets, route) {
  const relative = route.replace(/^\//, '')
  return assets.filter((asset) => asset.includes(route) || asset.includes(relative))
}

/**
 * Check the emitted assets against every marker. A route-bound marker is
 * judged only inside the assets declaring its route literal, so the marker and
 * the chunk declaring that route can never disagree about which asset was patched.
 * @param {string | readonly string[]} assets - emitted JS/CSS asset contents.
 * @returns {{ what: string }[]} failures, empty when every marker survived.
 */
export function checkVendorPatchBundle(assets) {
  const list = Array.isArray(assets) ? assets : [assets]
  const failures = []
  for (const marker of VENDOR_PATCH_MARKERS) {
    const candidates = marker.route === undefined ? list : routeOwned(list, marker.route)
    if (!candidates.some((asset) => marker.present.test(asset))) failures.push({ what: marker.what })
  }
  return failures
}

/** Every emitted chunk sourcemap under dist/web/assets (`build.sourcemap: true`). */
function allSourcemaps() {
  const assets = join(WEB, 'assets')
  if (!existsSync(assets)) return []
  return readdirSync(assets)
    .filter((name) => name.endsWith('.js.map'))
    .map((name) => join(assets, name))
}

/**
 * Load the emitted chunk maps, counting mappings only for the maps that carry a
 * registered vendor source: a multi-megabyte bundle map is not scanned for
 * nothing, and the counts are what separates "in the map" from "mapped".
 * @param {readonly string[]} files
 * @returns {{ sources: readonly string[], sourcesContent: readonly (string | null | undefined)[], segmentCounts: Map<number, number> }[]}
 */
function loadSourcemaps(files) {
  return files.map((file) => {
    const map = JSON.parse(readFileSync(file, 'utf8'))
    const sources = Array.isArray(map.sources) ? map.sources : []
    const registered = sources.some((source) =>
      VENDOR_PATCHES.some((patch) => patch.idSuffixes.some((suffix) => source.endsWith(suffix))))
    return {
      sources,
      sourcesContent: Array.isArray(map.sourcesContent) ? map.sourcesContent : [],
      segmentCounts: registered && typeof map.mappings === 'string'
        ? countSourcemapSegments(map.mappings)
        : new Map(),
    }
  })
}

/**
 * Check the emitted sourcemap chain: every registered vendor file must appear as
 * a source of some chunk map, with the pinned content and at least one mapping
 * segment pointing at it. A missing/incomplete map is invisible in the bundle
 * text and only fatal to a stack trace in patched code, which is why it is a
 * gate rather than a warning.
 * @param {readonly { sources: readonly string[], sourcesContent: readonly (string | null | undefined)[], segmentCounts: Map<number, number> }[]} maps
 * @returns {{ vendorFile: string, reason: string }[]} failures, empty when every patched module is mapped.
 */
export function checkVendorPatchSourcemaps(maps) {
  const failures = []
  for (const patch of VENDOR_PATCHES) {
    let reason = 'is not a source of any emitted chunk map'
    let mapped = false
    for (const map of maps) {
      const index = map.sources.findIndex((source) => patch.idSuffixes.some((suffix) => source.endsWith(suffix)))
      if (index === -1) continue
      if ((map.segmentCounts.get(index) ?? 0) === 0) {
        reason = 'is a source of a chunk map but no mapping points at it'
        continue
      }
      const content = map.sourcesContent[index]
      if (typeof content !== 'string' || content === '') {
        reason = 'is mapped but its chunk map carries no sourcesContent'
        continue
      }
      mapped = true
      break
    }
    if (!mapped) failures.push({ vendorFile: patch.vendorFile, reason })
  }
  return failures
}

/** Every emitted JS and CSS asset under dist/web/assets. */
function allAssets() {
  const assets = join(WEB, 'assets')
  if (!existsSync(assets)) return []
  return readdirSync(assets)
    .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
    .map((name) => join(assets, name))
}

function main() {
  const uncovered = uncoveredVendorFiles()
  if (uncovered.length > 0) {
    console.error(`verify-vendor-patch-applied: no artifact marker for registered patch(es): ${uncovered.join(', ')}`)
    return 1
  }
  const files = allAssets()
  if (files.length === 0) {
    console.error('verify-vendor-patch-applied: no emitted JS/CSS assets under dist/web/assets — run after vite build')
    return 1
  }
  const failures = checkVendorPatchBundle(files.map((file) => readFileSync(file, 'utf8')))
  for (const failure of failures) {
    console.error(`✗ vendor patch marker missing from the served bundle: ${failure.what}`)
  }
  if (failures.length > 0) {
    console.error('verify-vendor-patch-applied: a registered vendor patch did not reach the served bundle — check the vite transform id matching (design 09 §3.6)')
    return 1
  }
  const sourcemapFiles = allSourcemaps()
  if (sourcemapFiles.length === 0) {
    console.error('verify-vendor-patch-applied: no emitted chunk sourcemaps under dist/web/assets — the renderer build must keep build.sourcemap on')
    return 1
  }
  /** @type {{ vendorFile: string, reason: string }[]} */
  let sourcemapFailures
  try {
    sourcemapFailures = checkVendorPatchSourcemaps(loadSourcemaps(sourcemapFiles))
  } catch (error) {
    console.error(`verify-vendor-patch-applied: unreadable chunk sourcemap under dist/web/assets — ${error.message}`)
    return 1
  }
  for (const failure of sourcemapFailures) {
    console.error(`✗ patched vendor module absent from the emitted sourcemap chain: ${failure.vendorFile} (${failure.reason})`)
  }
  if (sourcemapFailures.length > 0) {
    console.error('verify-vendor-patch-applied: the patch transform must return a sourcemap, not only code — rollup drops an unmapped module from every chunk map (design 09 §3.6)')
    return 1
  }
  console.log(`✓ vendor patch markers survived into the emitted bundle (${VENDOR_PATCH_MARKERS.length} markers, ${VENDOR_PATCHES.length} registered files) and every patched module rides the emitted sourcemaps`)
  return 0
}

const isEntry = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url
if (isEntry) process.exit(main())
