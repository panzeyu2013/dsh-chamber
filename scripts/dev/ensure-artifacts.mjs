#!/usr/bin/env node
/**
 * ensure-artifacts.mjs — 构建期产物自举（2026-12「产物移出 git」改造）。
 *
 * 这些产物以前 tracked 进仓，靠「提交物 + freshness 门」保鲜；现在改为构建期
 * 生成、不入 git，因此 clean checkout 必须能自举。清单就是 C8（scripts/upstream/
 * verify-upstream-touchpoints.mjs）覆盖的同一组产物：
 *   - packages/dsh-runtime/dist/index.js
 *   - packages/dsh-chamber-seed-{client-graph,git-worktree,archive-cleanup,open-in}/dist/index.js
 *   - packages/dsh-chamber-client-ui-mobile/{dist/index.js,lib/index.js,lib/client.js,lib/client.js.map}
 *
 * 契约：
 *   - 默认（ensure）——缺产物就打印清单并执行 `pnpm run build:artifacts`；构建
 *     失败或构建后仍缺件 ⇒ exit 1（绝不静默放行）。
 *   - --check —— 只检查不构建；缺件时 exit 1 并指明 `pnpm run build:artifacts`。
 *     供 run-checks static 模式使用：static 是纯只读门，缺产物必须 loud fail，
 *     而不是替操作者把工作树写脏。
 *
 * 产物路径固定相对仓库根解析（脚本自身位置），与调用者 cwd 无关；被
 * scripts/gates/run-checks.mjs 以 ES module import 复用纯函数，入口判定保证
 * import 不触发构建。
 *
 * Usage:
 *   node scripts/dev/ensure-artifacts.mjs           # ensure（缺则构建）
 *   node scripts/dev/ensure-artifacts.mjs --check   # 只检查不构建
 * Exit codes: 0 齐全（或已构建） · 1 缺件/构建失败。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, derived from this file's own location (never the caller CWD). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Aggregate build command that produces every artifact below. */
export const BUILD_ARTIFACTS_COMMAND = 'pnpm run build:artifacts'

/**
 * The untracked build artifacts a clean checkout must materialize, in build
 * order. `build` is the narrow command that produces one artifact; the
 * aggregate {@link BUILD_ARTIFACTS_COMMAND} produces all of them.
 * @type {readonly { id: string, path: string, build: string }[]}
 */
export const ARTIFACTS = [
  { id: 'dsh-runtime/dist/index.js', path: 'packages/dsh-runtime/dist/index.js', build: 'pnpm run build:dsh-runtime' },
  { id: 'seed-client-graph/dist/index.js', path: 'packages/dsh-chamber-seed-client-graph/dist/index.js', build: 'pnpm run build:host-graph' },
  { id: 'seed-git-worktree/dist/index.js', path: 'packages/dsh-chamber-seed-git-worktree/dist/index.js', build: 'pnpm run build:host-git' },
  { id: 'seed-archive-cleanup/dist/index.js', path: 'packages/dsh-chamber-seed-archive-cleanup/dist/index.js', build: 'pnpm run build:host-archive-cleanup' },
  { id: 'seed-open-in/dist/index.js', path: 'packages/dsh-chamber-seed-open-in/dist/index.js', build: 'pnpm run build:host-open-in' },
  { id: 'mobile/dist/index.js', path: 'packages/dsh-chamber-client-ui-mobile/dist/index.js', build: 'pnpm run build:mobile' },
  { id: 'mobile/lib/index.js', path: 'packages/dsh-chamber-client-ui-mobile/lib/index.js', build: 'pnpm run build:mobile' },
  { id: 'mobile/lib/client.js', path: 'packages/dsh-chamber-client-ui-mobile/lib/client.js', build: 'pnpm run build:mobile' },
  { id: 'mobile/lib/client.js.map', path: 'packages/dsh-chamber-client-ui-mobile/lib/client.js.map', build: 'pnpm run build:mobile' },
]

/**
 * Which artifacts are absent under `repoRoot`.
 * @param {string} [repoRoot] - repository root (defaults to this checkout).
 * @returns {{ id: string, path: string, build: string }[]} missing entries, manifest order.
 */
