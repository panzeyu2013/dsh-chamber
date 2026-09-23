/**
 * Single gate entry for local development: the repository's `test:*`,
 * `typecheck:*` and `verify:*` scripts are grouped into named modes so "which
 * checks do I run" is one command instead of a list recalled from CI YAML.
 *
 * The `tests` / `typecheck` modes are the same sets `.github/workflows/ci.yml`
 * invokes; when a package's script is added or renamed, update the mode here and
 * `pnpm run test:release-workflow` keeps the release path aligned (the policy
 * test derives the push path's gates from ci.yml and requires release
 * validation to run them).
 *
 * A step is normally a package script name (`pnpm run <step>`). Two executed-
 * assembly gates (the compiled-sidecar smoke and the compiled Electron
 * artifacts smoke) have no root package.json alias on purpose — one is
 * a script under scripts/gates/ — so a step may also be written as an explicit
 * command line: `node <script> [args]` or `pnpm <args>`. Both forms are
 * spawned directly by this runner; nothing is interpreted by a shell.
 *
 * Usage:
 *   node scripts/gates/run-checks.mjs <static|tests|typecheck|full>
 *   node scripts/gates/run-checks.mjs <mode> --list     # print the plan, run nothing
 *   node scripts/gates/run-checks.mjs <mode> --continue # keep going after a failure
 *
 * Artifact pre-step: the untracked build artifacts
 * (dsh-runtime / the four seed packages / the mobile dist+lib) are ensured
 * before a mode runs. tests/typecheck/full build the missing ones
 * (`pnpm run build:artifacts`); static is read-only and fails loudly with that
 * command instead — a clean checkout bootstraps itself, and no mode silently
 * skips a gate because an artifact was absent.
 *
 * Exit status is 1 when any step fails (or when a mode resolves to no steps: a
 * mode that runs nothing has not passed).
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureArtifacts } from '../dev/ensure-artifacts.mjs'

/** Package test suites, in the order the CI job runs them. */
const PACKAGE_TESTS = [
  'test:runtime',
  'test:control-plane',
  'test:api-gateway',
  // Pure lifecycle reducers: no deps, no artifacts, so a
  // structural break in the shared model fails first and names itself.
  'test:stream-state',
  'test:desktop',
  'test:gateway',
  'test:renderer-shell',
  'test:sidebar',
  'test:layout',
  'test:git',
  'test:host-git',
  'test:host-archive-cleanup',
  'test:host-open-in',
  'test:settings-bridge',
  'test:connections',
  'test:client-web',
  'test:connection',
  'test:open-in',
  'test:mobile',
  'test:cli',
]

/**
 * Compiler faces checked on every push. `typecheck` is the ROOT program
 * (tsconfig.json: control-plane / cli / renderer / desktop / gateway sources).
 * It runs first, matching ci.yml: local `check:typecheck` could otherwise be green while the root
 * program regressed.
 */
const CLIENT_TYPECHECKS = [
  'typecheck',
  'typecheck:sidebar',
  'typecheck:git',
  'typecheck:layout',
  'typecheck:connections',
  'typecheck:settings-bridge',
  'typecheck:client-web',
  'typecheck:connection',
  'typecheck:api-gateway',
  'typecheck:stream-state',
  'typecheck:open-in',
  'typecheck:mobile',
]

/**
 * macOS/Swift-only leg: `test:swift` is the XCTest suite (run-swift-tests.mjs
 * pins `-c release` and fails on any XCTSkip), `test:macos` runs the
 * darwin O_EXLOCK lock assertions and the two packaging-script suites
 * (plutil/codesign/ditto/hdiutil + the SwiftPM .build output). Both are
 * appended only on darwin — never on the ubuntu test job / release validation.
 * The CI entry point is ci.yml's test-macos job; a local `check:tests` on
 * darwin needs `pnpm run build:control-plane` first (the packaging suites read
 * dist/control-plane). `test:swift` runs first so its release build satisfies
 * the packaging suite's `.build/release` precondition.
 *
 * The same leg also carries the executed-assembly gates ci.yml's
 * test-macos job runs — the compiled sidecar smoke (the shipped sidecar.js
 * boots, DSH_CHAMBER_SIDECAR_COMPILED=1 so a missing assembly is a hard
 * failure), the native acceptance (the sidecar the packaged Swift shell spawns
 * launches and serves; `--require-assembly` turns the loud SKIP into a FAIL,
 * so deleting the build step cannot turn this gate green), and the compiled
 * Electron artifacts smoke (control-plane boot + frozen preload surface). The
 * sidecar assembly is built here exactly as ci.yml builds it
 * (--skip-node/--skip-vendor/--skip-host-packages) so the mode is
 * self-contained; the Electron gate needs build:preload because a
 * control-plane-only tree is the partial build that gate refuses by design.
 */
