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
 * 步骤：swift build（可 --skip-build）→ 组装 → Info.plist 渲染 → 嵌套签名
 * （sidecar/node，Developer ID 时带 hardened runtime + node 权限）→ 主签名
 * （--identity 缺省 ad-hoc `-`）→ zip（ditto）/ dmg（hdiutil）。
 *
 * 离线/沙箱：--skip-build 复用已有 .build 产物；--skip-sidecar 允许无 W-23
 * 产物时只验壳装配；--no-sign/--no-dmg/--no-zip 分步跳过。
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
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
    else if (arg === '--sidecar') options.sidecarDir = path.resolve(next())
    else if (arg === '--icon') options.iconPath = path.resolve(next())
    else if (arg === '--web-dist') options.webDistDir = path.resolve(next())
    else if (arg === '--skip-build') options.skipBuild = true
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

/** Mach-O magic（thin 32/64 + fat 大小端）——嵌套原生模块（.node/dylib）识别。 */
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

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
    } catch {
      return
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
  const plist = renderInfoPlist(readFileSync(templatePath, 'utf8'), { VERSION: version })
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
    cpSync(options.sidecarDir, layout.sidecarDir, { recursive: true })
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
  } else {
    throw new Error(`缺少 W-23 sidecar 装配目录：${options.sidecarDir}（先跑 build:sidecar，或用 --skip-sidecar）`)
  }
  if (existsSync(options.webDistDir)) {
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
      run('codesign', codesignArgs(options, file, nodeEntitlements), io)
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
    run('hdiutil', ['create', '-volname', APP_NAME, '-srcfolder', layout.appDir,
      '-ov', '-format', 'UDZO', layout.dmgPath], io)
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
      console.log('       [--app-name <name>] [--artifact-basename <name>]')
      console.log('       [--sidecar <dir>] [--icon <icns>] [--web-dist <dir>] [--skip-build]')
      console.log('       [--skip-sidecar] [--no-sign] [--no-zip] [--no-dmg] [--dry-run] [--swift-args "<args>"]')
      process.exit(0)
    }
    await runBuildSwiftApp(options)
  } catch (error) {
    console.error(`[build-swift-app] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
