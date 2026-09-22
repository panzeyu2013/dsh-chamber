/**
 * @dsh-chamber/dsh-runtime test manifest — authoritative file list for this
 * package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as
 * its own node child with piped stdio (written through, so the transcript
 * stays intact); the first failure ends the run — the same semantics as the
 * inline && chain this replaces. A listed file that does not exist is a
 * failure, never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 *
 * Zero-test guard (S5 / review/windows FIX C, ported from
 * packages/desktop/scripts/test.mjs:207-223): each child's node:test summary
 * is parsed; a listed file that exits 0 without a summary line or with
 * `tests 0` fails the run, so a manifest entry that was silently skipped can
 * no longer be green. A file whose registered tests are all platform-skipped
 * still prints a summary (tests > 0) and stays green — the listed set and its
 * selection semantics are unchanged.
 *
 * test/support/fake-adapter.ts and test/support/run-phase-fixture.ts are shared
 * fixtures, not tests: they live under test/support/ and are imported by the
 * suites below (never manifest entries).
 *
 * Platform split: `--win32` (package script `test:win32`) selects
 * WIN32_FILES — the Windows-semantics set (win32-real units plus the
 * platform-neutral units the Windows legs pin), the same explicit-list split
 * packages/control-plane/scripts/test.mjs uses. The win32-only integration test
 * self-skips off Windows; the rest of the set still runs there.
 */

// Runner semantics (missing listed file, zero-test guard, first-failure stop,
// platform legs, per-file timeout) are the shared engine settings below:
// scripts/lib/test-manifest.mjs. This file owns only the manifest tables.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // registry: registry 访问链 —— URL 白名单、SRI 强度校验、packument 读取
  registry: [
    'test/registry/registry-url.test.ts',
    'test/registry/registry-integrity.test.ts',
    'test/registry/registry-metadata.test.ts',
  ],
  // updater: 版本更新编排（SingleFlight / 版本清单 / no-op 判定）与刷新合并
  updater: [
    'test/updater/dsh-runtime-updater.test.ts',
    'test/updater/coalesced-refresh.test.ts',
  ],
  // store: 版本树 / 快照 / known-good / 元数据恢复数据面，及其版本路径安全与错误脱敏原语
  store: [
    'test/store/metadata-authority.test.ts',
    'test/store/dsh-runtime-store.test.ts',
    'test/store/disk-accounting.test.ts',
    'test/store/snapshot-store.test.ts',
    'test/store/known-good-monitor.test.ts',
    'test/store/runtime-metadata-recovery.test.ts',
    // The shared metadata-health projection both Node hosts publish (M14).
    'test/store/metadata-health-projection.test.ts',
    'test/store/version-safety.test.ts',
    'test/store/sanitize-error.test.ts',
    'test/store/private-fs-nofollow.test.ts',
  ],
  // activation: 激活裁决、应用事务（apply-phase / apply-now）、状态迁移与宿主探针
  activation: [
    'test/activation/activation-gate.test.ts',
    'test/activation/apply-phase.test.ts',
    'test/activation/runtime-state-machine.test.ts',
    'test/activation/runtime-probes.test.ts',
    'test/activation/apply-now.test.ts',
  ],
  // lifecycle: 启动阶段 / 重启耗尽回退 / override 生命周期 / 运行期互斥 / 宿主适配 seam
  lifecycle: [
    'test/lifecycle/runtime-startup.test.ts',
    'test/lifecycle/restart-exhausted-rollback.test.ts',
    'test/lifecycle/override-lifecycle.test.ts',
    'test/lifecycle/runtime-operation-fence.test.ts',
    'test/lifecycle/runtime-host-adapter.test.ts',
  ],
  // install: 安装流水线（source-bound pnpm install / 发布树）与构建产物锁定
  install: [
    'test/install/runtime-installer.test.ts',
    'test/install/allow-builds.test.ts',
    'test/install/dist-sync.test.ts',
  ],
  // windows: Windows 进程树探针、瞬时重命名重试与只读清理（design 21 M2a）
  windows: [
    'test/windows/windows-process.test.ts',
    'test/windows/rename-retry.test.ts',
    'test/windows/win32-readonly-rm.integration.test.ts',
    // Zero-test guard of this manifest (S5 / review/windows FIX C), pinned on
    // every leg and on the Windows one.
    'test/windows/test-runner-guard.test.mjs',
  ],
}

const WIN32_FILES = [
  'test/windows/windows-process.test.ts',
  'test/windows/rename-retry.test.ts',
  // Zero-test guard of this manifest (S5 / review/windows FIX C); it is
  // platform-neutral and fast, so the Windows leg pins it too.
  'test/windows/test-runner-guard.test.mjs',
  'test/updater/coalesced-refresh.test.ts',
  'test/windows/win32-readonly-rm.integration.test.ts',
  'test/install/dist-sync.test.ts',
  'test/store/sanitize-error.test.ts',
  // no-O_NOFOLLOW fallback is precisely the win32 semantics the leg must pin
  'test/store/private-fs-nofollow.test.ts',
]

function main() {
  runTestManifest({
    label: 'dsh-runtime',
    packageRoot: PACKAGE_ROOT,
    groups: GROUPS,
    platformFiles: { win32: WIN32_FILES },
    guard: 'registered',
  })
}

// Import guard: this manifest is also imported by its zero-test guard test as
// a pure module (table lockstep assertions), so the CLI only runs as the
// entry point.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
