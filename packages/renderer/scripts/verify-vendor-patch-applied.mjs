/**
 * Build-time proof that the registered vendor patches landed in the emitted
 * chamber bundle (design 09 §3.6).
 *
 * TWO LAYERS, ONE JOB:
 *  - the renderer's vite plugin accumulates `applyVendorPatches`' `applied`
 *    coverage and fails the build when a registered vendor file was never
 *    patched (an id-form mistake is otherwise a silent no-op), and
 *  - this artifact check proves each patch's marker SURVIVED into an asset the
 *    browser is served.
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
import { VENDOR_PATCHES } from './vendor-patches.mjs'

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
    vendorFile: 'dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx',
    what: 'ui-chat file-API base carries the per-entry base path',
    // Patched: `const base = chamberFileApiBase === undefined ? document.baseURI
    // : new URL(`\${chamberFileApiBase}/`, document.baseURI).href`. The backreference
    // pins the same minified variable on both sides of the ternary.
    present: /([A-Za-z_$][\w$]*)\s*===\s*void 0\s*\?\s*document\.baseURI\s*:\s*new URL\(\`\$\{\1\}\/\`/,
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
    // Module identity: the asset declaring this route must own the marker.
    route: '/api/session.export',
  },
  {
    vendorFile: 'dsh-session-log-export/src/client/index.ts',
    what: 'session-log export plugin hands the controller its base path',
    // Patched: `controller.chamberFileApiBase = basePath === undefined ? '' : `\${basePath}/``.
    present: /chamberFileApiBase\s*=\s*[A-Za-z_$][\w$]*\s*===\s*void 0\s*\?\s*""\s*:\s*\`/,
  },
  {
    vendorFile: 'dsh-client-ui-deliverables/src/client/present-open.ts',
    what: 'ui-deliverables present routes carry the per-entry base path',
    // Patched: `fetch(`\${this.chamberFileApiBase}\${ROUTE}`)` — the
    // chamber-owned property, never a generic two-interpolation fetch.
    present: /fetch\(\`\$\{this\.chamberFileApiBase\}\$\{/,
    route: '/api/present.host',
  },
  {
    vendorFile: 'dsh-client-ui-deliverables/src/client/index.ts',
    what: 'ui-deliverables plugin hands the controller its base path',
    // Patched: `new PresentedOpenController((ctx.get('chamberBasePath') as string | undefined) ?? '')`.
    present: /new\s+[A-Za-z_$][\w$]*\s*\(\s*[A-Za-z_$][\w$]*\.get\("chamberBasePath"\)\s*\?\?\s*""\s*\)/,
  },
  {
    vendorFile: 'dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx',
    what: 'ui-chat node view forwards the file-API base prop',
    // Patched: `chamberFileApiBase` closes the destructured parameter list and
    // the component body still starts from `node.data` — the forwarding edit.
    present: /chamberFileApiBase\s*:\s*[A-Za-z_$][\w$]*\s*\}\s*\)\s*\{\s*const\s+[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$][\w$]*\.data\s*,/,
  },
  {
    vendorFile: 'dsh-client-ui-chat/src/client/chat/ReasoningRow.module.css',
    what: 'running-row sweep animates the compositor-only keyframes',
    // Patched: the keyframes are renamed `…-x` and animate `transform` (the CSS
    // pipeline may rewrite `translateX` to `translate`).
    present: /dsh-reasoning-row-sweep-x[\w-]*\{[^@]{0,160}transform:\s*translateX?\(-300px\)/,
  },
  {
    vendorFile: 'dsh-client-ui-conversation/src/client/conversation/assembly.ts',
    what: 'conversation scheduler carries the 80 ms slice state',
    // Patched: the slice scheduler's monotonic timestamps are new class fields.
    present: /lastFlushAt/,
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
]

/** Registered vendor files with no marker above — every patch needs one. */
function uncoveredVendorFiles() {
  return VENDOR_PATCHES
    .filter((patch) => !VENDOR_PATCH_MARKERS.some((marker) => marker.vendorFile === patch.vendorFile))
    .map((patch) => patch.vendorFile)
}

/** Assets carrying a route literal (leading slash optional) = module identity. */
function routeOwned(assets, route) {
  const relative = route.replace(/^\//, '')
  return assets.filter((asset) => asset.includes(route) || asset.includes(relative))
}

/**
 * Check the emitted assets against every marker. A route-bound marker is
 * judged only inside the assets declaring its route literal, so the marker and
 * the module it belongs to can never disagree about which chunk was patched.
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
  console.log(`✓ vendor patch markers survived into the emitted bundle (${VENDOR_PATCH_MARKERS.length} markers, ${VENDOR_PATCHES.length} registered files)`)
  return 0
}

const isEntry = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url
if (isEntry) process.exit(main())
