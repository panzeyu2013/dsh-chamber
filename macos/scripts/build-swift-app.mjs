#!/usr/bin/env node
/**
 * build-swift-app.mjs —— Swift 原生壳 .app 打包（W-24；design 25 §3.2/§8.4）
 *
 * 产物布局（SwiftPM 可执行 + 资源包 + W-23 装配 sidecar）：
 *   <out>/dsh-chamber.app/Contents/
 *     Info.plist                      ← macos/Info.plist.template（__VERSION__ 替换）
 *     MacOS/dsh-chamber               ← swift build -c release 产物（SwiftPM target DSHChamber）
 *     Resources/
 *       icon.icns                     ← packages/desktop/resources/icon.icns（缺件 fail
 *                                       closed——G38：electron-builder 同样 fatal）
 *       DSHChamber_DSHChamber.bundle   ← SwiftPM 资源包（bridge-shim 等）；
 *         **必须放 Contents/Resources**（放 .app 根会被 codesign 判为未密封内容）
 *       sidecar/{node,sidecar.js,package.json,dist/…}   ← W-23 build-sidecar 产物
 *       dist/web/                     ← renderer 产物（可选；sidecar 静态伺服；
 *                                       过滤 *.map 与 .vite/，与 Electron build.files
 *                                       逐条对齐——G40）
 *
 * 步骤：swift build（可 --skip-build）→ 组装（sidecar 必须自带可执行 node 与
 * sidecar.js，build 时断言）→ 架构一致性断言（.app 可执行 vs 捆绑 node，lipo；
 * build-sidecar 缺省 darwin-arm64 而 swift build 跟随宿主——不一致的 .app 过去能
 * 签名打包、运行时才崩）→ Info.plist 渲染（plutil -lint）→ 嵌套签名
 * （sidecar/node，Developer ID 时带 hardened runtime + node 权限）→ 主签名
 * （--identity 缺省 ad-hoc `-`）→ zip（ditto）/ dmg（dmg.mjs：可写镜像 +
 * Finder 布局 + UDZO，卷内含 /Applications 快捷方式、背景箭头与图标定位）。
 *
 * 离线/沙箱：--skip-build 复用已有 .build 产物；--skip-sidecar 允许无 W-23
 * 产物时只验壳装配（此时不做 node 架构比对）；--no-sign/--no-dmg/--no-zip
 * 分步跳过。
 *
 * --dry-run（G30）：不写盘，但把**已解析的计划**（app/可执行/产物名/feed/公钥
 * 成对性）全部打印并做一致性断言（dryRunPlanReport）——ci.yml 的 packaging dry
 * run 声称 "validate their plans and layouts"，此前只是打印存在性便返回 0。
 *
 * CFBundleVersion（S-23）：Sparkle 以它（而非 CFBundleShortVersionString）做版本
 * 比较，映射见 bundleVersionFor：稳定版 X.Y.Z → X.Y.Z.999999999，beta
 * X.Y.Z-beta.N → X.Y.Z.N；同 base 的 beta.N < beta.N+1 < final。
 *
 * 产物路径是**精确路径**（artifactBasename 单源）：发布腿只上传这些精确文件，
 * 绝不 glob 输出目录（G29：复用工作目录时旧版本归档曾被 *.dmg/*.zip 一并上传）。
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
  readlinkSync,
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
// S-22：beta feed 的滚动 tag 单源在 release-artifacts.mjs（release.yml 的 job env
// 与它逐字锁步）——装配脚本据此在 dry-run 计划里断言通道 URL 形状。
import { NATIVE_BETA_ROLLING_TAG } from '../../scripts/release/release-artifacts.mjs'
// 2026-09 P7 补强：样式化 DMG（Finder 背景箭头 + 图标定位 + /Applications 快捷
// 方式）的**单一实现**。正式发布腿（release.yml 公证步）调用同文件的 CLI——
// 两处各写一份必然漂移，实现与背景资产都收敛在 macos/scripts/dmg.mjs。
import { createStyledDmg } from './dmg.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const macosDir = path.resolve(here, '..')
const repoRoot = path.resolve(macosDir, '..')
const desktopDir = path.join(repoRoot, 'packages', 'desktop')

/** 默认 .app 名与产物名（可见名；发布腿用 --app-name/--artifact-basename 显式覆盖）。 */
export const APP_NAME = 'dsh-chamber'
/** SwiftPM executable target / 模块名：构建产物 = .build/<config>/DSHChamber（T-17）。 */
export const MODULE_NAME = 'DSHChamber'
/** bundle 内可执行名（活动监视器/进程名）——与可见产品名同源。 */
export const EXECUTABLE_NAME = APP_NAME
/** SwiftPM 资源包名（target 名重复一次，见 Package.swift target DSHChamber）。 */
export const RESOURCE_BUNDLE_NAME = `${MODULE_NAME}_${MODULE_NAME}.bundle`

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
    executable: path.join(contentsDir, 'MacOS', EXECUTABLE_NAME),
    // 资源包放 Contents/Resources（**不能放 .app 根**：codesign 会报
    // "unsealed contents present in the bundle root"；运行时由
    // ChamberResources 按 Bundle.main.resourceURL 定位——见该文件头注释）。
    resourceBundle: path.join(resourcesDir, RESOURCE_BUNDLE_NAME),
    icon: path.join(resourcesDir, 'icon.icns'),
    sidecarDir: path.join(resourcesDir, 'sidecar'),
    // Sparkle 等内嵌框架放 Contents/Frameworks（S-01 / 裁决 D-1 选 B）；可执行靠
    // @executable_path/../Frameworks 的 rpath 找到它（见下方 embedSparkle）。
    frameworksDir: path.join(contentsDir, 'Frameworks'),
    webDist: path.join(resourcesDir, 'dist', 'web'),
    zipPath: path.join(outDir, `${artifactBasename}.zip`),
    dmgPath: path.join(outDir, `${artifactBasename}.dmg`),
  }
}

