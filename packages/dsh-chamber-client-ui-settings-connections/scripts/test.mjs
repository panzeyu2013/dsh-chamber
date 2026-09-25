/**
 * @dsh-chamber/dsh-chamber-client-ui-settings-connections test manifest -
 * authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its
 * own node child with inherited stdio; the first failure ends the run. A listed
 * file that does not exist is a failure, never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 */
// Runner semantics (missing listed file, zero-test guard, first-failure stop,
// platform legs) are the shared engine's: scripts/lib/test-manifest.mjs.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // plugin-inventory: 插件清单读取面与展示投影（row 派生、种子漂移、诊断）
  'plugin-inventory': [
    'test/plugin-inventory/chamber-rows.test.ts',
    'test/plugin-inventory/plugin-diagnostic.test.ts',
    'test/plugin-inventory/plugin-inventory.test.ts',
    'test/plugin-inventory/plugin-inventory-text.test.ts',
  ],
  // plugin-management: 只读行模型、PluginDialog 源码级接线锁与浏览器侧单一定义锁步
  'plugin-management': [
    'test/plugin-management/plugin-model.test.ts',
    // 浏览器侧单一定义锁步：client-core 面就是 wire 源（写出面已退役，路径判据不再消费）。
    'test/plugin-management/plugin-manifest-lockstep.test.ts',
  ],
  // connection-form: 连接表单输入契约（桌面权威常量对齐 + draft/schema 行为）
  'connection-form': [
    'test/connection-form/connection-form-contract.test.ts',
    'test/connection-form/save-host.test.ts',
  ],
  // runtime-gate: 卡片 runtime 门/探针、本地实例 spawn 门（design 18 applying）
  // 与 managed-restart 分类
  'runtime-gate': [
    'test/runtime-gate/restart-gates.test.ts',
    'test/runtime-gate/local-spawn-gate.test.ts',
    'test/runtime-gate/restart-action.test.ts',
    // The classifier and the verbatim-error projection are single-sourced on
    // the client-core face (test/shared/runtime-refusal.test.ts locks the
    // body matrix absolutely).
    'test/runtime-gate/error-text-parity.test.ts',
  ],
  // gateway: control-plane REST 客户端与网关就绪轮询
  gateway: [
    'test/gateway/control-plane.test.ts',
    'test/gateway/gateway-start-poll.test.ts',
  ],
  // connections-section: 连接页呈现面——视觉锁与本地卡片提示/通知投影
  'connections-section': [
    // 凭据清除动作的共享契约（单源化）。
    'test/connections-section/clear-credential.test.ts',
    'test/connections-section/action-hint.test.ts',
    'test/connections-section/writer-diagnosis.test.ts',
    // The secretStorageUnreadable settings-page hint (zh + en); the local card
    // must show why the instance could not start.
  ],
}

runTestManifest({
  label: 'dsh-chamber-client-ui-settings-connections',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
