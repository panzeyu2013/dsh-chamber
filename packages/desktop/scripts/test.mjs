/**
 * @dsh-chamber/desktop test manifest — authoritative file list for this
 * package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as
 * its own node child; stdout/stderr are piped through so the transcript stays
 * intact, and the first failure ends the run — the same semantics as the inline
 * && chain this replaces. Two failures are never silent skips:
 *   - a listed file that does not exist;
 *   - a listed file that exits 0 without running any test (no node:test summary
 *     or "tests 0"), or that cannot be spawned. Such a file must be recorded in
 *     ZERO_TEST_ALLOWLIST with a justification (D2b guard).
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
 * macOS leg skip discipline (G2, 2026-12 parity audit): the packaging suites
 * carry five environment-conditional `t.skip` sites (codesign/hdiutil, the
 * SwiftPM .build/release product, the resolved Sparkle artifact). A skipped case
 * there is exactly the silent-coverage-loss this runner exists to stop, so the
 * macOS leg additionally requires `skipped === 0` in every child summary —
 * a missing prerequisite is a loud failure, not a green run.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const GROUPS = {
  // transport: instance transport specs, connection save/credential binding and the ssh transport provider
  transport: [
    'test/transport/transport-manager.test.ts',
    'test/transport/transport-connection-recovery.test.ts',
    'test/transport/transport-exec-and-registry.test.ts',
    'test/transport/transport-providers.test.ts',
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
    'test/gateway/gateway-provider.test.ts',
    'test/gateway/gateway-session-spki.test.ts',
    'test/gateway/gateway-chamber-sync.test.ts',
    'test/gateway/gateway-chamber-apply-materialize.test.ts',
    'test/gateway/gateway-ipc-shared.test.ts',
    'test/gateway/gateway-sync-registry.test.ts',
    'test/gateway/gateway-session.test.ts',
    'test/gateway/gateway-session-lifecycle.test.ts',
    'test/gateway/gateway-session-refresh.test.ts',
  ],
  // plugins: remote plugin sync/tarball, the ssh apply increment rows + journal, and the main.ts plugin wiring gates
  plugins: [
    'test/plugins/plugin-sync.test.ts',
    'test/plugins/plugin-sync-remote-read.test.ts',
    'test/plugins/plugin-sync-apply.test.ts',
    'test/plugins/plugin-sync-seed.test.ts',
    'test/plugins/plugin-sync-renderer-projection.test.ts',
    'test/plugins/plugin-tarball.test.ts',
    'test/plugins/ssh-apply-rows.test.ts',
    'test/plugins/ssh-plugin-journal.test.ts',
  ],
  // runtime: managed dsh runtime controller, renderer<->main action lockstep, and the main.ts decision gates
  runtime: [
    'test/runtime/runtime-lockstep.test.ts',
    'test/runtime/dsh-runtime-controller.test.ts',
    'test/runtime/main-decision-gates.test.ts',
    // swift-side runtime probe diagnostics pure module (flat path, same reason
    // as the ipc group's flat swift-side files)
    'runtime-probe-detail.test.ts',
    // swift-flavor host-package source-dir helper (same flat-path reason)
    'host-package-dirs.test.ts',
  ],
  // ipc: preload/renderer IPC surface mirror, cross-package protocol lockstep and IPC sender trust
  ipc: [
    'test/ipc/renderer-trust.test.ts',
    'test/ipc/cross-package-contract.test.ts',
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
    'test/desktop-shell/updater-cache-maintenance.test.ts',
    'test/desktop-shell/update-restart-quit.test.ts',
    // swift-side headless update controller (design 25 §7)
    'update-headless.test.ts',
  ],
  // local-state: durable local files — settings, audit log and owner-private ACLs
  'local-state': [
    'test/local-state/audit-log.test.ts',
    'test/local-state/chamber-settings.test.ts',
    'test/local-state/win-acl.test.ts',
    // swift-side main.ts directory-lock wiring source assertions (三审 #13)
    'chamber-lock-wiring.test.ts',
  ],
  // scripts: package build/packaging helper tests (stay in scripts/ by design)
  scripts: [
    'scripts/bundle-swap.test.mjs',
    'scripts/after-pack-adhoc-sign.test.mjs',
    'scripts/before-pack.test.mjs',
    'scripts/build-host-graph-package.test.mjs',
    'scripts/electron-shared.test.mjs',
    'scripts/control-plane-freshness.test.mjs',
    // lockstep of this manifest + the zero-test guard (D2b)
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
 * Listed files that legitimately run zero node:test tests, each with the reason
 * a reviewer accepted. A file that exits 0 without reporting a runner summary
 * is a silent skip — the failure mode this guard exists to stop — so it is a
 * failure unless recorded here. The current corpus runs at least one test in
 * every listed file, so the list is empty; do not add an entry to paper over a
 * file that stopped exercising its tests.
 * @type {readonly { file: string, reason: string }[]}
 */
