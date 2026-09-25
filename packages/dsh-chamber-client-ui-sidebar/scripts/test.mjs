/**
 * @dsh-chamber/dsh-chamber-client-ui-sidebar test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its
 * own node child with piped stdio (stdout/stderr are written through so the
 * transcript stays intact, and the zero-test guard below can read the node:test
 * summary); the first failure ends the run - the same semantics as the inline
 * && chain. A listed file that does not exist is a failure,
 * never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 *
 * 平台腿（与 packages/desktop/scripts/test.mjs 同款）：`test` 跑 GROUPS，
 * `test:win32`（`--win32`）只跑 WIN32_FILES——sidebar 对 settled-boot gap 的
 * 文案/词表契约（sidebarRight 等行缺失时的降级呈现）。
 *
 * 零测试守卫：列出的文件退出 0 但没有 node:test 汇总行、tests 0
 * 或全部 skip（pass 0 / fail 0）时判失败——静默空清单不得变绿。
 */

// Runner semantics (missing listed file, zero-test guard, first-failure stop,
// platform legs, per-file timeout) are the shared engine settings below:
// scripts/lib/test-manifest.mjs. This file owns only the manifest tables.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const GROUPS = {
  // scripts: 测试清单自身的零测试守卫 + 清单锁步（留在 scripts/ 原地）
  scripts: [
    'scripts/test-runner-guard.test.mjs',
  ],
  // session-rows: session/workspace projection, row windowing, row hover and the shell's row wiring
  'session-rows': [
    // 三处拖拽闭包共用的 over-目标推进（纯叶子）。
    'test/session-rows/drag-over-state.test.ts',
    'test/session-rows/derive.test.ts',
    // The shared unread predicate of the B edge track; the
    // facts-merge / ordering / label / search-archive contracts live in
    // derive.test.ts.
    'test/session-rows/derive-unread.test.ts',
    // 行/待办条的机器可读状态标记（纯分类器 + 属性锁）。
    'test/session-rows/session-row-state.test.ts',
    // goal 三值事实：解析/最后已知/activation 合并/身份签名（design 19 §3.2.1）。
    'test/session-rows/goal-facts.test.ts',
    // 运行位唯一解析规则（官方 status?.running ?? row.running）的真值表 + 三处消费者
    // 行为（design 06 §4.3）：?? 与 || 的差别在这里承重，禁止静默改名/删除。
    'test/session-rows/running-resolution.test.ts',
    'test/session-rows/session-row-window.test.ts',
    'test/session-rows/todo-attention.test.ts',
    'test/session-rows/hover-intent.test.ts',
    // Source-header prewarm intent: the 120ms dwell machine (distinct from the
    // row hover-card machine above).
    'test/session-rows/prewarm-intent.test.ts',
  ],
  // session-state: the shared chamber store and the per-source view/search/todo state
  'session-state': [
    'test/session-state/aggregate-store.test.ts',
    // goal activation tracker 状态机（事件制、有界重试、reset、触发矩阵；禁 goals/get）。
    'test/session-state/goal-activation.test.ts',
    // 运行位对账链（官方 refresh + 权威判定 seam + 有界重试/单次尝试超时）。
    'test/session-state/session-fact-reconcile.test.ts',
    // 端到端语料：真实执行端快照驱动 App 升级 ladder（table 值下的 190s/310s 行为）。
    'test/session-state/session-authority-escalation.test.ts',
    // 取证面：机内持久 authority 动作环（有界、fail-soft）。
    'test/session-state/authority-log-store.test.ts',
    // 能力一览：来源行的会话事实档位展示读数（源文本锁）。
    'test/session-state/facts-capability-note.test.ts',
    // 会话创建归因账本（含 blank 的按标签聚合与「无标签外来源」判据）。
    'test/session-state/session-create-ledger.test.ts',
    // 上游会话事实语义的源码 lockstep（vendor 树未物化时默认失败，显式 opt-out 才跳过）。
    'test/session-state/vendor-session-fact-contract.test.ts',
    'test/session-state/workspace-echo.test.ts',
    'test/session-state/session-echo.test.ts',
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
    // Behaviour + wiring lock of the boot-time early-open arm; plain modules
    // and source text only, no loader needed.
    'test/open-flow/early-open.test.ts',
    'test/open-flow/open-outcome.test.ts',
    'test/open-flow/pending-click.test.ts',
  ],
  // source-runtime: the instance wire/API, runtime management and the source serving/boot gates
  'source-runtime': [
    // 生产者接线锁（源码文本）：一处 status 读必须喂到四处消费点，且不得漏进 store
    // 修复面（design 06 §4.3「显示面与修复面分工」）——纯源码断言，无运行时依赖。
    'test/source-runtime/mounted-running-resolution-wiring.test.ts',
    'test/source-runtime/instance-api.test.ts',
    'test/source-runtime/instance-mutation-values.test.ts',
    'test/source-runtime/control-plane-client.test.ts',
    'test/source-runtime/serving-gate.test.ts',
    'test/source-runtime/source-boot-gap.test.ts',
    'test/source-runtime/gateway-runtime.test.ts',
    'test/source-runtime/gateway-runtime-poll.test.ts',
    'test/source-runtime/managed-runtime.test.ts',
    // Cross-host lockstep for the gateway runtime-status identity literal
    // (gateway producer + inline payload, desktop constant, this package's contract).
    'test/source-runtime/gateway-runtime-status-kind-lockstep.test.ts',
    // The shared 409 refusal classifier + verbatim-error projection (the plugins re-export it).
    'test/shared/runtime-refusal.test.ts',
    // The shared error-text projections (errorMessage / describeThrown).
    'test/shared/error-text.test.ts',
    // The settled-boot gap identity both publish signatures consume.
    'test/shared/boot-gap-signature.test.ts',
    // The settled-boot gap -> copy-shape projection (sidebar + connections consumers).
    'test/shared/boot-gap-shape.test.ts',
  ],
  // plugin-kernel: the page-level client-plugin load kernel, plugin graph and the panel/settings seats
  'plugin-kernel': [
    'test/plugin-kernel/client-plugin-loader.test.ts',
    // host-graph 通道分类的单一来源（各状态码/信封分支 + 逐字文案 + 两个消费点锁）。
    'test/plugin-kernel/plugin-graph-classify.test.ts',
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
    'test/archive-purge/purged-tracker.test.ts',
    'test/archive-purge/purged-session-store.test.ts',
  ],
  // leading: the frame's window-chrome seat occupant that keeps the reopen control
  // reachable while the macOS collapse hides the whole column (design 05 §2): the
  // control-binding contract plus the client/index.ts wiring lock a cordis plugin
  // body cannot be imported for.
  leading: [
    'test/leading/leading-controls.test.ts',
    'test/leading/leading-seat-wiring.test.ts',
    // Expanded-state window chrome: the darwin top strip (traffic-light band)
    // and the panel toggle it carries — geometry + wiring lock.
    'test/leading/macos-top-strip.test.ts',
  ],
  // visual-lock: source locks over the sidebar's visual rules. No entrance animation may
  // start invisible (a frozen timeline pins it at opacity 0 while staying hit-testable),
  // and the renderer must refuse to create animations inside a shell nobody renders.
  'visual-lock': [
    'test/visual-lock/sidebar-entrance-visibility.test.ts',
  ],
}

export const WIN32_FILES = [
  // settled-boot gap 的四种 kind → 各自 copy key，以及两种语言的词表存在性。
  'test/source-runtime/source-boot-gap.test.ts',
]

function main() {
  runTestManifest({
    label: 'dsh-chamber-client-ui-sidebar',
    packageRoot: PACKAGE_ROOT,
    groups: GROUPS,
    platformFiles: { win32: WIN32_FILES },
    guard: 'executed',
  })
}

// Import guard: this manifest is also imported by its zero-test guard test as
// a pure module (table lockstep assertions), so the CLI only runs as the
// entry point.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
