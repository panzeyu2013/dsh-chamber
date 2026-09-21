/**
 * @dsh-chamber/dsh-chamber-client-ui-git test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). The shared runner
 * (scripts/lib/test-manifest.mjs) owns the semantics: a listed file that does
 * not exist fails, every file runs as its own node child, the first failure
 * ends the run, and a child that exits 0 without executing a node:test body
 * fails (a zero-case manifest is never a pass).
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

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
    'test/shared/action-error.test.ts',
    'test/shared/discard-gate.test.ts',
    'test/shared/remove-notes.test.ts',
    'test/shared/visibility-gate.test.ts',
  ],
  // locks: source-text locks over the client sources and the cross-package contracts.
  locks: [
    'test/locks/slot-contract.test.ts',
  ],
}

runTestManifest({
  label: '@dsh-chamber/dsh-chamber-client-ui-git',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
