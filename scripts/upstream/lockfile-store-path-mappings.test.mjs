/**
 * tsconfig ↔ pnpm-lock store-path mapping lockstep.
 *
 * WHY: seed-package tsconfigs resolve `@deepseek-ai/*` to the VENDOR SOURCES (vendor members publish no built
 * `lib/`), so compiling them compiles upstream sources AND their registry deps, which pnpm never links into the
 * symlinked vendor checkout — each dep therefore gets a hand-written `paths` entry into the virtual store
 * (`…/.pnpm/<pkg>@<version>/node_modules/<pkg>`): the seam `dsh-chamber-seed-client-graph` documents for
 * `@standard-schema/spec` / `compression` / `negotiator`, and `dsh-chamber-seed-open-in` needed for `undici`
 * (four TS2307s in `vendor/…/dsh-http-proxy/src/install.ts`, invisible on a hoisted local install).
 *
 * THE INVARIANT: every mapping's version IS a version the committed lockfile installs for some importer that
 * declares that package; a pin bump that moves a dependency must move the mapping, or typecheck fails with
 * module-not-found errors inside vendor code — the least debuggable form.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LOCKFILE = join(ROOT, 'pnpm-lock.yaml')
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every `"<spec>": ["…/.pnpm/<store>/node_modules/<pkg>"]` mapping declared by a package tsconfig
 * (read as text: tsconfigs are JSONC). @returns one entry per mapping: file, specifier, store dir,
 * package name, version. */
function storePathMappings() {
  const mappings = []
  const packagesDir = join(ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir)) {
    for (const file of readdirSync(join(packagesDir, pkg))) {
      if (!/^tsconfig.*\.json$/.test(file)) continue
      const text = readFileSync(join(packagesDir, pkg, file), 'utf8')
      for (const match of text.matchAll(/"([^"]+)"\s*:\s*\[\s*"([^"]*\/\.pnpm\/[^"]*)"/g)) {
        const store = /\/\.pnpm\/([^/]+)\/node_modules\//.exec(match[2])?.[1]
        if (store === undefined) continue
        const at = store.lastIndexOf('@')
        mappings.push({
          file: `packages/${pkg}/${file}`,
          specifier: match[1],
          entry: match[2],
          store,
          packageName: store.slice(0, at).replace('+', '/'),
          version: store.slice(at + 1),
        })
      }
    }
  }
  return mappings.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier))
}

/** Every version the lockfile resolves for `name`, across all importers that
 * declare it (vendor members and chamber packages alike).
 * @param lockfile text, @param name package name, @returns the resolved version set. */
function lockfileVersions(lockfile, name) {
  const pattern = new RegExp(
    `^\\s+'?${escapeRe(name)}'?:\\n\\s+specifier: [^\\n]*\\n\\s+version: (\\S+)`,
    'gm',
  )
  return new Set([...lockfile.matchAll(pattern)].map((match) => match[1]))
}
test('every tsconfig store-path mapping points at a version the lockfile installs', () => {
  const lockfile = readFileSync(LOCKFILE, 'utf8')
  const mappings = storePathMappings()
  // The documented seams: @standard-schema/spec, @types/compression, @types/negotiator, undici. A drop
  // below that means a seam was deleted without a replacement — re-derive it before relaxing this floor.
  assert.ok(mappings.length >= 4, `expected the documented store-path seams, found ${mappings.length}`)
  for (const mapping of mappings) {
    const versions = lockfileVersions(lockfile, mapping.packageName)
    assert.ok(
      versions.size > 0,
      `${mapping.file}: "${mapping.specifier}" maps ${mapping.packageName}, which no lockfile importer declares`,
    )
    assert.ok(
      versions.has(mapping.version),
      `${mapping.file}: "${mapping.specifier}" pins ${mapping.packageName}@${mapping.version} but the lockfile `
      + `installs ${[...versions].join(' / ')} — update the mapping after a pin bump`,
    )
  }
})

test('the mappings resolve through the pnpm virtual store, never a top-level hoist', () => {
  // A bare `["../../node_modules/undici"]` works only on a machine with the public-hoist leftover; a fresh CI install never has it.
  for (const mapping of storePathMappings()) {
    assert.match(
      mapping.entry,
      /\/node_modules\/\.pnpm\//,
      `${mapping.file}: "${mapping.specifier}" must resolve through the pnpm virtual store, got ${mapping.entry}`,
    )
  }
})
