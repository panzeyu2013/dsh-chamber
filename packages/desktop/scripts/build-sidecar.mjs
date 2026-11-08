#!/usr/bin/env node
/**
 * build-sidecar.mjs —— Swift flavor sidecar 打包（design 25 §3.2/§4.3）
 *
 * 产物布局（design 25 §3.2「sidecar 装配目录约定」）：
 *   <out>/sidecar.js               esbuild 打包的 sidecar 入口（含 shell-core
 *                                  全家 + sidecar-ctx + node-edges + dsh-runtime）
 *   <out>/dist/control-plane/…     build:control-plane 的编译产物（运行时经
 *                                  control-plane-module 的相对动态 import
 *                                  加载——包外裸说明符在打包态不可解析）
 *   <out>/primary-runtime/         全量 payload（python/node/pnpm）的拷贝；
 *   <out>/office-skills/           office 技能资产的拷贝（8 个 markdown）。
 *                                  **单 Node 裁决（swift-impl-contract）**：不再
 *                                  下载/固定/重命名独立 Node，也没有
 *                                  `dsh-chamber-helper`——装配内唯一的 Node 就是
 *                                  payload 的
 *                                  `primary-runtime/dependencies/node/bin/node`
 *                                  （Swift 用它启动 sidecar.js，托管 dsh 用同一
 *                                  process.execPath；进程名就是 node，归因按
 *                                  design 25 §4.3 A5 的应用派生关系，不靠基名）。
 *
 * 步骤：
 *   1. tsc -p tsconfig.sidecar.build.json —— 编译闭包校验（noEmit；Electron-free
 *      家族全家可编译；失败即 loud 中止，不产出半成品。这一步不 emit：
 *      packages/desktop/dist/sidecar 没有运行期消费者，而 electron-builder
 *      的 dist/** files glob 会把它打进 Electron 包）；
 *   2. esbuild 打包 sidecar-entry.ts → sidecar.js（platform=node、format=esm、
 *      target=node22；external：@dsh-chamber/control-plane / electron /
 *      ./dist/control-plane/index.js——三者都在运行期由装配目录解析）；
 *   3. 拷贝 dist/control-plane → <out>/dist/control-plane；
 *   4. payload 门控（不再下载 Node）：python 载荷整目录拷贝 → 按需断言
 *      `dependencies/node/bin/node`（--require-node）与
 *      `dependencies/pnpm/bin/pnpm.mjs`（--require-pnpm）→ office 技能资产拷贝
 *      （--require-office-assets 时缺件 fail-closed）。
 *
 * 离线/无网：--skip-node 表达「本次不要求 payload node」（dev/CI 的
 * compiled-sidecar smoke 用调用者 node 启动 sidecar.js）；--dry-run 只打印计划与
 * 输入校验，不写盘、不联网。
 * **--skip-* 的诚实语义**：<out> 是持久装配目录，跳过必须产生
 * **缺位**，而不是继承既有的产物——每个 skip 开关在开工前清掉自己的目标
 * （sidecar.js / vendor+dsh / dist / office-skills），否则残留产物会留在
 * 装配里被 .app 一起签名发布，而构建日志却声称「已跳过」。改名前的 `node` 与
 * 旧的 `dsh-chamber-helper` 在开工时清除一次（旧装配目录是持久目录）。
 * **缺源的诚实语义**：不跳过的源缺失不是可降级状态——vendor/dsh
 * 或 pnpm 源不存在时在**任何写盘之前** fail closed（既有产物绝不冒充构建结果）；
 * pnpm 源还必须是仓库 pin 的版本（desktop dependencies.pnpm，Electron 侧同源）。
 *
 * 运行期标记：Swift Supervisor spawn `<sidecar>/sidecar.js` 时必须带
 * `DSH_CHAMBER_SIDECAR_COMPILED=1`（control-plane-module.isPackagedSidecarRuntime）
 * ——装配目录无 node_modules 树，裸说明符 `@dsh-chamber/control-plane` 不可解析，
 * 必须走 <sidecar>/dist/control-plane/index.js 的相对入口。
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyPayload } from './prepare-python-payload.mjs'
import { verifyOfficeAssets } from './prepare-office-assets.mjs'
import { isCliEntry, runCliTool } from '../../../scripts/lib/cli.mjs'
import { payloadNodePath } from '../../../scripts/lib/sidecar-assembly.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')
const repoRoot = path.resolve(desktopDir, '..', '..')

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
    // primary-runtime 全量 payload（python/node/pnpm）：与 Electron 侧
    // extraResources 同布局同内容——<out>/primary-runtime 随 build-swift-app 拷进
    // Contents/Resources/sidecar。**装配内唯一的 Node 就在它里面**：单 Node 裁决
    // 取消了独立 dsh-chamber-helper，Swift 用 payload node 启动 sidecar.js。
    primaryRuntime: path.join(outDir, 'primary-runtime'),
    payloadNode: payloadNodePath(outDir),
    payloadPnpmEntry: path.join(outDir, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    // office 技能资产（8 个 markdown）：与 Electron extraResources 同布局，
    // 随 build-swift-app 进 Contents/Resources/sidecar/office-skills。
    officeSkills: path.join(outDir, 'office-skills'),
  }
}

/** Electron extraResources 同款过滤器：vendor/dsh 只带清单三件 + node_modules。 */
export const VENDOR_DSH_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
/** Electron extraResources 同款过滤器：pnpm 只带 package.json + bin/pnpm.{cjs,mjs} + dist。 */
export const PNPM_BIN_FILES = ['pnpm.cjs', 'pnpm.mjs']

