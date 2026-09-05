#!/usr/bin/env node
/**
 * T3 合成基线：同步磁盘统计遍历的耗时曲线（场景⑥主进程阻塞估算锚点）。
 *
 * 测量对象：dsh-runtime-store.ts 现有同步实现（runtimeDiskSummary /
 * measurePathBytes / measureDedupedBytes 全树 lstat+readdir 递归）。
 * 在合成目录树上跑（.pnpm-store 形态：深层嵌套 + 大量小文件 + 符号链接），
 * 按条目数描点（中位数/最大，≥5 次）。改动后同脚本复测即得前后对照
 * （runtimeDiskSummaryAsync 落地后以 --async 变体切换测量目标）。
 *
 * 用法：node scripts/perf/disk-walk-baseline.mjs [--async] [--out scripts/perf/data/disk-walk-baseline.json]
 * 不加新依赖：node 24 类型擦除直跑 TS。
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runtimeDiskSummary, runtimeDiskSummaryAsync } from '../../packages/dsh-runtime/src/dsh-runtime-store.ts'

const useAsync = process.argv.includes('--async')
const measure = useAsync ? runtimeDiskSummaryAsync : runtimeDiskSummary
const outFlag = process.argv.indexOf('--out')
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : 'scripts/perf/data/disk-walk-baseline.json'

/**
 * 真实布局（desktop owner：<userData>/runtime 下版本树 + .pnpm-store +
 * .pnpm-cache + snapshots；<userData>/state/dsh-home 为 dshHome）。
 * $storePkgs 个 store 包；每包：package.json + index.js + 内部 .bin 符号链接
 * （.pnpm-store 形态）。版本树每 $storePkgs/8 个包以硬链接复用 store 文件
 * （真实 pnpm 链接面，专打 measureDedupedBytes 的 (dev,ino) 去重路径）。
 */
function buildTree(root, storePkgs) {
  const runtime = join(root, 'dsh-runtime')
  const store = join(runtime, '.pnpm-store')
  const version = join(runtime, '0.2.0')
  mkdirSync(store, { recursive: true })
  mkdirSync(join(version, 'node_modules', '.pnpm'), { recursive: true })
  for (let i = 0; i < storePkgs; i++) {
    const pkg = join(store, `pkg-${i}@1.0.0`, 'node_modules', `pkg-${i}`)
    mkdirSync(pkg, { recursive: true })
    const js = join(pkg, 'index.js')
    writeFileSync(js, 'x'.repeat(1024))
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: `pkg-${i}` }))
    mkdirSync(join(store, `pkg-${i}@1.0.0`, 'node_modules', '.bin'), { recursive: true })
    symlinkSync(js, join(store, `pkg-${i}@1.0.0`, 'node_modules', '.bin', `pkg-${i}`))
    if (i % 8 === 0) {
      const vpkg = join(version, 'node_modules', '.pnpm', `pkg-${i}@1.0.0`, 'node_modules', `pkg-${i}`)
      mkdirSync(join(vpkg, '..'), { recursive: true })
      // 硬链接复用 store 实体（dedupe 面）— 目录内以真实文件链入
      const vdir = join(version, 'node_modules', '.pnpm', `pkg-${i}@1.0.0`, 'node_modules', `pkg-${i}`, '..', `pkg-${i}`)
      mkdirSync(vdir, { recursive: true })
      linkSync(js, join(vdir, 'index.js'))
      writeFileSync(join(vdir, 'index.mjs'), 'y'.repeat(512))
    }
  }
  mkdirSync(join(runtime, '.pnpm-cache'), { recursive: true })
  writeFileSync(join(runtime, '.pnpm-cache', 'metadata.json'), '{}')
  mkdirSync(join(runtime, 'snapshots'), { recursive: true })
  writeFileSync(join(runtime, 'snapshots', 'snap.json'), '{}')
  mkdirSync(join(root, 'state', 'dsh-home'), { recursive: true })
  writeFileSync(join(root, 'state', 'dsh-home', 'settings.yaml'), '{}')
}

const points = []
for (const n of [2000, 8000, 32000, 100000]) {
  console.error('building point n=' + n)
  const root = mkdtempSync(join(tmpdir(), 'dsh-disk-walk-'))
  try {
    buildTree(root, n)
    const runs = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      const result = await measure(root)
      runs.push({ ms: performance.now() - t0, totalBytes: result.totalBytes })
    }
    runs.sort((a, b) => a.ms - b.ms)
    const entries = n * 4 + (n / 8) * 2
    points.push({ approxEntries: entries, runsMs: runs.map(r => +r.ms.toFixed(1)), medianMs: +runs[2].ms.toFixed(1), maxMs: +runs[4].ms.toFixed(1), totalBytes: runs[0].totalBytes })
    console.log(`entries≈${entries.toLocaleString()}: median ${points.at(-1).medianMs}ms max ${points.at(-1).maxMs}ms bytes=${runs[0].totalBytes}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

mkdirSync(new URL('.', new URL(`file://${process.cwd()}/${outPath}`)).pathname, { recursive: true })
writeFileSync(outPath, JSON.stringify({ impl: useAsync ? 'async' : 'sync', at: new Date().toISOString(), env: { node: process.version, platform: process.platform, arch: process.arch }, points }, null, 2))
console.log(`written: ${outPath}`)