export function missingArtifacts(repoRoot = REPO_ROOT) {
  return ARTIFACTS.filter(artifact => !existsSync(join(repoRoot, artifact.path)))
}

/**
 * Render the loud missing-artifact report: every missing id + path, its narrow
 * build command and the aggregate one. Always names the aggregate command so an
 * operator has one copy-pasteable fix.
 * @param {readonly { id: string, path: string, build: string }[]} missing - {@link missingArtifacts} output.
 * @returns {string[]} report lines (without a trailing newline).
 */
export function formatMissingArtifacts(missing) {
  const lines = ['[ensure-artifacts] 缺失 ' + missing.length + ' 个构建期产物（这些产物已不入 git，clean checkout 需自举）：']
  for (const artifact of missing) {
    lines.push('  - ' + artifact.id + '  →  ' + artifact.build)
  }
  lines.push('  一键构建全部：' + BUILD_ARTIFACTS_COMMAND)
  return lines
}

/** Resolve the pnpm invocation used for the build (same rule as run-checks.mjs). */
export function pnpmInvocation() {
  const execPath = process.env.npm_execpath
  if (execPath !== undefined && execPath !== '') {
    return { command: process.execPath, prefix: [execPath] }
  }
  return { command: 'pnpm', prefix: [] }
}

/**
 * Run the aggregate artifact build. Inherited stdio so the package builders'
 * output stays visible; never throws on a non-zero child exit.
 * @param {{ repoRoot?: string, log?: (line: string) => void }} [options] - overrides.
 * @returns {number} child exit status (or 1 when the child was killed by a signal).
 */
export function runBuildArtifacts({ repoRoot = REPO_ROOT, log = (line) => { console.log(line) } } = {}) {
  const pnpm = pnpmInvocation()
  log('')
  log('[ensure-artifacts] 执行 ' + BUILD_ARTIFACTS_COMMAND + ' …')
  const result = spawnSync(pnpm.command, [...pnpm.prefix, 'run', 'build:artifacts'], { cwd: repoRoot, stdio: 'inherit' })
  return result.status === null ? 1 : result.status
}

/**
 * Ensure every artifact exists, optionally building the missing ones.
 * @param {{ repoRoot?: string, build?: boolean, log?: (line: string) => void }} [options] - overrides.
 * @returns {{ ok: boolean, missing: { id: string, path: string, build: string }[], built: boolean }} verdict;
 *   `missing` is what is still absent after the attempt.
 */
export function ensureArtifacts({ repoRoot = REPO_ROOT, build = true, log = (line) => { console.log(line) } } = {}) {
  const before = missingArtifacts(repoRoot)
  if (before.length === 0) {
    log('[ensure-artifacts] ' + ARTIFACTS.length + ' 个构建期产物齐全')
    return { ok: true, missing: [], built: false }
  }
  for (const line of formatMissingArtifacts(before)) log(line)
  if (!build) return { ok: false, missing: before, built: false }
  const status = runBuildArtifacts({ repoRoot, log })
  const after = missingArtifacts(repoRoot)
  if (status !== 0) {
    log('[ensure-artifacts] ' + BUILD_ARTIFACTS_COMMAND + ' 失败（exit ' + status + '）')
    return { ok: false, missing: after.length > 0 ? after : before, built: false }
  }
  if (after.length > 0) {
    for (const line of formatMissingArtifacts(after)) log(line)
    log('[ensure-artifacts] 构建报告成功但产物仍缺失——构建脚本与其输出清单不一致')
    return { ok: false, missing: after, built: true }
  }
  log('[ensure-artifacts] 已构建 ' + before.length + ' 个产物')
  return { ok: true, missing: [], built: true }
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const verdict = ensureArtifacts({ build: !checkOnly })
  if (!verdict.ok) {
    if (checkOnly) {
      console.error('[ensure-artifacts] --check 失败：产物缺失（先跑 ' + BUILD_ARTIFACTS_COMMAND + '；或直接跑 pnpm run check:typecheck / check:tests 让其自举）')
    }
    process.exit(1)
  }
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main()