/**
 * 内嵌 pnpm 的版本 pin：**单一来源** = desktop package.json 的
 * `dependencies.pnpm`。Electron 侧 after-pack 的运行时校验
 * （after-pack-adhoc-sign.mjs 的 PACKAGED_PNPM_VERSION）读同一个来源，
 * build-sidecar.test.mjs 断言两者逐一相等——任一处的版本注释漂移都会红。
 * @param {object} [manifest] - desktop package.json（测试可注入）。
 * @returns {string} 期望的 pnpm 版本。
 */
export function resolvePnpmPin(manifest = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))) {
  const version = manifest !== null && typeof manifest === 'object' && manifest.dependencies !== undefined
    ? manifest.dependencies.pnpm
    : undefined
  if (typeof version !== 'string' || version === '') {
    throw new Error('desktop package.json 缺少 dependencies.pnpm —— sidecar 内嵌 pnpm 的版本 pin 无来源（G18）')
  }
  return version
}

/** 构建期望的内嵌 pnpm 版本（Electron 侧同一来源，见 after-pack）。 */
export const PNPM_PINNED_VERSION = resolvePnpmPin()

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
 * 背景：Node 的 `fs.cpSync`（含
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
          // 逃出树外：实体化（复制内容，不是链接）。
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
 * 清掉 tsc emit 目标（packages/desktop/dist/sidecar）。
 * 该目录没有消费者，但 electron-builder 的 `dist` files glob 会把它打进
 * Electron 包，所以检出中存在的遗留必须删除而不是留在那里（导出以便单测）。
 */
export function clearLegacySidecarEmit(emitDir) {
  rmSync(emitDir, { recursive: true, force: true })
}

/**
 * vendor/dsh 的版本 + 平台装配断言——Electron after-pack 的
 * verifyPackagedDshRuntime 同款两问：
 *   ① runtime manifest 记录的 @deepseek-ai/dsh 版本 == 包内 node_modules 里
 *      dsh 自己的 version（防拼接了别的 dsh 版本）；
 *   ② runtime manifest 的 dsh.platform 以 `<platform>-` 开头（防把别的平台
 *      烘焙的运行时装进 .app）。
 * 漂移的 vendor 树本可过全部门禁；本函数在任何写盘之前对源、拷贝之后再对产物各断一次。
 * @param {string} vendorDir - vendor/dsh 目录。
 * @param {string} [platform] - 期望平台前缀（构建宿主，测试可注入）。
 * @returns {{ version: string, platform: string }} 已验证的运行时事实。
 */
