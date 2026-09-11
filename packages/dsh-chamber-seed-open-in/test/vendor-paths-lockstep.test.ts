/**
 * tsconfig vendor-dep mapping lockstep (2026-09-11 CI fix).
 *
 * WHY THIS EXISTS: this package's tsconfig resolves `@deepseek-ai/*` to the
 * VENDOR SOURCES (`../../vendor/harness-packages/@deepseek-ai/<pkg>/src/index.ts`)
 * because the vendor workspace members publish no built `lib/`. Compiling
 * upstream sources means compiling THEIR registry deps too, and pnpm never
 * links a registry dep into the symlinked vendor checkout — so `undici`
 * (imported by `vendor/…/dsh-http-proxy/src/install.ts`, reachable here through
 * dsh-subprocess / dsh-native-command) has to be mapped into the pnpm virtual
 * store by hand, the same seam `dsh-chamber-seed-client-graph` documents for
 * `@standard-schema/spec` / `compression` / `negotiator`.
 *
 * THE INVARIANT: the version inside that mapping IS the version the committed
 * lockfile installs. A pin bump that moves `undici` must move the mapping with
 * it. Without this lock the drift surfaces as four TS2307s inside vendor code
 * (`dsh-http-proxy/src/install.ts:10/144/194/209`) — on CI only, because a
 * long-lived local install carries accidental hoists that hide it: exactly the
 * 2026-09-11 red `typecheck:host-open-in`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const LOCKFILE = join(PACKAGE_ROOT, '..', '..', 'pnpm-lock.yaml')

/** The version in `paths.undici[0]` (`…/.pnpm/undici@<version>/node_modules/undici`). */
function mappedUndiciVersion() {
  const tsconfig = readFileSync(join(PACKAGE_ROOT, 'tsconfig.json'), 'utf8')
  const entry = /"undici":\s*\[\s*"([^"]+)"/.exec(tsconfig)?.[1]
  assert.ok(entry !== undefined, 'tsconfig.json must map "undici" for the vendor sources it compiles')
  const version = /\/\.pnpm\/undici@([^/]+)\/node_modules\/undici$/.exec(entry)?.[1]
  assert.ok(version !== undefined, `the undici mapping must name a pnpm store path, got ${entry}`)
  return { entry, version }
}

/** One importer block of the committed lockfile (blocks are blank-line separated). */
function importerBlock(lockfile, packageName) {
  const block = lockfile.split('\n\n')
    .find(chunk => chunk.startsWith(`  vendor/harness-packages/@deepseek-ai/${packageName}:`))
  assert.ok(block !== undefined, `pnpm-lock.yaml must carry the vendor importer ${packageName}`)
  return block
}

test('the undici mapping points at the version the lockfile installs for the vendor importers', () => {
  const lockfile = readFileSync(LOCKFILE, 'utf8')
  const { entry, version } = mappedUndiciVersion()
  for (const importer of ['dsh-http-proxy', 'dsh-web-fetch-http']) {
    const declared = /undici:\n\s+specifier: [^\n]*\n\s+version: (\S+)/.exec(importerBlock(lockfile, importer))?.[1]
    assert.ok(declared !== undefined, `${importer} must declare undici in the lockfile`)
    assert.equal(
      version,
      declared,
      `tsconfig maps undici@${version} but the lockfile installs undici@${declared} (${importer}): `
      + `update the "${entry}" mapping after a pin bump`,
    )
  }
})

test('the mapping is the only undici resolution seam this program relies on', () => {
  // A bare `"undici": ["../../node_modules/undici"]` would work only on a
  // machine with the top-level hoist — never on a fresh CI install.
  const { entry } = mappedUndiciVersion()
  assert.ok(
    entry.includes('/node_modules/.pnpm/'),
    `the undici mapping must resolve through the pnpm virtual store, got ${entry}`,
  )
})
