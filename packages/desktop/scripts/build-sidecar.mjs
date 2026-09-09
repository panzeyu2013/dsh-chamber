#!/usr/bin/env node
/**
 * build-sidecar.mjs —— Swift flavor sidecar 打包（W-23；design 25 §3.2/§4.3）
 *
 * 产物布局（design 25 §3.2「sidecar 装配目录约定」）：
 *   <out>/node                     捆绑的官方 Node（**基名必须叫 node**，
 *                                  design 25 §4.3 A5——spawn-dsh 的纯 Node
 *                                  分支只在 basename(execPath) ∈ {node,node.exe}
 *                                  时直用 process.execPath；命名 node 即零改动）
 *   <out>/sidecar.js               esbuild 打包的 sidecar 入口（含 shell-core
 *                                  全家 + sidecar-ctx + node-edges + dsh-runtime）
 *   <out>/dist/control-plane/…     build:control-plane 的编译产物（运行时经
 *                                  control-plane-module 的相对动态 import
 *                                  加载——包外裸说明符在打包态不可解析）
 *
 * 步骤：
 *   1. tsc -p tsconfig.sidecar.build.json —— 编译闭包校验（Electron-free 家族
 *      全家可编译；失败即 loud 中止，不产出半成品）；
 *   2. esbuild 打包 sidecar-entry.ts → sidecar.js（platform=node、format=esm、
 *      target=node22；external：@dsh-chamber/control-plane / electron /
 *      ./dist/control-plane/index.js——三者都在运行期由装配目录解析）；
 *   3. 拷贝 dist/control-plane → <out>/dist/control-plane；
 *   4. Node 捆绑：官方 tar.gz 下载（或 --node-archive 离线提供）→ SHA-256 校验
 *      → 解出 bin/node → 落位 <out>/node（0755）→ **基名断言**。
 *
 * 离线/无网：--skip-node 跳过第 4 步（布局仍完整，仅缺 node，供 dev/CI 校验）；
 * --dry-run 只打印计划与输入校验，不写盘、不联网。
 *
 * 运行期标记：Swift Supervisor spawn `<sidecar>/sidecar.js` 时必须带
 * `DSH_CHAMBER_SIDECAR_COMPILED=1`（control-plane-module.isPackagedSidecarRuntime）
 * ——装配目录无 node_modules 树，裸说明符 `@dsh-chamber/control-plane` 不可解析，
 * 必须走 <sidecar>/dist/control-plane/index.js 的相对入口。
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')
const repoRoot = path.resolve(desktopDir, '..', '..')

/** 缺省 Node 版本：与 desktop Electron 43.4.0 内置 Node 大版本对齐（D6；
 *  exact minor 以安装态 process.versions.node 核实——24.18.1 为 2026-09 实测）。 */
export const DEFAULT_NODE_VERSION = '24.18.1'
/** v1 只发 arm64（design 25 §10 决策 6）。 */
export const DEFAULT_ARCH = 'arm64'

/** chamber host 包（design 09/08/24）——打包态必须随 sidecar 装配，否则
 *  sidecar-ctx 的 hostPackageSourceDir 在 .app 内向上找不到 `packages/<pkg>`
 *  → seed 走「构建产物缺失」loud 路径，Git worktree / client graph / 归档清理
 *  三个宿主域整体缺席。Swift 侧按显式参数注入（AppDelegate 装配态分支）。 */
export const HOST_PACKAGES = [
  { name: 'dsh-host-client-graph', arg: 'host-graph-dir' },
  { name: 'dsh-chamber-host-git-worktree', arg: 'host-git-dir' },
  { name: 'dsh-host-archive-cleanup', arg: 'host-archive-dir' },
]

