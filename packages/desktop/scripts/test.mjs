/**
 * @dsh-chamber/desktop test manifest — authoritative file list for this
 * package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as
 * its own node child; stdout/stderr are piped through so the transcript stays
 * intact, and the first failure ends the run — the same semantics as an inline
 * && chain. Two failures are never silent skips:
 *   - a listed file that does not exist;
 *   - a listed file that exits 0 without running any test (no node:test summary
 *     or "tests 0"), or that cannot be spawned. Such a file must be recorded in
 *     ZERO_TEST_ALLOWLIST with a justification.
 * Entries: a path, { file, nodeArgs } when a loader (--import ...) is needed, or
 * { file, guard: 'registered' } for an environment-gated file that must still
 * enter node:test and report a summary on every leg.
 *
 * Platform split (same precedent as packages/control-plane/scripts/test.mjs):
 * `test` runs GROUPS below; `test:win32` runs WIN32_FILES via --win32 and
 * `test:macos` runs MACOS_FILES via --macos (the two flags are mutually
 * exclusive). win-acl.test.ts exercises the icacls argument builders / output
 * verifiers on every leg (the win32 exec helper is platform-gated inside the
 * module), so it is both part of the full set and the package's Windows CI leg.
 * The macOS-only files need macOS tools (O_EXLOCK/plutil/codesign/ditto), so
 * --macos is their only entry point and they never ride the ubuntu leg.
 *
 * macOS leg skip discipline: the packaging suites
 * carry five environment-conditional `t.skip` sites (codesign/hdiutil, the
 * SwiftPM .build/release product, the resolved Sparkle artifact). A skipped case
 * there is exactly the silent-coverage-loss this runner exists to stop, so the
 * macOS leg additionally requires `skipped === 0` in every child summary —
 * a missing prerequisite is a loud failure, not a green run.
 */

