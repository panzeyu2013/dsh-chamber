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
 *   1. tsc -p tsconfig.sidecar.build.json —— 编译闭包校验（noEmit；Electron-free
 *      家族全家可编译；失败即 loud 中止，不产出半成品。历史上这一步 emit 到
 *      packages/desktop/dist/sidecar，但没有任何运行期消费者，而 electron-builder
 *      的 dist/** files glob 会把它打进 Electron 包——已改 noEmit 并清理遗留目录）；
 *   2. esbuild 打包 sidecar-entry.ts → sidecar.js（platform=node、format=esm、
 *      target=node22；external：@dsh-chamber/control-plane / electron /
 *      ./dist/control-plane/index.js——三者都在运行期由装配目录解析）；
 *   3. 拷贝 dist/control-plane → <out>/dist/control-plane；
 *   4. Node 捆绑：官方 tar.gz 下载（或 --node-archive 离线提供）→ SHA-256 校验
 *      （默认版本摘要固定在仓库 PINNED_NODE_SHA256；未固定版本回退
 *      SHASUMS256.txt 并响亮说明）→ 解出 bin/node → 落位 <out>/node（0755）
 *      → **基名断言**。
 *
 * 离线/无网：--skip-node 跳过第 4 步（供 dev/CI 校验）；--dry-run 只打印计划与
 * 输入校验，不写盘、不联网。
 * **--skip-* 的诚实语义（2026-12 P3）**：<out> 是持久装配目录，跳过必须产生
 * **缺位**，而不是继承上一轮的产物——每个 skip 开关在开工前清掉自己的目标
 * （node / sidecar.js / vendor+dsh / dist），否则上一轮的 node/vendor 会留在装配
 * 里被 .app 一起签名发布，而构建日志却声称「已跳过」。
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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
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

/**
 * 仓库内固定的官方 Node 归档 SHA-256（design 25 §4.3 A5 的信任基座）。
 *
 * 为什么固定：W-23 原先按 `SHASUMS256.txt` 联网取摘要——信任落在下载回来的那份
 * 文本上（同一通道可被替换），构建可复现性也依赖网络内容。摘要钉进仓库后，默认
 * 路径只下载归档、与表比对（fail-closed），不再读网络摘要；未列出的版本
 * （`--node-version`）仍回退 SHASUMS256.txt，并**响亮说明**「该版本未固定」——
 * 「没固定」绝不伪装成「已校验」。
 *
 * 来源与维护：摘要逐字取自 https://nodejs.org/dist/v<version>/SHASUMS256.txt。
 * 默认 DEFAULT_NODE_VERSION 的两个 darwin 归档（arm64/x64）都必须在本表内；
 * 升级默认版本时在同一提交更新本表（build-sidecar.test.mjs 的门禁会红）。
 */
export const PINNED_NODE_SHA256 = {
  'node-v24.18.1-darwin-arm64.tar.gz': 'eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941',
  'node-v24.18.1-darwin-x64.tar.gz': '6fb20fceacbb157c2f95825b80df4a454a0f6d81cdcd7bb81eeae9147e0e76ec',
}

/**
 * 本次 Node 归档的期望摘要（纯函数，单测不联网）。
 * - `--node-sha256`（override）优先，但与仓库固定值冲突时 **throw**：同一版本的
 *   官方归档内容不可变，出现不同摘要只可能是固定值写错或包被替换——绝不静默采纳；
 * - 无 override 且表内有该归档 → 用固定值（不读网络摘要）；
 * - 表内没有 → `{ digest: null, source: 'network' }`，调用方回退 SHASUMS256.txt 并说明。
 * @param {string} archiveName - `node-v<ver>-darwin-<arch>.tar.gz`
 * @param {string | null} override - 调用方显式摘要（已归一化小写）或 null
 * @param {Record<string, string>} pins - 固定表（测试可注入）
 * @returns {{ digest: string | null, source: 'override' | 'pinned' | 'network' }}
 */
