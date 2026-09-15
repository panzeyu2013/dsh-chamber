/**
 * @deepseek-ai/dsh-client-connection test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its
 * own node child with inherited stdio; the first failure ends the run - the same
 * semantics as the inline && chain this replaces. A listed file that does not
 * exist is a failure, never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // base-path: the per-instance base path and the generic RPC carrier assembly.
  'base-path': [
    'test/base-path/api-path.test.ts',
    'test/base-path/carrier-assembly.test.ts',
  ],
  // lifecycle: the apply/start seam and the liveness wiring it installs.
  lifecycle: [
    {
      file: 'test/lifecycle/client-apply.test.ts',
      nodeArgs: ['--import', '../../scripts/dev/test-connection-register.mjs'],
    },
    {
      file: 'test/lifecycle/client-start-liveness-wiring.test.ts',
      nodeArgs: ['--import', '../../scripts/dev/test-connection-register.mjs'],
    },
  ],
  // recovery: the sleep/wake recovery triggers and the per-source recovery policy.
  recovery: [
    {
      file: 'test/recovery/liveness-triggers.test.ts',
      nodeArgs: ['--import', '../../scripts/dev/test-connection-register.mjs'],
    },
    'test/recovery/recovery-policy.test.ts',
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
