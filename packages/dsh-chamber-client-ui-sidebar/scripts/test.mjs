/**
 * @dsh-chamber/dsh-chamber-client-ui-sidebar test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its
 * own node child with piped stdio (stdout/stderr are written through so the
 * transcript stays intact, and the zero-test guard below can read the node:test
 * summary); the first failure ends the run - the same semantics as the inline
 * && chain this replaces. A listed file that does not exist is a failure,
 * never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 *
 * 平台腿（与 packages/desktop/scripts/test.mjs 同款）：`test` 跑 GROUPS，
 * `test:win32`（`--win32`）只跑 WIN32_FILES——sidebar 对 settled-boot gap 的
 * 文案/词表契约（sidebarRight 等行缺失时的降级呈现）。Windows CI 腿此前完全
 * 没跑过它。
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
  // scripts: 测试清单自身的零测试守卫 + 清单锁步（留在 scripts/ 原地）
  scripts: [
    'scripts/test-runner-guard.test.mjs',
  ],
  // session-rows: session/workspace projection, row windowing, row hover and the shell's row wiring
  'session-rows': [
    'test/session-rows/derive.test.ts',
    'test/session-rows/workspace-membership.test.ts',
    'test/session-rows/completed-dots-signatures.test.ts',
    'test/session-rows/source-ordering.test.ts',
    'test/session-rows/search-and-archive.test.ts',
    'test/session-rows/schedule-label-reuse.test.ts',
    'test/session-rows/session-row-window.test.ts',
    'test/session-rows/todo-attention.test.ts',
    'test/session-rows/hover-intent.test.ts',
  ],
  // session-state: the shared chamber store and the per-source view/search/todo state
  'session-state': [
    'test/session-state/aggregate-store.test.ts',
    // 运行位对账链（官方 refresh + 权威判定 seam + 有界重试/单次尝试超时）。
    'test/session-state/session-fact-reconcile.test.ts',
    'test/session-state/workspace-echo.test.ts',
    'test/session-state/session-echo.test.ts',
    'test/session-state/workspace-mutations.test.ts',
    'test/session-state/session-mutations.test.ts',
    'test/session-state/workspace-drag-order.test.ts',
    'test/session-state/workspace-git-flags.test.ts',
    'test/session-state/view-prefs.test.ts',
    'test/session-state/search-state.test.ts',
    'test/session-state/todo-prefs.test.ts',
  ],
  // open-flow: the page-wide open intent, its boot-time arm and the open outcome/click seams
  'open-flow': [
    'test/open-flow/open-intent.test.ts',
    // Merged behaviour + wiring lock of the boot-time early-open arm (test/early-open.test.ts
    // + test/early-open-wiring.test.ts); plain modules and source text only, no loader needed.
    'test/open-flow/early-open.test.ts',
    'test/open-flow/open-outcome.test.ts',
    'test/open-flow/pending-click.test.ts',
  ],
  // source-runtime: the instance wire/API, runtime management and the source serving/boot gates
  'source-runtime': [
    'test/source-runtime/instance-api.test.ts',
    'test/source-runtime/instance-mutation-values.test.ts',
    'test/source-runtime/control-plane-client.test.ts',
    'test/source-runtime/serving-gate.test.ts',
    'test/source-runtime/source-boot-gap.test.ts',
    'test/source-runtime/gateway-runtime.test.ts',
    'test/source-runtime/gateway-runtime-poll.test.ts',
    'test/source-runtime/managed-runtime.test.ts',
  ],
  // plugin-kernel: the page-level client-plugin load kernel, plugin graph and the panel/settings seats
  'plugin-kernel': [
    'test/plugin-kernel/client-plugin-loader.test.ts',
    'test/plugin-kernel/plugin-graph-recheck.test.ts',
    'test/plugin-kernel/restart-window-reload.test.ts',
    // panel-source.ts value-imports the dsh store engine, so this file runs through
    // the test-only vendor loader (mapping it to test/support/vendor-store-double.mjs).
    { file: 'test/plugin-kernel/panel-source.test.ts', nodeArgs: ['--import', './test/support/vendor-register.mjs'] },
    'test/plugin-kernel/settings-shell.test.ts',
  ],
  // archive-purge: the archive/purge flow, its tombstones and the producer/retention wiring
  'archive-purge': [
    'test/archive-purge/archive-purge.test.ts',
    'test/archive-purge/purged-rows.test.ts',
    'test/archive-purge/purged-convergence.test.ts',
    'test/archive-purge/purged-tracker.test.ts',
  ],
  // visual-lock: source locks over the sidebar's visual rules. No entrance animation may
  // start invisible (a frozen timeline pins it at opacity 0 while staying hit-testable),
  // and the renderer must refuse to create animations inside a shell nobody renders.
  'visual-lock': [
    'test/visual-lock/sidebar-entrance-visibility.test.ts',
  ],
}

/** Windows CI leg（`test:win32` / `--win32`）：boot-gap 文案/词表的平台无关契约。 */
export const WIN32_FILES = [
  // settled-boot gap 的四种 kind → 各自 copy key，以及两种语言的词表存在性。
  'test/source-runtime/source-boot-gap.test.ts',
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
