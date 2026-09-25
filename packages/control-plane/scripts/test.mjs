/**
 * `pnpm run test:control-plane` (root) → `pnpm --filter @dsh-chamber/control-plane
 * run test` — the control-plane unit-test set (release-checklist §3 names this
 * script as the authoritative list). Each file runs as its own `node <file>.ts`
 * child with inherited stdio (a failure in one file stops the run non-zero).
 *
 * Every listed file is required: silently skipping a deleted/renamed test
 * would make the aggregate command pass with less coverage than the checklist
 * and CI claim. The manifest is grouped by subject area and mirrors the
 * test/<domain>/ layout. test/smoke.test.ts is deliberately NOT listed here:
 * the root `smoke` script runs that exact path directly (root package.json),
 * so it stays at the test/ top level.
 *
 * Zero-test guard: each child's node:test summary
 * is parsed; a listed file that exits 0 without a summary line or with
 * `tests 0` fails the run, so a manifest entry that is silently skipped
 * cannot be green. A file whose registered tests are all platform-skipped
 * still prints a summary (tests > 0) and stays green.
 *
 * Platform split (structural — no file lists in workflow YAML): the
 * POSIX-semantics suites (private-fs O_NOFOLLOW/0700 etc., fail-closed on
 * win32 by design) run on the POSIX legs via `test`. The Windows CI leg runs
 * `pnpm --filter @dsh-chamber/control-plane run test:win32` (= this script
 * with `--win32`), which runs WIN32_FILES below — win32-real or
 * platform-neutral units only. Extend WIN32_FILES as Windows semantics land,
 * never by hand-copying lists into ci.yml.
 */

// Runner semantics (missing listed file, zero-test guard, first-failure stop,
// platform legs, per-file timeout) are the shared engine settings below:
// scripts/lib/test-manifest.mjs. This file owns only the manifest tables.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // api: 管理 REST API（连接/生命周期/实例状态）、写者静默 latch 与持久化存储
  'api': [
    'test/api/manager-api.test.ts',
    // Writer-quiescence latch recovery: the in-session re-proof, the
    // structured 409 detail and the explicit 清理并接管 action.
    'test/api/writer-latch.test.ts',
    'test/api/storage.test.ts',
  ],
  // state: state 根写者唯一租约（R2 W1）。契约模块 + 真实跨进程矩阵（两进程竞争、
  // SIGKILL 认领、exit 释放、stale 并发接管）与单进程搬移用例；只依赖 node 内建。
  'state': [
    'test/state/state-root-lease.test.ts',
  ],
  // protocol: 启动握手、dsh 客户端、A2 跨包 RPC envelope 与浏览器 auth cookie
  'protocol': [
    'test/protocol/protocol.test.ts',
    'test/protocol/m1-dsh-client.test.ts',
    'test/protocol/rpc-envelope.test.ts',
    'test/protocol/browser-auth-cookie.test.ts',
    // 会话状态 wire 契约单一源（capability 判定矩阵、feature 冻结元组、读标记
    // max 归并、turn/end 分类）与 Typert mux 最小客户端（$events 订阅、每次
    // (重)连全量 session/list 基线对账、waterfall 委派硬约束、R21 ready/
    // lastEventAt 信号）。两者都是纯模块（注入假 socket/假 unary carrier），
    // 平台无关，所以 Windows 腿同样跑（见 WIN32_FILES）。
    'test/protocol/session-state-protocol.test.ts',
    'test/protocol/session-mux.test.ts',
    // 跨包 parity/lockstep：control-plane 与 dsh-runtime 的
    // 孪生实现以相对路径 import 对拍，绝对期望值 + 意图分叉登记表 + 导出面清单
    // 三重锁定；任一侧改名/删面/静默漂移都会让这两条变红。
    // private-fs 门含 POSIX 权限/符号链接语义，只在 POSIX 腿跑（与同一孪生实现
    // 的既有 private-fs 套件同样的平台分割）；win-probes 门是平台中性的纯解析
    // 对拍，同时进 WIN32_FILES。
    'test/protocol/private-fs-parity.test.ts',
    'test/protocol/win-probes-parity.test.ts',
    // Node-side shared primitives with the desktop main process and the gateway
    // (single-sourcing; error-text leaf).
    'test/protocol/error-text.test.ts',
    // Git 三层超时阶梯（host 30s < 反代 45s < 浏览器 60s）的可执行锁步：真实
    // import 三包常量并断言严格嵌套 + 答题余量 + 登记槽位，取代只靠注释维持。
    'test/protocol/git-timeout-ladder.test.ts',
  ],
  // host-lifecycle: 宿主进程生命周期（spawn/readiness/健康/回收/重启）
  'host-lifecycle': [
    'test/host-lifecycle/lifecycle.test.ts',
    'test/host-lifecycle/local-connection.test.ts',
    'test/host-lifecycle/spawn-dsh.test.ts',
    'test/host-lifecycle/reaper.test.ts',
    'test/host-lifecycle/restart-local.test.ts',
  ],
  // host-logs: 宿主日志文件（listDiagnostics/轮转）与 opt-in 应用日志桥
  'host-logs': [
    'test/host-logs/host-logs.test.ts',
    // 控制面自身日志落盘（<stateDir>/logs/control-plane.log：JSONL + 有界轮转）。
    'test/log-file.test.ts',
    // Opt-in managed-dsh application-log bridge (host-log-bridge.ts): the
    // generated Cordis logger exporter, its seed entry, and the off-path
    // byte-identity of the `--patch` overlay.
    'test/host-logs/host-log-bridge.test.ts',
  ],
  // proxy: 实例反向代理（HTTP/WS/SSE）、WS 帧、注入预算与静态前端服务
  'proxy': [
    'test/proxy/instance-proxy.test.ts',
    'test/proxy/response-encoding.test.ts',
    'test/proxy/ws-upgrade.test.ts',
    'test/proxy/liveness-timeout.test.ts',
    'test/proxy/real-node-spki.test.ts',
    'test/proxy/gateway-transport.test.ts',
    'test/proxy/ws-frames.test.ts',
    'test/proxy/static-serving.test.ts',
    // Injection-budget pin: MAX_HTML_INJECTION_BYTES is the single source
    // (the gateway html-inject.ts consumes it via @dsh-chamber/control-plane —
    // no twin constant); the test pins the budget value.
    'test/proxy/html-inject-lockstep.test.ts',
    // SSE 断线续传：
    // Last-Event-ID 经实例代理的透传、SSE 帧序与客户端断开的释放，
    // 行为级锁定——若代理吃掉该头，续传会静默降级为整量重取。
    'test/proxy/sse-resume.test.ts',
  ],
  // plugins: 宿主图种子、cordis insert 渲染与受保护插件集合判定
  'plugins': [
    'test/plugins/host-graph-seed.test.ts',
    // 新 host 域的接线锁步（audit arch-03 P1-1）：以 CHAMBER_HOST_PACKAGES 为驱动，
    // 断言 desktop 两 flavor 的 sourceDir 映射、dsh-runtime 的探针常量与
    // runtime-probes 的每域分支都覆盖注册表；漏登记任一处即红，且远端映射缺键
    // 是 throw（不再 filter/warn）。
    'test/plugins/host-domain-wiring-lockstep.test.ts',
    'test/plugins/cordis-inserts.test.ts',
    // 受保护集合 / 代耦合 / 装后复验的完整判定面（design 21 §6.11，决策 19）。
    // §6.11 的全部 pin 与 familyNamesFromLockfileClosure（C11 同源解析器）是
    // 「官方 opt-in 层可装可卸」这条契约唯一的单测锚点。
    'test/plugins/protected-plugins.test.ts',
    // plugin-manifest 单一定义（wire 共享面）的 parse/版本/掩码/版本门矩阵 +
    // control-plane 公开面的同源断言（design 21 §3 readManifest）。
    'test/plugins/plugin-manifest.test.ts',
  ],
  // windows: Windows 探针解析/分类与 win32-only 生命周期集成
  'windows': [
    // Windows probe parsers/classifiers run on every leg; the win32-only
    // lifecycle integration test self-skips on POSIX and runs on the Windows
    // CI leg (design 02 §5.1 parity work).
    'test/windows/win-probes.test.ts',
    'test/windows/win32-lifecycle.integration.test.ts',
    // Zero-test guard of this manifest, pinned on
    // every leg and on the Windows one.
    'test/windows/test-runner-guard.test.mjs',
  ],
}