/** Sparkle.framework 的定位（SwiftPM 二进制制品；纯函数，单测直测）。
 *  路径形态：<macos>/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/<slice>/Sparkle.framework
 *  （slice 名随机器与架构而变，如 macos-arm64_x86_64 / macos-arm64）。找不到返回 null。 */
export function findSparkleFramework(packageRoot, hostArch = process.arch) {
  const artifacts = path.join(packageRoot, '.build', 'artifacts', 'sparkle')
  if (!existsSync(artifacts)) return null
  const wanted = hostArch === 'arm64' ? 'macos-arm64' : 'macos-x86_64'
  const candidates = []
  for (const xcframework of globDirs(artifacts, 'Sparkle.xcframework')) {
    for (const slice of readdirSync(xcframework)) {
      const framework = path.join(xcframework, slice, 'Sparkle.framework')
      if (existsSync(framework)) candidates.push({ framework, slice })
    }
  }
  if (candidates.length === 0) return null
  // 宿主架构 slice 优先（.app 只装宿主架构时也够用）；否则退第一个。
  const preferred = candidates.find((c) => c.slice.includes(wanted))
  return (preferred ?? candidates[0]).framework
}

/** 递归找目录名（exactly-one 语义不需要；仅供 findSparkleFramework 使用）。 */
function globDirs(root, name) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const next = path.join(dir, entry.name)
      if (entry.name === name) { found.push(next); continue }
      walk(next, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

/** 嵌入 Sparkle.framework 到 Contents/Frameworks，并保证可执行带 rpath。
 *  必须在签名之前调用（嵌套框架先于主签名）。找不到框架而配置了 feed → 抛。 */
function embedSparkle(layout, options, io) {
  const configured = options.sparkleFeed !== '' && options.sparklePublicKey !== ''
  const framework = findSparkleFramework(macosDir)
  if (framework === null) {
    if (configured) {
      throw new Error('配置了 --sparkle-feed/--sparkle-public-key 但找不到 Sparkle.framework'
        + '（先跑 swift package resolve；CI 需要网络取二进制制品）')
    }
    return false
  }
  mkdirSync(layout.frameworksDir, { recursive: true })
  const destination = path.join(layout.frameworksDir, 'Sparkle.framework')
  rmSync(destination, { recursive: true, force: true })
  // verbatimSymlinks 必须有：Node 缺省会把框架里的相对符号链接（Sparkle ->
  // Versions/Current/Sparkle 等）改写成指向 SwiftPM 制品的绝对路径——codesign 随即
  // 报 "unsealed contents present in the root directory of an embedded framework"，
  // 且 bundle 里出现逃出自身的链接；把链接**物化**（normalizeSymlinks）又会得到
  // "bundle format is ambiguous (could be app or framework)"（2026-12 实测）。
  cpSync(framework, destination, { recursive: true, dereference: false, verbatimSymlinks: true })
  const escaping = findEscapingSymlinks(destination)
  if (escaping.length > 0) {
    throw new Error(`Sparkle.framework 含逃出自身的符号链接：${escaping.join(', ')}`)
  }
  io.log(`[build-swift-app] Sparkle.framework → ${destination}`)
  // rpath：swift build 的链接行已带 @executable_path/../Frameworks（缺省 swiftArgs），
  // 但 --skip-build 复用旧产物时未必有——这里补齐并校验（失败 = 启动期 dyld 找不到）。
  quiet('install_name_tool', ['-add_rpath', '@executable_path/../Frameworks', layout.executable])
  const otool = quiet('otool', ['-l', layout.executable])
  if (!otool.stdout.includes('@executable_path/../Frameworks')) {
    throw new Error('可执行缺少 @executable_path/../Frameworks rpath——嵌入的 Sparkle 在启动期会找不到')
  }
  return true
}
export function buildOutputDir(config) {
  return path.join(macosDir, '.build', config)
}

/** SwiftPM 资源包的「资源目录」——两种后端形态不同：
 *  - `native`（旧默认）：扁平资源包 `<bundle>/bridge-shim.js`；
 *  - `swiftbuild`（Swift 6.4+ 默认）：多一层 `<bundle>/Contents/Resources/bridge-shim.js`。
 *  装配态只认扁平形态（运行期 `ChamberResources` 按 `<Resources>/<bundle>/<name>` 查找，
 *  release.yml 的资源断言同样按该路径），所以这里统一收敛到资源目录再拷：两种后端
 *  产出同一个扁平资源包。判定用目录形态而不是文件名——将来资源包加文件也不必回来改。 */
export function resourceBundleResourcesDir(bundleDir, exists = existsSync) {
  const nested = path.join(bundleDir, 'Contents', 'Resources')
  return exists(nested) ? nested : bundleDir
}

/** 装配后的资源包必须真有桥 shim——形态再变（第三层目录、改名）时当场 loud。
 *  抽成函数是为了能直接单测失败分支（2026-09 审查：新 fail-closed 分支原先无负例）。 */
export function assertBridgeShimPresent(resourceBundleDir, source = '', exists = existsSync) {
  if (!exists(path.join(resourceBundleDir, 'bridge-shim.js'))) {
    throw new Error('装配后的资源包缺 bridge-shim.js：' + resourceBundleDir
      + (source ? '（来源 ' + source + '——SwiftPM 资源形态变了？）' : ''))
  }
}

export function renderInfoPlist(template, values) {
  let rendered = template
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.split(`__${key}__`).join(value)
  }
  return rendered
}