export function resolvePinnedNodeDigest(archiveName, override, pins = PINNED_NODE_SHA256) {
  const pinned = Object.prototype.hasOwnProperty.call(pins, archiveName) ? pins[archiveName] : null
  if (override !== null) {
    if (pinned !== null && pinned !== override) {
      throw new Error(
        `--node-sha256 与仓库固定摘要不一致（${archiveName}）：固定 ${pinned}，传入 ${override}`
        + '——官方归档内容不可变，请先核对固定值（或先更新 PINNED_NODE_SHA256）',
      )
    }
    return { digest: override, source: 'override' }
  }
  if (pinned !== null) return { digest: pinned, source: 'pinned' }
  return { digest: null, source: 'network' }
}

/** chamber host 包（design 09/08/24）——打包态必须随 sidecar 装配，否则
 *  sidecar-ctx 的 hostPackageSourceDir 在 .app 内向上找不到 `packages/<pkg>`
 *  → seed 走「构建产物缺失」loud 路径，Git worktree / client graph / 归档清理
 *  三个宿主域整体缺席。Swift 侧按显式参数注入（AppDelegate 装配态分支）。 */
export const HOST_PACKAGES = [
  { name: 'dsh-chamber-seed-client-graph', arg: 'host-graph-dir' },
  { name: 'dsh-chamber-seed-git-worktree', arg: 'host-git-dir' },
  { name: 'dsh-chamber-seed-archive-cleanup', arg: 'host-archive-dir' },
  // open-in（design 20 §6）是注册表里的 localOnly 行：它必须随 .app 分发，
  // 但**只**供本地实例播种——远端（SSH/gateway）种子表由 registry 驱动，
  // 永不携带它（见 sidecar-ctx 的远程 seed 数组与 main.ts 的同类注记）。
  { name: 'dsh-chamber-seed-open-in', arg: 'host-open-in-dir' },
]

/**
 * host 包构建产物的 fail-closed 前置检查（导出以便单测）：sourceDir 下必须有
 * package.json 与 dist/index.js。Electron 侧同款拷贝（build-host-graph-package.mjs）
 * 缺产物直接 exit 1；这里过去只 warn，于是装配能「成功」产出宿主域整体缺席的 .app。
 * @param {{ name: string }[]} hostPackages - 要检查的包（顺序无关）
 * @param {(name: string) => string} resolveSourceDir - 包名 → 源目录
 */
export function assertHostPackageArtifacts(hostPackages, resolveSourceDir) {
  for (const host of hostPackages) {
    const sourceDir = resolveSourceDir(host.name)
    const artifact = path.join(sourceDir, 'dist', 'index.js')
    const manifest = path.join(sourceDir, 'package.json')
    if (!existsSync(artifact) || !existsSync(manifest)) {
      throw new Error(
        `host 包 ${host.name} 缺少构建产物：${!existsSync(artifact) ? artifact : manifest}`
        + '（先跑 pnpm run build:host-packages；或显式 --skip-host-packages 表达本次不要 host 包）',
      )
    }
  }
}

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

/**
 * 拷贝目录树并**原样保留符号链接**（含相对拼写）。
 *
 * 为什么用 cpSync(verbatimSymlinks: true)：cpSync 的缺省行为
 * （verbatimSymlinks=false，含 dereference: true）会把相对链接改写成指向源树的
 * **绝对**链接（Node 24 实测），产物于是含逃出 bundle 的链接，
 * `codesign --verify --strict` 必挂；而把 `.bin/*` 一律实体化又会破坏
 * `import.meta.url` 相对解析（那些 shim 指向模块文件）。verbatimSymlinks
 * 让复制只搬链接本身，链接语义交给下一步。
 *
 * 链接处置（**唯一**的实现点是 normalizeSymlinks，所有调用点都在 copyTree
 * 之后立刻调用它）：
 * - 树内链接 → 保持链接（相对拼写原样）；
 * - 树外链接 → 由 normalizeSymlinks 实体化，产物自包含；
 * - 悬空链接 → normalizeSymlinks loud（绝不留下悬空链接）。
 */