// Runner semantics (missing listed file, zero-test verdict, platform legs,
// macOS no-skip discipline, per-file timeout) are the shared engine settings
// below: scripts/lib/test-manifest.mjs. This file owns only the data tables.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const GROUPS = {
  // transport: instance transport specs, connection save/credential binding and the ssh transport provider
  transport: [
    'test/transport/transport-manager.test.ts',
    'test/transport/transport-connection-recovery.test.ts',
    'test/transport/transport-health.test.ts',
    'test/transport/transport-registration.test.ts',
    'test/transport/auth-recovery-policy.test.ts',
    'test/transport/auth-recovery.test.ts',
    'test/transport/transport-identity.test.ts',
    // F13：注册表加载降级信号（manager 只读健康位 + desktop_ssh_instances_health IPC）。
    'test/transport/transport-registry-health.test.ts',
    'test/transport/transport-spec-binding.test.ts',
    'test/transport/connection-save.test.ts',
    'test/transport/ssh-provider.test.ts',
    // P2-1：POSIX UDS 隧道（路径/0700/长度/清理 + argv 形状 + manager 真实 UDS 就绪与
    // 崩溃账本 + orphan sweep 矩阵）。
    'test/transport/ssh-socket.test.ts',
    'test/transport/ssh-provider-socket.test.ts',
    'test/transport/transport-uds.test.ts',
    'test/transport/ssh-orphan.test.ts',
    // P2-5：SSH 密码镜像的 safeStorage 加密/迁移/不可用拒绝 + askpass FIFO 传递路径。
    'test/transport/ssh-credentials.test.ts',
    'test/transport/ssh-provider-exec.test.ts',
    'test/transport/ssh-provider-endpoint-auth.test.ts',
    // P0-2: ssh stdin lifecycle (EPIPE/early close never crash; exit > timeout > stdin priority).
    'test/transport/ssh-stdin.test.ts',
    // P0-3: app-owned known_hosts + the ssh self-proof probe (pure + injected-spawn paths).
    'test/transport/host-key.test.ts',
    // P0-3: transport-manager pre-spawn gate / hostkey action class / ssh argv pin.
    'test/transport/host-key-manager.test.ts',
    'test/transport/ssh-config.test.ts',
    'test/transport/free-port.test.ts',
  ],
  // forward: remote-browser port forwards (design 28, W0/S1): wire contract,
  // ssh argv golden, browserNamespace/alias allocator, manager state machine,
  // the crash-safe child registry/reaper, the IPC/bridge layer
  // (forward-ipc = registrar + rejection matrix; forward-open = main-side URL
  // composition/path guard; forward-log-redaction = no payload echo/log path),
  // and the production assembly (forward-service = source resolver/stores/
  // launcher/authorize/openExternal + the shell-ipc-open-in singleton).
  // Every file is pure Node (injected adapters; no ssh, no fs, no Electron)
  // except three acceptances that register their test unconditionally and skip
  // when their prerequisite is absent. All three opt into the shared runner's
  // 'registered' guard, so a leg without the prerequisite is a legitimate skip
  // instead of a red run, while each file must still register a test and report
  // a summary (deleting an acceptance stays red):
  //   - forward-real-ssh needs Linux + root + sshd/ssh-keygen/ssh;
  //   - forward-spawn proves the real-child identity through Linux /proc start
  //     ticks (the file documents macOS/win32 real-machine drills as its gap).
  forward: [
    'test/forward/forward-wire.test.ts',
    'test/forward/ssh-forward-args.test.ts',
    'test/forward/forward-namespace.test.ts',
    'test/forward/forward-manager.test.ts',
    'test/forward/forward-lifecycle.test.ts',
    'test/forward/forward-ipc.test.ts',
    'test/forward/forward-open.test.ts',
    'test/forward/forward-log-redaction.test.ts',
    'test/forward/forward-service.test.ts',
    'test/forward/forward-windows.test.ts',
    { file: 'test/forward/forward-spawn.test.ts', guard: 'registered' },
    { file: 'test/forward/forward-real-ssh.test.ts', guard: 'registered' },
  ],
  // gateway: gateway provider/session and the manual gateway chamber seed sync path
  gateway: [
    // 凭据两维交叉矩阵（design 17 §2.3）。
    'test/gateway/gateway-credential-matrix.test.ts',
    'test/gateway/gateway-provider.test.ts',
    'test/gateway/gateway-session-spki.test.ts',
    'test/gateway/gateway-sync-registry.test.ts',
    'test/gateway/gateway-session.test.ts',
    'test/gateway/gateway-session-lifecycle.test.ts',
  ],
  // plugins: the plugin READ face (manifest/rows/redaction) and the main.ts plugin wiring gates
  plugins: [
    'test/plugins/plugin-sync.test.ts',
    // pnpm 入口候选解析（保留的 bundled entry + firstExisting 探针）——其他流的
    // 模块，清单归属本流维护。
    'test/plugins/pnpm-launcher.test.ts',
  ],
  // runtime: managed dsh runtime controller, renderer<->main action lockstep, and the main.ts decision gates
  runtime: [
    'test/runtime/runtime-lockstep.test.ts',
    'test/runtime/dsh-runtime-controller.test.ts',
    'test/runtime/main-decision-gates.test.ts',
    // 同步 spawn 解析器的三态 fail-closed（B3 2.2/2.3：corrupt|unknown 绝不落 builtin）
    'test/runtime/authority-fail-closed.test.ts',
    // B1 §2.6 restore blocked+cause 路径：真实 throw 必须走错误分支（不静默吞掉）
    'test/runtime/restore-pre-rollback-cause.test.ts',
    // swift-side runtime probe diagnostics pure module (flat path, same reason
    // as the ipc group's flat swift-side files)
    'runtime-probe-detail.test.ts',
    // swift-flavor host-package source-dir helper (same flat-path reason)
    'host-package-dirs.test.ts',
  ],
  // ipc: preload/renderer IPC surface mirror, cross-package protocol lockstep and IPC sender trust
  ipc: [
    // clear-only 凭据 IPC 的准入契约。
    'test/ipc/clear-only-credentials.test.ts',
    'test/ipc/renderer-trust.test.ts',
    'test/ipc/cross-package-contract.test.ts',
    'test/ipc/local-plugin-list-redaction.test.ts',
    'test/ipc/ipc-surface-mirror.test.ts',
    // P0-3：host-key probe/trust IPC 的载荷形状与准入（注入 guard，不跑真实 ssh）。
    'test/ipc/host-key-ipc.test.ts',
    // design 11 §4：更新确认的**执行级** fail-closed/revision 护栏（伪 ctx 驱动真实注册体）。
    'test/ipc/shell-ipc-update.test.ts',
    // swift-side electron-free core seam gate + the Swift-flavor sidecar/B-bridge
    // surface (flat paths on purpose; kept out of the test/<domain>/ regrouping).
    'electron-free-gate.test.ts',
    'node-edges.test.ts',
    'sidecar-stdio.test.ts',
    'bridge-manifest.test.ts',
    'bridge-shim.test.ts',
    'bridge-shim-surface.test.ts',
    // 原生 chrome 文案（tray / 对话框）的语言裁决与词典
    'shell-locale.test.ts',
    // 上游席位锁：platform 标记 / dshDesktop 载体 / 失败分类 / Windows caption
    'upstream-seats.test.ts',
    // C4 启动与修复：三选恢复决策 + chamber 自持状态备份 + main.ts 接线锁步
    'test/desktop-shell/startup-recovery.test.ts',
    // 致命诊断本地报告（§18 行 1 / §22.3.1）：describeFatalError + 报告落盘诚实性 +
    // 渲染端 console 有界环
    'test/desktop-shell/fatal-report.test.ts',
    'test/ipc/bridge-shim-document.test.ts',
    // 宿主路径面（上游 __DSH_HOST_PATHS__）：painted-source 门控 / 批次配对 / 消费一次。
    'test/ipc/bridge-shim-host-paths.test.ts',
    // rc.2 dshDesktop 载体（官方 desktop preload 面）：字面量单源锁步 + 原生
    // 键盘桥行为（真 protocol + 内存存储，无 Electron/GUI）。
    'test/ipc/desktop-carrier-surface.test.ts',
    'test/ipc/desktop-shortcuts-bridge.test.ts',
  ],
  // desktop-shell: OS-facing shell surfaces (deep links, open-in, notifications, badge) and the update lifecycle
  'desktop-shell': [
    'test/desktop-shell/renderer-frame-watchdog.test.ts',
    'test/desktop-shell/notifications.test.ts',
    'test/desktop-shell/badge.test.ts',
    // W4：非交互腿有界队列的合流语义（在飞期间的新值不得被 shift 吞掉）。
    'test/desktop-shell/node-edges-queue.test.ts',
    // 本地 dsh 端口基址的 env 覆盖（与在跑实例并存；I-15 验收腿的前置）
    'test/desktop-shell/dsh-port-base.test.ts',
    'test/desktop-shell/deep-link.test.ts',
    'test/desktop-shell/open-in.test.ts',
    'test/desktop-shell/updater.test.ts',
    'test/desktop-shell/updater-restart-install.test.ts',
    // 检查/下载的 idle 看门狗（P0-1 取件）
    'test/desktop-shell/updater-watchdog.test.ts',
    // 就绪注意力语义（每目标一次 + 焦点即清 + 聚焦不打扰；§22.3.5）
    'test/desktop-shell/updater-attention.test.ts',
    // main.ts 宿主的 resume nudge 与 win32 flashFrame seam（源码锁步 + seam 直测）
    'test/desktop-shell/updater-main-wiring.test.ts',
    // 两个 GitHub 发现面的锁步（共享 update-discovery.ts）
    'test/desktop-shell/update-discovery.test.ts',
    // design 11 §4 采纳点②：确认回答的 revision 护栏（控制器语义 + IPC 源码锁）
    'test/desktop-shell/updater-revision.test.ts',
    // design 11 §4 采纳点①：构建期通道封签（优先级表 + beta.yml 封签静态断言）
    'test/desktop-shell/updater-channel-seal.test.ts',
    // swift-side headless update controller (design 25 §7)
    'update-headless.test.ts',
    // 上游节奏单源 + 可选取证 JSONL（2026-09 对齐）
    'update-schedule.test.ts',
    'update-journal.test.ts',
  ],
  // local-state: durable local files — settings, audit log, owner-private ACLs and
  // the installed-runtime closure sample
  'local-state': [
    'test/local-state/audit-log.test.ts',
    'test/local-state/chamber-settings.test.ts',
    // D4 系统内存快照：/proc/meminfo 与 vm_stat 的纯解析 + TTL/单飞（假探针/假时钟），
    // 以及 settings-get 携带快照而 set/push 不携带的接线断言。
    'test/local-state/system-memory.test.ts',
    'test/local-state/win-acl.test.ts',
    // 安装树上游 client-plugin 闭包抽样：纯函数 + 临时目录 fixture
    'test/local-state/runtime-tree-check.test.ts',
    // lockfile-derived family facts memo：mtime+size 失效
    'test/local-state/lockfile-facts-memo.test.ts',
    // <userData> host-root 租约（R2 §3.6 L2）：desktop/sidecar 接线 + sidecar
    // 冲突 stderr/exit 契约与生命周期（源文本锁 + 真进程端到端）。
    'test/local-state/host-root-lease.test.ts',
  ],
  // scripts: package build/packaging helper tests (stay in scripts/ by design)
  scripts: [
    'scripts/bundle-swap.test.mjs',
    'scripts/bundle-pnpm-launcher.test.mjs',
    'scripts/after-pack-adhoc-sign.test.mjs',
    'scripts/before-pack.test.mjs',
    'scripts/electron-shared.test.mjs',
    'scripts/control-plane-freshness.test.mjs',
    // python 载荷 machinery（C5：锁校验 / 解包器 / dry-run 离线保证 / 摘要纪律 /
    // full 载荷的 pnpm 半边：版本单源、拷贝/prune、manifest/digest、--verify）
    'scripts/prepare-python-payload.test.mjs',
    // Office 技能资产（上游 skill-office 的 8 文件）：源解析/逐文件 temp+rename/
    // README 保留/清残留/verify sha256/CLI dry-run 与真实往返
    'scripts/prepare-office-assets.test.mjs',
    // 上游 pnpm patch 通道（§17-C）：pin 集合 → 运行期 workspace → runtime lock 的锁步
    'scripts/upstream-patches.test.mjs',
  ],
}

