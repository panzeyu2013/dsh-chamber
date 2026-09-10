#!/usr/bin/env node
/**
 * 升级前「pin 预检」——在动 pin **之前**给出重放清单（只读、不改任何文件）。
 *
 * 背景（2026-09 复盘）：0.1.5 升级是在改完 pin 之后才发现 upstream 重构了
 * ui-layout 的三栏模型（`DETAILS_*` 消失、`details` → `rightbar`），chamber 的
 * layout fork 因此立刻编译失败——属于「先动手、后发现问题」。本脚本把这一步
 * 提前：对目标 tag 与当前 pin 做只读 diff，直接回答三个问题：
 *
 *   1. **三个 fork 副本**里哪些文件变了，且各自的处置类别（pure 面 = 直接照抄；
 *      patched/own 面 = 需要人工重放）；
 *   2. **chamber 深引的 vendor 文件**（`@deepseek-ai/<pkg>/src/...`）是否变化
 *      ——这是 0.1.5 踩到的类别（layout fork 直接 import vendor 的
 *      `AppFrame.tsx`/`columns.ts`/`service.ts`）；
 *   3. **上游包集合变化**（新增/移除）与新增的 **client 行**（带 `dsh.client`
 *      元数据的包 → roster/covered 决策），以及运行时版本是否已发布 npm。
 *
 * 用法：
 *   node scripts/dev/preflight-vendor-pin.mjs dsh-v0.1.5-alpha.1 [--offline] [--fail-on-replay]
 *   node scripts/dev/preflight-vendor-pin.mjs <tag> --json
 *
 * 退出码：默认 0（advisory）；`--fail-on-replay` 时若存在需人工重放项则 1。
 * 只依赖内置模块 + git（+ 可选 npm view）；不写工作树、不动 submodule 的 HEAD
 * （`git diff` 只读对象库；若 tag 对象不在本地会提示 fetch 命令而不自动 fetch）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SUBMODULE = path.join(ROOT, 'vendor', 'harness-checkout')

/** 三个 fork 副本：目录名 == 上游包名（vendor 路径 → 本仓副本路径）。 */
export const FORK_PATHS = [
  { upstream: 'packages/client/connection', fork: 'packages/dsh-client-connection' },
  { upstream: 'packages/client/web', fork: 'packages/dsh-client-web' },
  { upstream: 'packages/api/gateway', fork: 'packages/dsh-api-gateway' },
]

/** 从 harness.commit 文本解析 pin（跳过注释/空行，取最后一行）。 */
export function parsePin(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
  return lines.length === 0 ? null : lines[lines.length - 1]
}

/**
 * 把一个上游变更路径分类：
 * - `fork-pure`    → 本仓副本该文件与旧 pin 字节一致（直接照抄）；
 * - `fork-replay`  → 本仓副本该文件带补丁（人工重放）；
 * - `fork-missing` → 上游有、本仓副本没有（dropped 面，通常无需动作）；
 * - `vendor-seam`  → 非 fork 路径，但被 chamber 源码深引（seam 风险）；
 * - `other`        → 其余（一般忽略）。
 * @param relPath - 相对上游仓库根的路径。
 * @param isPure - 判定器：该 fork 文件当前是否与旧 pin 字节一致。
 * @param deepImports - chamber 深引的上游包相对路径集合。
 */
export function classifyChange(relPath, isPure, deepImports) {
  const fork = FORK_PATHS.find(candidate => relPath === candidate.upstream || relPath.startsWith(`${candidate.upstream}/`))
  if (fork !== undefined) {
    const local = path.join(ROOT, fork.fork, relPath.slice(fork.upstream.length + 1))
    if (!existsSync(local)) return 'fork-missing'
    return isPure(local) ? 'fork-pure' : 'fork-replay'
  }
  for (const dir of deepImports) {
    if (relPath === dir || relPath.startsWith(`${dir}/`)) return 'vendor-seam'
  }
  return 'other'
}

/**
 * 收集 chamber 源码深引的上游**包名**（`from '@deepseek-ai/<pkg>/src/...'`）。
 * 返回包名集合；调用方再用 {@link resolvePackageDirs} 映射到上游仓库路径。
 * @param root - 仓库根（测试可覆盖）。
 */
