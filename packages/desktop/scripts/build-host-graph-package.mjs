#!/usr/bin/env node
/**
 * build-host-graph-package.mjs — 把 chamber 自带的两个 host 包的可分发
 * 形态（package.json + 已构建 dist/）拷贝进 desktop/dist/，供打包态
 * 控制面/SSH seed 使用。脚本名保留，避免破坏现有 build 调用方。
 *
 * 背景（设计 09 §3.5）：控制面 seed 时把 host 包分发进本地 profile 的
 * node_modules，并把 --patch overlay 注入 spawn 命令。开发态直接从源码树
 * packages/dsh-host-client-graph/ 读取；打包态没有源码树，必须随应用分发
 * 一份拷贝——electron-builder 的 files 包含 dist/**，所以放这里。
 * 幂等：每次构建清空重建（与 build:control-plane 同节奏）。
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(desktopDir, '..', '..')
const packages = [
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
]

// Preflight both packages before replacing either output. A missing second
// artifact therefore cannot publish a mixed old/new host package set.
for (const entry of packages) {
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

for (const entry of packages) {
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
