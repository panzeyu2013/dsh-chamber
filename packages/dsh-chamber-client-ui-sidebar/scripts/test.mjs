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
    // N-ctx 完成修正臂（官方 completionUnread 之外的唯一 App 侧状态）；facts-merge /
    // ordering / label / search-archive 契约在 derive.test.ts。
    'test/session-rows/completion-arm.test.ts',
    // 行/待办条的机器可读状态标记（纯分类器 + 属性锁）。
    'test/session-rows/session-row-state.test.ts',
    // A4 渲染成本：memo 行 / 一次性派生 / ctxValue 依赖覆盖（源码文本锁；本包无 DOM）。
    'test/session-rows/row-render-cost.test.ts',
    // A1 seat-position lock (patch 13): the transferred leading seat renders before the title.
    'test/session-rows/seat-position.test.ts',
    // 行动作簇：kebab + 独立归档钮（上游 ArchiveSessionRowButton 的形态移植；源码文本 + 字典值锁）。
    'test/session-rows/session-row-actions.test.ts',
    // 来源头视图选项菜单：上游 ViewOptionsMenu 三段三轴形态 + 未知归档集的禁用/选中规则。
    'test/session-rows/view-options-menu.test.ts',
    // 归档筛选三态（derive + 搜索跟随 + renderer 接线锁）。
    'test/session-rows/archived-filter.test.ts',
    // 按工作区树：owningParentFolder 规则 + 家族优先 + 缩进接线锁。
    'test/session-rows/workspace-tree.test.ts',
    // 单列表 flat：per-source 账号 + 无表头渲染 + 本地拖拽提交接线锁。
    'test/session-rows/flat-list.test.ts',
    // 置顶渲染分区（Phase 4 选项1）：纯函数 + 三处接线 + 集合出处门。
    'test/session-rows/pin-partition.test.ts',
    // 归档提示条模型：per-kind TTL + 断连裁剪 + hook/shell 接线锁。
    'test/session-rows/archive-notice.test.ts',
    // 第三轮 review 的回归锁：置顶拖放门、看门狗、待办归档排除、签名/簿记/焦点/悬停/提示条等。
    'test/session-rows/round3-regressions.test.ts',
    // 孤儿 workspace 行的注册清理入口：常驻清理钮 + 徽标共用 opener（源码文本 + 字典值锁）。
    'test/session-rows/workspace-orphan-cleanup.test.ts',
    // (facts 身份, running, stale) → 单槽记忆化的纯行为测（9-12 次读数 → 1 次派生）。
    'test/session-rows/row-state-cache.test.ts',
    // goal 三值事实：解析/最后已知/activation 合并/身份签名（design 19 §3.2.1）。
    'test/session-rows/goal-facts.test.ts',
    // 运行位唯一解析规则（官方 status?.running ?? row.running）的真值表 + 三处消费者
    // 行为（design 06 §4.3）：?? 与 || 的差别在这里承重，禁止静默改名/删除。
    'test/session-rows/running-resolution.test.ts',
    'test/session-rows/session-row-window.test.ts',
    // 上游 useTitleMarquee 的移植：placeTitle/restTitle 的两个渐隐钩子 + 常数下限。
    'test/session-rows/session-title-marquee.test.ts',
    // 官方「创建于 {time}」悬停行：zh/en 日期模板 + createdLabel 组合（无时钟行为测）。
    'test/session-rows/hover-created-label.test.ts',
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
  'test/session-state/session-correction-marks.test.ts',
    // I-10 写面探测三分（contract/concrete/none）：执行端只依赖该叶面。
    'test/session-state/status-write-face.test.ts',
    'test/session-state/workspace-echo.test.ts',
    // 位置意图（pre-create 半边）：宿主 create 的 PREPEND 短暂态按住 + 四条退场路径 + 接线锁。
    'test/session-state/workspace-placement.test.ts',
    'test/session-state/session-echo.test.ts',
    'test/session-state/session-mutations.test.ts',
    // 归档两段式的纯逻辑：失败分类 + 活动家族 → 文案行（官方 activityLine 的逐分支对照）。
    'test/session-state/session-archive-confirm.test.ts',
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
    // I-4 锁：sidebar.workspaces 保留声明但永不渲染（上游 ui-workspace 注册不抛，
    // chamber 自有多源列表拥有浏览区）。
    'test/source-runtime/sidebar-slot-declaration.test.ts',
    'test/source-runtime/instance-mutation-values.test.ts',
    'test/source-runtime/control-plane-client.test.ts',
    'test/source-runtime/source-boot-gap.test.ts',
    'test/source-runtime/gateway-runtime.test.ts',
    'test/source-runtime/gateway-runtime-poll.test.ts',
    'test/source-runtime/managed-runtime.test.ts',
    // Cross-host lockstep for the gateway runtime-status identity literal
    // (gateway producer + inline payload, desktop constant, this package's contract).
    'test/source-runtime/gateway-runtime-status-kind-lockstep.test.ts',
  ],
  // shared: cross-package leaves this package also locks (refusal classifier, error text,
  // settled-boot gap identity + copy shape).
  shared: [
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
  ],
  // visual-lock: source locks over the sidebar's visual rules. No entrance animation may
  // start invisible (a frozen timeline pins it at opacity 0 while staying hit-testable),
  // and the renderer must refuse to create animations inside a shell nobody renders.
  //
  // This is also the LAST group, so every lock that reads the vendor tree lives here and
  // after the non-vendor member: with the submodule unmaterialized (or under the documented
  // DSH_CHAMBER_VENDOR_ABSENT=skip opt-out, where it contributes zero executed tests and
  // trips the runner's zero-test guard) it always fails, and the runner stops at the first
  // failing file — a missing submodule must never hide the runnable suite.
  'visual-lock': [
    'test/visual-lock/sidebar-entrance-visibility.test.ts',
    // The git occupant's rest-state footprint (design 08 §3.2): its container must
    // leave the flex flow at rest (`data-git-occupant`) and return on exactly the
    // action hook's reveal paths (hover / `.rowActionsVisible`). Cross-package source lock.
    'test/visual-lock/git-occupant-rest-flow.test.ts',
    // Keyboard reveal reachability (design 08 §3.2): the keyboard state rides the JS
    // reveal class, because a CSS `:has(:focus-visible)` display flip is visible but
    // not Tab-reachable. Cross-file wiring lock.
    'test/visual-lock/keyboard-reveal-reachability.test.ts',
    // Row motion (the ported AnimatedRows + its key wiring, design 06 §7): the
    // byte-fidelity lock compares against the pinned vendor source.
    'test/session-rows/animated-rows.test.ts',
    // Expanded-state window chrome: the darwin top strip (traffic-light band) and the
    // panel toggle it carries — geometry + wiring lock against the vendor CSS.
    'test/leading/macos-top-strip.test.ts',
    // Upstream session-fact semantics source lockstep. LAST on purpose: under the opt-out it
    // contributes zero executed tests, so the zero-test guard always stops the run here — it
    // must never sit in front of a file that can still run.
    'test/session-state/vendor-session-fact-contract.test.ts',
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