const MACOS_CHECKS = process.platform === 'darwin' ? [
  'test:swift',
  'test:macos',
  'pnpm run build:sidecar --skip-node --skip-vendor --skip-host-packages',
  'test:sidecar:compiled',
  'node scripts/gui-acceptance/run.mjs --flavor native --require-assembly',
  'pnpm --filter @dsh-chamber/desktop run build:preload',
  'node scripts/gates/verify-electron-artifacts.mjs',
] : []

/** Repository-level policy and documentation gates. */
const STATIC_CHECKS = [
  'verify:i18n',
  'verify:styles',
  'verify:workflows',
  'verify:workflow-yaml',
  'verify:test-wiring',
  'verify:shim-payload',
  'verify:md-links',
  'verify:registry',
  'verify:anchors',
  // C1–C15 触点门：advisory 模式（只读，不重建产物）。必须是普通门——
  // 否则本地 static/full 可以在 C1/C3 失败（例如把 pure 文件挪进 patched）时全绿，
  // 与 AGENTS "本地 pass = CI 同证据" 的口径矛盾。CI 两处直接调用同一命令。
  'node scripts/upstream/verify-upstream-touchpoints.mjs --no-artifact-rebuild',
  // 远端完成未读/切源的故障注入矩阵：快、离线、自带 --self-test 负控。
  'node scripts/gates/remote-state-injection-matrix.mjs',
  // 差分回放：把旧路轨迹与新 reducer 的 effects 对着 vectors.json 比一遍。
  // 纯 node、无依赖、离线，故属 static；drift≠0 即红（差异必须在 DIVERGENCE.md 登记）。
  'node scripts/refactor/equivalence.mjs',
  // Stream-state 的 Swift 镜像锁步：编译 Foundation-only 的
  // packages/dsh-stream-state/swift/CarrierDecision.swift 并对着共享 tables.json 断言。
  // 只读、离线、临时目录内编译（不写工作树），故属 static 模式；
  // 负控：node scripts/... --simulate-skip 会明确打印 SKIP。
  'node scripts/gates/verify-stream-state-swift-parity.mjs',
  // 四条恢复阶梯的阈值锁步——值记在共享 tables.json，仍各自持有常量的模块
  // 由本门逐个比对（漂移即红；模块删掉常量正是退役，不算失败）。
  // 只读、离线、无依赖，故属 static 模式。
  'node scripts/gates/verify-ladder-table-parity.mjs',
  // G-H 死面扫描：遍历工作区全部 packages/*/src/index.ts，每个运行时导出必须有一个
  // 生产 importer，否则红；显式豁免必须带理由且不得过期。运行期装载包（dsh loader /
  // client-plugin loader）单列理由不做判定；待收窄包按 PENDING_PACKAGES（owner + 退役
  // 阶段）抑制并打印，名单僵尸即红。当前全绿且名单为空（client-core 桶已收敛为生产面）。
  'verify:no-dead-exports',
  'verify:upstream-lifecycle-contract',
  // 包边界门（R4 P7）：生产面禁跨包相对 import（vendor 直穿按 registry 放行）+
  // exports 面白名单。只读、离线、自带 --self-test 负控；新增门同时登记在根
  // package.json 与 ci.yml 的 static 腿（static-gate-parity 双向校验）。
  'verify:package-boundaries',
  'test:scripts',
]

/**
 * Modes whose steps consume the untracked build artifacts (scripts/dev/
 * ensure-artifacts.mjs). `tests`/`typecheck`/`full` self-bootstrap: the
 * pre-step builds what is missing before any step runs. `static` is the
 * read-only gate set — it must NEVER write the working tree, so a missing
 * artifact is a loud failure that names `pnpm run build:artifacts` instead of a
 * silent skip or a hidden rebuild.
 */
export const ARTIFACT_MODES = new Set(['static', 'typecheck', 'tests', 'full'])

/** Named gate groups. Keep the names disjoint from script names to avoid confusion. */
export const MODES = {
  static: STATIC_CHECKS,
  tests: [...PACKAGE_TESTS, 'node scripts/gates/verify-artifact-freshness.mjs', ...MACOS_CHECKS],
  typecheck: CLIENT_TYPECHECKS,
  full: [...STATIC_CHECKS, ...CLIENT_TYPECHECKS, ...PACKAGE_TESTS, 'node scripts/gates/verify-artifact-freshness.mjs', ...MACOS_CHECKS],
}

/**
 * Resolve the pnpm invocation used for one step.
 * @returns {{ command: string, prefix: string[] }} executable and leading args.
 */
