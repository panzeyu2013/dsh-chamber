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
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (this file lives in scripts/gates/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Explicit node override consumed by the Swift integration tests. */
export const NODE_BIN_ENV = 'DSH_CHAMBER_SHELL_NODE_BIN'

/** Swift package path relative to the repository root. */
export const SWIFT_PACKAGE_PATH = 'macos'

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
  if (dryRun) {
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
