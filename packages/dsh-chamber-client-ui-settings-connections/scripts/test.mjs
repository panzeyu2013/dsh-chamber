/**
 * @dsh-chamber/dsh-chamber-client-ui-settings-connections test manifest -
 * authoritative file list for this package test script.
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
  // plugin-inventory: 插件清单读取面与展示投影（row 派生、种子漂移、诊断）
  'plugin-inventory': [
    'test/plugin-inventory/chamber-rows.test.ts',
    'test/plugin-inventory/chamber-seed-drift.test.ts',
    'test/plugin-inventory/plugin-diagnostic.test.ts',
    'test/plugin-inventory/plugin-inventory.test.ts',
    'test/plugin-inventory/plugin-inventory-text.test.ts',
  ],
  // plugin-management: 统一插件模型、diff/apply 边界与 PluginDialog 源码级接线锁
  'plugin-management': [
    'test/plugin-management/plugin-model.test.ts',
    'test/plugin-management/plugin-diff.test.ts',
    'test/plugin-management/chamber-table-wiring.test.ts',
    'test/plugin-management/installed-fence-wiring.test.ts',
    'test/plugin-management/protected-rows-wiring.test.ts',
  ],
  // connection-form: 连接表单输入契约（桌面权威常量对齐 + draft/schema 行为）
  'connection-form': [
    'test/connection-form/connection-form-contract.test.ts',
    'test/connection-form/save-host.test.ts',
  ],
  // runtime-gate: 卡片 runtime 门/探针与 managed-restart 分类
  'runtime-gate': [
    'test/runtime-gate/runtime-gate-wiring.test.ts',
    'test/runtime-gate/restart-gates.test.ts',
    'test/runtime-gate/restart-completion-wiring.test.ts',
  ],
  // gateway: control-plane REST 客户端与网关就绪轮询
  gateway: [
    'test/gateway/control-plane.test.ts',
    'test/gateway/gateway-start-poll.test.ts',
  ],
  // connections-section: 连接页呈现面——视觉锁与本地卡片提示/通知投影
  'connections-section': [
    'test/connections-section/batch1-visual-locks.test.ts',
    'test/connections-section/action-hint.test.ts',
    'test/connections-section/writer-diagnosis.test.ts',
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
