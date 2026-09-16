#!/usr/bin/env node
/**
 * build-swift-app.mjs —— Swift 原生壳 .app 打包（W-24；design 25 §3.2/§8.4）
 *
 * 产物布局（SwiftPM 可执行 + 资源包 + W-23 装配 sidecar）：
 *   <out>/DSHChamberPoc.app/Contents/
 *     Info.plist                      ← macos/Info.plist.template（__VERSION__ 替换）
 *     MacOS/DSHChamberPoc             ← swift build -c release 产物
 *     Resources/
 *       icon.icns                     ← packages/desktop/resources/icon.icns（平移）
 *       DSHChamberPoc_DSHChamberPoc.bundle   ← SwiftPM 资源包（bridge-shim 等）；
 *         **必须放 Contents/Resources**（放 .app 根会被 codesign 判为未密封内容）
 *       sidecar/{node,sidecar.js,package.json,dist/…}   ← W-23 build-sidecar 产物
 *       dist/web/                     ← renderer 产物（可选；sidecar 静态伺服）
 *
 * 步骤：swift build（可 --skip-build）→ 组装（sidecar 必须自带可执行 node 与
 * sidecar.js，build 时断言）→ 架构一致性断言（.app 可执行 vs 捆绑 node，lipo；
 * build-sidecar 缺省 darwin-arm64 而 swift build 跟随宿主——不一致的 .app 过去能
 * 签名打包、运行时才崩）→ Info.plist 渲染（plutil -lint）→ 嵌套签名
 * （sidecar/node，Developer ID 时带 hardened runtime + node 权限）→ 主签名
 * （--identity 缺省 ad-hoc `-`）→ zip（ditto）/ dmg（hdiutil，卷内含
 * /Applications 快捷方式）。
 *
 * 离线/沙箱：--skip-build 复用已有 .build 产物；--skip-sidecar 允许无 W-23
 * 产物时只验壳装配（此时不做 node 架构比对）；--no-sign/--no-dmg/--no-zip
 * 分步跳过。
 *
 * 注意（2026-09 实测）：entitlements plist **不能带 XML 注释**——codesign 的
 * AMFIUnserializeXML 解析器对注释/非 ASCII 文本直接报
 * "Failed to parse entitlements"；权限集理由写在 design 25 §4.3/§8.4 与
 * STATUS，不写在 plist 里。
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 共享装配 seam（monorepo 内相对导入，同 packages/desktop/scripts/
// build-swift-app.test.mjs 的反向引用）：bundle 内符号链接归一化必须与 W-23
// sidecar 装配同源，绝不允许两份实现漂移。
import { copyTree, normalizeSymlinks } from '../../packages/desktop/scripts/build-sidecar.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const macosDir = path.resolve(here, '..')
const repoRoot = path.resolve(macosDir, '..')
const desktopDir = path.join(repoRoot, 'packages', 'desktop')

export const APP_NAME = 'DSHChamberPoc'
/** SwiftPM 资源包名（target 名重复一次，见 Package.swift target DSHChamberPoc）。 */
export const RESOURCE_BUNDLE_NAME = `${APP_NAME}_${APP_NAME}.bundle`

export function appLayout(outDir, appName = APP_NAME, artifactBasename = APP_NAME) {
  const appDir = path.join(outDir, `${appName}.app`)
  const contentsDir = path.join(appDir, 'Contents')
  const resourcesDir = path.join(contentsDir, 'Resources')
  return {
    outDir,
    appDir,
    contentsDir,
    macOsDir: path.join(contentsDir, 'MacOS'),
    resourcesDir,
    infoPlist: path.join(contentsDir, 'Info.plist'),
    executable: path.join(contentsDir, 'MacOS', APP_NAME),
    // 资源包放 Contents/Resources（**不能放 .app 根**：codesign 会报
    // "unsealed contents present in the bundle root"；运行时由
    // ChamberResources 按 Bundle.main.resourceURL 定位——见该文件头注释）。
    resourceBundle: path.join(resourcesDir, RESOURCE_BUNDLE_NAME),
    icon: path.join(resourcesDir, 'icon.icns'),
    sidecarDir: path.join(resourcesDir, 'sidecar'),
    webDist: path.join(resourcesDir, 'dist', 'web'),
    zipPath: path.join(outDir, `${artifactBasename}.zip`),
    dmgPath: path.join(outDir, `${artifactBasename}.dmg`),
  }
}

