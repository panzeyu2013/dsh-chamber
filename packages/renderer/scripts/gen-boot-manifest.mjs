#!/usr/bin/env node
/**
 * gen-boot-manifest.mjs — writes the `__DSH_BOOT__` wire (dist/manifest.json)
 * from the vite build output (design 05 §2/§3.3).
 *
 * The boot graph carries ONE plugin row: the chamber composite bundle
 * (`chamber` input → dist/assets/chamber-<hash>.js), which self-registers as
 * `@dsh-chamber/app` through `window.__ModuleLoader__.load` (factory form).
 * The wire shape matches dsh-client-modules' parseBootManifest contract:
 *
 *   { rev, entries: [{ id, url, rev, immediately }] }
 *
 * revs are sha1 content hashes shortened to 12 hex (the dsh convention).
 * The control plane serves this file at /manifest.json and injects it into
 * the served index.html as `window.__DSH_BOOT__` (design 05 §3.3); until
 * that injection exists the chamber boot refuses to start (missing
 * manifest → loud AppWebEntry rejection).
 *
 * The chamber bundle is a plain vite entry (not referenced from index.html),
 * so its CSS assets are linked here, into dist/index.html, after the build.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../../desktop/dist/', import.meta.url))
const VITE_MANIFEST = fileURLToPath(new URL('../../desktop/dist/.vite/manifest.json', import.meta.url))
const INDEX_HTML = fileURLToPath(new URL('../../desktop/dist/index.html', import.meta.url))
const OUT_MANIFEST = fileURLToPath(new URL('../../desktop/dist/manifest.json', import.meta.url))

/** dsh boot-graph row id (see src/chamber-entry.ts). */
const CHAMBER_ID = '@dsh-chamber/app'
/**
 * The vite 6 manifest keys chunks by facade-relative source path (not the
 * rollupOptions.input key), so the chamber row is located by its emitted
 * file pattern: the input name drives chunkFileNames (`assets/chamber-*.js`).
 * The pattern ALONE is not sufficient: a shared chunk named after the input
 * module (chamber-knob.ts is imported by both the main and chamber entries,
 * so rollup hoists it into `assets/chamber-knob-*.js`) also matches it. The
 * row must therefore also be a real entry (isEntry === true) — shared chunks
 * carry no `__ModuleLoader__.load` registration and must never be picked.
 */
const CHAMBER_FILE_PATTERN = /^assets\/chamber-[^/]+\.js$/

