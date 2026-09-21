/**
 * @dsh-chamber/dsh-chamber-seed-archive-cleanup test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its
 * own node child with inherited stdio; the first failure ends the run - the same
 * semantics as the inline node invocation this replaces. A listed file that does
 * not exist is a failure, never a silent skip. Shared fixtures live under
 * test/support/ and are never entries.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const entries = Object.entries(GROUPS).flatMap(([group, list]) =>
  list.map(entry => (typeof entry === 'string' ? { group, file: entry, nodeArgs: [] } : { group, nodeArgs: [], ...entry })),
)
const missing = entries.filter(entry => !existsSync(join(PACKAGE_ROOT, entry.file)))
if (missing.length > 0) {
  console.error('[test] listed test file(s) missing:')
  for (const entry of missing) console.error('  - ' + entry.file)
  process.exit(1)
}
for (const [index, entry] of entries.entries()) {
  if (index === 0 || entries[index - 1].group !== entry.group) console.log('\n=== ' + entry.group + ' ===')
  const result = spawnSync(process.execPath, [...entry.nodeArgs, entry.file], { cwd: PACKAGE_ROOT, stdio: "inherit" })
  if (result.status !== 0) {
    console.error('[test] ' + entry.file + ' failed (exit ' + (result.status ?? ('signal ' + result.signal)) + ')')
    process.exit(1)
  }
}