export function copyTree(sourceDir, destDir) {
  cpSync(sourceDir, destDir, { recursive: true, verbatimSymlinks: true })
}

/**
 * 归一化目录树内的符号链接，使产物**自包含**且可过 `codesign --verify --strict`。
 *
 * 背景（2026-09 GUI 验收 P2，release 阻塞）：Node 的 `fs.cpSync`（含
 * `dereference: true`）会把**相对**符号链接改写成**指向源树的绝对**链接
 * （实测 Node 24：`.bin/dsh -> ../@deepseek-ai/dsh/lib/bin.js` 复制后变成
 * `/…/packages/desktop/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`）。
 * bundle 内出现逃出 bundle 的符号链接 → codesign 报
 * `invalid destination for symbolic link in bundle`，签名/ad-hoc 构建全挂。
 *
 * 规则：
 * - 目标在树内 → 改写为**相对**链接（保留链接语义：pnpm `.bin` 依赖它）；
 * - 目标在树外（或树内但经 realpath 逃出）→ **实体化**（文件复制 / 目录递归
 *   复制），产物自包含；
 * - 目标不存在 → throw（loud，绝不留下悬空链接）。
 *
 * 幂等：已规范化的树再次调用不产生变化。
 */
export function normalizeSymlinks(rootDir) {
  if (!existsSync(rootDir)) return 0
  const realRoot = realpathSync(rootDir)
  const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep)
  let rewritten = 0
  const stack = [rootDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir)) {
      const entryPath = path.join(dir, entry)
      const lst = lstatSync(entryPath)
      if (lst.isSymbolicLink()) {
        const rawTarget = readlinkSync(entryPath)
        const resolved = path.resolve(path.dirname(entryPath), rawTarget)
        if (!existsSync(resolved)) {
          throw new Error(`符号链接目标不存在：${entryPath} -> ${rawTarget}`)
        }
        const real = realpathSync(resolved)
        if (inside(real)) {
          // 相对链接的基准必须与目标同为 realpath 拼写（macOS /tmp →
          // /private/tmp 这类别名否则会算出越界相对路径）。
          const baseDir = realpathSync(path.dirname(entryPath))
          const relative = path.relative(baseDir, real)
          if (relative !== rawTarget) {
            rmSync(entryPath, { force: true })
            symlinkSync(relative, entryPath)
            rewritten += 1
          }
          const st = statSync(entryPath)
          if (st.isDirectory()) stack.push(entryPath)
        } else {
          // 逃出树外：实体化（复制内容，不再是链接）。
          rmSync(entryPath, { recursive: true, force: true })
          cpSync(real, entryPath, { recursive: true, dereference: true })
          rewritten += 1
          if (statSync(entryPath).isDirectory()) stack.push(entryPath)
        }
      } else if (lst.isDirectory()) {
        stack.push(entryPath)
      }
    }
  }
  return rewritten
}

/**
 * 清掉历史 tsc emit 目标（packages/desktop/dist/sidecar）。
 * 该目录已无任何消费者，但 electron-builder 的 `dist` files glob 会把它打进
 * Electron 包，所以旧 checkout 上的遗留必须删除而不是留在那里（导出以便单测）。
 */