export function verifyVendorDshRuntime(vendorDir, platform = process.platform) {
  const runtimeManifestPath = path.join(vendorDir, 'package.json')
  const dshManifestPath = path.join(vendorDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(runtimeManifestPath) || !existsSync(dshManifestPath)) {
    throw new Error(
      `vendor/dsh 装配不完整：缺少 ${!existsSync(runtimeManifestPath) ? runtimeManifestPath : dshManifestPath}（G39）`,
    )
  }
  const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
  const dshManifest = JSON.parse(readFileSync(dshManifestPath, 'utf8'))
  const recordedVersion = runtimeManifest.dependencies?.['@deepseek-ai/dsh']
  if (recordedVersion !== dshManifest.version) {
    throw new Error(
      `vendor/dsh 版本漂移：runtime manifest=${JSON.stringify(recordedVersion)}，包内 dsh=${JSON.stringify(dshManifest.version)}`
      + '（G39；与 Electron afterPack 的 verifyPackagedDshRuntime 同款断言）',
    )
  }
  if (typeof runtimeManifest.dsh?.platform !== 'string' || !runtimeManifest.dsh.platform.startsWith(`${platform}-`)) {
    throw new Error(
      `vendor/dsh 平台漂移：期望 ${platform}-*，实际 ${JSON.stringify(runtimeManifest.dsh?.platform)}（G39）`,
    )
  }
  // LibreOffice 引擎载荷完整性（G39 延伸）：dsh 运行时闭包必须带 kit 闭包与
  // 目标平台引擎包——缺引擎不会让构建变红，只会在运行期让 office 的
  // convert/recalculate/render 静默降级（cli:false），故构建期 fail-closed。
  const kitDir = path.join(vendorDir, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  if (!existsSync(kitDir)) {
    throw new Error(
      'vendor/dsh 缺 @deepseek-ai/libreoffice-kit 闭包——office 能力会静默不可用（若确为旧 pin，先升级 pin 并重建 runtime）'
      + '（G39/LibreOffice 载荷断言）',
    )
  }
  {
    const enginePackage = runtimeManifest.dsh.platform.startsWith('linux-')
      ? 'libreoffice-kit-wasm'
      : `libreoffice-kit-${runtimeManifest.dsh.platform}`
    const engineDir = path.join(vendorDir, 'node_modules', '@deepseek-ai', enginePackage)
    const prebuildsPath = path.join(engineDir, 'prebuilds.json')
    let engineManifest = null
    try {
      engineManifest = JSON.parse(readFileSync(prebuildsPath, 'utf8'))
    } catch {
      engineManifest = null
    }
    const engineKind = engineManifest?.engine?.kind
    const engineEntry = engineKind === 'native' ? engineManifest?.engine?.executable
      : engineKind === 'wasm' ? engineManifest?.engine?.loader
        : undefined
    if (!existsSync(engineDir) || engineManifest === null
      || typeof engineEntry !== 'string' || engineEntry === ''
      || !existsSync(path.join(engineDir, engineEntry))) {
      throw new Error(
        `vendor/dsh 缺少目标平台的 LibreOffice 引擎：${enginePackage}（期望 ${engineDir}，其 prebuilds.json 声明 native executable 或 wasm loader 且文件在场）`
        + '——G39/LibreOffice 载荷断言',
      )
    }
  }
  return { version: recordedVersion, platform: runtimeManifest.dsh.platform }
}

/** 拷贝内置 dsh 工作区（缺源时返回 false；调用方 fail closed，见 runBuildSidecar）。
 *  版本/平台漂移的 vendor 树在任何写盘之前 fail closed，拷贝产物再验一次。 */
export function copyVendorDsh(sourceDir, destDir, { platform = process.platform } = {}) {
  const manifest = path.join(sourceDir, 'package.json')
  if (!existsSync(manifest)) return false
  verifyVendorDshRuntime(sourceDir, platform)
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
  verifyVendorDshRuntime(destDir, platform)
  return true
}

/**
 * 拷贝内嵌 pnpm（缺源时返回 false）。**版本 fail-closed**：源的
 * package.json 必须 name=pnpm 且 version == 仓库 pin（desktop dependencies.pnpm，
 * 与 Electron after-pack 的运行时校验同一来源），否则 throw——绝不让一个与
 * Electron extraResources 不同版本的 pnpm 混进 Swift 装配并随 .app 签名发布。
 * @param {string} sourceDir - pnpm 包目录。
 * @param {string} destDir - 装配目标。
 * @param {object} [options] - { expectedVersion } 测试可注入。
 * @returns {boolean} 源存在并已拷贝。
 */
export function copyPnpm(sourceDir, destDir, { expectedVersion = PNPM_PINNED_VERSION } = {}) {
  const manifest = path.join(sourceDir, 'package.json')
  const entry = path.join(sourceDir, 'bin', 'pnpm.cjs')
  if (!existsSync(manifest) || !existsSync(entry)) return false
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  if (parsed.name !== 'pnpm') {
    throw new Error(`内嵌 pnpm 源不是 pnpm 包：${manifest}（name=${JSON.stringify(parsed.name)}）`)
  }
  if (parsed.version !== expectedVersion) {
    throw new Error(
      `内嵌 pnpm 版本漂移：源 ${String(parsed.version)} != 仓库 pin ${String(expectedVersion)}`
      + '（desktop package.json dependencies.pnpm；与 Electron after-pack 校验同一来源）',
    )
  }
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


/**
 * 拷贝 office 技能资产（缺源时返回 false，与 copyVendorDsh/copyPnpm 同姿态）。
 * 替换式落位：先清目标（跳过 = 缺位），拷贝后断言 office/SKILL.md；发布腿用
 * --require-office-assets 把缺件升级为 fail-closed。
 * @param {string} sourceDir - 资产源（prepare:office-assets 的产物目录）。
 * @param {string} destDir - 装配目标 <out>/office-skills。
 * @param {{ requireAssets?: boolean }} [options] - true = 缺件 fail-closed（发布腿）。
 * @returns {boolean} 源完整并已拷贝。
 */
export function copyOfficeAssets(sourceDir, destDir, { requireAssets = false } = {}) {
  const assets = verifyOfficeAssets(sourceDir)
  if (!assets.ok && requireAssets) {
    throw new Error(`--require-office-assets 但 office 技能资产不可用（${sourceDir}）：${assets.problems.join('；')}`)
  }
  rmSync(destDir, { recursive: true, force: true })
  if (!assets.ok) return false
  copyTree(sourceDir, destDir)
  if (!existsSync(path.join(destDir, 'office', 'SKILL.md'))) {
    throw new Error(`office 技能资产拷贝不完整：${path.join(destDir, 'office', 'SKILL.md')}`)
  }
  return true
}

export function parseBuildSidecarArgs(argv) {
  const options = {
    outDir: path.join(desktopDir, 'release', 'sidecar'),
    dryRun: false,
    // 单 Node 裁决：--skip-node 只表达「本次不要求 payload node」（dev/CI 的
    // compiled-sidecar smoke 用调用者 node 启动 sidecar.js），不再有独立 Node 下载。
    skipNode: false,
    requireNode: false,
    requirePnpm: false,
    skipBundle: false,
    skipHostPackages: false,
    skipVendor: false,
    skipPython: false,
    requirePython: false,
    skipOfficeAssets: false,
    requireOfficeAssets: false,
    pythonPayloadDir: path.join(desktopDir, 'resources', 'primary-runtime'),
    officeAssetsDir: path.join(desktopDir, 'resources', 'office-skills'),
    vendorDshDir: path.join(desktopDir, 'vendor', 'dsh'),
    pnpmDir: path.join(desktopDir, 'node_modules', 'pnpm'),
    // 仅当调用方**显式**传入源目录时才在 dry-run 里严格校验：默认路径在
    // 干净 checkout 上不存在（.gitignore 只提交 vendor/dsh/pnpm-lock.yaml，
    // 由 release 腿的 bundle:dsh 物化）——严格校验会让 push CI 必红。
    vendorDshExplicit: false,
    pnpmExplicit: false,
    officeAssetsExplicit: false,
    // payload 目标架构声明（--arch 保留以兼容发布腿 argv）：payload 存在时与
    // runtime.json 的 platform/arch 比对；payload node 的真实架构由
    // build-swift-app 的 lipo 断言覆盖（单 Node 后 node 就在 payload 里）。
    arch: null,
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
    else if (arg === '--require-node') options.requireNode = true
    else if (arg === '--require-pnpm') options.requirePnpm = true
    else if (arg === '--skip-bundle') options.skipBundle = true
    else if (arg === '--skip-host-packages') options.skipHostPackages = true
    else if (arg === '--skip-vendor') options.skipVendor = true
    else if (arg === '--skip-python') options.skipPython = true
    else if (arg === '--require-python') options.requirePython = true
    else if (arg === '--skip-office-assets') options.skipOfficeAssets = true
    else if (arg === '--require-office-assets') options.requireOfficeAssets = true
    else if (arg === '--python-payload') options.pythonPayloadDir = path.resolve(next())
    else if (arg === '--office-assets') {
      options.officeAssetsDir = path.resolve(next())
      options.officeAssetsExplicit = true
    }
    else if (arg === '--vendor-dsh') {
      options.vendorDshDir = path.resolve(next())
      options.vendorDshExplicit = true
    }
    else if (arg === '--pnpm-dir') {
      options.pnpmDir = path.resolve(next())
      options.pnpmExplicit = true
    }
    else if (arg === '--arch') {
      const arch = next()
      // 架构白名单（对照 build-swift-app.mjs 的同款校验）：拼错或空值会一路
      // 传进 payload 目标断言与发布腿产物，失败点距参数很远。
      if (arch !== 'arm64' && arch !== 'x64') throw new Error(`--arch 只接受 arm64|x64，收到：${arch}`)
      options.arch = arch
    }
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  for (const [skip, require, label] of [
    ['skipNode', 'requireNode', 'node'],
    ['skipPython', 'requirePython', 'python'],
    ['skipOfficeAssets', 'requireOfficeAssets', 'office-assets'],
  ]) {
    if (options[skip] === true && options[require] === true) {
      throw new Error('--skip-' + label + ' 与 --require-' + label + ' 互斥：skip 表达「本次不要求」')
    }
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
  // 单 Node 裁决：不再有「Node 捆绑」步骤；装配内唯一的 Node 来自 payload。
  if (options.skipPython) steps.push('[4] 跳过 python 载荷（--skip-python）')
  else {
    steps.push(`[4] python 载荷：${options.pythonPayloadDir} → ${layout.primaryRuntime}`
      + (options.requirePython ? '（--require-python：缺件 fail-closed）' : '（未准备则跳过；发布腿用 --require-python）'))
  }
  if (options.skipNode) steps.push('[4a] 跳过 payload node 要求（--skip-node：dev/CI 用调用者 node 启动 sidecar.js）')
  else if (options.requireNode) steps.push(`[4a] 断言 payload node：${layout.payloadNode}（--require-node：缺件 fail-closed）`)
  else steps.push(`[4a] payload node：${layout.payloadNode}（未要求；发布腿用 --require-node）`)
  if (options.requirePnpm) steps.push(`[4b] 断言 payload pnpm：${layout.payloadPnpmEntry}（--require-pnpm：缺件 fail-closed）`)
  else steps.push(`[4b] payload pnpm：${layout.payloadPnpmEntry}（未要求；发布腿用 --require-pnpm）`)
  if (options.arch !== null) {
    steps.push(`[4c] payload 目标架构：darwin-${options.arch}（与 runtime.json 比对；payload node 的真实架构由 build-swift-app lipo 断言）`)
  }
  if (options.skipOfficeAssets) steps.push('[4d] 跳过 office 技能资产（--skip-office-assets）')
  else {
    steps.push(`[4d] office 技能资产：${options.officeAssetsDir} → ${layout.officeSkills}`
      + (options.requireOfficeAssets ? '（--require-office-assets：缺件 fail-closed）' : '（未准备则跳过；发布腿用 --require-office-assets）'))
  }
  steps.push('[5] 断言：sidecar.js / dist/control-plane / package.json 产物存在')
  return steps
}

/**
 * payload 内 node/pnpm 的按需断言（纯函数，导出以便单测）。单 Node 裁决后装配
 * **不下载任何 Node**：--require-node/--require-pnpm 只核对
 * prepare-python-payload 产出的 payload 是否真的带齐（--with-node / --with-pnpm）。
 * @param {string} payloadDir - primary-runtime 目录（源或装配拷贝）。
 * @param {{ requireNode?: boolean, requirePnpm?: boolean, skipNode?: boolean }} [options]
 * @returns {{ ok: boolean, node: string, pnpm: string, problems: string[] }}
 */
export function verifyPayloadNodeAndPnpm(payloadDir, options = {}) {
  const node = path.join(payloadDir, 'dependencies', 'node', 'bin', 'node')
  const pnpm = path.join(payloadDir, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  const problems = []
  if (options.skipNode !== true && options.requireNode === true) {
    if (!existsSync(node)) {
      problems.push('缺 payload node：' + node + '（prepare-python-payload 需 --with-node）')
    } else if (!statSync(node).isFile()) {
      problems.push('payload node 不是常规文件：' + node)
    } else if ((statSync(node).mode & 0o111) === 0) {
      problems.push('payload node 没有可执行位：' + node
        + '（mode ' + (statSync(node).mode & 0o777).toString(8) + '）')
    }
  }
  if (options.requirePnpm === true && !existsSync(pnpm)) {
    problems.push('缺 payload pnpm：' + pnpm + '（prepare-python-payload 需 --with-pnpm）')
  }
  return { ok: problems.length === 0, node, pnpm, problems }
}

/**
 * payload 目标架构断言（--arch 保留的语义）：runtime.json 存在且 complete 时，
 * platform 必须是 darwin、arch 必须等于声明的 --arch——防止把别的目标架构的
 * payload 装进 macOS .app（单 Node 后 payload node 的真实架构由 build-swift-app
 * 的 lipo 断言复核）。payload 未准备时返回 null（是否要求由 --require-* 决定）。
 * @param {string} payloadDir - primary-runtime 目录。
 * @param {string | null} arch - 声明的目标架构（--arch）。
 * @returns {string | null} 已断言的 payload arch。
 */
export function assertPayloadTarget(payloadDir, arch) {
  if (arch === null || arch === undefined) return null
  const manifestPath = path.join(payloadDir, 'runtime.json')
  if (!existsSync(manifestPath)) return null
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error('payload runtime.json 不是合法 JSON（' + manifestPath + '）：'
      + (error instanceof Error ? error.message : String(error)))
  }
  if (manifest.payload !== 'complete') return null
  if (manifest.platform !== 'darwin') {
    throw new Error('payload 目标平台不是 darwin：' + JSON.stringify(manifest.platform) + '（' + manifestPath + '）')
  }
  if (manifest.arch !== arch) {
    throw new Error('payload 目标架构 ' + JSON.stringify(manifest.arch) + ' != --arch ' + arch + '（' + manifestPath + '）')
  }
  return manifest.arch
}

function resolveEsbuild() {
  const requireFromRenderer = createRequire(
    fileURLToPath(new URL('../../renderer/package.json', import.meta.url)),
  )
  const viteEntry = requireFromRenderer.resolve('vite')
  return createRequire(viteEntry).resolve('esbuild')
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

export async function runBuildSidecar(options, io = {}) {
  // 注入的 io 允许是部分实现（现有测试只给 log/error）；缺项回落控制台。
  // 否则「干净 checkout 缺 vendor/dsh 或 pnpm」的 warn 分支会 io.warn is not
  // a function —— 本地有 vendor/pnpm 永不触发，只在 CI 的 test-macos 上红。
  io = { log: console.log, warn: console.warn, error: console.error, ...io }
  const layout = sidecarLayout(options.outDir)
  const plan = buildPlan(options)
  for (const step of plan) io.log(`  ${step}`)

  // 输入校验（dry-run 同样执行）。
  const tsconfig = path.join(desktopDir, 'tsconfig.sidecar.build.json')
  const sidecarEntry = path.join(desktopDir, 'sidecar-entry.ts')
  // dry-run 的「输入校验」必须真的校验：只打印计划的实现会让
  // `--office-assets /nope --vendor-dsh /nope` 也报"输入校验通过"。
  if (options.dryRun) {
    // 显式传入的源缺失 = 调用方写错路径 → 抛；默认源缺失 = 干净 checkout 的
    // 正常形态 → warn（release 腿在 build:sidecar 之前跑 bundle:dsh）。
    const vendorPresent = existsSync(path.join(options.vendorDshDir, 'package.json'))
    const pnpmPresent = existsSync(path.join(options.pnpmDir, 'bin', 'pnpm.cjs'))
    if (!options.skipPython) {
      const payload = verifyPayload(options.pythonPayloadDir)
      if (!payload.ok && options.requirePython) {
        throw new Error(`--require-python 但 python 载荷不可用（${options.pythonPayloadDir}）：${payload.problems.join('；')}`)
      }
      if (!payload.ok) {
        io.warn(`[build-sidecar] 警告：python 载荷未准备（${payload.problems[0]}）——发布腿必须 --require-python`)
      }
    }
    // 单 Node：node/pnpm 要求只核对 payload 内容（不下载任何 Node）。
    const components = verifyPayloadNodeAndPnpm(options.pythonPayloadDir, options)
    if (!components.ok) {
      throw new Error(`payload node/pnpm 不可用（${options.pythonPayloadDir}）：${components.problems.join('；')}`)
    }
    assertPayloadTarget(options.pythonPayloadDir, options.arch)
    if (!options.skipOfficeAssets) {
      if (options.officeAssetsExplicit && !existsSync(options.officeAssetsDir)) {
        throw new Error(`--office-assets 源不存在：${options.officeAssetsDir}`)
      }
      const assets = verifyOfficeAssets(options.officeAssetsDir)
      if (!assets.ok && options.requireOfficeAssets) {
        throw new Error(`--require-office-assets 但 office 技能资产不可用（${options.officeAssetsDir}）：${assets.problems.join('；')}`)
      }
      if (!assets.ok) {
        io.warn(`[build-sidecar] 警告：office 技能资产未准备（${assets.problems[0]}）——发布腿必须先跑 prepare:office-assets`)
      }
    }
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

  // 非 dry-run 的 vendor/pnpm 缺源 **fail closed**：<out> 是持久
  // 装配目录，残留的 vendor/dsh 与 pnpm 留在那里会被 build-swift-app 原样拷进 .app
  // 一起签名发布，而构建日志只 warn「未找到源」——这正是假成功。
  // 显式 --skip-vendor 才表达「不要 vendor」（它先清缺位再跳过）。
  // 检查在任何写盘之前：失败不产出半新半旧的装配。
  if (!options.skipVendor) {
    if (!existsSync(path.join(options.vendorDshDir, 'package.json'))) {
      throw new Error(
        `内置 dsh 工作区源不存在：${options.vendorDshDir}`
        + '（先跑 bundle:dsh；或显式 --skip-vendor 表达本次不要 vendor）',
      )
    }
    if (!existsSync(path.join(options.pnpmDir, 'bin', 'pnpm.cjs'))) {
      throw new Error(`内嵌 pnpm 源不存在：${options.pnpmDir}（先 pnpm install；或显式 --skip-vendor）`)
    }
  }

  mkdirSync(layout.outDir, { recursive: true })

  // 0. 迁移清理：旧布局的独立 Node 产物（<out>/node 与 dsh-chamber-helper）会被
  // build-swift-app 原样拷进 .app 一起签名发布；单 Node 裁决后它们不再被任何运行期
  // 解析（装配内唯一的 Node 在 payload 里），必须从持久装配目录清掉。
  rmSync(path.join(layout.outDir, 'node'), { force: true })
  rmSync(path.join(layout.outDir, 'dsh-chamber-helper'), { force: true })
  // skip 的诚实语义（见文件头）：每个被跳过的目的地先清空，跳过 = 缺位。
  if (options.skipBundle) rmSync(layout.entry, { force: true })
  if (options.skipHostPackages) rmSync(layout.dist, { recursive: true, force: true })
  if (options.skipVendor) {
    rmSync(layout.vendorDsh, { recursive: true, force: true })
    rmSync(layout.pnpm, { recursive: true, force: true })
  }
  // --skip-node 不再产/清任何独立 Node（单 Node）：它只表达「不要求 payload node」。
  // python 载荷的跳过 = 清空缺位（持久 <out> 里的旧载荷会被 build-swift-app 原样
  // 拷进 .app 一起签名发布）；payload 里的 node/pnpm 随之一起缺位。
  if (options.skipPython) rmSync(layout.primaryRuntime, { recursive: true, force: true })
  if (options.skipOfficeAssets) rmSync(layout.officeSkills, { recursive: true, force: true })
  // tsc emit 遗留：本脚本的 tsc 步是 noEmit，不生成它；该目录必须消失（否则
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
  // chamber host 包），所以整目录重建而非逐个覆盖——否则改名/删包之后，既有装配
  // 留下的目录会继续躺在装配里，并被 build-swift-app 原样拷进 .app 一起签名
  // 发布。
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

  // 3c. chamber host 包（打包态 seed 源）。**fail closed**：Electron
  // 侧同款拷贝（build-host-graph-package.mjs）缺产物直接 exit 1；只 warn 时
  // 装配可以「成功」产出一个宿主域整体缺席、却自称完整的 .app。source 不存在
  // 或缺 dist/index.js 都是构建顺序错误，不是可降级状态；显式 --skip-host-packages
  // 才表达「不要 host 包」。
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
    // 前置已在写盘前检查缺源；这里是兜底（源在检查与拷贝之间消失/竞态时，
    // 绝不留下既有产物冒充构建结果）。
    if (!copyVendorDsh(options.vendorDshDir, layout.vendorDsh)) {
      throw new Error(`内置 dsh 工作区源不存在：${options.vendorDshDir}（先跑 bundle:dsh；或显式 --skip-vendor）`)
    }
    io.log(`[build-sidecar] vendor/dsh → ${layout.vendorDsh}`)
    if (!copyPnpm(options.pnpmDir, layout.pnpm)) {
      throw new Error(`内嵌 pnpm 源不存在：${options.pnpmDir}（先 pnpm install；或显式 --skip-vendor）`)
    }
    io.log(`[build-sidecar] pnpm → ${layout.pnpm}`)
  }

  // 4. python 载荷（可选；发布腿用 --require-python 让缺件变红）。单 Node 裁决后，
  // payload 同时是 node（--with-node）与 pnpm（--with-pnpm）的唯一来源，
  // --require-node/--require-pnpm 因此核对**拷贝后的装配目录**（与源同一内容）。
  if (options.skipPython) {
    io.log('[build-sidecar] 跳过 python 载荷（--skip-python）')
  } else {
    const payload = verifyPayload(options.pythonPayloadDir)
    if (!payload.ok && options.requirePython) {
      throw new Error(`--require-python 但 python 载荷不可用（${options.pythonPayloadDir}）：${payload.problems.join('；')}`)
    }
    rmSync(layout.primaryRuntime, { recursive: true, force: true })
    if (!payload.ok) {
      io.log(`[build-sidecar] python 载荷未准备，跳过（${payload.problems[0]}）——发布腿必须 --require-python`)
    } else {
      copyTree(options.pythonPayloadDir, layout.primaryRuntime)
      io.log(`[build-sidecar] python 载荷（target=${String(payload.target)}）→ ${layout.primaryRuntime}`)
    }
  }

  // 4a/4b. payload node/pnpm 门控（只核对内容，不下载任何 Node）。
  const components = verifyPayloadNodeAndPnpm(layout.primaryRuntime, options)
  if (!components.ok) {
    throw new Error(`payload node/pnpm 不可用（${layout.primaryRuntime}）：${components.problems.join('；')}`)
  }
  if (options.skipNode) {
    io.log('[build-sidecar] 跳过 payload node 要求（--skip-node：dev/CI 用调用者 node 启动 sidecar.js）')
  } else if (existsSync(components.node)) {
    io.log(`[build-sidecar] payload node → ${components.node}`)
  } else {
    io.log(`[build-sidecar] payload node 未就绪（${components.node}）——发布腿必须 --require-node`)
  }
  if (existsSync(components.pnpm)) {
    io.log(`[build-sidecar] payload pnpm → ${components.pnpm}`)
  } else {
    io.log(`[build-sidecar] payload pnpm 未就绪（${components.pnpm}）——发布腿必须 --require-pnpm`)
  }
  assertPayloadTarget(layout.primaryRuntime, options.arch)

  // 4c. office 技能资产（可选；发布腿用 --require-office-assets 让缺件变红）。
  // 缺件默认只跳过：本地/未 prepare 的装配不应因此失败，但 release 腿先跑
  // prepare:office-assets 并用 --require-office-assets 把缺件变成红。
  if (options.skipOfficeAssets) {
    io.log('[build-sidecar] 跳过 office 技能资产（--skip-office-assets）')
  } else {
    const copied = copyOfficeAssets(options.officeAssetsDir, layout.officeSkills, {
      requireAssets: options.requireOfficeAssets,
    })
    if (copied) {
      io.log(`[build-sidecar] office 技能资产 → ${layout.officeSkills}`)
    } else {
      io.log(`[build-sidecar] office 技能资产未准备，跳过（先把 assets 准备到 ${options.officeAssetsDir}）——发布腿必须 --require-office-assets`)
    }
  }

  // 5. 终态断言：装配产物必须真的落盘（--skip-* 的缺位已在上面显式产生）。
  if (!options.skipBundle && !existsSync(layout.entry)) {
    throw new Error(`装配产物缺失：sidecar.js（${layout.entry}）`)
  }
  for (const [label, file] of [
    ['dist/control-plane/index.js', layout.controlPlaneEntry],
    ['package.json', layout.packageJson],
  ]) {
    if (!existsSync(file)) throw new Error(`装配产物缺失：${label}（${file}）`)
  }
  io.log(`[build-sidecar] 完成：${layout.outDir}`)
  return { dryRun: false, layout }
}

if (isCliEntry(import.meta.url)) {
  await runCliTool({
    label: 'build-sidecar',
    usage: [
      '用法：build-sidecar.mjs [--out <dir>] [--dry-run] [--arch <arm64|x64>]',
      '       [--skip-node（不要求 payload node，dev/CI 用调用者 node）]',
      '       [--skip-bundle] [--skip-host-packages] [--skip-vendor] [--skip-python]',
      '       [--skip-office-assets] [--vendor-dsh <dir>] [--pnpm-dir <dir>]',
      '       [--python-payload <dir>] [--office-assets <dir>]',
      '       [--require-python] [--require-node] [--require-pnpm] [--require-office-assets] [--help]',
    ],
    parse: parseBuildSidecarArgs,
    run: runBuildSidecar,
  })
}
