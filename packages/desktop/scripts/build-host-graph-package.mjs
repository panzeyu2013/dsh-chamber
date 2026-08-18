#!/usr/bin/env node
/**
 * build-host-graph-package.mjs — 把 @dsh-chamber/dsh-host-client-graph 的
 * 可分发形态（package.json + 已构建的 dist/index.js）拷贝进
 * desktop/dist/host-graph-package/，供打包态（asar 内）控制面 seed 使用。
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
const srcDir = join(repoRoot, 'packages', 'dsh-host-client-graph')
const outDir = join(desktopDir, 'dist', 'host-graph-package')

const artifact = join(srcDir, 'dist', 'index.js')
if (!existsSync(artifact)) {
  console.error(
    `[build-host-graph-package] 缺少 host-graph 构建产物：${artifact}\n`
    + '请先执行 pnpm run build:host-graph（或 pnpm --filter @dsh-chamber/dsh-host-client-graph run build）',
  )
  process.exit(1)
}

// 原子替换：先把完整产物写进 .tmp（旧的 .tmp 先清），再删旧目录、rename 入位。
// 任一时刻读取者看到的是旧产物或完整新产物，绝不会是半拷状态（与
// build:control-plane 同节奏；cpSync 中途失败只会留下 .tmp，不影响已发布的 dist）。
const tmpDir = `${outDir}.tmp`
rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })
cpSync(join(srcDir, 'package.json'), join(tmpDir, 'package.json'))
cpSync(join(srcDir, 'dist'), join(tmpDir, 'dist'), { recursive: true })
rmSync(outDir, { recursive: true, force: true })
renameSync(tmpDir, outDir)
console.log('[build-host-graph-package] host-graph package -> dist/host-graph-package/')
