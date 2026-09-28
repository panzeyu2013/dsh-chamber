#!/usr/bin/env node
/**
 * run-swift-tests.mjs —— the single macOS/Swift test entry (G1/G2/G23).
 *
 * Why this exists:
 * - G1: a darwin `pnpm run check:tests` must run the XCTest suite (the suite
 *   is otherwise reachable only from ci.yml).
 * - G23: `swift test` defaults to debug, while the shipped native binary is a
 *   release build. This runner pins `-c release` so the tests exercise the
 *   configuration that ships (release-only branches such as MainWindowController's #if DEBUG).
 * - G2: eight real sidecar integration cases may `XCTSkip` and CI stays green.
 *   A skipped XCTest case is a failure here: the runner parses the XCTest
 *   summary and requires executed > 0, failures == 0 AND skipped == 0.
 * - Corpus pin: "executed > 0" cannot see a deleted or emptied test file (the
 *   rest of the suite still reports a positive total). SWIFT_TEST_MANIFEST is
 *   the committed file list and every on-disk `*Tests.swift` must carry at
 *   least one XCTest case, so a vanished test file is red BEFORE `swift test`
 *   runs — the manifest + zero-test-allowlist discipline of
 *   packages/desktop/scripts/test.mjs, with the (deliberate) subset direction
 *   documented at swiftTestCorpusProblems.
 *
 * Environment discipline: the Swift integration tests spawn
 * `node packages/desktop/sidecar-entry.ts` (the 8 XCTSkip sites). When
 * DSH_CHAMBER_SHELL_NODE_BIN is absent the runner points it at the node running this gate, so
 * the integration cases actually run instead of skipping. An explicit-but-broken
 * DSH_CHAMBER_SHELL_NODE_BIN still hard-fails inside the Swift tests themselves.
 *
 * Usage:
 *   node scripts/gates/run-swift-tests.mjs            # gate (exit 1 on any skip/failure)
 *   node scripts/gates/run-swift-tests.mjs --dry-run  # print the command, run nothing
 *
 * The `--disable-sandbox` flag matches the repository's documented Swift test
 * invocation; SwiftPM's manifest sandbox cannot run inside every dev/CI
 * harness, and this package's manifest has no plugins to protect.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (this file lives in scripts/gates/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Explicit node override consumed by the Swift integration tests. */
export const NODE_BIN_ENV = 'DSH_CHAMBER_SHELL_NODE_BIN'

/** Swift package path relative to the repository root. */
export const SWIFT_PACKAGE_PATH = 'macos'

/** Swift 测试根目录（仓库根相对；语料清单引脚的扫描面）。 */
export const SWIFT_TESTS_ROOT = `${SWIFT_PACKAGE_PATH}/Tests`

/**
 * Scratch dirs for the swift child, relative to the repository root. Sparkle's
 * manifest plugin and Clang write module caches to TMPDIR/~/Library by default;
 * inside a restricted harness (and on CI sandboxes) those locations are not
 * writable, which fails the build with "unable to open output file ...
 * ModuleCache ... 'Operation not permitted'" instead of a test result. Pointing
 * them at the repo's own .tmp/ keeps the gate runnable everywhere; an explicit
 * caller value is never overwritten.
 */
export const SWIFT_SCRATCH_DIRS = [
  { env: 'TMPDIR', path: '.tmp/swift/tmp' },
  { env: 'CLANG_MODULE_CACHE_PATH', path: '.tmp/swift/clang' },
  { env: 'SWIFT_MODULE_CACHE_PATH', path: '.tmp/swift/module' },
]

/**
 * Swift 测试语料清单（**提交清单**，仓库根相对路径）。
 *
 * 为什么需要它："executed > 0" 看不见「删掉一个测试文件」——其余用例照常执行，
 * 汇总行依然正数，套件静默缩水。JS 侧的 packages/desktop/scripts/test.mjs 用
 * 「清单 + 零测试守卫」把这个洞堵住，Swift 侧此前没有对应物（STATUS「原生壳验证面
 * 缺类」③就是这一项）。
 *
 * 判据是**子集**而不是精确相等（刻意）：承诺「清单登记的文件都在且不空」，新增
 * 的测试文件不必同时改清单（精确相等会让两个并行新增互相变红）。缺失/删除/删空
 * 由 swiftTestCorpusProblems 逐条 loud；新增未登记文件不受影响。
 *
 * 维护：新增测试文件时把路径加进来（顺序无关，重复即红）。不要为了消红把文件从
 * 清单里删掉——删文件会让门禁失去它唯一的存在理由。
 */