export function buildOutputDir(config) {
  return path.join(macosDir, '.build', config)
}

export function renderInfoPlist(template, values) {
  let rendered = template
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.split(`__${key}__`).join(value)
  }
  return rendered
}

export function parseBuildSwiftAppArgs(argv) {
  const options = {
    outDir: path.join(macosDir, 'release'),
    config: 'release',
    identity: '-',
    appName: APP_NAME,
    artifactBasename: APP_NAME,
    sidecarDir: path.join(desktopDir, 'release', 'sidecar'),
    iconPath: path.join(desktopDir, 'resources', 'icon.icns'),
    webDistDir: path.join(desktopDir, 'dist', 'web'),
    skipBuild: false,
    skipSidecar: false,
    noSign: false,
    noZip: false,
    noDmg: false,
    dryRun: false,
    // 期望架构：null = 只断言 .app 与捆绑 node 存在交集（不猜宿主）；
    // 显式值（arm64|x64）时两者都必须包含它。
    arch: null,
    swiftArgs: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} 缺少取值`)
      return argv[index]
    }
    if (arg === '--out') options.outDir = path.resolve(next())
    else if (arg === '--app-name') options.appName = next()
    else if (arg === '--artifact-basename') options.artifactBasename = next()
    else if (arg === '--config') options.config = next()
    else if (arg === '--identity') options.identity = next()
    else if (arg === '--arch') {
      const arch = next()
      if (arch !== 'arm64' && arch !== 'x64') throw new Error(`--arch 只接受 arm64|x64：${arch}`)
      options.arch = arch
    }
    else if (arg === '--sidecar') options.sidecarDir = path.resolve(next())
    else if (arg === '--icon') options.iconPath = path.resolve(next())
    else if (arg === '--web-dist') options.webDistDir = path.resolve(next())
    else if (arg === '--skip-build') options.skipBuild = true
    else if (arg === '--skip-web-dist') options.skipWebDist = true
    else if (arg === '--skip-sidecar') options.skipSidecar = true
    else if (arg === '--no-sign') options.noSign = true
    else if (arg === '--no-zip') options.noZip = true
    else if (arg === '--no-dmg') options.noDmg = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--swift-args') options.swiftArgs = next().split(' ').filter(Boolean)
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

export function assemblePlan(options) {
  const layout = appLayout(options.outDir, options.appName, options.artifactBasename)
  const steps = []
  steps.push(options.skipBuild
    ? `[1] 复用已有 swift build -c ${options.config} 产物`
    : `[1] swift build -c ${options.config}${options.swiftArgs.length > 0 ? ` ${options.swiftArgs.join(' ')}` : ''}`)
  steps.push(`[2] 组装 ${layout.appDir}（MacOS/ + Resources/ + Info.plist）`)
  if (options.skipSidecar) steps.push('[3] 跳过 sidecar 拷贝（--skip-sidecar）')
  else steps.push(`[3] 拷贝 W-23 sidecar 装配 → ${layout.sidecarDir}`)
  steps.push(options.noSign ? '[4] 跳过签名（--no-sign）' : `[4] 签名（identity=${options.identity}）`)
  if (!options.noZip) steps.push(`[5] zip → ${layout.zipPath}`)
  if (!options.noDmg) steps.push(`[6] dmg → ${layout.dmgPath}`)
  return steps
}

function run(command, args, io, cwd) {
  io.log(`  $ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    // SwiftPM 需要 Package.swift 所在目录——脚本可从仓库根调用（2026-09 三审：
    // 原先依赖调用方 cwd = macos/，从根跑会 "Could not find Package.swift"）。
    ...(cwd !== undefined ? { cwd } : {}),
  })
  if (result.error) throw new Error(`${command} 启动失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} 失败（exit ${result.status}）`)
}

function quiet(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Mach-O magic（thin 32/64 + fat 32/64，大小端各一）——嵌套原生模块（.node/dylib）识别。 */
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, // MH_MAGIC / MH_MAGIC_64（大端）
  0xcefaedfe, 0xcffaedfe, // MH_CIGAM / MH_CIGAM_64（小端）
  0xcafebabe, 0xbebafeca, // FAT_MAGIC / FAT_CIGAM
  0xcafebabf, 0xbfbafeca, // FAT_MAGIC_64 / FAT_CIGAM_64（2026-12 P9：漏判会让 64 位胖文件逃避嵌套签名）
])