/** 稳定版 CFBundleVersion 的 final 标记（第 4 段）：恒大于同 base 的 beta 序号。 */
export const STABLE_BUNDLE_SUFFIX = 999999999

/**
 * chamber 版本字符串 → CFBundleVersion（S-23；纯函数，单测直测）。
 *
 * 为什么不能只取数字段：Sparkle 用 CFBundleVersion 作 sparkle:version 做版本
 * 比较，旧实现把 X.Y.Z-beta.N 与 X.Y.Z 都映射成 X.Y.Z ⇒ beta.N→final 不提示、
 * beta.N→beta.N+1 也不可区分。
 *
 * 方案（只含点分十进制整数，4 段）：
 *   X.Y.Z-beta.N → X.Y.Z.N        第 4 段 = beta 序号（N 单调递增）
 *   X.Y.Z        → X.Y.Z.999999999 第 4 段 = final 标记（恒大于 beta 序号）
 * 排序：X.Y.Z-beta.N < X.Y.(Z).999999999 < X.Y.(Z+1)-beta.M——Sparkle 对同段数
 * 的整数段做数值比较；beta 序号须 < STABLE_BUNDLE_SUFFIX（超出即 loud，绝不
 * 产出会让 final 被 beta 盖住的映射）。CFBundleShortVersionString 仍是完整
 * 版本字符串（含 -beta.N），展示不受影响。
 */