export function collectDeepImportedPackages(root = ROOT) {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx|mts)$/.test(entry.name)) continue
      const text = readFileSync(full, 'utf8')
      for (const match of text.matchAll(/from '(@deepseek-ai\/[a-z0-9-]+)\/src\//g)) {
        found.add(match[1].slice('@deepseek-ai/'.length))
      }
    }
  }
  for (const group of readdirSync(path.join(root, 'packages'))) {
    const groupDir = path.join(root, 'packages', group)
    if (statSync(groupDir).isDirectory()) walk(groupDir)
  }
  return found
}

/** 上游 workspace 成员清单的候选路径（覆盖上游 pnpm-workspace.yaml 的各根）。 */
const MEMBER_MANIFEST_PATTERN = /^(packages\/[^/]+\/[^/]+|native\/[^/]+|native\/[^/]+\/packages\/[^/]+|apps\/[^/]+|benchmarks|website)\/package\.json$/

/** 该 ref 下所有可能的上游成员清单路径。 */
function memberManifestPaths(listAtRef) {
  return listAtRef.split('\n').filter(line => MEMBER_MANIFEST_PATTERN.test(line))
}

/**
 * 包名 → 上游仓库目录（如 `dsh-client-ui-layout` → `packages/client/ui-layout`）。
 * @param io - 只读访问器 `{ list, read }`。
 * @param ref - 解析所用的 ref。
 * @returns name → dir 映射（未命中的包不在映射中）。
 */
export function resolvePackageDirs(io, ref) {
  const map = new Map()
  for (const manifestPath of memberManifestPaths(io.list(ref))) {
    try {
      const manifest = JSON.parse(io.read(ref, manifestPath))
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) {
        map.set(manifest.name.slice('@deepseek-ai/'.length), path.posix.dirname(manifestPath))
      }
    } catch { /* unparsable manifest: skip */ }
  }
  return map
}

/**
 * 上游 workspace 成员集合（覆盖 `packages/<group>/<pkg>`、`native/**`、
 * `apps/*`、`benchmarks`、`website` 各根，按包名）——非 `packages/<group>/<pkg>` 的成员
 * （如 0.1.5 被移除的 `native/landlock-run/packages/*`）同样被识别。
 * @param io - `{ list(ref): string, read(ref, path): string }` 只读访问器。
 * @param ref - 目标 ref（pin 或 tag）。
 */
export function upstreamPackages(io, ref) {
  const names = new Set()
  for (const manifestPath of memberManifestPaths(io.list(ref))) {
    try {
      const manifest = JSON.parse(io.read(ref, manifestPath))
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) names.add(manifest.name)
    } catch { /* unparsable manifest: skip */ }
  }
  return names
}