/** 读 4 字节判定是否 Mach-O（导出以便单测；读失败 → false）。 */
export function isMachO(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(4)
      const read = readSync(fd, buffer, 0, 4, 0)
      if (read < 4) return false
      return MACHO_MAGICS.has(buffer.readUInt32BE(0))
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/** 递归找出目录下所有 Mach-O 文件（跳过符号链接；导出以便单测）。 */
export function findNestedMachOFiles(rootDir) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // fail closed（2026-12 P9）：旧实现静默 return——枚举不到嵌套 Mach-O 时
      // 主签名仍会通过，未签名的 .node/可执行模块被「deep」校验放过，公证才炸。
      throw new Error(
        `无法读取待枚举目录（嵌套 Mach-O 签名前置）：${dir}——`
        + (error instanceof Error ? error.message : String(error)),
      )
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && isMachO(full)) {
        found.push(full)
      }
    }
  }
  walk(rootDir)
  return found.sort()
}

/**
 * codesign argv（纯函数，build-swift-app.test.mjs 直测——2026-09 审计发现 hardened 分支错序：
 * `--options runtime` 被插到 `--sign` 与 identity 之间，codesign 会把 `--options`
 * 当成 identity 报 "--options: no identity found"）。规则：所有选项先于
 * `--sign <identity>`；ad-hoc（identity === '-'）不带 hardened runtime 与
 * 时间戳；Developer ID 带 `--options runtime` 且**不加** `--timestamp=none`
 * （公证需要安全时间戳；离线 ad-hoc 才用 none）。
 */
export function codesignArgs(options, target, entitlements) {
  const hardened = options.identity !== '-'
  const args = ['--force']
  if (!hardened) args.push('--timestamp=none')
  if (hardened) args.push('--options', 'runtime')
  args.push('--sign', options.identity)
  if (typeof entitlements === 'string' && entitlements.length > 0) {
    args.push('--entitlements', entitlements)
  }
  args.push(target)
  return args
}

/** lipo -archs stdout → 架构集合（导出以便单测；x86_64/arm64e 归一化）。 */
export function parseLipoArchs(stdout) {
  const text = String(stdout)
  const marker = 'architecture:'
  // 旧版 lipo 对 thin 文件打印 "Non-fat file: … is architecture: arm64"。
  const payload = text.includes(marker) ? text.slice(text.lastIndexOf(marker) + marker.length) : text
  return [...new Set(payload.trim().split(/\s+/).filter(Boolean))]
    .map((arch) => (arch === 'x86_64' ? 'x64' : arch === 'arm64e' ? 'arm64' : arch))
}

/**
 * 读取 Mach-O 文件的架构集合（lipo -archs）。失败一律 throw（fail closed）：
 * 一个 lipo 读不动的「可执行」正是需要拦下的产物。
 */
export function machOArchs(file) {
  if (!existsSync(file)) throw new Error(`缺少可执行文件：${file}`)
  const result = quiet('lipo', ['-archs', file])
  if (result.status !== 0) {
    throw new Error(`无法读取架构（lipo -archs exit ${result.status}）：${file}——${(result.stderr || result.stdout).trim()}`)
  }
  const archs = parseLipoArchs(result.stdout)
  if (archs.length === 0) throw new Error(`lipo 未报告任何架构：${file}`)
  return archs
}

/** DMG 的 hdiutil argv（纯函数；卷名必须来自 --app-name，而非壳内定名）。 */
export function dmgCreateArgs(options, stageDir, dmgPath) {
  return ['create', '-volname', options.appName, '-srcfolder', stageDir, '-ov', '-format', 'UDZO', dmgPath]
}

/**
 * 搭 DMG 卷内容：.app 副本 + /Applications 快捷方式（Finder 拖拽安装惯例；
 * 缺它的 DMG 只能手动把 app 拖出，2026-12 P7）。ditto 保签名与资源分叉。
 */
export function stageDmgVolume(appDir, stageDir, appName, io = { log: () => {} }) {
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  run('ditto', [appDir, path.join(stageDir, `${appName}.app`)], io)
  symlinkSync('/Applications', path.join(stageDir, 'Applications'))
  return stageDir
}

