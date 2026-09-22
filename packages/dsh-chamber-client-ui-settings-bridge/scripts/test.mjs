/**
 * @dsh-chamber/dsh-chamber-client-ui-settings-bridge test manifest - authoritative
 * file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its
 * own node child with inherited stdio; the first failure ends the run. A listed
 * file that does not
 * exist is a failure, never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 */
// Runner semantics (missing listed file, zero-test guard, first-failure stop,
// platform legs) are the shared engine's: scripts/lib/test-manifest.mjs.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // runtime: 设计 18 runtime 投影/策略 + armed-confirmation 机与 live-fact 守卫
  runtime: [
    'test/runtime/gateway-runtime-api.test.ts',
    'test/runtime/runtime-management.test.ts',
    'test/runtime/confirm-machine-guards.test.ts',
    // The bridge's dictionary/wording half of the shared refusal projection.
    'test/runtime/restart-refusal.test.ts',
  ],
  // settings: 设置存储，以及 notifications/sessionTodo 嵌套控制组访问
  settings: [
    'test/settings/settings-store.test.ts',
    'test/settings/settings-groups.test.ts',
    // 测试通知失败原因映射（design 19 §3.3/§4）
    'test/settings/notify-test-result.test.ts',
  ],
  // update: 设计 11 更新按钮门与模块级 restart 单飞 store
  update: [
    'test/update/update-gate.test.ts',
    'test/update/update-store.test.ts',
  ],
  // shell: SettingsShell 面板面——视觉锁、交互辅助、跨包 prop 镜像
  shell: [
    'test/shell/escape-owner.test.ts',
    'test/shell/disclosure-attrs.test.ts',
  ],
  // bridge: 完整桥接面——outlet cell dispatch / source face / 桥接契约锁 / onboarding
  bridge: [
    'test/bridge/cell-dispatch.test.ts',
    'test/bridge/onboarding.test.ts',
    'test/bridge/settings-source-face.test.ts',
  ],
  // navigation: 固定导航 id 与服务器下拉选择/清理
  navigation: [
    { file: 'test/navigation/nav-active.test.ts', nodeArgs: ['--import', './test/support/vendor-register.mjs'] },
    'test/navigation/server-selector.test.ts',
  ],
}

runTestManifest({
  label: 'dsh-chamber-client-ui-settings-bridge',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