/** Windows CI leg (`test:win32` / `--win32`): win32-real or platform-neutral units only. */
export const WIN32_FILES = [
  'test/local-state/win-acl.test.ts',
  // design 28 §9.6 ssh argv golden: argv + the shared `-o` discipline are
  // platform-neutral (the ssh binary differs, the argv contract does not), so
  // the Windows leg runs the same lockstep. The win32-only forward pieces
  // (`taskkill /T`, no Job Object) live in forward-lifecycle's injected seam and
  // a dedicated forward-win32 suite is still TODO (S1); do not move the other
  // forward files here — they would then stop running on the POSIX legs.
  'test/forward/ssh-forward-args.test.ts',
]

/** macOS CI leg (`test:macos` / `--macos`): darwin lock assertions + packaging-script suites. */
export const MACOS_FILES = [
  'chamber-lock.test.ts',
  'scripts/build-sidecar.test.mjs',
  'scripts/build-swift-app.test.mjs',
]

/**
 * Listed files that legitimately run zero node:test tests, each with its reason.
 * A file that exits 0 without reporting a runner summary
 * is a silent skip — the failure mode this guard exists to stop — so it is a
 * failure unless recorded here. The current corpus runs at least one test in
 * every listed file, so the list is empty; do not add an entry to paper over a
 * file that stopped exercising its tests.
 * @type {readonly { file: string, reason: string }[]}
 */
export const ZERO_TEST_ALLOWLIST = []

function main() {
  runTestManifest({
    label: 'desktop',
    packageRoot: PACKAGE_ROOT,
    groups: GROUPS,
    platformFiles: { win32: WIN32_FILES, macos: MACOS_FILES },
    zeroTestAllowlist: ZERO_TEST_ALLOWLIST,
    requireNoSkipsLegs: ['macos'],
    // The macos leg is a STANDALONE set: the darwin lock assertion and the two
    // packaging-script suites are deliberately not in GROUPS (macos-only leg).
    allowPlatformFilesOutsideGroups: true,
  })
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
