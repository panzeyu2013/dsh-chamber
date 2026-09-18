#!/usr/bin/env node
/**
 * dmg.mjs —— 样式化 DMG 的**单一实现**（2026-09 P7 补强）。
 *
 * 背景与目标：DMG 卷此前只有 `.app + /Applications 快捷方式`（能拖但没有引导）。
 * Electron 侧由 electron-builder/dmg-builder 给出「背景箭头 + 图标定位」的明确
 * 拖拽提示，原生腿没有 —— 本模块把同一体验显式做出来，并且**只做一份**：
 *   - 本地/装配腿：macos/scripts/build-swift-app.mjs 直接 import 本模块；
 *   - 正式发布腿：release.yml 的「Notarize + staple」步调用本文件的 CLI。
 * 两处若各自实现必然漂移，故实现与资产都收敛在这里。
 *
 * 卷布局（Finder 语义）——与 electron-builder 的 dmg 默认形态对齐：
 *   - 背景图按**内容区左下角**锚定、按点尺寸绘制（不缩放）；窗口标题栏会吃掉
 *     约 28px 顶部。资产是与 electron-builder 同款的**双 rep TIFF**
 *     （540×380@72dpi + 1080×760@144dpi）：Retina 上由系统挑 2x rep，
 *     1x PNG 那种清晰度不足的问题由此消除（2026-09 用户实测反馈）。
 *   - 图标坐标采用 electron-builder 的默认 contents（app 130,220 / Applications
 *     410,220），与背景箭头保持同一视觉关系。
 *   - 图标定位/背景图/窗口尺寸都写在卷内 `.DS_Store`，只能由 Finder 写出：
 *     因此流程是「UDRW 可写镜像 → 挂载 → osascript 驱动 Finder → 等 .DS_Store
 *     落盘 → detach → convert UDZO」。UDZO 转换保留 .DS_Store 与 .background。
 *   - 失败一律 loud（抛错）：产出没有拖拽提示的 DMG 正是本模块要修的缺陷，
 *     静默降级等于把缺陷重新发出去。
 *
 * 与 electron-builder 的取舍（design 25 §8.5「Rejected alternatives」）：
 * dmg-builder 用的是**下载+校验**的独立 dmgbuild 工具（不驱动 Finder）。本模块
 * 不引外部工具/网络依赖，代价是依赖 Finder 自动化；CI 上由 osascript 失败即刻
 * 红灯兜住（绝不产出无提示卷）。
 *
 * CLI：
 *   node macos/scripts/dmg.mjs --app <App.app> --app-name <name> --out <x.dmg>
 *     [--background <tiff>] [--skip-verify]
 * 退出码非 0 = 失败；stdout 打印路径与字节数。
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const macosDir = path.resolve(here, '..')

/** 背景图资产（仓库内、随 checkout 一起进 CI；绝不放 packages/desktop 的
 *  buildResources —— electron-builder 的 computeBackground 会优先吃那里的
 *  background.tiff/png，放错位置会顺手改掉 Electron 的 DMG）。 */
export const DMG_BACKGROUND_FILE_NAME = 'background.tiff'
/** 仓库内源资产（electron-builder dmg-builder 模板同款双 rep TIFF；MIT，
 *  署名见 THIRD_PARTY_NOTICES.md）。卷内一律以 background.tiff 落位——
 *  Finder 脚本按卷内名寻址。 */
export const DMG_BACKGROUND_SOURCE_NAME = 'dmg-background.tiff'
export const DMG_BACKGROUND_DIR_NAME = '.background'
export const DMG_APPLICATIONS_LINK = 'Applications'
/** 窗口尺寸（点）＝背景图像素尺寸；图标定位见 DMG_ICON_POSITIONS。 */
export const DMG_WINDOW = { width: 540, height: 380 }
export const DMG_ICON_SIZE = 128
/** 图标中心（窗口内容坐标，原点左上）——electron-builder dmg 默认 contents 坐标，
 *  与背景箭头保持同一视觉关系。 */
