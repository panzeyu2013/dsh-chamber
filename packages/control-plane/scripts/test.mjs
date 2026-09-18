/**
 * `pnpm run test:control-plane` (root) → `pnpm --filter @dsh-chamber/control-plane
 * run test` — the control-plane unit-test set (release-checklist §3 names this
 * script as the authoritative list). Each file runs as its own `node <file>.ts`
 * child with inherited stdio (the same semantics as the former inline CI chain:
 * a failure in one file stops the run non-zero).
 *
 * Every listed file is required: silently skipping a deleted/renamed test
 * would make the aggregate command pass with less coverage than the checklist
 * and CI claim. The manifest is grouped by subject area and mirrors the
 * test/<domain>/ layout. test/smoke.test.ts is deliberately NOT listed here:
 * the root `smoke` script runs that exact path directly (root package.json),
 * so it stays at the test/ top level.
 *
 * Platform split (2026-09, structural — no file lists in workflow YAML): the
 * POSIX-semantics suites (private-fs O_NOFOLLOW/0700 etc., fail-closed on
 * win32 by design) run on the POSIX legs via `test`. The Windows CI leg runs
 * `pnpm --filter @dsh-chamber/control-plane run test:win32` (= this script
 * with `--win32`), which runs WIN32_FILES below — win32-real or
 * platform-neutral units only. Extend WIN32_FILES as Windows semantics land
 * (M2b), never by hand-copying lists into ci.yml.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // api: 管理 REST API（连接/生命周期/实例状态）、写者静默 latch 与持久化存储
  'api': [
    'test/api/manager-api.test.ts',
    // Writer-quiescence latch recovery (2026-09-10): the in-session re-proof, the
    // structured 409 detail and the explicit 清理并接管 action.
    'test/api/writer-latch.test.ts',
    'test/api/storage.test.ts',
  ],
  // protocol: 启动握手、dsh 客户端、A2 跨包 RPC envelope 与浏览器 auth cookie
  'protocol': [
    'test/protocol/protocol.test.ts',
    'test/protocol/m1-dsh-client.test.ts',
    'test/protocol/rpc-envelope.test.ts',
    'test/protocol/browser-auth-cookie.test.ts',
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
  // proxy: 实例反向代理（HTTP/WS/SSE）、WS 帧、S0 注入预算与静态前端服务
  'proxy': [
    'test/proxy/instance-proxy.test.ts',
    'test/proxy/response-encoding.test.ts',
    'test/proxy/ws-upgrade.test.ts',
    'test/proxy/liveness-timeout.test.ts',
    'test/proxy/real-node-spki.test.ts',
    'test/proxy/gateway-transport.test.ts',
    'test/proxy/ws-frames.test.ts',
    'test/proxy/static-serving.test.ts',
    // S0 injection-budget pin: MAX_HTML_INJECTION_BYTES is the single source
    // (the gateway html-inject.ts consumes it via @dsh-chamber/control-plane —
    // no twin constant since the B-6e dedupe); the test pins the budget value.
    'test/proxy/html-inject-lockstep.test.ts',
  ],
  // plugins: 宿主图种子、cordis insert 渲染与受保护插件集合判定
  'plugins': [
    'test/plugins/host-graph-seed.test.ts',
    'test/plugins/cordis-inserts.test.ts',
    // 受保护集合 / 代耦合 / 装后复验的完整判定面（design 21 §6.11，决策 19）。
    // 本文件此前只靠手动 `node <path>` 运行，所以 §6.11 的全部 pin 与
    // familyNamesFromLockfileClosure（C11 同源解析器）从未进入 CI —— 而它正是
    // 「官方 opt-in 层可装可卸」这条契约唯一的单测锚点。
    'test/plugins/protected-plugins.test.ts',
  ],
  // windows: Windows 探针解析/分类与 win32-only 生命周期集成
  'windows': [
    // Windows probe parsers/classifiers run on every leg; the win32-only
    // lifecycle integration test self-skips on POSIX and runs on the Windows
    // CI leg (design 02 §5.1 parity work, M1).
    'test/windows/win-probes.test.ts',
    'test/windows/win32-lifecycle.integration.test.ts',
  ],
}

/** Windows CI leg set (`test:win32` / `--win32`): win32-real or
 *  platform-neutral tests. Same entry shape as GROUPS. */
const WIN32_FILES = [
  // Windows probe parsers/classifiers; win32-lifecycle self-skips on POSIX and
  // runs the real CIM/netstat/taskkill gates on windows-2022.
  'test/windows/win-probes.test.ts',
  'test/windows/win32-lifecycle.integration.test.ts',
  // The §6.11 judgement face is platform-neutral (join/mkdtemp/tmpdir only) and
  // runs in ~25 ms, so the Windows leg gets the same pins as the POSIX legs —
  // including symlink/junction semantics of readInstalledVersion.
  'test/plugins/protected-plugins.test.ts',
]

const isWin32 = process.argv.includes('--win32')
// `--win32` selects the set; it does not require Windows. The lifecycle
// integration self-skips on POSIX anyway, so a POSIX machine still exercises
// the parsers and the skip path.
const entries = Object.entries(GROUPS).flatMap(([group, list]) =>
  list.map(entry => (typeof entry === 'string' ? { group, file: entry, nodeArgs: [] } : { group, nodeArgs: [], ...entry })),
)
const missing = entries.filter(entry => !existsSync(join(PACKAGE_ROOT, entry.file)))
if (missing.length > 0) {
  console.error('[test:control-plane] listed test file(s) missing:')
  for (const entry of missing) console.error('  - ' + entry.file)
  process.exit(1)
}
const selected = isWin32
  ? WIN32_FILES.map(file => {
      const entry = entries.find(candidate => candidate.file === file)
      if (entry === undefined) {
        console.error(`[test:control-plane] --win32 lists a file outside GROUPS: ${file}`)
        process.exit(1)
      }
      return { ...entry, group: 'win32' }
    })
  : entries
for (const [index, entry] of selected.entries()) {
  if (index === 0 || selected[index - 1].group !== entry.group) console.log('\n=== ' + entry.group + ' ===')
  const result = spawnSync(process.execPath, [...entry.nodeArgs, entry.file], { cwd: PACKAGE_ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`[test:control-plane] ${entry.file} failed (exit ${result.status ?? `signal ${result.signal}`})`)
    process.exit(1)
  }
}
