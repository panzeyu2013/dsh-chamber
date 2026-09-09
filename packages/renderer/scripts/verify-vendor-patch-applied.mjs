/**
 * Build-time proof that the registered vendor patches actually landed in the
 * emitted chamber bundle (design 09 §3.6).
 *
 * WHY: the patch registry is applied through a vite `transform` hook keyed on
 * the module id. Vite resolves vendor sources through `realpathSync`, so the
 * id is the submodule path — an id-form mistake makes every patch a silent
 * no-op while the build still succeeds (this happened during development and
 * was only caught by grepping the bundle by hand). C9 checks the anchors
 * against the pinned source; this script checks the OUTPUT.
 *
 * Runs as the last step of `build:renderer`, after `gen-boot-manifest.mjs` has
 * written dist/web/manifest.json.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WEB = join(ROOT, 'desktop', 'dist', 'web')

/** Locate the chamber entry bundle (manifest first, glob fallback). */
function chamberBundle() {
  const manifestPath = join(WEB, 'manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entry = (manifest?.entries ?? []).find(item => item?.id === '@dsh-chamber/app')
    const url = entry?.url ?? manifest?.batches?.[0]?.url
    if (typeof url === 'string') {
      const candidate = join(WEB, url.replace(/^\//, ''))
      if (existsSync(candidate)) return candidate
    }
  }
  const assets = join(WEB, 'assets')
  if (!existsSync(assets)) return undefined
  const hit = readdirSync(assets).filter(name => /^chamber-.*\.js$/.test(name)).sort().pop()
  return hit === undefined ? undefined : join(assets, hit)
}

/**
 * One assertion per registered patch: the patched shape must be present and
 * the unpatched shape must be gone. The regexes are minifier-tolerant (they
 * only assume the template-literal structure the patch changes).
 */
const ASSERTIONS = [
  {
    what: 'ui-chat file-API URL carries the per-entry base path',
    // `${X}${Y}/api/file?path=` — two adjacent interpolations (patched).
    present: /\$\{[A-Za-z_$][\w$]*\}\$\{[A-Za-z_$][\w$]*\}\/api\/file\?path=/,
    // `${X}/api/file?path=` — the upstream single-interpolation shape. The
    // lookbehind keeps it from matching the tail of the PATCHED form
    // (`${X}${Y}/api/file?path=` contains `${Y}/api/file?path=`).
    absent: /(?<!\})\$\{[A-Za-z_$][\w$]*\}\/api\/file\?path=/,
  },
  {
    what: 'file-upload upload URL carries the per-entry base path',
    // `new URL(`${X}${Y}`, ...)` — patched; upstream is `new URL(Y, ...)`.
    present: /new URL\(`\$\{[A-Za-z_$][\w$]*\}\$\{[A-Za-z_$][\w$]*\}`/,
    absent: null,
  },
  {
    what: 'session-log export URL carries the per-entry base path',
    // `new URL(`${X}/api/session.export`, ...)` — patched; upstream is a literal.
    present: /new URL\(`\$\{(?:this\.)?[A-Za-z_$][\w$.]*\}\/api\/session\.export`/,
    absent: null,
  },
  {
    what: 'ui-deliverables present routes carry the per-entry base path',
    // `fetch(`${X}${Y}`)` — patched; upstream is `fetch(Y)`. The first
    // interpolation may be a member expression (`this.chamberFileApiBase`).
    present: /fetch\(`\$\{(?:this\.)?[A-Za-z_$][\w$.]*\}\$\{/,
    absent: null,
  },
  {
    what: 'layout fork publishes the chamberFileApiBase root standard prop',
    present: /chamberFileApiBase/,
    absent: null,
  },
]

// Patches land in different chunks: the composite entry carries the covered
// first-screen families (ui-chat, file-upload), while ui-deliverables is a
// DEFERRED family in its own chunk. Scan every emitted JS asset.
function allAssets() {
  const assets = join(WEB, 'assets')
  if (!existsSync(assets)) return []
  return readdirSync(assets)
    .filter(name => name.endsWith('.js'))
    .map(name => join(assets, name))
}
const bundle = chamberBundle()
if (bundle === undefined) {
  console.error('verify-vendor-patch-applied: chamber bundle not found under dist/web — run after vite build')
  process.exit(1)
}
const files = allAssets()
if (files.length === 0) {
  console.error('verify-vendor-patch-applied: no emitted JS assets under dist/web/assets — run after vite build')
  process.exit(1)
}
const code = files.map(file => readFileSync(file, 'utf8')).join('\n')
let failed = 0
for (const assertion of ASSERTIONS) {
  if (!assertion.present.test(code)) {
    console.error(`✗ vendor patch not applied: ${assertion.what} (${bundle})`)
    failed += 1
  } else if (assertion.absent !== null && assertion.absent.test(code)) {
    console.error(`✗ vendor patch not applied (unpatched shape still present): ${assertion.what} (${bundle})`)
    failed += 1
  } else {
    console.log(`✓ vendor patch applied: ${assertion.what}`)
  }
}
if (failed > 0) {
  console.error('verify-vendor-patch-applied: the registered vendor patches did not reach the bundle — check the vite transform id matching (design 09 §3.6)')
  process.exit(1)
}
