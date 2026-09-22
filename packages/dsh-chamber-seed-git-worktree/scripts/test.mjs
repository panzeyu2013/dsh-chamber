/**
 * @dsh-chamber/dsh-chamber-seed-git-worktree test manifest - authoritative file list for this package test script.
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
  // core: the Git worktree domain core - snapshot topology/classification,
  // preview/create + rollback, removal (running guard, replay/reconcile,
  // unregistered/missing-record legs), and mutation safety.
  core: [
    'test/core.test.ts',
    'test/create-rollback.test.ts',
    'test/removal.test.ts',
    'test/mutation-safety.test.ts',
  ],
}

runTestManifest({
  label: 'dsh-chamber-seed-git-worktree',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