function git(args, opts = {}) {
  return execFileSync('git', ['-C', SUBMODULE, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

function main() {
  const argv = process.argv.slice(2)
  const tag = argv.find(arg => !arg.startsWith('--'))
  const offline = argv.includes('--offline')
  const asJson = argv.includes('--json')
  const failOnReplay = argv.includes('--fail-on-replay')
  if (tag === undefined) {
    console.error('用法: node scripts/dev/preflight-vendor-pin.mjs <tag> [--offline] [--fail-on-replay] [--json]')
    process.exit(2)
  }

  const pin = parsePin(readFileSync(path.join(ROOT, 'harness.commit'), 'utf8'))
  if (pin === null) { console.error('[preflight] 无法解析 harness.commit 的 pin'); process.exit(2) }

  let target
  try {
    target = git(['rev-parse', `${tag}^{commit}`]).trim()
  } catch {
    console.error(`[preflight] 本地 submodule 没有 tag ${tag} 的对象；先执行：`)
    console.error(`  git -C vendor/harness-checkout fetch origin tag ${tag}`)
    process.exit(2)
  }
  if (target === pin) { console.log(`[preflight] 当前 pin 已是 ${tag}（${pin.slice(0, 12)}），无需升级。`); process.exit(0) }

  const deepImportNames = collectDeepImportedPackages()
  const changed = git(['diff', '--name-status', pin, target]).trim().split('\n').filter(Boolean)
    .map(line => { const [status, ...rest] = line.split('\t'); return { status, path: rest[rest.length - 1] } })

  const isPure = (local) => {
    const rel = path.relative(ROOT, local).split(path.sep).join('/')
    const fork = FORK_PATHS.find(candidate => rel.startsWith(`${candidate.fork}/`))
    if (fork === undefined) return false
    const upstreamRel = `${fork.upstream}/${rel.slice(fork.fork.length + 1)}`
    try {
      const old = execFileSync('git', ['-C', SUBMODULE, 'show', `${pin}:${upstreamRel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      return old === readFileSync(local, 'utf8')
    } catch { return false }
  }

  const io = {
    list: ref => git(['ls-tree', '-r', '--name-only', ref]).trim(),
    read: (ref, file) => git(['show', `${ref}:${file}`]),
  }
  // chamber 深引的包名 → 上游仓库目录（用于把 vendor 变更标为 seam 风险）。
  const dirsByPackage = resolvePackageDirs(io, pin)
  const deepImports = new Set(
    [...deepImportNames].map(name => dirsByPackage.get(name)).filter(dir => dir !== undefined),
  )

  const buckets = { 'fork-pure': [], 'fork-replay': [], 'fork-missing': [], 'vendor-seam': [], other: [] }
  for (const change of changed) {
    buckets[classifyChange(change.path, isPure, deepImports)].push(change)
  }

  const pinPkgs = upstreamPackages(io, pin)
  const tagPkgs = upstreamPackages(io, target)
  const addedPkgs = [...tagPkgs].filter(name => !pinPkgs.has(name))
  const removedPkgs = [...pinPkgs].filter(name => !tagPkgs.has(name))

  // 新增包里的 client 行（带 dsh.client 元数据 → host-graph 会发射为行，
  // 需要 covered/roster 裁决）。目录名与包名可能不同，统一经 dirsAtTarget 解析。
  const dirsAtTarget = resolvePackageDirs(io, target)
  const newRows = []
  for (const name of addedPkgs) {
    const dir = dirsAtTarget.get(name.slice('@deepseek-ai/'.length))
    if (dir === undefined) continue
    try {
      const manifest = JSON.parse(io.read(target, `${dir}/package.json`))
      if (manifest.dsh?.client !== undefined) newRows.push({ name, dir })
    } catch { /* unparsable manifest: skip */ }
  }

  const runtimeVersion = tag.replace(/^dsh-v/, '')
  let published = null
  if (!offline) {
    try {
      published = execFileSync('npm', ['view', `@deepseek-ai/dsh@${runtimeVersion}`, 'version'], { encoding: 'utf8' }).trim() !== ''
    } catch { published = false }
  }

  const report = {
    tag, pin, target,
    changedFiles: changed.length,
    pure: buckets['fork-pure'].length,
    replay: buckets['fork-replay'].length,
    dropped: buckets['fork-missing'].length,
    seam: buckets['vendor-seam'].length,
    addedPackages: addedPkgs,
    removedPackages: removedPkgs,
    newClientRows: newRows.map(row => row.name),
    runtimeVersion,
    runtimePublished: published,
    replayFiles: buckets['fork-replay'].map(change => change.path),
    seamFiles: buckets['vendor-seam'].map(change => change.path),
  }

  if (asJson) { console.log(JSON.stringify(report, null, 2)) }
  else {
    console.log(`[preflight] ${pin.slice(0, 12)} → ${tag}（${target.slice(0, 12)}）：上游变更 ${changed.length} 个文件`)
    console.log(`[preflight] fork 面：pure ${report.pure}（照抄）/ 需人工重放 ${report.replay} / dropped ${report.dropped}`)
    if (report.replayFiles.length > 0) for (const file of report.replayFiles.slice(0, 20)) console.log(`  · 重放 ${file}`)
    if (report.seamFiles.length > 0) {
      console.log(`[preflight] ⚠ chamber 深引的 vendor 文件变化 ${report.seamFiles.length} 个（seam 风险，必须与 fork 一起评审）：`)
      for (const file of report.seamFiles.slice(0, 20)) console.log(`  · seam ${file}`)
    }
    if (addedPkgs.length > 0) console.log(`[preflight] 新增上游包 ${addedPkgs.length}：${addedPkgs.join(', ')}`)
    if (removedPkgs.length > 0) console.log(`[preflight] ⚠ 移除上游包 ${removedPkgs.length}：${removedPkgs.join(', ')}（锁文件/链接集合需同步）`)
    if (newRows.length > 0) console.log(`[preflight] ⚠ 新增 client 行 ${newRows.length}：${newRows.map(row => `${row.name}(${row.dir})`).join(', ')}（roster/covered 需裁决）`)
    console.log(`[preflight] 运行时 @deepseek-ai/dsh@${runtimeVersion} 已发布 npm：${published === null ? '未检查（--offline）' : String(published)}`)
  }

  if (failOnReplay && (report.replay > 0 || report.seam > 0 || report.newClientRows.length > 0 || report.removedPackages.length > 0)) {
    console.error('[preflight] 存在需人工处理的项（--fail-on-replay）')
    process.exit(1)
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