export const ZERO_TEST_ALLOWLIST = []

/** node:test summary lines: the spec reporter prints "ℹ tests N" / "ℹ pass N"
 *  / "ℹ fail N" / "ℹ skipped N", TAP prints the same keys behind "#". */
const SUMMARY_LINE = /^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)\s*$/gm

/**
 * The LAST node:test summary block in `output` (a file that never entered the
 * runner prints none). `tests` counts REGISTERED tests including skipped/todo
 * ones, so a positive `tests` alone does NOT prove a test body executed — the
 * verdict below additionally requires pass+fail > 0 (2026-12 验证轮：全 skip 的
 * 文件报 "tests 1 / skipped 1" 并通过旧的计数守卫，而旧注释声称它不可能通过)。
 * @param {string} output - combined child stdout + stderr.
 * @returns {{ tests: number | null, pass: number | null, fail: number | null, skipped: number | null }}
 */
export function parseReportedTotals(output) {
  const empty = { tests: null, pass: null, fail: null, skipped: null }
  let block = null
  for (const match of output.matchAll(SUMMARY_LINE)) {
    const key = match[1]
    if (block === null || key === 'tests') block = { ...empty }
    block[key] = Number(match[2])
  }
  return block ?? empty
}

/**
 * Number of tests reported by the last node:test summary, or null when no
 * summary is present (kept for the runner lockstep test's parse assertions).
 * @param {string} output - combined child stdout + stderr.
 * @returns {number | null}
 */
export function parseReportedTestCount(output) {
  return parseReportedTotals(output).tests
}

/** @typedef {{ ok: true } | { ok: false, reason: string }} ChildVerdict */

/**
 * Decide one listed child's outcome: spawn failure, non-zero exit, or a run
 * that executed no test body (no summary / tests 0 / pass 0 且 fail 0——全
 * skipped 也算，见 parseReportedTotals). `allowlist` is injectable so the
 * lockstep test covers both the failure and the explicit-exception paths.
 * `requireNoSkips` is the macOS-leg discipline (G2): a partial skip set is a
 * failure there, because the five packaging-suite `t.skip` sites guard real
 * prerequisites (codesign/hdiutil/.build/release/Sparkle) that a green CI run
 * must have proven, not skipped.
 * @param {string} file - package-relative listed path.
 * @param {{ status: number | null, signal: string | null, error?: Error, stdout?: string | null, stderr?: string | null }} result - spawnSync result.
 * @param {readonly { file: string, reason: string }[]} [allowlist] - zero-test exceptions.
 * @param {{ requireNoSkips?: boolean }} [options] - macOS-leg no-skip discipline.
 * @returns {ChildVerdict}
 */