export function pnpmInvocation() {
  const execPath = process.env.npm_execpath
  if (execPath !== undefined && execPath !== '') {
    return { command: process.execPath, prefix: [execPath] }
  }
  return { command: 'pnpm', prefix: [] }
}

/**
 * Read the mode requested on the command line.
 * @param {string[]} argv - process arguments.
 * @returns {string | undefined} mode name, or undefined when absent/unknown.
 */
export function requestedMode(argv) {
  const name = argv.find(argument => !argument.startsWith('-'))
  return name !== undefined && Object.hasOwn(MODES, name) ? name : undefined
}

/**
 * Resolve one mode step to an executable invocation. A step is either a
 * package script name (the default: `pnpm run <step>`) or an explicit command
 * line for a gate without a root package.json alias (`node <script> [args]` or
 * `pnpm <args>`); nothing is passed through a shell, so the tokens are split on
 * whitespace and no quoting is honoured — the entries in this file are
 * constants, not user input.
 * @param {string} step - one MODES entry.
 * @param {{ command: string, prefix: string[] }} [pnpm] - the pnpm invocation.
 * @returns {{ command: string, args: string[], display: string }} invocation.
 */
export function stepInvocation(step, pnpm = pnpmInvocation()) {
  if (step.startsWith('node ')) {
    return {
      command: process.execPath,
      args: step.slice('node '.length).trim().split(/\s+/u),
      display: step,
    }
  }
  if (step.startsWith('pnpm ')) {
    return {
      command: pnpm.command,
      args: [...pnpm.prefix, ...step.slice('pnpm '.length).trim().split(/\s+/u)],
      display: step,
    }
  }
  return { command: pnpm.command, args: [...pnpm.prefix, 'run', step], display: `pnpm run ${step}` }
}

/**
 * Run one mode's steps in order.
 * @param {string} mode - mode name present in {@link MODES}.
 * @param {{ list?: boolean, keepGoing?: boolean, log?: (line: string) => void, ensureArtifacts?: typeof ensureArtifacts }} [options] - behaviour overrides.
 * @returns {{ failed: string[], ran: number }} outcome.
 */
export function runMode(mode, options = {}) {
  const log = options.log ?? ((line) => { console.log(line) })
  const steps = MODES[mode]
  if (steps === undefined || steps.length === 0) return { failed: [`mode ${mode} has no steps`], ran: 0 }
  const pnpm = pnpmInvocation()
  if (options.list === true) {
    log(`run-checks ${mode}: ${steps.length} step(s)`)
    for (const step of steps) log(`  - ${stepInvocation(step, pnpm).display}`)
    return { failed: [], ran: 0 }
  }
  // Artifact pre-step: tests/typecheck/full build what is missing, static only
  // reports. Must stay after the --list early return (listing runs nothing).
  if (ARTIFACT_MODES.has(mode)) {
    const ensure = options.ensureArtifacts ?? ensureArtifacts
    const verdict = ensure({ build: mode !== 'static', log })
    if (!verdict.ok) {
      log(`run-checks: ${mode} 需要构建期产物且缺失 ${verdict.missing.length} 个——先跑 pnpm run build:artifacts`
        + (mode === 'static' && verdict.built === false ? '（static 只读，不自动构建）' : ''))
      return { failed: [`ensure-artifacts (${verdict.missing.length} missing)`], ran: 0 }
    }
  }
  const failed = []
  let ran = 0
  for (const step of steps) {
    const invocation = stepInvocation(step, pnpm)
    log(`\n=== ${invocation.display} ===`)
    const result = spawnSync(invocation.command, invocation.args, { stdio: 'inherit' })
    ran += 1
    if (result.status !== 0) {
      failed.push(step)
      log(`run-checks: ${step} FAILED (exit ${String(result.status ?? 'signal')})`)
      if (options.keepGoing !== true) break
    }
  }
  return { failed, ran }
}

function main() {
  const mode = requestedMode(process.argv.slice(2))
  if (mode === undefined) {
    console.error(`run-checks: expected one of ${Object.keys(MODES).join(', ')}`)
    console.error('  node scripts/gates/run-checks.mjs <mode> [--list] [--continue]')
    process.exit(2)
  }
  const { failed, ran } = runMode(mode, {
    list: process.argv.includes('--list'),
    keepGoing: process.argv.includes('--continue'),
  })
  if (failed.length > 0) {
    console.error(`\nrun-checks ${mode}: ${failed.length} of ${ran} step(s) failed: ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log(`\nrun-checks ${mode}: ${ran} step(s) passed`)
}

/** 入口判定：realpath 双侧比较（符号链接绝对路径调用时不静默 no-op）。 */
const isEntry = (() => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isEntry) main()