const WIN32_FILES = [
  // Windows probe parsers/classifiers; win32-lifecycle self-skips on POSIX and
  // runs the real CIM/netstat/taskkill gates on windows-2022.
  'test/windows/win-probes.test.ts',
  'test/windows/win32-lifecycle.integration.test.ts',
  // Zero-test guard of this manifest; it is
  // platform-neutral and fast, so the Windows leg pins it too.
  'test/windows/test-runner-guard.test.mjs',
  // The §6.11 judgement face is platform-neutral (join/mkdtemp/tmpdir only) and
  // runs in ~25 ms, so the Windows leg gets the same pins as the POSIX legs —
  // including symlink/junction semantics of readInstalledVersion.
  'test/plugins/protected-plugins.test.ts',
  // The plugin-manifest single source is pure data projection (no fs
  // permissions, no platform branches) plus a mkdtemp version fixture, so the
  // Windows leg pins the same matrix.
  'test/plugins/plugin-manifest.test.ts',
  // Session-state wire contract + mux client: pure modules (no fs permissions,
  // no network, injected socket/carrier) whose contract must hold on every
  // platform — the failure mode they guard (a downstream-less observer
  // settling an approval) is platform-independent.
  'test/protocol/session-state-protocol.test.ts',
  'test/protocol/session-mux.test.ts',
  // 孪生探针的纯解析对拍：平台中性（win32-gated exec 段自行 skip），
  // 与 test/windows/win-probes.test.ts 同批在 Windows 腿再跑一遍。
  'test/protocol/win-probes-parity.test.ts',
]

function main() {
  runTestManifest({
    label: 'control-plane',
    packageRoot: PACKAGE_ROOT,
    groups: GROUPS,
    platformFiles: { win32: WIN32_FILES },
    guard: 'registered',
    timeoutMs: 120_000,
  })
}

// Import guard: this manifest is also imported by its zero-test guard test as
// a pure module (table lockstep assertions), so the CLI only runs as the
// entry point.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