export function clearLegacySidecarEmit(emitDir) {
  rmSync(emitDir, { recursive: true, force: true })
}

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
    // copyTree（而非 cpSync）：保留树内相对链接、实体化树外链接——见其注释。
    copyTree(modules, path.join(destDir, 'node_modules'))
    // 兜底网：任何仍逃出树的链接一律实体化（签名/公证腿的硬前提）。
    normalizeSymlinks(path.join(destDir, 'node_modules'))
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
  if (existsSync(dist)) {
    // 同 copyVendorDsh：copyTree 保相对链接 + 实体化树外链接，再归一化兜底。
    copyTree(dist, path.join(destDir, 'dist'))
    normalizeSymlinks(path.join(destDir, 'dist'))
  }
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
    // 仅当调用方**显式**传入源目录时才在 dry-run 里严格校验：默认路径在
    // 干净 checkout 上不存在（.gitignore 只提交 vendor/dsh/pnpm-lock.yaml，
    // 由 release 腿的 bundle:dsh 物化）——严格校验会让 push CI 必红
    // （2026-09 二轮评审 major）。
    vendorDshExplicit: false,
    pnpmExplicit: false,
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
    else if (arg === '--vendor-dsh') {
      options.vendorDshDir = path.resolve(next())
      options.vendorDshExplicit = true
    }
    else if (arg === '--pnpm-dir') {
      options.pnpmDir = path.resolve(next())
      options.pnpmExplicit = true
    }
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
    '[1] tsc -p tsconfig.sidecar.build.json（编译闭包校验，noEmit）',
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
    const pin = resolvePinnedNodeDigest(archiveName, expected)
    if (pin.digest !== null) {
      expected = pin.digest
      log(`[build-sidecar] Node 归档摘要：${pin.source === 'pinned' ? '仓库固定表 PINNED_NODE_SHA256' : '--node-sha256'}（不读网络摘要）`)
    } else {
      // 未固定的版本：退回官方 SHASUMS256.txt，并响亮说明信任落在本次下载内容上。
      log(`[build-sidecar] ${archiveName} 未在仓库固定——回退 SHASUMS256.txt（v${options.nodeVersion}）；建议把该版本钉进 PINNED_NODE_SHA256`)
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

export async function runBuildSidecar(options, io = {}) {
  // 注入的 io 允许是部分实现（现有测试只给 log/error）；缺项回落控制台。
  // 否则「干净 checkout 缺 vendor/dsh 或 pnpm」的 warn 分支会 io.warn is not
  // a function —— 本地有 vendor/pnpm 永不触发，只在 CI 的 test-macos 上红
  // （2026-09 合并后首次 CI 实测）。
  io = { log: console.log, warn: console.warn, error: console.error, ...io }
  const layout = sidecarLayout(options.outDir)
  const plan = buildPlan(options)
  for (const step of plan) io.log(`  ${step}`)

  // 输入校验（dry-run 同样执行）。
  const tsconfig = path.join(desktopDir, 'tsconfig.sidecar.build.json')
  const sidecarEntry = path.join(desktopDir, 'sidecar-entry.ts')
  // 摘要冲突先于任何耗时工作失败：--node-sha256 与仓库固定值不一致时，下载/打包
  // 几十 MB 归档之后再报错是纯粹的浪费（判定与 bundleNode 同一纯函数，语义不分叉）。
  if (!options.skipNode && options.nodeSha256 !== null) {
    resolvePinnedNodeDigest(nodeArchiveName(options.nodeVersion, options.arch), options.nodeSha256)
  }
  // dry-run 的「输入校验」必须真的校验（2026-09 模块评审 minor：原实现只打印
  // 计划，`--node-archive /nope --vendor-dsh /nope` 也报"输入校验通过"）。
  if (options.dryRun) {
    if (options.nodeArchive !== null && !existsSync(options.nodeArchive)) {
      throw new Error(`--node-archive 不存在：${options.nodeArchive}`)
    }
    // 显式传入的源缺失 = 调用方写错路径 → 抛；默认源缺失 = 干净 checkout 的
    // 正常形态 → warn（release 腿在 build:sidecar 之前跑 bundle:dsh）。
    const vendorPresent = existsSync(path.join(options.vendorDshDir, 'package.json'))
    const pnpmPresent = existsSync(path.join(options.pnpmDir, 'bin', 'pnpm.cjs'))
    if (!options.skipVendor) {
      if (!vendorPresent && options.vendorDshExplicit) {
        throw new Error(`--vendor-dsh 源不存在：${options.vendorDshDir}`)
      }
      if (!pnpmPresent && options.pnpmExplicit) {
        throw new Error(`--pnpm-dir 源不存在：${options.pnpmDir}`)
      }
      if (!vendorPresent) {
        io.warn(`[build-sidecar] 警告：未找到内置 dsh 工作区 ${options.vendorDshDir}（干净 checkout 正常；release 腿先跑 bundle:dsh）`)
      }
      if (!pnpmPresent) {
        io.warn(`[build-sidecar] 警告：未找到 pnpm ${options.pnpmDir}（先 pnpm install）`)
      }
    }
  }

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

  // 0. skip 的诚实语义（见文件头）：每个被跳过的目的地先清空，跳过 = 缺位。
  if (options.skipBundle) rmSync(layout.entry, { force: true })
  if (options.skipHostPackages) rmSync(layout.dist, { recursive: true, force: true })
  if (options.skipVendor) {
    rmSync(layout.vendorDsh, { recursive: true, force: true })
    rmSync(layout.pnpm, { recursive: true, force: true })
  }
  if (options.skipNode) rmSync(layout.node, { force: true })
  // 历史 tsc emit 遗留：noEmit 之后本脚本不再生成它，旧目录必须消失（否则
  // electron-builder 的 dist/** glob 会把无人消费的编译产物打进 Electron 包）。
  clearLegacySidecarEmit(path.join(desktopDir, 'dist', 'sidecar'))

  // 1. tsc 编译闭包校验（Electron-free 家族可编译；noEmit，见 tsconfig）。
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

  // 3. 装配 <out>/dist：本脚本是这棵子树的**唯一写入者**（control-plane 拷贝 +
  // chamber host 包），所以整目录重建而非逐个覆盖——否则改名/删包之后，上一轮装
  // 配留下的目录会继续躺在装配里，并被 build-swift-app 原样拷进 .app 一起签名
  // 发布（实测：T2 包改名后三个旧 host 包目录仍留在 release/sidecar/dist）。
  rmSync(layout.dist, { recursive: true, force: true })
  mkdirSync(layout.dist, { recursive: true })

  // 3a. 拷贝 control-plane 编译产物。
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

  // 3c. chamber host 包（打包态 seed 源）。**fail closed**（2026-12 P2）：Electron
  // 侧同款拷贝（build-host-graph-package.mjs）缺产物直接 exit 1；这里过去只 warn，
  // 于是装配可以「成功」产出一个宿主域整体缺席、却自称完整的 .app。source 不存在
  // 或缺 dist/index.js 都是构建顺序错误，不是可降级状态；显式 --skip-host-packages
  // 才是表达「本次不要 host 包」的开关。
  if (options.skipHostPackages) {
    io.log('[build-sidecar] 跳过 host 包拷贝（--skip-host-packages）')
  } else {
    // 先全量检查再拷贝：缺第二个包时不得发布半新半旧的 host 包集合。
    assertHostPackageArtifacts(HOST_PACKAGES, (name) => path.join(repoRoot, 'packages', name))
    for (const host of HOST_PACKAGES) {
      const sourceDir = path.join(repoRoot, 'packages', host.name)
      const artifact = path.join(sourceDir, 'dist', 'index.js')
      const manifest = path.join(sourceDir, 'package.json')
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
      console.log('       [--node-version <v>] [--node-sha256 <hex>（覆盖仓库固定摘要，冲突即拒绝）]')
      console.log('       [--node-archive <tar.gz>] [--arch <arm64|x64>]')
      process.exit(0)
    }
    await runBuildSidecar(options)
  } catch (error) {
    console.error(`[build-sidecar] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
