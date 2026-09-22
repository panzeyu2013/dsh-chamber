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

// Runner semantics (missing listed file, zero-test verdict, platform legs,
// macOS no-skip discipline, per-file timeout) are the shared engine settings
// below: scripts/lib/test-manifest.mjs. This file owns only the data tables.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

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
    // per-source 注册表收敛内核（阶段 3：live 外删除 / 保序 / identity-preserving 负例）。
    'test/lifecycle/source-registry.test.ts',
    // The shell *.test.ts split is served from test/support/shell-harness.ts and needs the
    // dsh-client-web fixture loader (see scripts/dev/test-shell-loader.mjs); the --import
    // specifier resolves from the package root (spawn cwd).
    { file: 'test/lifecycle/shell.test.ts', nodeArgs: ['--import', '../../scripts/dev/test-shell-register.mjs'] },
    { file: 'test/lifecycle/shell-tail-wait-teardown.test.ts', nodeArgs: ['--import', '../../scripts/dev/test-shell-register.mjs'] },
    { file: 'test/lifecycle/session-open-poll.test.ts', nodeArgs: ['--import', '../../scripts/dev/test-shell-register.mjs'] },
    'test/lifecycle/page-read-path-lockstep.test.ts',
    'test/lifecycle/source-readiness.test.ts',
    // B2 接线（session-chain 重构）: the App's hidden-window ledger pinned against the
    // shared source reducer, including the measured painted/suppression divergence.
    'test/lifecycle/source-ledger-equivalence.test.ts',
    // B2-a: the self-heal decision's truth table, re-expressed against the container
    // (the planner keeps its own copy until B7 retires it).
    'test/lifecycle/degraded-retry-decision.test.ts',
    // facts 行刷新提示的四拒 + 1s floor（2026-12 WS-C）。
    'test/lifecycle/source-refresh-hint.test.ts',
    // P3 会话面绘制信号（[data-phase] 揭示门）的纯决策契约。
    'test/lifecycle/session-surface.test.ts',
    // P2 露屏接线：held 帧的定时器必须来自帧的绝对期限（>0ms），越界必须揭示租客。
    'test/lifecycle/veil-release-timer.test.ts',
  ],
  // aggregate: 多来源聚合状态与通知投影（聚合拉取/重连、通知边、角标计数）
  aggregate: [
    'test/aggregate/aggregate-refresh.test.ts',
    'test/aggregate/notification-edges.test.ts',
    // P3 单通知投影：两条证据、一个策略、一个账本键空间。
    'test/aggregate/notification-projection.test.ts',
    // 水位原语单一来源（2026-12 阶段 2：同一完成不重发、坏值不臆造、max/完成水位负例）。
    'test/aggregate/watermark.test.ts',
    // complete 通知账本内核（两轨：水位 + 武装；撤回只清武装轨 / forget / prune）。
    'test/aggregate/complete-ledger.test.ts',
    'test/aggregate/badge-count.test.ts',
  ],
  // session-state: gateway session-state 事实源 + 未读 v2 落盘 + 派生账本（2026-12 WS-C）
  'session-state': [
    // 粗分类/快照/增量/SSE 帧 + 与 control-plane 协议模块的源文本锁步。
    'test/session-state/session-facts-source.test.ts',
    // 未读 v2（键常量/清洗/v1 防御导入/单调 max/LRU/client id/ack/隐私白名单）。
    'test/session-state/unread-store.test.ts',
    // 派生投影行为（deriveUnread + 通道边沿机 + listComplete 唯一剪枝门）。
    'test/session-state/unread-derivation.test.ts',
    // I3/I4 仪器：徽标回读 + 通知决定账本（含「没有桥」这一次）与单组装点锁。
    'test/session-state/notification-ledger.test.ts',
    // W6：SSH/dsh 远端的无壳观察者（$events + 每边沿一次 session/follow）。
    'test/session-state/source-mux-facts.test.ts',
    // I8：预热命中率（attempt/hit/cancelled 的定义与计数 + 全局仪器）。
    'test/session-state/prewarm-ledger.test.ts',
    // 有界集合内核（2026-12 阶段 2：容量/FIFO 淘汰/同键替换裁决的负例）。
    'test/session-state/bounded-ledger.test.ts',
    // R19 生产端：probe 判定 → 侧栏档位（含陈旧不得说成 full + 跨包词汇锁）。
    'test/session-state/session-facts-mode.test.ts',
  ],
  // session-intent: 会话打开/深链意图管线（路由激活、待发队列、App 意图门接线）
  'session-intent': [
    'test/session-intent/pending-open-queue.test.ts',
    'test/session-intent/deep-link-activation.test.ts',
  ],
  // wiring: 跨文件源码文本接线契约（App/InstanceView/侧栏桥）
  wiring: [
    // P2 单一权威链接线锁：一个策略所有者、一个执行端、App 无第二 planner。
    'test/wiring/session-authority-wiring.test.ts',
    // 遮罩层叠不变量（P0 租客边界 / P1 遮罩期隐藏 / P2 过渡作用域 / P3 揭幕信号）。
    'test/wiring/veil-layering-invariants.test.ts',
    // P4 源注册表接线：指纹只在 roster 刷新处换代，事件只带 epoch，退役即出表。
    'test/wiring/source-registry-wiring.test.ts',
  ],
  // view-runtime: 视图运行时 —— 隐藏视图回收、视图过渡队列、侧栏滚动恢复、切源揭示
  'view-runtime': [
    'test/view-runtime/retention.test.ts',
    'test/view-runtime/view-transition.test.ts',
    'test/view-runtime/frame-coalescer.test.ts',
    'test/view-runtime/sidebar-scroll-sync.test.ts',
    // W3 揭示门（选择/绘制分离 + 有界持有窗）：规则本体（稳态/不可挂载/settled/失败/到期/回拨）。
    'test/view-runtime/reveal-gate.test.ts',
    // W3 无白帧判据（三形态 + 温壳进度面 + INFO/严格档语义）；采集腿见 scripts/perf/switch-frame-probe.mjs。
    'test/view-runtime/switch-frame-verdict.test.ts',
    // W3 采集仪器：png-ink 解码自测 + 探针注入表达式/CLI 失败响亮（无 CDP 可跑的部分）。
    'test/view-runtime/switch-frame-instruments.test.ts',
    // SemVer precedence 单一实现（2026-12 阶段 2：build metadata 忽略 / prerelease 方向 / 非法 null）。
    'test/view-runtime/semver.test.ts',
  ],
  // svg-resource: 文档级 SVG 资源 id 归属（N-ctx 失绘不变量，design 05 §4.2）
  'svg-resource': [
    'test/svg-resource/svg-resource-scope.test.ts',
  ],
  // frame-chrome: frame 文案/主题兜底与视觉锁
  'frame-chrome': [
    // 错误文案助手的敌意值边界（审查补强，2026-12）。
    'test/frame-chrome/status-error-text.test.ts',
    'test/frame-chrome/theme-fallback.test.ts',
    'test/frame-chrome/frame-locale.test.ts',
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

function main() {
  runTestManifest({
    label: 'renderer',
    packageRoot: PACKAGE_ROOT,
    groups: GROUPS,
    platformFiles: { win32: WIN32_FILES },
  })
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
