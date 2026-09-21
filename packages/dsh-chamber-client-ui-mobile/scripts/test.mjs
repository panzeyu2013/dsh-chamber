/**
 * @dsh-chamber/dsh-client-ui-mobile test manifest - authoritative file list for this package test script.
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
  // artifacts: committed build outputs and their marker guards (STATUS:61 family).
  // The mobile client bundle is seeded verbatim by the gateway, so a source edit
  // without a rebuild would otherwise ship the previous bundle silently; the
  // scoper install marker guard fails on exactly that (design 05 §4.2, W8/R15③).
  artifacts: [
    'scripts/artifact-scope-marker.test.mjs',
  ],
  // visual: stylesheet/source-text locks over the mobile CSS and its component surface.
  visual: [
    'test/visual/breakpoints.test.ts',
    'test/visual/css-source.test.ts',
  ],
  // behavior: the pure interaction decisions (composer, drawer gestures, settings chips).
  behavior: [
    'test/behavior/composer.test.ts',
    'test/behavior/composer-guard.test.ts',
    'test/behavior/drawer-taps.test.ts',
    'test/behavior/settings-sheet.test.ts',
  ],
  // state: read-watermark reporting to the gateway mirror (plan W5; pure, injected fetch/list).
  state: [
    'test/state/read-watermark.test.ts',
  ],
  // dom: the DOM-facing adaptation modules (markup stamping, stall notice, hover-card watchdog).
  dom: [
    'test/dom/markup.test.ts',
    'test/dom/session-stall.test.ts',
    'test/dom/official-hover-card.test.ts',
    'test/dom/entry-scope-wiring.test.ts',
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
