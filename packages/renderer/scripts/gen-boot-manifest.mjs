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

const entries = [{
  id: CHAMBER_ID,
  url: `/${bundleFile}?rev=${bundleRev}`,
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
for (const css of cssAssets) {
  const href = `./${css}`
  if (html.includes(href)) continue
  const link = `<link rel="stylesheet" href="${href}" />`
  html = html.includes('</head>')
    ? html.replace('</head>', `${link}\n  </head>`)
    : `${html}\n${link}`
  console.log(`gen-boot-manifest: linked chamber css ${href}`)
}
writeFileSync(INDEX_HTML, html)
