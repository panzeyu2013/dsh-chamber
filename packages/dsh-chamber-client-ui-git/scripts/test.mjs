/**
 * @dsh-chamber/dsh-chamber-client-ui-git test manifest - authoritative file list for this package test script.
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
  // api: the RPC value decoders and the create/remove/adopt saga state machines.
  api: [
    'test/api/git-api.test.ts',
    'test/api/saga.test.ts',
  ],
  // snapshot: host snapshot normalization and the client ↔ host lockstep.
  snapshot: [
    'test/snapshot/snapshot-facts.test.ts',
    'test/snapshot/host-client-lockstep.test.ts',
  ],
  // shared: the pure shared modules behind the dialog gates and the polling seam.
  shared: [
    'test/shared/discard-gate.test.ts',
    'test/shared/remove-notes.test.ts',
    'test/shared/visibility-gate.test.ts',
  ],
  // locks: source-text locks over the client sources and the cross-package contracts.
  locks: [
    'test/locks/batch1-visual-locks.test.ts',
    'test/locks/batch2-visual-locks.test.ts',
    'test/locks/upstream-alignment.test.ts',
    'test/locks/slot-contract.test.ts',
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
