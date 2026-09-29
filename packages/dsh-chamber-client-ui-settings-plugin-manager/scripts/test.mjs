/**
 * @dsh-chamber/dsh-chamber-client-ui-settings-plugin-manager test manifest - authoritative
 * file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its own
 * node child with piped stdio; the first failure ends the run. A listed file that does not
 * exist is a failure, never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 */
// Runner semantics (missing listed file, zero-test guard, first-failure stop,
// platform legs, per-file timeout) are the shared engine's: scripts/lib/test-manifest.mjs.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // dom-seam: 容纳层与上游插件管理页之间的 DOM 缝（design 05 §5）——
  // vendor 源锁（缺树响亮失败）+ 本层消费面锁（不读 vendor，永不跳过）。
  'dom-seam': [
    'test/dom-seam/vendor-page-dom-seam.test.ts',
    'test/dom-seam/containment-selectors.test.ts',
  ],
}

runTestManifest({
  label: 'dsh-chamber-client-ui-settings-plugin-manager',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
