/**
 * @dsh-chamber/renderer test manifest - authoritative file list for this package test script.
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
  // scripts: 包内构建/契约脚本的自测（留在 scripts/ 原地，不属于 test/<domain>/）
  scripts: [
    'scripts/typert-remote-contract.test.mjs',
    'scripts/vendor-patches.test.mjs',
  ],
  // lifecycle: 实例启动生命周期 —— shell 引导与降级自愈、宿主图/必需行探测、首屏基线预热、page 读路
  lifecycle: [
    'test/lifecycle/boot-degradation.test.ts',
    'test/lifecycle/baseline-harvest.test.ts',
    'test/lifecycle/host-graph.test.ts',
    'test/lifecycle/required-extra-rows.test.ts',
    // The shell *.test.ts split is served from test/support/shell-harness.ts and needs the
    // dsh-client-web fixture loader (see scripts/dev/test-shell-loader.mjs); the --import
    // specifier resolves from the package root (spawn cwd).
    { file: 'test/lifecycle/shell.test.ts', nodeArgs: ['--import', '../../scripts/dev/test-shell-register.mjs'] },
    { file: 'test/lifecycle/shell-tail-wait-teardown.test.ts', nodeArgs: ['--import', '../../scripts/dev/test-shell-register.mjs'] },
    { file: 'test/lifecycle/session-open-poll.test.ts', nodeArgs: ['--import', '../../scripts/dev/test-shell-register.mjs'] },
    'test/lifecycle/page-read-path-lockstep.test.ts',
    'test/lifecycle/source-readiness.test.ts',
    // 运行位活性守卫的决策纯模块契约（design 14 §D4）。
    'test/lifecycle/session-liveness.test.ts',
  ],
  // aggregate: 多来源聚合状态与通知投影（聚合拉取/重连、通知边、角标计数）
  aggregate: [
    'test/aggregate/aggregate-refresh.test.ts',
    'test/aggregate/aggregate-reconnect.test.ts',
    'test/aggregate/notification-edges.test.ts',
    'test/aggregate/badge-count.test.ts',
  ],
  // session-intent: 会话打开/深链意图管线（路由激活、待发队列、App 意图门接线）
  'session-intent': [
    'test/session-intent/pending-open-queue.test.ts',
    'test/session-intent/deep-link-activation.test.ts',
  ],
  // wiring: 跨文件源码文本接线契约（App/InstanceView/侧栏桥）
  wiring: [
  ],
  // view-runtime: 视图运行时 —— 隐藏视图回收、视图过渡队列、侧栏滚动恢复
  'view-runtime': [
    'test/view-runtime/retention.test.ts',
    'test/view-runtime/view-transition.test.ts',
    'test/view-runtime/sidebar-scroll-sync.test.ts',
  ],
  // frame-chrome: frame 文案/主题兜底与视觉锁
  'frame-chrome': [
    'test/frame-chrome/theme-fallback.test.ts',
    'test/frame-chrome/frame-locale.test.ts',
    'test/frame-chrome/page-language.test.ts',
    'test/frame-chrome/page-language-hook.test.ts',
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
