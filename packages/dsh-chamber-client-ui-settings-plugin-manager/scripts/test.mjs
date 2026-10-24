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
  // trigger: 本页插件管理器的动作结算边沿 + 收敛接线锁（纯函数/源文本，不加载 vendor），
  // 以及 vendor 三参 inject 的源锁（读 pin 住的源码，缺树响亮失败）。
  trigger: [
    'test/trigger/plugin-action-tracker.test.ts',
    // pluginNavigation provider（rc.3 openList）：视图目标与 UI 打开两半的晚到队列。
    'test/trigger/plugin-navigation.test.ts',
    // 跨包接线锁：服务键/座席键/壳消费路径的源文本（字符串键改错会静默 no-op）。
    'test/trigger/plugin-navigation-wiring.test.ts',
    'test/trigger/plugin-refresh-wiring.test.ts',
    'test/trigger/manager-inject-signature.test.ts',
  ],
}

runTestManifest({
  label: 'dsh-chamber-client-ui-settings-plugin-manager',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
