/**
 * @dsh-chamber/dsh-chamber-client-ui-sidebar test manifest - authoritative file list for this package test script.
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
  // session-rows: session/workspace projection, row windowing, row hover and the shell's row wiring
  'session-rows': [
    'test/session-rows/derive.test.ts',
    'test/session-rows/workspace-membership.test.ts',
    'test/session-rows/completed-dots-signatures.test.ts',
    'test/session-rows/source-ordering.test.ts',
    'test/session-rows/search-and-archive.test.ts',
    'test/session-rows/schedule-label-reuse.test.ts',
    'test/session-rows/session-row-window.test.ts',
    'test/session-rows/todo-attention.test.ts',
    'test/session-rows/hover-intent.test.ts',
    'test/session-rows/hover-card-wiring.test.ts',
    'test/session-rows/new-session-wiring.test.ts',
  ],
  // session-state: the shared chamber store and the per-source view/search/todo state
  'session-state': [
    'test/session-state/aggregate-store.test.ts',
    'test/session-state/workspace-echo.test.ts',
    'test/session-state/workspace-drag-order.test.ts',
    'test/session-state/workspace-git-flags.test.ts',
    'test/session-state/view-prefs.test.ts',
    'test/session-state/search-state.test.ts',
    'test/session-state/todo-prefs.test.ts',
  ],
  // open-flow: the page-wide open intent, its boot-time arm and the open outcome/click seams
  'open-flow': [
    'test/open-flow/open-intent.test.ts',
    // Merged behaviour + wiring lock of the boot-time early-open arm (test/early-open.test.ts
    // + test/early-open-wiring.test.ts); plain modules and source text only, no loader needed.
    'test/open-flow/early-open.test.ts',
    'test/open-flow/open-outcome.test.ts',
    'test/open-flow/pending-click.test.ts',
  ],
  // source-runtime: the instance wire/API, runtime management and the source serving/boot gates
  'source-runtime': [
    'test/source-runtime/instance-api.test.ts',
    'test/source-runtime/instance-mutation-values.test.ts',
    'test/source-runtime/control-plane-client.test.ts',
    'test/source-runtime/serving-gate.test.ts',
    'test/source-runtime/source-boot-gap.test.ts',
    'test/source-runtime/gateway-runtime.test.ts',
    'test/source-runtime/gateway-runtime-poll.test.ts',
    'test/source-runtime/managed-runtime.test.ts',
  ],
  // plugin-kernel: the page-level client-plugin load kernel, plugin graph and the panel/settings seats
  'plugin-kernel': [
    'test/plugin-kernel/client-plugin-loader.test.ts',
    'test/plugin-kernel/plugin-graph-recheck.test.ts',
    // panel-source.ts value-imports the dsh store engine, so this file runs through
    // the test-only vendor loader (mapping it to test/support/vendor-store-double.mjs).
    { file: 'test/plugin-kernel/panel-source.test.ts', nodeArgs: ['--import', './test/support/vendor-register.mjs'] },
    'test/plugin-kernel/panel-wiring.test.ts',
    'test/plugin-kernel/settings-shell.test.ts',
  ],
  // archive-purge: the archive/purge flow, its tombstones and the producer/retention wiring
  'archive-purge': [
    'test/archive-purge/archive-purge.test.ts',
    'test/archive-purge/purged-rows.test.ts',
    'test/archive-purge/purged-convergence.test.ts',
    'test/archive-purge/purged-tracker.test.ts',
    'test/archive-purge/producer-purged-wiring.test.ts',
    'test/archive-purge/resident-retention-wiring.test.ts',
  ],
  // visual-lock: the batch1/batch2/upstream-alignment visual and alignment locks (never merged)
  'visual-lock': [
    'test/visual-lock/batch1-visual-locks.test.ts',
    'test/visual-lock/batch2-visual-locks.test.ts',
    'test/visual-lock/upstream-alignment.test.ts',
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