export async function runBuildSwiftApp(options, io = { log: console.log, error: console.error }) {
  const layout = appLayout(options.outDir, options.appName, options.artifactBasename)
  for (const step of assemblePlan(options)) io.log(`  ${step}`)

  const templatePath = path.join(macosDir, 'Info.plist.template')
  const entitlements = path.join(macosDir, 'entitlements.plist')
  if (!existsSync(templatePath)) throw new Error(`缺少 Info.plist 模板：${templatePath}`)
  if (!existsSync(entitlements)) throw new Error(`缺少 entitlements：${entitlements}`)

  const outputDir = buildOutputDir(options.config)
  const binarySource = path.join(outputDir, APP_NAME)
  const bundleSource = path.join(outputDir, RESOURCE_BUNDLE_NAME)

  if (options.dryRun) {
    io.log(`[build-swift-app] dry-run：模板/entitlements 就绪；二进制 ${binarySource}（${existsSync(binarySource) ? '存在' : '待构建'}）`)
    io.log(`[build-swift-app] dry-run：sidecar ${options.sidecarDir}（${existsSync(options.sidecarDir) ? '存在' : '缺失'}）`)
    return { dryRun: true, layout }
  }

  // 1. swift build。
  if (!options.skipBuild) {
    run('swift', ['build', '-c', options.config, ...options.swiftArgs], io, macosDir)
  }
  if (!existsSync(binarySource)) {
    throw new Error(`缺少可执行产物：${binarySource}（先跑 swift build -c ${options.config}）`)
  }
  if (!existsSync(bundleSource)) {
    throw new Error(`缺少 SwiftPM 资源包：${bundleSource}（bridge-shim 等资源随 Package.swift resources 生成）`)
  }

  // 2. 组装。
  rmSync(layout.appDir, { recursive: true, force: true })
  mkdirSync(layout.macOsDir, { recursive: true })
  mkdirSync(layout.resourcesDir, { recursive: true })
  cpSync(binarySource, layout.executable)
  chmodSync(layout.executable, 0o755)
  cpSync(bundleSource, layout.resourceBundle, { recursive: true })

  const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))
  const version = typeof desktopPkg.version === 'string' ? desktopPkg.version : '0.0.0'
  // CFBundleVersion 只允许数字与点（Apple）；beta 版本 X.Y.Z-beta.N 取其
  // 数字段（2026-09 模块评审 minor：plutil -lint 不查这条）。
  const bundleVersion = version.split('-')[0]
  const plist = renderInfoPlist(readFileSync(templatePath, 'utf8'), {
    VERSION: version,
    BUNDLE_VERSION: bundleVersion,
  })
  writeFileSync(layout.infoPlist, plist)
  const lint = quiet('plutil', ['-lint', layout.infoPlist])
  if (lint.status !== 0) throw new Error(`Info.plist 非法：${lint.stdout}${lint.stderr}`)
  io.log(`[build-swift-app] Info.plist（version=${version}）→ ${layout.infoPlist}`)

  if (existsSync(options.iconPath)) {
    cpSync(options.iconPath, layout.icon)
    io.log(`[build-swift-app] icon.icns → ${layout.icon}`)
  } else {
    io.log(`[build-swift-app] 警告：图标缺失（${options.iconPath}）——继续，Dock/访达用默认图标`)
  }

  // 3. sidecar（W-23 装配产物）。
  if (options.skipSidecar) {
    io.log('[build-swift-app] 跳过 sidecar 拷贝（--skip-sidecar）')
  } else if (existsSync(options.sidecarDir)) {
    // P2（2026-09 GUI 验收）：`cpSync` 会把相对符号链接改写成指向**源树**的
    // 绝对链接，bundle 内随即出现逃出 bundle 的链接，`codesign --verify
    // --strict` 直接报 `invalid destination for symbolic link in bundle`。
    // copyTree 保留树内相对链接（pnpm `.bin` 的语义）、实体化树外链接。
    rmSync(layout.sidecarDir, { recursive: true, force: true })
    const materialized = copyTree(options.sidecarDir, layout.sidecarDir)
    // 兜底网：任何仍逃出树的链接一律实体化（对手工/旧装配目录也成立）。
    const normalizedLinks = normalizeSymlinks(layout.sidecarDir)
    if (materialized > 0 || normalizedLinks > 0) {
      io.log(`[build-swift-app] 符号链接归一化：实体化 ${materialized} 处 / 改写 ${normalizedLinks} 处（bundle 自包含）`)
    }
    io.log(`[build-swift-app] sidecar → ${layout.sidecarDir}`)
    // A5 前置断言（W-23 已保证，这里防手工/外部装配目录把 node 放错名）：
    // sidecar 目录下任何以 node 开头的条目都必须恰好叫 node。
    const { readdirSync } = await import('node:fs')
    for (const entry of readdirSync(layout.sidecarDir)) {
      if (entry.startsWith('node') && entry !== 'node') {
        throw new Error(`sidecar 内 node 基名必须是 'node'（design 25 §4.3 A5）：发现 '${entry}'`)
      }
    }
    if (!existsSync(path.join(layout.sidecarDir, 'sidecar.js'))) {
      throw new Error(`sidecar 装配目录缺少 sidecar.js：${layout.sidecarDir}`)
    }
    // 2026-12 P2：没有捆绑 node 时 runtime 会静默回落 PATH 上的系统 node——
    // 签名与打包都会成功，但发布物的运行时依赖构建机环境。存在性与可执行位
    // 必须在这里 fail closed（--skip-sidecar/--dry-run 才允许缺位）。
    const bundledNode = path.join(layout.sidecarDir, 'node')
    if (!existsSync(bundledNode)) {
      throw new Error(`sidecar 装配目录缺少捆绑 node：${bundledNode}（runtime 会回落到 PATH 上的系统 node；先跑 build:sidecar，或用 --skip-sidecar）`)
    }
    const nodeStat = statSync(bundledNode)
    if (!nodeStat.isFile()) {
      throw new Error(`捆绑 node 不是常规文件：${bundledNode}`)
    }
    if ((nodeStat.mode & 0o111) === 0) {
      throw new Error(`捆绑 node 没有可执行位：${bundledNode}（mode ${(nodeStat.mode & 0o777).toString(8)}）`)
    }
  } else {
    throw new Error(`缺少 W-23 sidecar 装配目录：${options.sidecarDir}（先跑 build:sidecar，或用 --skip-sidecar）`)
  }
  // 2026-12 P4：build-sidecar 缺省 darwin-arm64，而 swift build 跟随宿主架构；
  // 两者不一致的 .app 能签名、能打包，直到运行时才崩。lipo 读两边架构：必须
  // 存在交集；显式 --arch 时两边都必须包含它（.app 可执行不存在/非 Mach-O 也
  // 在这里 loud，不留给 codesign 的模糊报错）。
  const appArchs = machOArchs(layout.executable)
  if (options.arch !== null && !appArchs.includes(options.arch)) {
    throw new Error(`.app 可执行架构不含 ${options.arch}：${layout.executable}（实际 ${appArchs.join('/')}）`)
  }
  if (!options.skipSidecar) {
    const nodeArchs = machOArchs(path.join(layout.sidecarDir, 'node'))
    if (options.arch !== null && !nodeArchs.includes(options.arch)) {
      throw new Error(`捆绑 node 架构不含 ${options.arch}：实际 ${nodeArchs.join('/')}`)
    }
    if (!appArchs.some((arch) => nodeArchs.includes(arch))) {
      throw new Error(
        `.app 可执行与捆绑 node 架构无交集（.app ${appArchs.join('/')} ≠ node ${nodeArchs.join('/')}）`
        + '——build:sidecar 的 --arch 必须与 swift build 的宿主架构一致',
      )
    }
  }
  // S5·F19（2026-12 双端逐函数核对 + 审查修正）：此前缺 renderer dist/web 只静默
  // 跳过——装配出来的 .app 首次启动即白屏（release.yml 的 verify 步虽有断言，装配
  // 脚本自身必须 fail-closed）。
  // 规则（审查后收紧）：**只有显式 --skip-web-dist 才允许缺位**。早先按
  // 「是否产出 zip/dmg」放行是错的——release.yml 的正式腿恰以 --no-zip --no-dmg
  // 组装真正发布的 .app（归档在公证之后另做），那种形状也会缺 web 界面。
  // 并且判据是 `dist/web/index.html` 而不是目录存在：emptyOutDir 失败留下的空目录
  // 同样必须被挡住。
  if (options.skipWebDist === true) {
    io.log('[build-swift-app] 跳过 renderer dist/web 拷贝（--skip-web-dist）')
  } else if (!existsSync(path.join(options.webDistDir, 'index.html'))) {
    throw new Error(
      `renderer dist/web 缺失或不完整：${path.join(options.webDistDir, 'index.html')}`
      + '——装配必须自带 web 界面（先跑 pnpm run build:renderer；仅局部装配可显式 --skip-web-dist）',
    )
  } else {
    cpSync(options.webDistDir, layout.webDist, { recursive: true })
    io.log(`[build-swift-app] renderer dist/web → ${layout.webDist}`)
  }

  // 4. 签名（嵌套先于主签名）。argv 由 codesignArgs 单源生成（顺序由
  //    build-swift-app.test.mjs 的 argv 断言锁定）。
  if (options.noSign) {
    io.log('[build-swift-app] 跳过签名（--no-sign）')
  } else {
    // 嵌套原生代码必须先签（公证要求 app 内所有 Mach-O 都已签名）：
    // 自带 node + vendor/dsh/node_modules 下的 .node/dylib。Resources 不是
    // codesign 的「已知嵌套位置」，不会被主签名自动覆盖。
    const nodeEntitlements = path.join(macosDir, 'entitlements.node.plist')
    const nested = findNestedMachOFiles(layout.appDir).filter(
      (file) => file !== layout.executable,
    )
    for (const file of nested) {
      // 只有捆绑的 node 需要 JIT/可写可执行内存权限（design 25 §3.2「捆绑 node
      // 另加」）；其余嵌套原生模块（.node/dylib）用裸 hardened runtime 签名，
      // 避免无谓放大权限面（2026-09 模块评审 minor）。
      const isNode = path.basename(file) === 'node'
      run('codesign', codesignArgs(options, file, isNode ? nodeEntitlements : undefined), io)
    }
    if (nested.length > 0) {
      io.log(`[build-swift-app] 嵌套 Mach-O 已签名 ${nested.length} 个（含自带 node 与 .node 原生模块）`)
    }
    run('codesign', codesignArgs(options, layout.appDir, entitlements), io)
    const verify = quiet('codesign', ['--verify', '--deep', '--strict', layout.appDir])
    if (verify.status !== 0) {
      throw new Error(`签名校验失败：${verify.stderr || verify.stdout}`)
    }
    io.log('[build-swift-app] codesign 校验通过')
  }

  // 5/6. 分发产物。
  if (!options.noZip) {
    rmSync(layout.zipPath, { force: true })
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', layout.appDir, layout.zipPath], io)
  }
  if (!options.noDmg) {
    rmSync(layout.dmgPath, { force: true })
    // 2026-12 P7：卷内容 = .app + /Applications 快捷方式；卷名来自 --app-name
    // （旧实现固定 APP_NAME，与 --app-name dsh-chamber-native 的发布腿不符）。
    const stageDir = path.join(layout.outDir, '.dmg-stage')
    try {
      stageDmgVolume(layout.appDir, stageDir, options.appName, io)
      run('hdiutil', dmgCreateArgs(options, stageDir, layout.dmgPath), io)
    } finally {
      rmSync(stageDir, { recursive: true, force: true })
    }
  }

  const size = statSync(layout.executable).size
  io.log(`[build-swift-app] 完成：${layout.appDir}（可执行 ${(size / 1024 / 1024).toFixed(1)}MB）`)
  return { dryRun: false, layout, version }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  try {
    const options = parseBuildSwiftAppArgs(process.argv.slice(2))
    if (options.help) {
      console.log('用法：build-swift-app.mjs [--out <dir>] [--config release] [--identity <id>|-]')
      console.log('       [--app-name <name>] [--artifact-basename <name>] [--arch arm64|x64]')
      console.log('       [--sidecar <dir>] [--icon <icns>] [--web-dist <dir>] [--skip-build]')
      console.log('       [--skip-sidecar] [--skip-web-dist] [--no-sign] [--no-zip] [--no-dmg] [--dry-run] [--swift-args "<args>"]')
      process.exit(0)
    }
    await runBuildSwiftApp(options)
  } catch (error) {
    console.error(`[build-swift-app] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