export const DMG_ICON_POSITIONS = { app: { x: 130, y: 220 }, applications: { x: 410, y: 220 } }

/** 仓库内背景图的绝对路径。 */
export function defaultBackgroundPath(root = macosDir) {
  return path.join(root, 'resources', DMG_BACKGROUND_SOURCE_NAME)
}

function defaultIo() {
  return { log: (line) => console.log(line), error: (line) => console.error(line) }
}

/** 前台的 loud 执行：非零退出抛错（含 stderr 尾部）。 */
function run(command, args, io, options = {}) {
  const { quiet = false } = options
  if (!quiet) io.log(`  $ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: false,
  })
  if (result.error) throw new Error(`${command} 启动失败：${result.error.message}`)
  if (result.status !== 0) {
    const detail = quiet ? `：${((result.stderr ?? '') + (result.stdout ?? '')).trim().slice(-400)}` : ''
    throw new Error(`${command} 失败（exit ${result.status}）${detail}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** AppleScript 字符串字面量的注入护栏：卷名/app 名只允许常规字符。 */
function assertScriptSafe(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${label} 含非法字符（只允许 [A-Za-z0-9._-]）：${value}`)
  }
}

/** 搭建卷内容：.app 副本 + /Applications 快捷方式 + 隐藏的 .background/背景图。
 *  （签名/资源分叉由 ditto 保真；背景图放 .background 目录，chflags hidden 隐藏。） */
export function stageDmgVolume(appDir, stageDir, appName, options = {}) {
  const io = options.io ?? defaultIo()
  const backgroundPath = options.backgroundPath ?? defaultBackgroundPath()
  if (!existsSync(appDir)) throw new Error(`缺少 .app：${appDir}`)
  if (!existsSync(backgroundPath)) throw new Error(`缺少 DMG 背景图：${backgroundPath}`)
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  run('ditto', [appDir, path.join(stageDir, `${appName}.app`)], io)
  symlinkSync('/Applications', path.join(stageDir, DMG_APPLICATIONS_LINK))
  const backgroundDir = path.join(stageDir, DMG_BACKGROUND_DIR_NAME)
  mkdirSync(backgroundDir, { recursive: true })
  cpSync(backgroundPath, path.join(backgroundDir, DMG_BACKGROUND_FILE_NAME))
  run('chflags', ['hidden', backgroundDir], { ...io, log: () => {} })
  return stageDir
}

/** hdiutil create argv：可写 UDRW 镜像（卷名 = --app-name）。 */
export function dmgCreateArgs(appName, stageDir, rwPath) {
  return ['create', '-volname', appName, '-srcfolder', stageDir, '-fs', 'HFS+', '-format', 'UDRW', '-ov', rwPath]
}

/** hdiutil convert argv：最终分发格式 UDZO（保留 .DS_Store/.background）。 */
export function dmgConvertArgs(rwPath, outPath) {
  return ['convert', rwPath, '-format', 'UDZO', '-ov', '-o', outPath]
}

/** Finder 布局脚本：窗口尺寸/图标大小/背景图/图标坐标（写进卷内 .DS_Store）。 */
export function finderLayoutScript(volumeName, appName) {
  assertScriptSafe(volumeName, '卷名')
  assertScriptSafe(`${appName}.app`, 'app 名')
  const bounds = [200, 120, 200 + DMG_WINDOW.width, 120 + DMG_WINDOW.height].join(', ')
  const appPos = `{${DMG_ICON_POSITIONS.app.x}, ${DMG_ICON_POSITIONS.app.y}}`
  const appsPos = `{${DMG_ICON_POSITIONS.applications.x}, ${DMG_ICON_POSITIONS.applications.y}}`
  return [
    'tell application "Finder"',
    `  tell disk "${volumeName}"`,
    '    open',
    '    set current view of container window to icon view',
    '    set toolbar visible of container window to false',
    '    set statusbar visible of container window to false',
    `    set the bounds of container window to {${bounds}}`,
    '    set viewOptions to the icon view options of container window',
    '    set arrangement of viewOptions to not arranged',
    `    set icon size of viewOptions to ${DMG_ICON_SIZE}`,
    `    set background picture of viewOptions to file "${DMG_BACKGROUND_DIR_NAME}:${DMG_BACKGROUND_FILE_NAME}"`,
    `    set position of item "${appName}.app" of container window to ${appPos}`,
    `    set position of item "${DMG_APPLICATIONS_LINK}" of container window to ${appsPos}`,
    '    update without registering applications',
    '    delay 1',
    '    close',
    '  end tell',
    'end tell',
  ].join('\n')
}

/**
 * 挂载镜像并返回挂载点。**必须让 hdiutil 走 /Volumes/<卷名> 的默认挂载点**：
 * Finder 把「disk」按挂载点末段命名（实测：-mountpoint 到自定义目录时
 * `tell disk "<卷名>"` 会 -1728，而 `disk "<挂载点末段>"` 才存在），
 * 自定义挂载点会让 Finder 定位不到本卷。可写挂载同时不能带 -nobrowse
 * （Finder 不登记 nobrowse 卷）；只读校验挂载不需要 Finder，保持 -nobrowse。
 * 挂载点从 hdiutil 输出末行解析（同名卷残留时 hdiutil 会加 " 1" 后缀）。
 */
function attach(imagePath, readonly) {
  const args = ['attach', imagePath, '-noverify', '-noautoopen']
  if (readonly) args.push('-readonly', '-nobrowse')
  else args.push('-readwrite')
  const { stdout } = run('hdiutil', args, defaultIo(), { quiet: true })
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const columns = (lines[lines.length - 1] ?? '').split('\t').map((cell) => cell.trim()).filter((cell) => cell !== '')
  const mountPoint = columns[columns.length - 1]
  if (!mountPoint || !existsSync(mountPoint)) {
    throw new Error(`hdiutil attach 未返回可用挂载点：${stdout.trim().slice(-200)}`)
  }
  return mountPoint
}

/** 卸载：Finder/Spotlight 可能短暂占用，重试 + 最后 -force；仍失败则 loud。 */
function detach(mountPoint) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const args = ['detach', mountPoint]
    if (attempt >= 2) args.push('-force')
    const result = spawnSync('hdiutil', args, { encoding: 'utf8', stdio: 'pipe' })
    if (result.status === 0) return
    sleepMs(500)
  }
  throw new Error(`hdiutil detach 失败（5 次重试后仍占用）：${mountPoint}`)
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 等 Finder 把 .DS_Store 落盘（异步写；超时即 loud，不产无提示卷）。 */
function waitForFile(file, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file) && statSync(file).size > 0) return true
    sleepMs(250)
  }
  return false
}

/**
 * 产出样式化 DMG：UDRW → 挂载 → Finder 布局 → 等 .DS_Store → detach → UDZO → 校验。
 * 与 /Volumes/<appName> 同名卷冲突时直接失败（Finder 按卷名寻址，同名会让布局
 * 写到别的卷上——那种「看起来成功其实没提示」的静默错误必须拦下）。
 */
export function createStyledDmg(options) {
  const io = options.io ?? defaultIo()
  const { appDir, appName, outPath } = options
  const backgroundPath = options.backgroundPath ?? defaultBackgroundPath()
  if (!appName || !outPath) throw new Error('createStyledDmg 需要 appName 与 outPath')
  if (existsSync(`/Volumes/${appName}`)) {
    throw new Error(`/Volumes/${appName} 已存在——请先推出该卷再重建 DMG（Finder 按卷名寻址，同名会让布局写到别的卷）`)
  }
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-chamber-dmg-'))
  const stageDir = path.join(tempRoot, 'stage')
  const rwPath = path.join(tempRoot, 'rw.dmg')
  rmSync(outPath, { force: true })
  try {
    stageDmgVolume(appDir, stageDir, appName, { backgroundPath, io })
    run('hdiutil', dmgCreateArgs(appName, stageDir, rwPath), io)
    const mountPoint = attach(rwPath, false)
    try {
      // Finder 的卷名 = 挂载点末段（见 attach 注释）。
      const volumeName = path.basename(mountPoint)
      // Finder 对刚挂载卷的登记可能滞后（disk "<name>" 偶发 -1728），有界重试。
      let layoutError = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          run('osascript', ['-e', finderLayoutScript(volumeName, appName)], io)
          layoutError = null
          break
        } catch (error) {
          layoutError = error
          sleepMs(1000)
        }
      }
      if (layoutError !== null) throw layoutError
      if (!waitForFile(path.join(mountPoint, '.DS_Store'))) {
        throw new Error('Finder 未在时限内写出卷内 .DS_Store（无拖拽布局）——拒绝产出无提示 DMG')
      }
    } finally {
      detach(mountPoint)
    }
    run('hdiutil', dmgConvertArgs(rwPath, outPath), io)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
  if (options.verify !== false) verifyDmgLayout(outPath, appName, { io })
  const bytes = statSync(outPath).size
  io.log(`[dmg] 完成：${outPath}（${(bytes / 1024 / 1024).toFixed(1)}MB，含 Finder 拖拽布局）`)
  return { outPath, bytes }
}

/**
 * 产物级校验（headless）：挂载成品并断言 /Applications 链接、.app、.DS_Store、
 * .background/背景图都在。没有这一步，「加了背景但 Finder 不认」照样能过 CI。
 */
export function verifyDmgLayout(dmgPath, appName, options = {}) {
  const io = options.io ?? defaultIo()
  if (!existsSync(dmgPath)) throw new Error(`DMG 不存在：${dmgPath}`)
  const mountPoint = attach(dmgPath, true)
  try {
    {
      const appCopy = path.join(mountPoint, `${appName}.app`)
      const link = path.join(mountPoint, DMG_APPLICATIONS_LINK)
      const dsStore = path.join(mountPoint, '.DS_Store')
      const background = path.join(mountPoint, DMG_BACKGROUND_DIR_NAME, DMG_BACKGROUND_FILE_NAME)
      if (!existsSync(appCopy)) throw new Error(`DMG 卷内缺 ${appName}.app`)
      if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== '/Applications') {
        throw new Error(`DMG 卷内 ${DMG_APPLICATIONS_LINK} 必须是指向 /Applications 的快捷方式（P7）`)
      }
      if (!existsSync(dsStore) || statSync(dsStore).size <= 0) {
        throw new Error('DMG 卷内缺 .DS_Store——Finder 看不见拖拽布局')
      }
      if (!existsSync(background)) {
        throw new Error(`DMG 卷内缺 ${DMG_BACKGROUND_DIR_NAME}/${DMG_BACKGROUND_FILE_NAME}——背景图缺失`)
      }
      io.log('[dmg] 校验通过：.app + /Applications 快捷方式 + .DS_Store + 背景图齐全')
    }
  } finally {
    detach(mountPoint)
  }
}

/** CLI 参数解析（纯函数；未知参数 loud）。 */
export function parseDmgArgs(argv) {
  const options = { backgroundPath: null, verify: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} 缺少取值`)
      i += 1
      return value
    }
    if (arg === '--app') options.appDir = next()
    else if (arg === '--app-name') options.appName = next()
    else if (arg === '--out') options.outPath = next()
    else if (arg === '--background') options.backgroundPath = next()
    else if (arg === '--skip-verify') options.verify = false
    else throw new Error(`未知参数：${arg}`)
  }
  if (!options.appDir || !options.appName || !options.outPath) {
    throw new Error('用法：node macos/scripts/dmg.mjs --app <App.app> --app-name <name> --out <x.dmg> [--background <png>] [--skip-verify]')
  }
  return options
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    const options = parseDmgArgs(process.argv.slice(2))
    const result = createStyledDmg(options)
    console.log(`[dmg] ${result.outPath} ${result.bytes} bytes`)
  } catch (error) {
    console.error(`[dmg] 失败：${error.message}`)
    process.exit(1)
  }
}
