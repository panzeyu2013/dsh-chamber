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
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
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
    // F13：注册表加载降级信号（manager 只读健康位 + desktop_ssh_instances_health IPC）。
    'test/transport/transport-registry-health.test.ts',
    'test/transport/transport-spec-binding.test.ts',
    'test/transport/connection-save.test.ts',
    'test/transport/ssh-provider.test.ts',
    'test/transport/ssh-provider-exec.test.ts',
    'test/transport/ssh-provider-endpoint-auth.test.ts',
    'test/transport/ssh-config.test.ts',
    'test/transport/free-port.test.ts',
  ],
  // gateway: gateway provider/session and the manual gateway plugin sync apply path
  gateway: [
    // 凭据两维交叉矩阵（design 17 §2.3）。
    'test/gateway/gateway-credential-matrix.test.ts',
    'test/gateway/gateway-provider.test.ts',
    'test/gateway/gateway-session-spki.test.ts',
    'test/gateway/gateway-chamber-apply-materialize.test.ts',
    'test/gateway/gateway-ipc-shared.test.ts',
    'test/gateway/gateway-sync-registry.test.ts',
    'test/gateway/gateway-session.test.ts',
    'test/gateway/gateway-session-lifecycle.test.ts',
  ],
  // plugins: remote plugin sync/tarball, the ssh apply increment rows + journal, and the main.ts plugin wiring gates
  plugins: [
    'test/plugins/plugin-sync.test.ts',
    'test/plugins/plugin-sync-apply.test.ts',
    'test/plugins/plugin-tarball.test.ts',
    'test/plugins/ssh-apply-rows.test.ts',
    'test/plugins/ssh-plugin-journal.test.ts',
    // pnpm 启动器解析（design 21 §6.3 / design 23 D2，win32 .cmd 拒绝）——
    // 其他流的模块，清单归属本流维护。
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
    // swift-side electron-free core seam gate + the Swift-flavor sidecar/B-bridge
    // surface (flat paths on purpose; kept out of the test/<domain>/ regrouping).
    'electron-free-gate.test.ts',
    'node-edges.test.ts',
    'sidecar-stdio.test.ts',
    'bridge-manifest.test.ts',
    'bridge-shim.test.ts',
    'bridge-shim-surface.test.ts',
  ],
  // desktop-shell: OS-facing shell surfaces (deep links, open-in, notifications, badge) and the update lifecycle
  'desktop-shell': [
    'test/desktop-shell/notifications.test.ts',
    'test/desktop-shell/badge.test.ts',
    'test/desktop-shell/deep-link.test.ts',
    'test/desktop-shell/open-in.test.ts',
    'test/desktop-shell/updater.test.ts',
    'test/desktop-shell/updater-restart-install.test.ts',
    // 两个 GitHub 发现面的锁步（共享 update-discovery.ts）
    'test/desktop-shell/update-discovery.test.ts',
    // swift-side headless update controller (design 25 §7)
    'update-headless.test.ts',
  ],
  // local-state: durable local files — settings, audit log, owner-private ACLs and
  // the installed-runtime closure sample
  'local-state': [
    'test/local-state/audit-log.test.ts',
    'test/local-state/chamber-settings.test.ts',
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
    // lockstep of this manifest + the zero-test guard
    'scripts/test-runner-lockstep.test.mjs',
  ],
}

/** Windows CI leg (`test:win32` / `--win32`): win32-real or platform-neutral units only. */
export const WIN32_FILES = [
  'test/local-state/win-acl.test.ts',
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