export function bundleVersionFor(version) {
  const beta = /^([0-9]+)\.([0-9]+)\.([0-9]+)-beta\.([0-9]+)$/.exec(version)
  if (beta !== null) {
    const number = Number(beta[4])
    if (!Number.isSafeInteger(number) || number >= STABLE_BUNDLE_SUFFIX) {
      throw new Error(`无法映射 CFBundleVersion：beta 序号越界（${version}）`)
    }
    return `${beta[1]}.${beta[2]}.${beta[3]}.${number}`
  }
  const stable = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version)
  if (stable !== null) return `${version}.${STABLE_BUNDLE_SUFFIX}`
  throw new Error(`无法映射 CFBundleVersion：版本必须是 X.Y.Z 或 X.Y.Z-beta.N（got ${version}）`)
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
    // Sparkle（S-01 / 裁决 D-1 选 B）：feed 与 EdDSA 公钥由发布腿注入；
    // 缺省空串 = 更新不可用（壳禁用「检查更新…」菜单项，也不向内嵌 sidecar
    // 声明 --native-updater）。
    sparkleFeed: '',
    sparklePublicKey: '',
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
    else if (arg === '--sparkle-feed') options.sparkleFeed = next()
    else if (arg === '--sparkle-public-key') options.sparklePublicKey = next()
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
  if (options.sparkleFeed !== '' && options.sparklePublicKey !== '') {
    steps.push(`[2b] 嵌入 Sparkle.framework → ${path.join(layout.frameworksDir, 'Sparkle.framework')}`)
  }
  if (options.skipSidecar) steps.push('[3] 跳过 sidecar 拷贝（--skip-sidecar）')
  else steps.push(`[3] 拷贝 W-23 sidecar 装配 → ${layout.sidecarDir}`)
  steps.push(options.noSign ? '[4] 跳过签名（--no-sign）' : `[4] 签名（identity=${options.identity}）`)
  if (!options.noZip) steps.push(`[5] zip → ${layout.zipPath}`)
  if (!options.noDmg) steps.push(`[6] dmg → ${layout.dmgPath}（Finder 拖拽布局：背景图 + 图标定位 + /Applications 快捷方式）`)
  return steps
}

/**
 * appcast feed 的通道判定（S-22；纯函数，单测直测）：按 feed 末段文件名区分
 * 稳定/beta；其他 .xml 名（本地自定义 feed）返回 null，只做 https/.xml 形状校验。
 */
export function sparkleFeedChannel(feed) {
  if (feed.endsWith('/appcast-swift-beta.xml')) return 'beta'
  if (feed.endsWith('/appcast-swift.xml')) return 'stable'
  return null
}

/**
 * web dist 条目的跨侧过滤（G40；纯函数，单测直测）：Electron 的 build.files
 * （packages/desktop/package.json）排除 dist 下任意 .map 文件与 dist/.vite 目录，
 * Swift 装配此前无条件 cpSync 整棵 dist/web，随包带出 .vite/manifest.json 与
 * 源码映射等构建内部文件。规则**逐条对齐 Electron**（目录名 .vite 出现在任意
 * 层级 + 任何 .map 文件），不另造第二套规则。relativePath 相对 web dist 根。
 */
export function shouldCopyWebDistEntry(relativePath) {
  const normalized = relativePath.split(path.sep).join('/')
  if (normalized === '') return true
  if (normalized.endsWith('.map')) return false
  if (normalized === '.vite' || normalized.startsWith('.vite/')) return false
  if (normalized.includes('/.vite/')) return false
  return true
}

