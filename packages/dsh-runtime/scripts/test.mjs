/**
 * @dsh-chamber/dsh-runtime test manifest — authoritative file list for this
 * package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as
 * its own node child with inherited stdio; the first failure ends the run — the
 * same semantics as the inline && chain this replaces. A listed file that does
 * not exist is a failure, never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
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
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    'test/store/version-safety.test.ts',
    'test/store/sanitize-error.test.ts',
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
  ],
}

/** Windows-semantics set (`test:win32` / `--win32`): win32-real units plus the
 *  platform-neutral units the same legs pin. Same entry shape as GROUPS. */
const WIN32_FILES = [
  'test/windows/windows-process.test.ts',
  'test/windows/rename-retry.test.ts',
  'test/updater/coalesced-refresh.test.ts',
  'test/windows/win32-readonly-rm.integration.test.ts',
  'test/install/dist-sync.test.ts',
  'test/store/sanitize-error.test.ts',
]

const isWin32 = process.argv.includes('--win32')
const entries = Object.entries(GROUPS).flatMap(([group, list]) =>
  list.map(entry => (typeof entry === 'string' ? { group, file: entry, nodeArgs: [] } : { group, nodeArgs: [], ...entry })),
)
const missing = entries.filter(entry => !existsSync(join(PACKAGE_ROOT, entry.file)))
if (missing.length > 0) {
  console.error('[test] listed test file(s) missing:')
  for (const entry of missing) console.error('  - ' + entry.file)
  process.exit(1)
}
const selected = isWin32
  ? WIN32_FILES.map(file => {
      const entry = entries.find(candidate => candidate.file === file)
      if (entry === undefined) {
        console.error('[test] --win32 lists a file outside GROUPS: ' + file)
        process.exit(1)
      }
      return { ...entry, group: 'win32' }
    })
  : entries
for (const [index, entry] of selected.entries()) {
  if (index === 0 || selected[index - 1].group !== entry.group) console.log('\n=== ' + entry.group + ' ===')
  const result = spawnSync(process.execPath, [...entry.nodeArgs, entry.file], { cwd: PACKAGE_ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('[test] ' + entry.file + ' failed (exit ' + (result.status ?? ('signal ' + result.signal)) + ')')
    process.exit(1)
  }
}