export const SWIFT_TEST_MANIFEST = [
  'macos/Tests/DSHChamberTests/AnyCodableTests.swift',
  'macos/Tests/DSHChamberTests/AppUpdaterTests.swift',
  'macos/Tests/DSHChamberTests/AuditRegressionTests.swift',
  'macos/Tests/DSHChamberTests/BridgeClientEdgeIntegrationTests.swift',
  'macos/Tests/DSHChamberTests/BridgeClientFallbackTests.swift',
  'macos/Tests/DSHChamberTests/BridgeClientIntegrationTests.swift',
  'macos/Tests/DSHChamberTests/BridgeClientLineReadTests.swift',
  'macos/Tests/DSHChamberTests/BridgeClientStopGraceTests.swift',
  'macos/Tests/DSHChamberTests/BridgeManifestConsistencyTests.swift',
  'macos/Tests/DSHChamberTests/BridgeShimInjectorTests.swift',
  'macos/Tests/DSHChamberTests/CrashDiagnosticsTests.swift',
  'macos/Tests/DSHChamberTests/CrossLanguageLockstepTests.swift',
  'macos/Tests/DSHChamberTests/DownloadDestinationTests.swift',
  'macos/Tests/DSHChamberTests/ExternalOpenBudgetTests.swift',
  'macos/Tests/DSHChamberTests/FileOpenPanelTests.swift',
  'macos/Tests/DSHChamberTests/FrameCodecTests.swift',
  'macos/Tests/DSHChamberTests/HostFactsDiffTests.swift',
  'macos/Tests/DSHChamberTests/IngestReconcileSeamTests.swift',
  'macos/Tests/DSHChamberTests/JSLiteralEscapingTests.swift',
  'macos/Tests/DSHChamberTests/MessageHandlerTests.swift',
  'macos/Tests/DSHChamberTests/NativeTextLanguageOverrideTests.swift',
  'macos/Tests/DSHChamberTests/NativeTextTests.swift',
  'macos/Tests/DSHChamberTests/NavigationDecisionTests.swift',
  'macos/Tests/DSHChamberTests/NotifyRouteTests.swift',
  'macos/Tests/DSHChamberTests/PackagedLayoutTests.swift',
  'macos/Tests/DSHChamberTests/PageFactsReconcileGuardTests.swift',
  'macos/Tests/DSHChamberTests/PrivateFSTests.swift',
  'macos/Tests/DSHChamberTests/QuitCoordinatorTests.swift',
  'macos/Tests/DSHChamberTests/RecoveryChoicesTests.swift',
  'macos/Tests/DSHChamberTests/RefreshRatePolicyTests.swift',
  'macos/Tests/DSHChamberTests/RendererHangWatchdogTests.swift',
  'macos/Tests/DSHChamberTests/RendererRecoveryTests.swift',
  'macos/Tests/DSHChamberTests/RollingWindowLimiterTests.swift',
  'macos/Tests/DSHChamberTests/RuntimeRecoveryTests.swift',
  'macos/Tests/DSHChamberTests/ShellIdentityTests.swift',
  'macos/Tests/DSHChamberTests/ShellLogTests.swift',
  'macos/Tests/DSHChamberTests/ShellPageFactsTests.swift',
  'macos/Tests/DSHChamberTests/ShellPerfTests.swift',
  'macos/Tests/DSHChamberTests/ShellStartupTests.swift',
  'macos/Tests/DSHChamberTests/ShellWindowChromeTests.swift',
  'macos/Tests/DSHChamberTests/ShellWindowDragTests.swift',
  'macos/Tests/DSHChamberTests/SidecarExitCodeLockstepTests.swift',
  'macos/Tests/DSHChamberTests/SidecarStartupFailureTests.swift',
  'macos/Tests/DSHChamberTests/SidecarSupervisorTests.swift',
  'macos/Tests/DSHChamberTests/StartupLoadRetryTests.swift',
  'macos/Tests/DSHChamberTests/StartupRecoveryTests.swift',
  'macos/Tests/DSHChamberTests/StatusItemIconTests.swift',
  'macos/Tests/DSHChamberTests/StrictJSONNumberTests.swift',
  'macos/Tests/DSHChamberTests/SwiftEdgeHostLegsTests.swift',
  'macos/Tests/DSHChamberTests/ThemedBackgroundTests.swift',
  'macos/Tests/DSHChamberTests/TrustGuardTests.swift',
  'macos/Tests/DSHChamberTests/UpdateAvailabilityTests.swift',
  'macos/Tests/DSHChamberTests/UpdateStallWatchdogTests.swift',
  'macos/Tests/DSHChamberTests/WebKitSupportKVCTests.swift',
  'macos/Tests/DSHChamberTests/WebPermissionPolicyTests.swift',
  'macos/Tests/DSHChamberTests/ZoomPersistenceTests.swift',
]