export function sidecarLayout(outDir) {
  return {
    outDir,
    node: path.join(outDir, 'node'),
    entry: path.join(outDir, 'sidecar.js'),
    packageJson: path.join(outDir, 'package.json'),
    dist: path.join(outDir, 'dist'),
    controlPlaneDist: path.join(outDir, 'dist', 'control-plane'),
    controlPlaneEntry: path.join(outDir, 'dist', 'control-plane', 'index.js'),
    hostPackageDist: (name) => path.join(outDir, 'dist', name),
    // 内置 dsh 工作区与内嵌 pnpm（design 25 §3.2：打包态本地实例/运行时安装
    // 依赖它们；与 Electron 侧 extraResources 同布局同过滤器）。
    vendorDsh: path.join(outDir, 'vendor', 'dsh'),
    pnpm: path.join(outDir, 'pnpm'),
    pnpmEntry: path.join(outDir, 'pnpm', 'bin', 'pnpm.cjs'),
  }
}

/** Electron extraResources 同款过滤器：vendor/dsh 只带清单三件 + node_modules。 */
export const VENDOR_DSH_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
/** Electron extraResources 同款过滤器：pnpm 只带 package.json + bin/pnpm.{cjs,mjs} + dist。 */
export const PNPM_BIN_FILES = ['pnpm.cjs', 'pnpm.mjs']

/** 拷贝内置 dsh 工作区（缺源时返回 false，由调用方决定 warn/fatal）。 */
export function copyVendorDsh(sourceDir, destDir) {
  const manifest = path.join(sourceDir, 'package.json')
  if (!existsSync(manifest)) return false
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  for (const file of VENDOR_DSH_FILES) {
    const from = path.join(sourceDir, file)
    if (existsSync(from)) cpSync(from, path.join(destDir, file))
  }
  const modules = path.join(sourceDir, 'node_modules')
  if (existsSync(modules)) {
    cpSync(modules, path.join(destDir, 'node_modules'), { recursive: true, dereference: true })
  }
  if (!existsSync(path.join(destDir, 'package.json'))) {
    throw new Error(`vendor/dsh 拷贝不完整：${path.join(destDir, 'package.json')}`)
  }
  return true
}

/** 拷贝内嵌 pnpm（缺源时返回 false）。 */
export function copyPnpm(sourceDir, destDir) {
  const manifest = path.join(sourceDir, 'package.json')
  const entry = path.join(sourceDir, 'bin', 'pnpm.cjs')
  if (!existsSync(manifest) || !existsSync(entry)) return false
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(path.join(destDir, 'bin'), { recursive: true })
  cpSync(manifest, path.join(destDir, 'package.json'))
  for (const file of PNPM_BIN_FILES) {
    const from = path.join(sourceDir, 'bin', file)
    if (existsSync(from)) cpSync(from, path.join(destDir, 'bin', file))
  }
  const dist = path.join(sourceDir, 'dist')
  if (existsSync(dist)) cpSync(dist, path.join(destDir, 'dist'), { recursive: true, dereference: true })
  if (!existsSync(path.join(destDir, 'bin', 'pnpm.cjs'))) {
    throw new Error(`pnpm 拷贝不完整：${path.join(destDir, 'bin', 'pnpm.cjs')}`)
  }
  return true
}

export function nodeArchiveName(version, arch) {
  return `node-v${version}-darwin-${arch}.tar.gz`
}

export function nodeDistUrl(version, fileName) {
  return `https://nodejs.org/dist/v${version}/${fileName}`
}

export function nodeMemberPath(version, arch) {
  return `node-v${version}-darwin-${arch}/bin/node`
}

/** SHASUMS256.txt → 目标文件的校验和（找不到 → null）。 */
export function parseShasums(text, fileName) {
  for (const line of String(text).split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match !== null && match[2].trim() === fileName) return match[1]
  }
  return null
}

/** SHA-256 校验（导出以便单测：不匹配必须 throw——2026-09 审计发现原测试只比
 *  手写假摘要，任何 64 位 hex 都「通过」，校验逻辑回归不会被发现）。 */
export async function verifySha256(file, expected) {
  const actual = await sha256File(file)
  if (actual !== expected) {
    throw new Error(`Node 归档 SHA-256 不匹配（期望 ${expected}，实际 ${actual}）`)
  }
  return actual
}

