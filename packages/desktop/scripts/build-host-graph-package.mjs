#!/usr/bin/env node
/**
 * build-host-graph-package.mjs — 把 chamber 自带的 host 包（2026-12 起三个：
 * client-graph / git-worktree / archive-cleanup（design 24））的可分发
 * 形态（package.json + 已构建 dist/）拷贝进 desktop/dist/，供打包态
 * 控制面/SSH seed 使用。脚本名保留，避免破坏现有 build 调用方。
 *
 * 背景（设计 09 §3.5）：控制面 seed 时把 host 包分发进本地 profile 的
 * node_modules，并把 --patch overlay 注入 spawn 命令。开发态直接从源码树
 * packages/dsh-host-client-graph/ 读取；打包态没有源码树，必须随应用分发
 * 一份拷贝——electron-builder 的 files 包含 dist/**，所以放这里。
 * 幂等：每次构建清空重建（与 build:control-plane 同节奏）。
 *
 * 行集（HOST_PACKAGE_BUILD_ROWS）导出供打包测试固定三行；构建本身只在
 * 作为 CLI 直接执行时运行（import 守卫）。
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(desktopDir, '..', '..')

/** The three chamber host packages the packaging build distributes into
 *  desktop/dist/ (packaged source dirs the local control-plane seed and the
 *  remote SSH seed read from). Stable-ordered client-graph, git-worktree,
 *  archive-cleanup; each `label` mirrors the desktop seed-row label used by
 *  main.ts (note: row 1's label 'host-graph' differs from its loader insert
 *  id 'client-graph' — labels are NOT insert ids) and the outDir basename is
 *  `<label>-package`. Exported so the packaging test can pin the row set
 *  without executing the build. */
export const HOST_PACKAGE_BUILD_ROWS = [
  {
    label: 'host-graph',
    sourceDir: join(repoRoot, 'packages', 'dsh-host-client-graph'),
    outDir: join(desktopDir, 'dist', 'host-graph-package'),
  },
  {
    label: 'git-worktree',
    sourceDir: join(repoRoot, 'packages', 'dsh-chamber-host-git-worktree'),
    outDir: join(desktopDir, 'dist', 'host-git-worktree-package'),
  },
  {
    label: 'archive-cleanup',
    sourceDir: join(repoRoot, 'packages', 'dsh-host-archive-cleanup'),
    outDir: join(desktopDir, 'dist', 'host-archive-cleanup-package'),
  },
]

function buildHostGraphPackages() {
  // Preflight every package before replacing any output. A missing second
  // artifact therefore cannot publish a mixed old/new host package set.
  for (const entry of HOST_PACKAGE_BUILD_ROWS) {
    const artifact = join(entry.sourceDir, 'dist', 'index.js')
    const manifest = join(entry.sourceDir, 'package.json')
    if (!existsSync(artifact) || !existsSync(manifest)) {
      console.error(
        `[build-host-graph-package] 缺少 ${entry.label} 构建产物：${!existsSync(artifact) ? artifact : manifest}\n`
        + '请先构建全部 chamber host packages',
      )
      process.exit(1)
    }
  }

  for (const entry of HOST_PACKAGE_BUILD_ROWS) {
    // 原子替换：先把完整产物写进 .tmp，再 rename 入位；读取者只会看到旧
    // 产物或完整新产物，不会看到半拷目录。
    const tmpDir = `${entry.outDir}.tmp`
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    cpSync(join(entry.sourceDir, 'package.json'), join(tmpDir, 'package.json'))
    cpSync(join(entry.sourceDir, 'dist'), join(tmpDir, 'dist'), { recursive: true })
    rmSync(entry.outDir, { recursive: true, force: true })
    renameSync(tmpDir, entry.outDir)
    console.log(`[build-host-graph-package] ${entry.label} package -> ${entry.outDir}/`)
  }
}

// Import guard: a packaging test importing HOST_PACKAGE_BUILD_ROWS must not
// trigger the build.
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) buildHostGraphPackages()