/**
 * 合法零用例文件的出口（与 test.mjs 的 ZERO_TEST_ALLOWLIST 同纪律）：当前语料
 * 每个 `*Tests.swift` 都至少有 1 个 XCTest 用例，因此列表为空。要加条目必须
 * 写明「为什么它可以零用例」；文件消失或重新有用例时条目本身即红（stale 即红），
 * 绝不拿它给停跑的测试打掩护。
 * @type {readonly { file: string, reason: string }[]}
 */
export const SWIFT_ZERO_TEST_ALLOWLIST = []

/**
 * 数一个 Swift 源文件里的 XCTest 用例函数（`func test…(`，允许 async/throws 与
 * @MainActor/@available 等属性前缀）。不认 swift-testing 的 `@Test`：套件是
 * XCTest-only，且 parseSwiftTestReport 只把 XCTest 汇总当判据——把 @Test 也算进
 * 来会让「文件有用例但根本没被执行」重新变成绿灯。
 * @param {string} source - Swift 源文本。
 * @returns {number} 用例函数数。
 */
export function countSwiftTestFunctions(source) {
  // 先剥注释：把用例函数整段注释掉（"禁用"一个测试的常见做法）必须算 0 个用例，
  // 否则删空文件的检查会被一行 `// func testX()` 骗过去。
  const text = (typeof source === 'string' ? source : '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  // 名字规则与 XCTest 的发现一致：`test` 后必须是大写/数字/下划线或直接左括号，
  // 因此 `testingHelper` 这类助手不会被误当成用例（否则删空检查会被一个助手名骗过）。
  return [...text.matchAll(/^[ \t]*(?:@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?[ \t]+)*func[ \t]+test(?:[A-Z0-9_][A-Za-z0-9_]*)?[ \t]*\(/gmu)].length
}

/**
 * 枚举目录下所有 .swift 文件（相对该目录、'/' 分隔、排序）。
 * @param {string} root - 目录绝对路径。
 * @returns {string[] | null} 文件名列表；目录不存在 → null（调用方区分
 *   「--dry-run 不要求完整 checkout」与「真跑时语料目录都不见了」）。
 */
export function collectSwiftTestFiles(root) {
  if (!existsSync(root)) return null
  const found = []
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.swift')) found.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  found.sort()
  return found
}

/**
 * 清单引脚判据（纯函数，注入语料事实即可单测）：
 *  1. 清单登记的每个文件必须存在（删文件/改名 = 红）；
 *  2. 清单登记的每个文件必须有 ≥1 个 XCTest 用例（删空 = 红）；
 *  3. 盘上每个 `*Tests.swift` 必须有 ≥1 个用例——清单外的新文件同样受约束，
 *     「新增一个空文件」不能成为绕过零测试守卫的后门；
 *  4. SWIFT_ZERO_TEST_ALLOWLIST 每条都要在盘上且仍需零用例（stale 即红）；
 *  5. 语料集为空 = 红（"executed > 0" 在整目录消失时也可能被别的汇总骗过）。
 * @param {object} input - 语料事实。
 * @param {readonly string[]} input.listed - 清单（仓库根相对）。
 * @param {readonly string[]} input.onDisk - 盘上 .swift 文件（仓库根相对）。
 * @param {(file: string) => number} input.testFunctions - 仓库根相对路径 → 用例数。
 * @param {readonly { file: string, reason: string }[]} [input.zeroAllowlist] - 零用例出口。
 * @returns {string[]} 问题列表（空 = 通过）。
 */
export function swiftTestCorpusProblems({
  listed,
  onDisk,
  testFunctions,
  zeroAllowlist = SWIFT_ZERO_TEST_ALLOWLIST,
}) {
  const problems = []
  const seen = new Set()
  for (const file of listed) {
    if (seen.has(file)) {
      problems.push(`manifest lists ${file} twice — one entry per test file`)
      continue
    }
    seen.add(file)
    if (!onDisk.includes(file)) {
      problems.push(`manifest lists ${file} but the file is gone (deleted or renamed?) — a vanished test file must not stay green`)
      continue
    }
    if (testFunctions(file) === 0) {
      problems.push(`${file} is listed but carries no XCTest case ("func test…(") — an emptied test file must not stay green`)
    }
  }
  for (const file of onDisk) {
    if (!file.endsWith('Tests.swift')) continue
    if (testFunctions(file) > 0) continue
    if (zeroAllowlist.some((entry) => entry.file === file)) continue
    problems.push(`${file} carries no XCTest case — every on-disk *Tests.swift must keep at least one (add it to SWIFT_ZERO_TEST_ALLOWLIST with a reason if it legitimately has none)`)
  }
  for (const entry of zeroAllowlist) {
    if (!onDisk.includes(entry.file)) {
      problems.push(`SWIFT_ZERO_TEST_ALLOWLIST lists ${entry.file} but the file is gone — drop the entry`)
      continue
    }
    if (testFunctions(entry.file) > 0) {
      problems.push(`SWIFT_ZERO_TEST_ALLOWLIST lists ${entry.file} but it now carries cases — drop the stale entry`)
    }
    if (typeof entry.reason !== 'string' || entry.reason === '') {
      problems.push(`SWIFT_ZERO_TEST_ALLOWLIST entry ${entry.file} needs a reason`)
    }
  }
  if (onDisk.length === 0) {
    problems.push(`${SWIFT_TESTS_ROOT} has no .swift test file at all — the Swift suite cannot have real coverage`)
  }
  return problems
}

/**
 * 对真实仓库跑一次清单引脚（读取每个文件的用例数）。
 * @param {string} [root] - 测试根目录绝对路径。
 * @returns {{ files: number, listed: number, problems: string[] } | null} 报告；
 *   语料目录缺席 → null（由调用方按 dry-run/真跑分别定性）。
 */
export function judgeSwiftTestCorpus(root = resolve(REPO_ROOT, SWIFT_TESTS_ROOT)) {
  const onDisk = collectSwiftTestFiles(root)
  if (onDisk === null) return null
  const absolute = onDisk.map((name) => `${SWIFT_TESTS_ROOT}/${name}`)
  const testFunctions = (file) => countSwiftTestFunctions(readFileSync(resolve(REPO_ROOT, file), 'utf8'))
  return {
    files: absolute.length,
    listed: SWIFT_TEST_MANIFEST.length,
    problems: swiftTestCorpusProblems({
      listed: SWIFT_TEST_MANIFEST,
      onDisk: absolute,
      testFunctions,
    }),
  }
}

/**
 * The `swift test` argv this runner always uses: release configuration, so the
 * shipped build configuration is what gets executed.
 * @param {string} [packagePath] - package path relative to the repository root.
 * @returns {string[]} argv after the `swift` executable.
 */
export function swiftTestArgs(packagePath = SWIFT_PACKAGE_PATH) {
  return ['test', '--package-path', packagePath, '-c', 'release', '--disable-sandbox']
}

/**
 * Environment for the swift child: the caller's environment plus a DSH_CHAMBER_SHELL_NODE_BIN
 * default. An explicitly configured value is never overwritten.
 * @param {NodeJS.ProcessEnv} env - the parent environment.
 * @param {string} nodeExecPath - value to use when DSH_CHAMBER_SHELL_NODE_BIN is absent/empty.
 * @returns {NodeJS.ProcessEnv} child environment.
 */
export function swiftTestEnvironment(env = process.env, nodeExecPath = process.execPath) {
  const child = { ...env }
  const configured = child[NODE_BIN_ENV]
  if (typeof configured !== 'string' || configured === '') child[NODE_BIN_ENV] = nodeExecPath
  for (const { env: name, path } of SWIFT_SCRATCH_DIRS) {
    const current = child[name]
    if (typeof current === 'string' && current !== '') continue
    const dir = resolve(REPO_ROOT, path)
    mkdirSync(dir, { recursive: true })
    child[name] = dir.endsWith('/') ? dir : `${dir}/`
  }
  return child
}

/**
 * Parse an XCTest transcript: the LAST "Executed N tests, with M failures"
 * summary is the run total (the per-suite summaries come first), and every
 * `Test Case ... skipped (` line is an XCTSkip.
 *
 * The swift-testing footer (`Test run with 0 tests ...`) is deliberately not
 * treated as a summary: the chamber suite is XCTest-only, and accepting an
 * empty swift-testing run would let a vanished XCTest corpus pass.
 * @param {string} output - combined child stdout + stderr.
 * @returns {{ executed: number | null, failures: number | null, skipped: number }} parsed totals.
 */
export function parseSwiftTestReport(output) {
  const text = typeof output === 'string' ? output : ''
  let executed = null
  let failures = null
  for (const match of text.matchAll(/Executed (\d+) tests?, with (\d+) failures? \(/gu)) {
    executed = Number(match[1])
    failures = Number(match[2])
  }
  const skipped = [...text.matchAll(/^\s*Test Case '.*?' skipped \(/gmu)].length
  return { executed, failures, skipped }
}

/**
 * Judge one parsed report. A run with no summary, zero executed cases, any
 * failure, or any skipped case does not pass.
 * @param {{ executed: number | null, failures: number | null, skipped: number }} report - parsed totals.
 * @returns {{ ok: true } | { ok: false, reason: string }} verdict.
 */
export function judgeSwiftTestReport(report) {
  if (report.executed === null) {
    return { ok: false, reason: 'no XCTest summary ("Executed N tests") — the Swift suite did not run' }
  }
  if (report.executed === 0) {
    return { ok: false, reason: 'XCTest executed 0 tests — an empty Swift suite has not passed' }
  }
  if ((report.failures ?? 0) > 0) {
    return { ok: false, reason: `XCTest reported ${report.failures} failure(s)` }
  }
  if (report.skipped > 0) {
    return { ok: false, reason: `XCTSkip count is ${report.skipped}, must be 0 (a skipped integration case must fail the macOS leg)` }
  }
  return { ok: true }
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const args = swiftTestArgs()
  // 语料清单引脚先于任何 swift 调用：删掉/删空一个测试文件必须在这里就红，
  // 而不是被其余用例的汇总行掩盖（"executed > 0" 只证明还有别的用例在跑）。
  const corpus = judgeSwiftTestCorpus()
  if (corpus === null) {
    // --dry-run 只打印命令，不要求完整 checkout；真跑时连语料目录都不见是
    // 装配面损坏，必须 loud（而不是让 swift test 去报一句无关的错）。
    if (!dryRun) {
      console.error(`run-swift-tests: ${SWIFT_TESTS_ROOT} not found (run from a full checkout)`)
      return 1
    }
  } else if (corpus.problems.length > 0) {
    for (const problem of corpus.problems) console.error('run-swift-tests: ' + problem)
    return 1
  }
  if (dryRun) {
    if (corpus !== null) {
      console.log(`run-swift-tests: corpus pin passed — ${corpus.listed} manifest file(s) ⊆ ${corpus.files} on-disk .swift file(s), every *Tests.swift has ≥1 XCTest case`)
    }
    console.log('run-swift-tests: swift ' + args.join(' '))
    return 0
  }
  if (!existsSync(resolve(REPO_ROOT, SWIFT_PACKAGE_PATH, 'Package.swift'))) {
    console.error(`run-swift-tests: ${SWIFT_PACKAGE_PATH}/Package.swift not found (run from a full checkout)`)
    return 1
  }
  const result = spawnSync('swift', args, {
    cwd: REPO_ROOT,
    env: swiftTestEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (typeof result.stdout === 'string') process.stdout.write(result.stdout)
  if (typeof result.stderr === 'string') process.stderr.write(result.stderr)
  if (result.error !== undefined) {
    console.error('run-swift-tests: could not spawn swift: ' + result.error.message)
    return 1
  }
  if (result.status !== 0) {
    console.error(`run-swift-tests: swift test exited ${String(result.status ?? 'signal ' + String(result.signal))}`)
    return 1
  }
  const report = parseSwiftTestReport((result.stdout ?? '') + '\n' + (result.stderr ?? ''))
  const verdict = judgeSwiftTestReport(report)
  if (!verdict.ok) {
    console.error('run-swift-tests: ' + verdict.reason)
    return 1
  }
  console.log(
    `run-swift-tests: release suite passed — ${report.executed} executed, 0 failures, 0 skipped`,
  )
  return 0
}

const isEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
// process.exit 会丢掉管道尾部（runner 自己的摘要行）；用 exitCode 让事件循环自然退出。
if (isEntry) process.exitCode = main()