export async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** A5 断言：捆绑 Node 的基名必须是 `node`（spawn-dsh 直用 execPath 的前提）。 */
export function assertBundledNodeBasename(nodePath) {
  const base = path.basename(nodePath)
  if (base !== 'node') {
    throw new Error(
      `捆绑 Node 基名必须是 'node'（design 25 §4.3 A5：resolveNodeExecutable 的纯 Node 分支只在 basename(execPath) ∈ {node,node.exe} 时直用 process.execPath）；实际 '${base}'`,
    )
  }
}

export function parseBuildSidecarArgs(argv) {
  const options = {
    outDir: path.join(desktopDir, 'release', 'sidecar'),
    dryRun: false,
    skipNode: false,
    skipBundle: false,
    skipHostPackages: false,
    skipVendor: false,
    vendorDshDir: path.join(desktopDir, 'vendor', 'dsh'),
    pnpmDir: path.join(desktopDir, 'node_modules', 'pnpm'),
    nodeVersion: DEFAULT_NODE_VERSION,
    nodeSha256: null,
    nodeArchive: null,
    arch: process.arch === 'x64' ? 'x64' : DEFAULT_ARCH,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} 缺少取值`)
      return argv[index]
    }
    if (arg === '--out') options.outDir = path.resolve(next())
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--skip-node') options.skipNode = true
    else if (arg === '--skip-bundle') options.skipBundle = true
    else if (arg === '--skip-host-packages') options.skipHostPackages = true
    else if (arg === '--skip-vendor') options.skipVendor = true
    else if (arg === '--vendor-dsh') options.vendorDshDir = path.resolve(next())
    else if (arg === '--pnpm-dir') options.pnpmDir = path.resolve(next())
    else if (arg === '--node-version') options.nodeVersion = next()
    else if (arg === '--node-sha256') options.nodeSha256 = next().toLowerCase()
    else if (arg === '--node-archive') options.nodeArchive = path.resolve(next())
    else if (arg === '--arch') options.arch = next()
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

export function buildPlan(options) {
  const layout = sidecarLayout(options.outDir)
  const steps = [
    `[1] tsc -p tsconfig.sidecar.build.json（编译闭包校验 → dist/sidecar）`,
  ]
  if (options.skipBundle) steps.push('[2] 跳过 esbuild 打包（--skip-bundle）')
  else steps.push(`[2] esbuild 打包 sidecar-entry.ts → ${layout.entry}`)
  steps.push(`[3] 拷贝 dist/control-plane → ${layout.controlPlaneDist}`)
  steps.push(`[3b] 写装配 package.json（shell-core 模块级 version 读取依赖）→ ${layout.packageJson}`)
  if (options.skipHostPackages) steps.push('[3c] 跳过 host 包拷贝（--skip-host-packages）')
  else steps.push(`[3c] 拷贝 chamber host 包（${HOST_PACKAGES.map((p) => p.name).join(' / ')}）→ ${layout.dist}`)
  if (options.skipVendor) steps.push('[3d] 跳过 vendor/dsh + pnpm 拷贝（--skip-vendor）')
  else {
    steps.push(`[3d] 拷贝内置 dsh 工作区 → ${layout.vendorDsh}（${VENDOR_DSH_FILES.join(' / ')} + node_modules）`)
    steps.push(`[3e] 拷贝内嵌 pnpm → ${layout.pnpm}（package.json + bin/pnpm.{cjs,mjs} + dist）`)
  }
  if (options.skipNode) steps.push('[4] 跳过 Node 捆绑（--skip-node）')
  else {
    const archive = nodeArchiveName(options.nodeVersion, options.arch)
    steps.push(
      options.nodeArchive !== null
        ? `[4] Node 捆绑：本地 ${options.nodeArchive} → SHA-256 校验 → ${layout.node}`
        : `[4] Node 捆绑：${nodeDistUrl(options.nodeVersion, archive)} → SHA-256 校验 → ${layout.node}`,
    )
  }
  steps.push(`[5] 断言：${path.basename(layout.node)} 基名 + 产物存在`)
  return steps
}

function resolveEsbuild() {
  const requireFromRenderer = createRequire(
    fileURLToPath(new URL('../../renderer/package.json', import.meta.url)),
  )
  const viteEntry = requireFromRenderer.resolve('vite')
  return createRequire(viteEntry).resolve('esbuild')
}

async function fetchText(url, timeoutMs = 30_000) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: abort.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}（${url}）`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchToFile(url, target, timeoutMs = 300_000) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: abort.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}（${url}）`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const { writeFileSync } = await import('node:fs')
    writeFileSync(target, buffer)
    return buffer.length
  } finally {
    clearTimeout(timer)
  }
}

async function bundleSidecar(layout) {
  const esbuildEntry = resolveEsbuild()
  const esbuildModule = await import(pathToFileURL(esbuildEntry).href)
  mkdirSync(layout.outDir, { recursive: true })
  const result = await esbuildModule.build({
    entryPoints: [path.join(desktopDir, 'sidecar-entry.ts')],
    absWorkingDir: desktopDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // 运行期外部：control-plane 经 control-plane-module 的相对动态 import 加载
    // （打包态无裸说明符解析）；electron 只被 updater.ts 的缺省 seam 惰性 require
    // （Swift flavor 永不触达，但必须保持 external 以免 esbuild 试图解析）。
    external: ['@dsh-chamber/control-plane', 'electron', './dist/control-plane/index.js'],
    outfile: layout.entry,
    logLevel: 'warning',
  })
  if (result.errors.length > 0) {
    throw new Error(`esbuild 打包失败：${result.errors.map((e) => e.text).join('; ')}`)
  }
  return result
}

/** A5 归档成员断言（导出以便单测；member = 期望的归档内路径）。 */
export function assertNodeArchiveMembers(archivePath, member, stdout) {
  const listing = stdout !== undefined
    ? { status: 0, stdout }
    : spawnSync('tar', ['-tzf', archivePath], {
        encoding: 'utf8',
        // maxBuffer 显式放大：官方 node 归档清单约 0.8 MiB（2026-09 实测 5892 项
        // / 817 KB），默认 1 MiB 余量过小——超限会误报失败（fail-closed 但噪声）。
        maxBuffer: 64 * 1024 * 1024,
      })
  if (listing.status !== 0) {
    throw new Error(`无法列出 Node 归档成员（exit ${listing.status}）：${listing.stderr ?? ''}`)
  }
  const members = String(listing.stdout).split('\n').map((line) => line.trim()).filter(Boolean)
  if (!members.includes(member)) {
    throw new Error(`Node 归档缺少成员 ${member}（design 25 §4.3 A5；实际成员 ${members.length} 个）`)
  }
  // 注意：member 的基名恒为 node（nodeMemberPath 构造），故"归档内存在基名为
  // node 的成员"由成员存在性蕴含——不重复断言（2026-09 二审：原第二条检查结构
  // 上恒真）。基名的真正检查点在解包后（bundleNode 对落盘文件再断言一次）。
  return members
}

async function bundleNode(options, layout, log) {
  const archiveName = nodeArchiveName(options.nodeVersion, options.arch)
  const staging = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-node-'))
  try {
    let archivePath = options.nodeArchive
    if (archivePath === null) {
      archivePath = path.join(staging, archiveName)
      log(`[build-sidecar] 下载 ${nodeDistUrl(options.nodeVersion, archiveName)}`)
      await fetchToFile(nodeDistUrl(options.nodeVersion, archiveName), archivePath)
    } else if (!existsSync(archivePath)) {
      throw new Error(`--node-archive 不存在：${archivePath}`)
    }

    let expected = options.nodeSha256
    if (expected === null) {
      log(`[build-sidecar] 拉取 SHASUMS256.txt（v${options.nodeVersion}）`)
      const shasums = await fetchText(nodeDistUrl(options.nodeVersion, 'SHASUMS256.txt'))
      expected = parseShasums(shasums, archiveName)
      if (expected === null) throw new Error(`SHASUMS256.txt 未包含 ${archiveName}`)
    }
    await verifySha256(archivePath, expected)

    const member = nodeMemberPath(options.nodeVersion, options.arch)
    // A5 真实检查点（2026-09 二审判定原实现恒真）：列出归档成员，确认**归档里
    // 确实存在**一个基名为 node 的成员，且期望成员路径在其中。
    // maxBuffer 显式放大：官方 node 归档清单约 0.8 MiB（2026-09 实测 5892 项
    // / 817 KB），默认 1 MiB 余量过小——超限会误报失败（fail-closed 但噪声）。
    const listing = spawnSync('tar', ['-tzf', archivePath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (listing.status !== 0) {
      throw new Error(`无法列出 Node 归档成员（exit ${listing.status}）：${listing.stderr ?? ''}`)
    }
    assertNodeArchiveMembers(archivePath, member, listing.stdout)
    const extract = spawnSync(
      'tar',
      ['-xzf', archivePath, '-C', staging, '--strip-components=2', member],
      { encoding: 'utf8' },
    )
    if (extract.status !== 0) {
      throw new Error(`解包 Node 失败（exit ${extract.status}）：${extract.stderr ?? ''}`)
    }
    const extracted = path.join(staging, 'node')
    if (!existsSync(extracted)) throw new Error(`解包后未找到 ${extracted}`)
    if (path.basename(extracted) !== 'node') {
      throw new Error(`解包后基名必须是 node（design 25 §4.3 A5）：${extracted}`)
    }
    copyFileSync(extracted, layout.node)
    chmodSync(layout.node, 0o755)
    assertBundledNodeBasename(layout.node)
    log(`[build-sidecar] Node v${options.nodeVersion} → ${layout.node}（基名断言通过）`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export async function runBuildSidecar(options, io = { log: console.log, error: console.error }) {
  const layout = sidecarLayout(options.outDir)
  const plan = buildPlan(options)
  for (const step of plan) io.log(`  ${step}`)

  // 输入校验（dry-run 同样执行）。
  const tsconfig = path.join(desktopDir, 'tsconfig.sidecar.build.json')
  const sidecarEntry = path.join(desktopDir, 'sidecar-entry.ts')
  const controlPlaneSource = path.join(desktopDir, 'dist', 'control-plane', 'index.js')
  for (const [label, file] of [
    ['tsconfig.sidecar.build.json', tsconfig],
    ['sidecar-entry.ts', sidecarEntry],
  ]) {
    if (!existsSync(file)) throw new Error(`缺少输入：${label}（${file}）`)
  }
  if (!existsSync(controlPlaneSource)) {
    throw new Error('缺少 build:control-plane 产物——先跑 pnpm --filter @dsh-chamber/desktop run build:control-plane')
  }
  if (options.dryRun) {
    io.log('[build-sidecar] dry-run：输入校验通过，未写盘、未联网')
    return { dryRun: true, layout }
  }

  mkdirSync(layout.outDir, { recursive: true })

  // 1. tsc 编译闭包校验（Electron-free 家族可编译）。
  const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tscEntry)) throw new Error('未找到 TypeScript（先 pnpm install）')
  const compiled = spawnSync(process.execPath, [tscEntry, '-p', tsconfig], { stdio: 'inherit', shell: false })
  if (compiled.status !== 0) throw new Error(`tsc 编译失败（exit ${compiled.status}）`)

  // 2. esbuild 打包。
  if (!options.skipBundle) {
    await bundleSidecar(layout)
    if (!existsSync(layout.entry)) throw new Error(`打包产物缺失：${layout.entry}`)
    io.log(`[build-sidecar] sidecar.js → ${layout.entry}`)
  }

  // 3. 拷贝 control-plane 编译产物。
  rmSync(layout.controlPlaneDist, { recursive: true, force: true })
  cpSync(path.join(desktopDir, 'dist', 'control-plane'), layout.controlPlaneDist, { recursive: true })
  if (!existsSync(layout.controlPlaneEntry)) {
    throw new Error(`control-plane 产物拷贝不完整：${layout.controlPlaneEntry}`)
  }

  // 3b. 装配目录的 package.json：shell-core 的模块级 version 读取
  // （new URL('./package.json', import.meta.url)）与 ESM 判定都依赖它。
  const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))
  writeFileSync(layout.packageJson, `${JSON.stringify({
    name: '@dsh-chamber/sidecar',
    version: typeof desktopPkg.version === 'string' ? desktopPkg.version : '0.0.0',
    private: true,
    type: 'module',
  }, null, 2)}\n`)
  io.log(`[build-sidecar] package.json（version=${desktopPkg.version ?? 'unknown'}）→ ${layout.packageJson}`)

  // 3c. chamber host 包（打包态 seed 源；缺失只 warn 不 fatal——宿主域缺席是
  // 可诊断的降级，构建脚本不替运行期决定）。
  if (options.skipHostPackages) {
    io.log('[build-sidecar] 跳过 host 包拷贝（--skip-host-packages）')
  } else {
    for (const host of HOST_PACKAGES) {
      const sourceDir = path.join(repoRoot, 'packages', host.name)
      const artifact = path.join(sourceDir, 'dist', 'index.js')
      const manifest = path.join(sourceDir, 'package.json')
      if (!existsSync(artifact) || !existsSync(manifest)) {
        io.log(`[build-sidecar] 警告：host 包 ${host.name} 缺少构建产物（先跑 build:host-packages）——跳过`)
        continue
      }
      const target = layout.hostPackageDist(host.name)
      rmSync(target, { recursive: true, force: true })
      mkdirSync(path.join(target, 'dist'), { recursive: true })
      cpSync(manifest, path.join(target, 'package.json'))
      cpSync(artifact, path.join(target, 'dist', 'index.js'))
      io.log(`[build-sidecar] host 包 ${host.name} → ${target}（--${host.arg} 注入）`)
    }
  }

  // 3d/3e. 内置 dsh 工作区 + 内嵌 pnpm（打包态本地实例与运行时安装所需；
  // 缺源只 warn——离线 dev 可 --skip-vendor，release 腿由 verify 步断言存在）。
  if (options.skipVendor) {
    io.log('[build-sidecar] 跳过 vendor/dsh + pnpm 拷贝（--skip-vendor）')
  } else {
    if (copyVendorDsh(options.vendorDshDir, layout.vendorDsh)) {
      io.log(`[build-sidecar] vendor/dsh → ${layout.vendorDsh}`)
    } else {
      io.log(`[build-sidecar] 警告：未找到 dsh 工作区 ${options.vendorDshDir}（先跑 bundle-dsh / 或 --skip-vendor）`)
    }
    if (copyPnpm(options.pnpmDir, layout.pnpm)) {
      io.log(`[build-sidecar] pnpm → ${layout.pnpm}`)
    } else {
      io.log(`[build-sidecar] 警告：未找到 pnpm ${options.pnpmDir}（先 pnpm install / 或 --skip-vendor）`)
    }
  }

  // 4. Node 捆绑（可选）。
  if (options.skipNode) {
    io.log('[build-sidecar] 跳过 Node 捆绑（--skip-node）')
  } else {
    await bundleNode(options, layout, io.log)
  }

  // 5. 终态断言。
  if (existsSync(layout.node)) {
    assertBundledNodeBasename(layout.node)
    const mode = statSync(layout.node).mode & 0o777
    if (mode !== 0o755) throw new Error(`捆绑 Node 权限应为 0755，实际 ${mode.toString(8)}`)
  }
  io.log(`[build-sidecar] 完成：${layout.outDir}`)
  return { dryRun: false, layout }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  try {
    const options = parseBuildSidecarArgs(process.argv.slice(2))
    if (options.help) {
      console.log('用法：build-sidecar.mjs [--out <dir>] [--dry-run] [--skip-node] [--skip-bundle] [--skip-vendor]')
      console.log('       [--node-version <v>] [--node-sha256 <hex>] [--node-archive <tar.gz>] [--arch <arm64|x64>]')
      process.exit(0)
    }
    await runBuildSidecar(options)
  } catch (error) {
    console.error(`[build-sidecar] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
