/**
 * @dsh-chamber/dsh-chamber-seed-archive-cleanup test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its
 * own node child with inherited stdio; the first failure ends the run - the same
 * semantics as the inline node invocation this replaces. A listed file that does
 * not exist is a failure, never a silent skip. Shared fixtures live under
 * test/support/ and are never entries.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 */
// Runner semantics (missing listed file, zero-test guard, first-failure stop,
// platform legs) are the shared engine's: scripts/lib/test-manifest.mjs.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // core: the pure archive-cleanup domain core - preview/purge planning, the
  // subset/orphan-sweep fail-closed legs, the credibility gates and
  // protectSessionIds.
  core: [
    'test/core.test.ts',
    'test/sweep-gates-and-protection.test.ts',
  ],
  // parity: cross-seed lockstep (wire-carrier semantics + the shared
  // vendor-resolution seam). The open-in loader stubs the two vendor host
  // adapters its domain imports at runtime, so the real carriers all load.
  parity: [
    {
      file: 'test/seed-parity-lockstep.test.ts',
      nodeArgs: ['--experimental-transform-types', '--import', '../dsh-chamber-seed-open-in/test/support/vendor-register.mjs'],
    },
  ],
  // binding: the host binding.
  binding: [
    'test/binding.test.ts',
  ],
}

runTestManifest({
  label: 'dsh-chamber-seed-archive-cleanup',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