function shortHash(input) {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

function fail(message) {
  console.error(`gen-boot-manifest: ${message}`)
  process.exit(1)
}

if (!existsSync(VITE_MANIFEST)) fail(`vite build manifest missing (${VITE_MANIFEST}) — run the vite build first`)
if (!existsSync(INDEX_HTML)) fail(`dist/index.html missing (${INDEX_HTML})`)

const viteManifest = JSON.parse(readFileSync(VITE_MANIFEST, 'utf8'))
const chamberRow = Object.values(viteManifest).find(
  (row) => row?.isEntry === true && typeof row?.file === 'string' && CHAMBER_FILE_PATTERN.test(row.file),
)
if (chamberRow === undefined) {
  fail(`vite manifest has no "${CHAMBER_ID}" chamber entry (${CHAMBER_FILE_PATTERN}) — keys: ${Object.keys(viteManifest).join(', ')}`)
}

const bundleFile = chamberRow.file // e.g. assets/chamber-abc123.js
const bundlePath = fileURLToPath(new URL(`../../desktop/dist/${bundleFile}`, import.meta.url))
if (!existsSync(bundlePath)) fail(`chamber bundle missing (${bundleFile})`)
const bundleRev = shortHash(readFileSync(bundlePath))

/**
 * The manifest-row url AND the modulepreload href are ONE address, built here
 * in a single place: root-relative `/${bundleFile}` (NO `?rev=` query).
 *
 * > chamber patch (2026-08, deferred-family regression fix): the query was
 * > dropped on purpose. The vite chunk graph references the chamber entry
 * > bundle BARE (`./chamber-<hash>.js` — shared utilities are hoisted into
 * > the entry chunk and the deferred ui-* chunks import them from it). A
 * > `?rev=` on the boot-time load makes the browser treat it as a DIFFERENT
 * > module record from the chunk graph's bare reference; loading a deferred
 * > chunk then RE-EXECUTES the chamber entry bundle, whose top-level
 * > `__ModuleLoader__.load({id:'@dsh-chamber/app'})` hits the module table's
 * > duplicate-registration sink — the dynamic import rejects, the deferred
 * > ui-* family never registers, and every tool-call node renders the
 * > "未知 surface 事件：tool-call" fallback. The filename hash is already the
 * > immutability marker (rebuilt assets get a new name → new URL), so the
 * > query adds nothing but the double-execution.
 *
 * The preload must reuse this exact value — never a relative `./` form — so
 * that the boot graph's script fetch resolves to the same resource under any
 * mount point (origin root today, a sub-path in the future) and reuses the
 * preloaded fetch. Keep the two in lockstep; they must never diverge.
 */
const bundleUrl = `/${bundleFile}`

const entries = [{
  id: CHAMBER_ID,
  url: bundleUrl,
  rev: bundleRev,
  immediately: true,
}]
const graph = {
  rev: shortHash(JSON.stringify(entries)),
  entries,
}

writeFileSync(OUT_MANIFEST, `${JSON.stringify(graph, null, 2)}\n`)
console.log(`gen-boot-manifest: wrote ${OUT_MANIFEST}`)
console.log(`  rev=${graph.rev} entry=${CHAMBER_ID} url=${entries[0].url}`)

// The chamber bundle is an unlinked entry: link its CSS into index.html.
const cssAssets = (chamberRow.css ?? []).filter((css) => typeof css === 'string')
let html = readFileSync(INDEX_HTML, 'utf8')

// Preload the chamber bundle (LCP perf pass): a <link rel="modulepreload"> in
// <head> starts the 933KB bundle fetch during HTML parse, overlapping the
// ~1.8MB renderer-entry eval that precedes the boot chain. The href carries
// the SAME absolute address as the manifest row url (`bundleUrl` above — the
// two are built from one value and must stay identical): URL resolution of
// both against the document origin then yields the same resource, so the
// boot graph's script fetch (loadModuleBundle) reuses the preloaded
// resource — one network fetch, not two, under any mount point. The asset is
// immutable-cached by the control plane, so a relaunch serves it from the
// Electron HTTP cache.
const preload = `<link rel="modulepreload" crossorigin href="${bundleUrl}" />`
// In-place rewrite, never accumulate: drop any stale chamber preload line
// (older builds emitted a relative `./` href, or a `?rev=`-carrying href in
// either the relative or the absolute form — all diverged from the vite chunk
// graph's bare reference) so the head holds at most one preload — the
// canonical absolute bare href below. The dedupe guard keeps repeated runs a
// silent no-op.
html = html
  .split('\n')
  .filter((line) => !line.includes(`href="./${bundleFile}"`)
    && !line.includes(`href="./${bundleFile}?rev=`)
    && !line.includes(`href="/${bundleFile}?rev=`))
  .join('\n')
if (!html.includes(preload)) {
  html = html.includes('</head>')
    ? html.replace('</head>', `  ${preload}\n  </head>`)
    : `${html}\n${preload}`
  console.log(`gen-boot-manifest: preloaded chamber bundle ${bundleUrl}`)
}

for (const css of cssAssets) {
  const href = `./${css}`
  const link = `<link rel="stylesheet" href="${href}" />`
  // Same one-link rule as the preload: drop any existing chamber CSS line
  // (older builds inserted it at the wrong indent) and insert the canonical
  // form at the consistent head indent — log only when something changed.
  const next = html
    .split('\n')
    .filter((line) => !line.includes(`href="${href}"`))
    .join('\n')
  const inserted = next.includes('</head>')
    ? next.replace('</head>', `  ${link}\n  </head>`)
    : `${next}\n${link}`
  if (inserted !== html) {
    html = inserted
    console.log(`gen-boot-manifest: linked chamber css ${href}`)
  }
}
writeFileSync(INDEX_HTML, html)
