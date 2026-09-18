/**
 * @dsh-chamber/dsh-chamber-client-ui-settings-bridge test manifest - authoritative
 * file list for this package test script.
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
  // runtime: 设计 18 runtime 投影/策略 + armed-confirmation 机与 live-fact 守卫
  runtime: [
    'test/runtime/gateway-runtime-api.test.ts',
    'test/runtime/runtime-management.test.ts',
    'test/runtime/confirm-machine-guards.test.ts',
  ],
  // settings: 设置存储，以及 notifications/sessionTodo 嵌套控制组访问
  settings: [
    'test/settings/settings-store.test.ts',
    'test/settings/settings-groups.test.ts',
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
    'test/bridge/settings-extensions.test.ts',
    'test/bridge/settings-source-face.test.ts',
  ],
  // navigation: 固定导航 id 与服务器下拉选择/清理
  navigation: [
    { file: 'test/navigation/nav-active.test.ts', nodeArgs: ['--import', './test/support/vendor-register.mjs'] },
    'test/navigation/server-selector.test.ts',
  ],
  // package-locks: 跨域包级锁文件（跨 runtime/shell/bridge，留在 test/ 顶层）
  'package-locks': [
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
  const result = spawnSync(process.execPath, [...entry.nodeArgs, entry.file], { cwd: PACKAGE_ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('[test] ' + entry.file + ' failed (exit ' + (result.status ?? ('signal ' + result.signal)) + ')')
    process.exit(1)
  }
}