export function evaluateChildRun(file, result, allowlist = ZERO_TEST_ALLOWLIST, { requireNoSkips = false } = {}) {
  if (result.error !== undefined) return { ok: false, reason: '无法启动：' + result.error.message }
  if (result.status !== 0) {
    return { ok: false, reason: 'exit ' + (result.status ?? ('signal ' + (result.signal ?? 'unknown'))) }
  }
  if (allowlist.some(entry => entry.file === file)) return { ok: true }
  const totals = parseReportedTotals((result.stdout ?? '') + '\n' + (result.stderr ?? ''))
  if (totals.tests === null) return { ok: false, reason: '未运行任何测试（无 node:test 汇总行；零测试文件不得视为通过）' }
  if (totals.tests === 0) return { ok: false, reason: 'node:test 汇总 tests 0（零测试文件不得视为通过）' }
  if (requireNoSkips && (totals.skipped ?? 0) > 0) {
    return { ok: false, reason: `macOS 腿不得有跳过用例（skipped ${totals.skipped}）——缺前置必须红，不得静默降覆盖` }
  }
  if ((totals.pass ?? 0) === 0 && (totals.fail ?? 0) === 0) {
    return { ok: false, reason: '所有测试被跳过/待办（pass 0 / fail 0）——未执行任何测试体' }
  }
  return { ok: true }
}

/** Build the manifest entry list for the selected platform leg. */
export function collectEntries({ win32 = false, macos = false } = {}) {
  const toEntries = (group, files) =>
    files.map(entry => (typeof entry === 'string' ? { group, file: entry, nodeArgs: [] } : { group, nodeArgs: [], ...entry }))
  if (win32) return toEntries('win32', WIN32_FILES)
  if (macos) return toEntries('macos', MACOS_FILES)
  return Object.entries(GROUPS).flatMap(([group, list]) => toEntries(group, list))
}

/**
 * Run one manifest's entries, stopping at the first failure. The spawn/output
 * seams are injectable so scripts/test-runner-lockstep.test.mjs can prove the
 * zero-test guard is actually wired into the loop.
 * @param {{ group: string, file: string, nodeArgs: string[] }[]} entries
 * @param {{ spawn?: Function, writeOut?: (text: string) => void, writeErr?: (text: string) => void, requireNoSkips?: boolean }} [seams]
 * @returns {{ ok: true } | { ok: false, file: string, reason: string }}
 */
export function runEntries(entries, {
  spawn = spawnSync,
  writeOut = text => process.stdout.write(text),
  writeErr = text => process.stderr.write(text),
  requireNoSkips = false,
} = {}) {
  for (const [index, entry] of entries.entries()) {
    if (index === 0 || entries[index - 1].group !== entry.group) writeOut('\n=== ' + entry.group + ' ===\n')
    const result = spawn(process.execPath, [...entry.nodeArgs, entry.file], {
      cwd: PACKAGE_ROOT,
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (typeof result.stdout === 'string' && result.stdout !== '') writeOut(result.stdout)
    if (typeof result.stderr === 'string' && result.stderr !== '') writeErr(result.stderr)
    const verdict = evaluateChildRun(entry.file, result, ZERO_TEST_ALLOWLIST, { requireNoSkips })
    if (!verdict.ok) return { ok: false, file: entry.file, reason: verdict.reason }
  }
  return { ok: true }
}

function main() {
  const win32 = process.argv.includes('--win32')
  const macos = process.argv.includes('--macos')
  if (win32 && macos) {
    console.error('[test] --win32 and --macos are mutually exclusive')
    process.exit(1)
  }
  const entries = collectEntries({ win32, macos })
  const missing = entries.filter(entry => !existsSync(join(PACKAGE_ROOT, entry.file)))
  if (missing.length > 0) {
    console.error('[test] listed test file(s) missing:')
    for (const entry of missing) console.error('  - ' + entry.file)
    process.exit(1)
  }
  // macOS leg: a skipped packaging case (codesign/hdiutil/.build/release/Sparkle
  // prerequisite) must fail the run instead of quietly shrinking coverage.
  const verdict = runEntries(entries, { requireNoSkips: macos })
  if (!verdict.ok) {
    console.error('[test] ' + verdict.file + ' failed (' + verdict.reason + ')')
    process.exit(1)
  }
}

// Import guard：本清单同时被 scripts/test-runner-lockstep.test.mjs 以纯函数
// 方式 import（清单锁步 + 零测试守卫断言），CLI 只在作为入口运行时执行。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
