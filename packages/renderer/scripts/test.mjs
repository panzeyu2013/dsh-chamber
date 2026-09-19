/**
 * @dsh-chamber/renderer test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its
 * own node child with piped stdio (stdout/stderr are written through so the
 * transcript stays intact, and the zero-test guard below can read the node:test
 * summary); the first failure ends the run - the same semantics as the inline
 * && chain this replaces. A listed file that does not exist is a failure,
 * never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 *
 * 平台腿（与 packages/desktop/scripts/test.mjs 同款）：`test` 跑 GROUPS，
 * `test:win32`（`--win32`）只跑 WIN32_FILES——host-graph 合并 → 必需行探针 →
 * 降级呈现这条「boot-gap 机制」的平台无关判定面。Windows CI 腿此前完全没跑过
 * 它，Windows 特有的部分安装/加载失败因此只能靠人工发现。
 *
 * 零测试守卫（D2b，2026-12）：列出的文件退出 0 但没有 node:test 汇总行、tests 0
 * 或全部 skip（pass 0 / fail 0）时判失败——静默空清单不得变绿。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const GROUPS = {
  // scripts: 包内构建/契约脚本的自测（留在 scripts/ 原地，不属于 test/<domain>/）
  scripts: [
    'scripts/typert-remote-contract.test.mjs',
    'scripts/vendor-patches.test.mjs',
    // 清单自身的零测试守卫 + 清单锁步（D2b）
    'scripts/test-runner-guard.test.mjs',
  ],
  // lifecycle: 实例启动生命周期 —— shell 引导与降级自愈、宿主图/必需行探测、首屏基线预热、page 读路
  lifecycle: [
    'test/lifecycle/boot-degradation.test.ts',
    'test/lifecycle/baseline-harvest.test.ts',
    'test/lifecycle/host-graph.test.ts',
    'test/lifecycle/required-extra-rows.test.ts',
    // 必需行探针的纯记账（单调钟选择 / 每成员 grace / 有界复查窗口）
    'test/lifecycle/required-service-probe.test.ts',
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

/** Windows CI leg（`test:win32` / `--win32`）：boot-gap 机制的平台无关判定面。 */
export const WIN32_FILES = [
  // 图合并产出额外行（sidebarRight 的唯一 provider 由宿主任职图给出）。
  'test/lifecycle/host-graph.test.ts',
  // 必需行探针：缺服务时判 required-services-missing 而不是静默 pending。
  'test/lifecycle/required-extra-rows.test.ts',
  // 探针的纯记账（单调钟/grace/复查窗口）——Windows 腿同样要跑。
  'test/lifecycle/required-service-probe.test.ts',
  // 降级事实的呈现策略与自愈重挂计划。
  'test/lifecycle/boot-degradation.test.ts',
]

/** node:test 汇总行：spec（ℹ tests N）与 TAP（# tests N）两种。 */
const SUMMARY_LINE = /^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)\s*$/gm

/**
 * 最后一个 node:test 汇总块实际执行的测试体数（pass + fail）；没有测试体执行
 * （无汇总行 / tests 0 / 全部 skip）返回 null。与 desktop runner 的 D2b 守卫
 * 同义：列出的文件退出 0 但没跑测试时不得视为通过。
 */
export function parseExecutedTestCount(output) {
  let block = null
  for (const match of output.matchAll(SUMMARY_LINE)) {
    const key = match[1]
    if (block === null || key === 'tests') block = { tests: 0, pass: 0, fail: 0, skipped: 0 }
    block[key] = Number(match[2])
  }
  if (block === null || block.tests === 0) return null
  const executed = (block.pass ?? 0) + (block.fail ?? 0)
  return executed > 0 ? executed : null
}

/** Build the manifest entry list for the selected platform leg. */
export function collectEntries({ win32 = false } = {}) {
  const toEntries = (group, files) =>
    files.map(entry => (typeof entry === 'string' ? { group, file: entry, nodeArgs: [] } : { group, nodeArgs: [], ...entry }))
  if (win32) return toEntries('win32', WIN32_FILES)
  return Object.entries(GROUPS).flatMap(([group, list]) => toEntries(group, list))
}

function main() {
  const entries = collectEntries({ win32: process.argv.includes('--win32') })
  const missing = entries.filter(entry => !existsSync(join(PACKAGE_ROOT, entry.file)))
  if (missing.length > 0) {
    console.error('[test] listed test file(s) missing:')
    for (const entry of missing) console.error('  - ' + entry.file)
    process.exit(1)
  }
  for (const [index, entry] of entries.entries()) {
    if (index === 0 || entries[index - 1].group !== entry.group) console.log('\n=== ' + entry.group + ' ===')
    const result = spawnSync(process.execPath, [...entry.nodeArgs, entry.file], {
      cwd: PACKAGE_ROOT,
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (typeof result.stdout === 'string' && result.stdout !== '') process.stdout.write(result.stdout)
    if (typeof result.stderr === 'string' && result.stderr !== '') process.stderr.write(result.stderr)
    if (result.status !== 0) {
      console.error('[test] ' + entry.file + ' failed (exit ' + (result.status ?? ('signal ' + result.signal)) + ')')
      process.exit(1)
    }
    if (parseExecutedTestCount((result.stdout ?? '') + '\n' + (result.stderr ?? '')) === null) {
      console.error('[test] ' + entry.file + ' ran no test body（零测试文件不得视为通过）')
      process.exit(1)
    }
  }
}

// Import guard：本清单同时被 scripts/test-runner-guard.test.mjs 以纯函数方式
// import（零测试守卫 + 清单锁步），CLI 只在作为入口运行时执行。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
