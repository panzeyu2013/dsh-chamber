#!/usr/bin/env node
/**
 * G02 残留机器门：renderer 构建产物必须内联 `DSH_CLIENT_VERSION`。
 *
 * WHY. G02 的修复是构建期 define（vite.config.mjs 的 `process.env.DSH_CLIENT_VERSION`
 * 由 scripts/dsh-client-version.mjs 从已提交 lockfile 提供）。单测只能锁源码接线，
 * 锁不住「这次构建到底有没有把 define 折进去」——Vite 对非 lib 客户端构建默认把
 * `process.env` 折成 `{}`，若 define 键名/插件顺序/构建器升级出现回归，产物里就会
 * 退回 `he.DSH_CLIENT_VERSION`（运行期恒 undefined → 账号 RPC 必抛）。本脚本在
 * build 链里直接扫 dist 产物，把该回归变成构建失败，而不是等到运行期。
 *
 * 判定（对 `packages/desktop/dist/web/assets/*.js`）：
 *   1. 至少一个产物含期望版本字面量（define 已生效）；
 *   2. 任何产物都不得残留 `process.env.DSH_CLIENT_VERSION`（未替换的源码引用）；
 *   3. 任何产物都不得残留 `.DSH_CLIENT_VERSION` 折叠（如 `he.DSH_CLIENT_VERSION`）。
 * 缺产物目录/无 js/任一命中失败 → exit 1，打印重建命令。
 *
 * 用法：`node scripts/assert-client-version-inline.mjs [--assets-dir <path>]`
 *   （`--assets-dir` 只供单测 fixture 用；默认 = 本仓 dist/web/assets）
 *
 * 何时需要更新本门（改任何一项都要同步本脚本 + 单测 + build 链源码锁）：
 *  - 新增/改名 define（例如 DSH_CLIENT_VERSION 换键或再加一个版本键）：同步
 *    `RESIDUAL_PATTERNS` 与期望值来源（scripts/dsh-client-version.mjs）；
 *  - 产物目录/形态变化（vite outDir、资产子目录、非 .js 资产）：同步
 *    `DEFAULT_ASSETS_DIR` 与扫描范围；
 *  - 版本来源变化（lockfile 路径/结构/包名）：同步 dsh-client-version.mjs 与
 *    dsh-client-version.test.mjs 的漂移护栏；
 *  - 上游/Vite 改变 `process.env` 折叠语义（例如不再自动折 {}）：重跑 build 并
 *    按实际产物更新判定，不要只删断言。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshClientVersion } from './dsh-client-version.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** 默认构建产物目录（vite.config.mjs 的 outDir 为 ../desktop/dist/web）。 */
export const DEFAULT_ASSETS_DIR = join(REPO_ROOT, 'packages/desktop/dist/web/assets')

/** 失败时给用户的最短重建命令。 */
export const REBUILD_COMMAND = 'pnpm --filter @dsh-chamber/renderer build'

/** 未替换的 define 源码引用 / 空对象折叠残留（命中任一即失败）。 */
export const RESIDUAL_PATTERNS = Object.freeze([
  { kind: 'process-env', label: 'process.env.DSH_CLIENT_VERSION', pattern: /\bprocess\.env\.DSH_CLIENT_VERSION\b/u },
  { kind: 'folded-member', label: '.DSH_CLIENT_VERSION 折叠（如 he.DSH_CLIENT_VERSION）', pattern: /\.DSH_CLIENT_VERSION\b/u },
])

/**
 * 扫描一个 assets 目录并给出判定（纯函数；CLI 与单测共用）。
 * @param input.assetsDir - 产物 assets 目录。
 * @param input.expectedVersion - 期望内联的版本字面量。
 * @returns {{ ok: boolean, files: string[], literalFiles: string[], residuals: {file: string, label: string}[], problems: string[] }}
 */
export function inspectClientVersionInline({ assetsDir = DEFAULT_ASSETS_DIR, expectedVersion }) {
  const problems = []
  if (typeof expectedVersion !== 'string' || expectedVersion === '') {
    throw new Error('assert-client-version-inline: expectedVersion 必须是非空字符串')
  }
  if (!existsSync(assetsDir)) {
    problems.push('产物目录不存在：' + assetsDir)
    return { ok: false, files: [], literalFiles: [], residuals: [], problems }
  }
  if (!statSync(assetsDir).isDirectory()) {
    problems.push('产物路径不是目录：' + assetsDir)
    return { ok: false, files: [], literalFiles: [], residuals: [], problems }
  }
  const files = readdirSync(assetsDir)
    .filter(name => name.endsWith('.js'))
    .sort()
  if (files.length === 0) problems.push('产物目录里没有 .js 文件：' + assetsDir)
  const literalFiles = []
  const residuals = []
  for (const file of files) {
    const text = readFileSync(join(assetsDir, file), 'utf8')
    if (text.includes(expectedVersion)) literalFiles.push(file)
    for (const { kind, label, pattern } of RESIDUAL_PATTERNS) {
      if (pattern.test(text)) residuals.push({ file, kind, label })
    }
  }
  if (files.length > 0 && literalFiles.length === 0) {
    problems.push('没有任何产物内联期望版本 ' + expectedVersion + '（define 未生效）')
  }
  for (const residual of residuals) {
    problems.push('残留 ' + residual.label + '：' + residual.file)
  }
  return { ok: problems.length === 0, files, literalFiles, residuals, problems }
}

/**
 * CLI：解析参数 → 取值 → 扫描 → 打印通过/失败摘要。
 * @param argv - 进程参数（默认 process.argv.slice(2)）。
 * @returns 进程退出码（0 通过 / 1 失败，供 main 返回）。
 */
export function run(argv = process.argv.slice(2)) {
  let assetsDir = DEFAULT_ASSETS_DIR
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--assets-dir') {
      const value = argv[index + 1]
      if (value === undefined || value === '') {
        console.error('[assert-client-version-inline] --assets-dir 需要路径')
        return 1
      }
      assetsDir = value
      index += 1
    } else if (arg.startsWith('--assets-dir=')) {
      assetsDir = arg.slice('--assets-dir='.length)
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/assert-client-version-inline.mjs [--assets-dir <path>]')
      return 0
    } else {
      console.error('[assert-client-version-inline] 未知参数：' + arg)
      return 1
    }
  }
  let expectedVersion
  try {
    expectedVersion = resolveDshClientVersion()
  } catch (error) {
    console.error('[assert-client-version-inline] 无法解析期望版本：' + String(error))
    return 1
  }
  const verdict = inspectClientVersionInline({ assetsDir, expectedVersion })
  if (verdict.ok) {
    console.log('✓ client version inline: ' + expectedVersion
      + '（' + verdict.literalFiles.length + '/' + verdict.files.length + ' 个 js 产物命中）')
    return 0
  }
  console.error('[assert-client-version-inline] G02 构建产物断言失败（' + assetsDir + '）：')
  for (const problem of verdict.problems) console.error('  ✗ ' + problem)
  console.error('重建：' + REBUILD_COMMAND)
  return 1
}

const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) process.exit(run())