/**
 * --dry-run 的计划报告 + 一致性断言（G30；纯函数：不发命令、不写盘、单测直测）。
 *
 * ci.yml 的 packaging dry run 声称 ".app assembly plan validates its inputs"；
 * 此前 --dry-run 只打印二进制/sidecar 存在性便返回 0。这里把已解析的 app 布局、
 * 精确产物名与 Sparkle 注入面完整输出，并对**计划本身不合法**的组合直接 throw：
 * - feed 与公钥必须成对（半配置 = Info.plist 一半有值，壳会误判更新面）；
 * - feed 必须是 https（Sparkle/ATS 都拒绝明文；发布腿的 GitHub URL 天然满足）；
 * - feed 必须指向 .xml appcast；
 * - S-22 通道 URL 形状：appcast-swift-beta.xml 必须落在滚动 tag
 *   （NATIVE_BETA_ROLLING_TAG）上——版本固定 tag 会让 beta.N 看不到 beta.N+1；
 *   appcast-swift.xml 必须落在 releases/latest（稳定客户端的唯一解析面）；
 * - 产物名必须逐字来自 --artifact-basename（发布腿据此上传精确路径，G29）。
 * @returns {{ layout: object, lines: string[] }} 供调用方逐行打印。
 */
export function dryRunPlanReport(options) {
  const layout = appLayout(options.outDir, options.appName, options.artifactBasename)
  const feed = options.sparkleFeed
  const key = options.sparklePublicKey
  if ((feed === '') !== (key === '')) {
    throw new Error(
      'dry-run：--sparkle-feed 与 --sparkle-public-key 必须成对配置'
      + `（feed=${feed === '' ? '(空)' : feed}，publicKey=${key === '' ? '(空)' : '(已配置)'}）`,
    )
  }
  if (feed !== '' && !/^https:\/\//.test(feed)) {
    throw new Error(`dry-run：--sparkle-feed 必须是 https URL（Sparkle 拒绝明文 feed）：${feed}`)
  }
  if (feed !== '' && !/\.xml($|[?#])/.test(feed)) {
    throw new Error(`dry-run：--sparkle-feed 必须指向 .xml appcast：${feed}`)
  }
  // S-22 通道 URL 形状：稳定 = releases/latest；beta = 滚动 tag 的 asset。
  const channel = sparkleFeedChannel(feed)
  if (channel === 'beta'
    && !feed.endsWith(`/releases/download/${NATIVE_BETA_ROLLING_TAG}/appcast-swift-beta.xml`)) {
    throw new Error(
      `dry-run：beta feed 必须指向滚动 tag ${NATIVE_BETA_ROLLING_TAG}`
      + `（releases/download/${NATIVE_BETA_ROLLING_TAG}/appcast-swift-beta.xml）——`
      + `版本固定 tag 会让 beta.N 永远看不到 beta.N+1：${feed}`,
    )
  }
  if (channel === 'stable' && !feed.endsWith('/releases/latest/download/appcast-swift.xml')) {
    throw new Error(
      `dry-run：稳定 feed 必须是 releases/latest/download/appcast-swift.xml`
      + `（beta 才走滚动 tag ${NATIVE_BETA_ROLLING_TAG}）：${feed}`,
    )
  }
  for (const [kind, file] of [['zip', layout.zipPath], ['dmg', layout.dmgPath]]) {
    if (path.dirname(file) !== layout.outDir || path.basename(file) !== `${options.artifactBasename}.${kind}`) {
      throw new Error(`dry-run：${kind} 产物路径与 --artifact-basename 不一致：${file}`)
    }
  }
  // G38：图标缺件在 electron-builder 是 fatal（InvalidConfigurationError），
  // Swift 装配也必须 fail closed——dry-run 是 CI 的计划校验面，计划不合法直接抛。
  if (!existsSync(options.iconPath)) {
    throw new Error(`dry-run：缺少图标（${options.iconPath}）——electron-builder 在缺 mac.icon 时同样致命（G38）`)
  }
  const lines = [
    `app=${layout.appDir}`,
    `可执行=${layout.executable}`,
    `sidecar=${options.sidecarDir}（${existsSync(options.sidecarDir) ? '存在' : '缺失'}）`,
    options.skipWebDist
      ? 'web-dist=（--skip-web-dist 跳过）'
      : `web-dist=${options.webDistDir}（${existsSync(path.join(options.webDistDir, 'index.html')) ? '就绪' : '缺失'}）`,
    `icon=${options.iconPath}（就绪）`,
    options.noZip ? 'zip=（--no-zip 跳过）' : `zip=${layout.zipPath}`,
    options.noDmg ? 'dmg=（--no-dmg 跳过）' : `dmg=${layout.dmgPath}`,
    feed === ''
      ? 'sparkle=未配置（更新不可用）'
      : `sparkle-feed=${feed}；--sparkle-public-key=已配置（值不回显）`,
    feed === ''
      ? 'sparkle-channel=（未配置）'
      : channel === 'beta'
        ? `sparkle-channel=beta（滚动 tag ${NATIVE_BETA_ROLLING_TAG}：beta.N 能发现 beta.N+1）`
        : channel === 'stable'
          ? 'sparkle-channel=stable（releases/latest）'
          : 'sparkle-channel=（未识别 appcast 名；仅做 https/.xml 形状校验）',
    `app-name=${options.appName}；artifact-basename=${options.artifactBasename}`,
  ]
  return { layout, lines }
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
/** 找出 .app 内部的嵌套 bundle（framework/xpc/app/bundle），最深者在前。
 *  codesign 只会自动封存它认识的嵌套位置；framework 里的 Updater.app /
 *  XPCServices/*.xpc 必须**先于**所属 framework 单独签名，否则主签名后
 *  codesign --verify 会报 unsealed contents present in the root directory
 *  of an embedded framework（Sparkle 嵌入实测，2026-12）。 */
/** 找出 rootDir 下指向自身之外的符号链接（绝对目标或 .. 逃逸）；fail-closed
 *  用词：bundle 内不得含逃出自身的链接（AGENTS.md「Before changing the Swift
 *  native shell」）。纯函数，单测直测。 */
export function findEscapingSymlinks(rootDir) {
  const escaping = []
  const walk = (dir, depth) => {
    if (depth > 12) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(full)
        const resolved = path.resolve(dir, target)
        if (path.isAbsolute(target) || !resolved.startsWith(rootDir + path.sep)) {
          escaping.push(path.relative(rootDir, full) + ' -> ' + target)
        }
        continue
      }
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(rootDir, 0)
  return escaping
}
export function findNestedBundles(rootDir) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      throw new Error(`无法读取待枚举目录（嵌套 bundle 签名前置）：${dir}——` +
        (error instanceof Error ? error.message : String(error)))
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      // 只签真正的**代码** bundle：framework / xpc / app。SwiftPM 的
      // RESOURCE_BUNDLE（DSHChamber_DSHChamber.bundle）是纯资源目录、
      // 没有 Info.plist，交给它签会得到 "bundle format unrecognized"（2026-12；
      // 该目录由主 app 的签名封存，历来不需要单独签）。
      if (/\.(framework|xpc|app)$/.test(entry.name)) {
        found.push(full)
        // 继续下潜：framework 里还有 Updater.app / XPCServices/*.xpc。
        walk(full)
      } else {
        walk(full)
      }
    }
  }
  walk(rootDir)
  // 最深者先签（先内后外）。
  return found.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
}
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

