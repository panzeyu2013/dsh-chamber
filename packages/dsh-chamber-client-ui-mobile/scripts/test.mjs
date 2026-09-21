/**
 * @dsh-chamber/dsh-client-ui-mobile test manifest - authoritative file list for this package test script.
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
  // artifacts: committed build outputs and their marker guards (STATUS:61 family).
  // The mobile client bundle is seeded verbatim by the gateway, so a source edit
  // without a rebuild would otherwise ship the previous bundle silently; the
  // scoper install marker guard fails on exactly that (design 05 §4.2, W8/R15③).
  artifacts: [
    'scripts/artifact-scope-marker.test.mjs',
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

runTestManifest({
  label: '@dsh-chamber/dsh-client-ui-mobile',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