/**
 * DMG 的实现（卷内容 + Finder 布局 + 产物校验）已收敛到 macos/scripts/dmg.mjs
 * —— 本地装配腿与 release.yml 正式腿共用同一份实现与同一张背景图。
 * 这里只把纯函数面转发出去，供单测与发布腿按同一锚点断言。
 */
export {
  createStyledDmg,
  dmgConvertArgs,
  dmgCreateArgs,
  finderLayoutScript,
  stageDmgVolume,
  verifyDmgLayout,
} from './dmg.mjs'

export async function runBuildSwiftApp(options, io = { log: console.log, error: console.error }) {
  const layout = appLayout(options.outDir, options.appName, options.artifactBasename)
  for (const step of assemblePlan(options)) io.log(`  ${step}`)

  const templatePath = path.join(macosDir, 'Info.plist.template')
  const entitlements = path.join(macosDir, 'entitlements.plist')
  if (!existsSync(templatePath)) throw new Error(`缺少 Info.plist 模板：${templatePath}`)
  if (!existsSync(entitlements)) throw new Error(`缺少 entitlements：${entitlements}`)

  const outputDir = buildOutputDir(options.config)
  const binarySource = path.join(outputDir, MODULE_NAME)
  const bundleSource = path.join(outputDir, RESOURCE_BUNDLE_NAME)

  if (options.dryRun) {
    // G30：不写盘，但把完整计划（路径/产物名/feed 配对）打印出来并做一致性断言；
    // 计划不合法（feed 半配置、非 https、产物名与 --artifact-basename 不符）直接抛。
    const plan = dryRunPlanReport(options)
    io.log(`[build-swift-app] dry-run：模板/entitlements 就绪；二进制 ${binarySource}（${existsSync(binarySource) ? '存在' : '待构建'}）`)
    for (const line of plan.lines) io.log(`[build-swift-app] dry-run：${line}`)
    io.log(`[build-swift-app] dry-run：计划校验通过（app-name=${options.appName}，artifact-basename=${options.artifactBasename}）`)
    return { dryRun: true, layout: plan.layout, plan: plan.lines }
  }

  // 1. swift build。
  if (!options.skipBuild) {
    // 链接期带上 @executable_path/../Frameworks 的 rpath：装配态内嵌的 Sparkle
    // 靠它被 dyld 找到（dev 态该路径不存在，无副作用）。
    run('swift', ['build', '-c', options.config, ...options.swiftArgs,
      '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks'], io, macosDir)
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
  const bundleResources = resourceBundleResourcesDir(bundleSource)
  if (bundleResources !== bundleSource) {
    io.log(`[build-swift-app] SwiftPM 资源包为 swiftbuild 形态（${path.relative(macosDir, bundleSource)}/Contents/Resources）——按扁平形态装配`)
  }
  cpSync(bundleResources, layout.resourceBundle, { recursive: true })
  // fail-closed：形态再变（第三个目录层级）时当场红，绝不产出没有桥 shim 的 .app。
  assertBridgeShimPresent(layout.resourceBundle, bundleResources)

  const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))
  const version = typeof desktopPkg.version === 'string' ? desktopPkg.version : '0.0.0'
  // S-23：CFBundleVersion 必须让 beta.N、beta.N+1 与同 base 的 final 彼此可区分
  // （Sparkle 以它作 sparkle:version 比较）；映射与理由见 bundleVersionFor。
  const bundleVersion = bundleVersionFor(version)
  const plist = renderInfoPlist(readFileSync(templatePath, 'utf8'), {
    VERSION: version,
    BUNDLE_VERSION: bundleVersion,
    // 空串 = 更新不可用（AppUpdater 把空值判为未配置）；两键任一为空都不算配置。
    SPARKLE_FEED_URL: options.sparkleFeed,
    SPARKLE_PUBLIC_ED_KEY: options.sparklePublicKey,
  })
  writeFileSync(layout.infoPlist, plist)
  const lint = quiet('plutil', ['-lint', layout.infoPlist])
  if (lint.status !== 0) throw new Error(`Info.plist 非法：${lint.stdout}${lint.stderr}`)
  io.log(`[build-swift-app] Info.plist（version=${version}）→ ${layout.infoPlist}`)

  // G38：图标缺件在 electron-builder 是 fatal（app-builder-lib 的
  // InvalidConfigurationError），Swift 装配此前只警告并继续，能产出无图标 .app。
  // 对称 fail closed：发布腿永远拿不到「带默认图标」的次品。
  if (!existsSync(options.iconPath)) {
    throw new Error(
      `缺少图标：${options.iconPath}——electron-builder 在缺 mac.icon 时同样失败（G38）；`
      + '先补齐 packages/desktop/resources/icon.icns 或用 --icon <path> 指定',
    )
  }
  cpSync(options.iconPath, layout.icon)
  io.log(`[build-swift-app] icon.icns → ${layout.icon}`)

  // 3. sidecar（W-23 装配产物）。
  if (options.skipSidecar) {
    io.log('[build-swift-app] 跳过 sidecar 拷贝（--skip-sidecar）')
  } else if (existsSync(options.sidecarDir)) {
    // P2（2026-09 GUI 验收）：`cpSync` 会把相对符号链接改写成指向**源树**的
    // 绝对链接，bundle 内随即出现逃出 bundle 的链接，`codesign --verify
    // --strict` 直接报 `invalid destination for symbolic link in bundle`。
    // copyTree 保留树内相对链接（pnpm `.bin` 的语义）、实体化树外链接。
    rmSync(layout.sidecarDir, { recursive: true, force: true })
    // D12：copyTree 没有返回值（build-sidecar.mjs 只做 cpSync），旧实现把
    // undefined 当计数、日志恒打印「实体化 undefined 处」。归一化计数由
    // normalizeSymlinks 统一返回（它同时负责树外链接实体化与树内相对链接改写）。
    copyTree(options.sidecarDir, layout.sidecarDir)
    const normalizedLinks = normalizeSymlinks(layout.sidecarDir)
    if (normalizedLinks > 0) {
      io.log(`[build-swift-app] 符号链接归一化 ${normalizedLinks} 处（树外链接实体化 / 树内相对链接改写，bundle 自包含）`)
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
    // G40：过滤规则与 Electron 的 build.files 逐条对齐（no *.map / no .vite）——
    // 过滤是跨侧对称契约，不是「少拷几个文件」：.vite/manifest.json 与源码映射
    // 属构建内部文件，不得随 .app 分发（Electron 侧同样不打进 asar）。
    cpSync(options.webDistDir, layout.webDist, {
      recursive: true,
      filter: (source) => source === options.webDistDir
        || shouldCopyWebDistEntry(path.relative(options.webDistDir, source)),
    })
    io.log(`[build-swift-app] renderer dist/web → ${layout.webDist}（过滤 *.map 与 .vite/，与 Electron build.files 对齐）`)
  }

  // 3b. 嵌入 Sparkle.framework（S-01 / 裁决 D-1 选 B）：必须在签名之前——
  //     嵌套框架先于主签名，否则 codesign --verify --deep 会报未密封。
  embedSparkle(layout, options, io)

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
    // 嵌套 bundle（Sparkle.framework 及其 Updater.app / XPCServices）：必须按
    // 由深到浅单独签名——只签内部可执行文件不产生 framework 自己的封存，
    // 主签名后 --verify 会报 unsealed contents（2026-12 Sparkle 嵌入实测）。
    const nestedBundles = findNestedBundles(layout.appDir)
    for (const bundle of nestedBundles) {
      run('codesign', codesignArgs(options, bundle), io)
    }
    if (nestedBundles.length > 0) {
      io.log(`[build-swift-app] 嵌套 bundle 已签名 ${nestedBundles.length} 个（由深到浅）`)
    }
    run('codesign', codesignArgs(options, layout.appDir, entitlements), io)
    const verify = quiet('codesign', ['--verify', '--deep', '--strict', layout.appDir])
    if (verify.status !== 0) {
      throw new Error(`签名校验失败：${verify.stderr || verify.stdout}`)
    }
    io.log('[build-swift-app] codesign 校验通过')
  }

  // 5/6. 分发产物。路径 = artifactBasename + .zip/.dmg（精确路径，永不 glob）：
  // 复用输出目录时旧版本的归档会与新版本并存，发布腿必须只上传这两个精确路径
  // （G29：曾把 0.3.1 与 0.3.2-beta.1 的 *.dmg/*.zip 一并上传）。
  if (!options.noZip) {
    rmSync(layout.zipPath, { force: true })
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', layout.appDir, layout.zipPath], io)
  }
  if (!options.noDmg) {
    // P7（2026-12）+ 2026-09 补强：卷内容 = .app + /Applications 快捷方式
    // **+ Finder 拖拽布局**（背景箭头 + 图标定位，写进卷内 .DS_Store）。
    // 卷名/布局/背景资产全部由 dmg.mjs 单源；产出后立刻做产物级校验（挂载断言
    // .DS_Store/.background/快捷方式），失败 loud——绝不发没有提示的 DMG。
    createStyledDmg({
      appDir: layout.appDir,
      appName: options.appName,
      outPath: layout.dmgPath,
      io,
    })
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
      console.log('       [--skip-sidecar] [--skip-web-dist] [--no-sign] [--no-zip] [--no-dmg] [--dry-run]')
      console.log('       [--sparkle-feed <url>] [--sparkle-public-key <ed25519>] [--swift-args "<args>"]')
      process.exit(0)
    }
    await runBuildSwiftApp(options)
  } catch (error) {
    console.error(`[build-swift-app] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
