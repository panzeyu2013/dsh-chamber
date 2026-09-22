#!/usr/bin/env node
/**
 * dmg.mjs —— 样式化 DMG 的**单一实现**。
 *
 * 背景与目标：DMG 卷只有 `.app + /Applications 快捷方式`（能拖但没有引导）。
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
 *     1x PNG 那种清晰度不足的问题由此消除（用户实测反馈）。
 *   - 图标坐标采用 electron-builder 的默认 contents（app 130,220 / Applications
 *     410,220），与背景箭头保持同一视觉关系。
 *   - 图标定位/背景图/窗口尺寸都写在卷内 `.DS_Store`，只能由 Finder 写出：
 *     因此流程是「UDRW 可写镜像 → 挂载 → osascript 驱动 Finder → 等 .DS_Store
 *     落盘 → detach → convert UDZO」。UDZO 转换保留 .DS_Store 与 .background。
 *   - 失败一律 loud（抛错）：产出没有拖拽提示的 DMG 不可接受——
 *     静默降级等于把这种 DMG 发出去。
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
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync,
  symlinkSync,
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
/** 窗口左上角（全局坐标点）——Finder 脚本与内容级校验共用一处，避免两边各写一份。 */
export const DMG_WINDOW_ORIGIN = { x: 200, y: 120 }
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
  const bounds = [
    DMG_WINDOW_ORIGIN.x, DMG_WINDOW_ORIGIN.y,
    DMG_WINDOW_ORIGIN.x + DMG_WINDOW.width, DMG_WINDOW_ORIGIN.y + DMG_WINDOW.height,
  ].join(', ')
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

/**
 * 等 Finder 把**内容级**布局落盘（异步写）。只看 `.DS_Store` 存在会读到半成品
 * （先写窗口记录、后写图标视图/背景），convert 出来就是无提示卷；因此判据与产物级
 * 校验同源（`.icvp` 的 backgroundType=2 + 非空背景别名），超时即 loud。
 */
function waitForLayout(mountPoint, timeoutMs = 15000) {
  const dsStore = path.join(mountPoint, '.DS_Store')
  const deadline = Date.now() + timeoutMs
  let last = '.DS_Store 未出现'
  while (Date.now() < deadline) {
    if (existsSync(dsStore) && statSync(dsStore).size > 0) {
      try {
        const iconView = dmgLayoutFacts(readFileSync(dsStore)).iconView
        if (iconView?.backgroundType === 2 && iconView.backgroundImageAlias instanceof Uint8Array
          && iconView.backgroundImageAlias.length > 0) {
          return { ok: true }
        }
        last = '.DS_Store 已出现但内容级布局未落盘（backgroundType/背景别名）'
      } catch (error) {
        last = '.DS_Store 暂不可解析：' + String(error.message).slice(0, 80)
      }
    }
    sleepMs(250)
  }
  return { ok: false, reason: last }
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
      const layout = waitForLayout(mountPoint)
      if (!layout.ok) {
        throw new Error('Finder 未在时限内写出内容级拖拽布局（' + layout.reason
          + '）——拒绝产出无提示 DMG')
      }
    } finally {
      detach(mountPoint)
    }
    run('hdiutil', dmgConvertArgs(rwPath, outPath), io)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
  if (options.verify === false) {
    // 跳过也必须可观测：发布腿禁用这条校验等于把门禁静默拿掉。
    io.log('[dmg] 警告：--skip-verify 跳过产物级布局校验（仅供调试；发布腿不得使用）')
  } else {
    verifyDmgLayout(outPath, appName, { io })
  }
  const bytes = statSync(outPath).size
  io.log(`[dmg] 完成：${outPath}（${(bytes / 1024 / 1024).toFixed(1)}MB，含 Finder 拖拽布局）`)
  return { outPath, bytes }
}

/**
 * 取出 .DS_Store 里所有 blob 记录的载荷。记录布局（本机实测，Xcode 27）：
 *   [名长][名]["blob"][载荷长度 u32 大端][载荷……]
 * 因此只认「bplist00 前 4 字节 = 载荷长度、再前 4 字节 = "blob"」这一可验证形态，
 * 不猜记录名、也不依赖记录目录块（DSDB）的偏移表。
 * @param {Buffer} buffer - 整个 .DS_Store 文件。
 * @returns {Buffer[]} 各 blob 载荷，顺序 = 文件内出现顺序。
 */
export function dsStoreBlobs(buffer) {
  const blobs = []
  let from = 0
  while (from < buffer.length) {
    const magic = buffer.indexOf('bplist00', from, 'latin1')
    if (magic < 0) break
    const isBlob = magic >= 8
      && buffer.toString('latin1', magic - 8, magic - 4) === 'blob'
      && buffer.readUInt32BE(magic - 4) > 0
      && magic + buffer.readUInt32BE(magic - 4) <= buffer.length
    if (isBlob) {
      const length = buffer.readUInt32BE(magic - 4)
      blobs.push(buffer.subarray(magic, magic + length))
      from = magic + length
    } else {
      from = magic + 1
    }
  }
  return blobs
}

/** 最小二进制 plist（bplist00）读取器：只实现 .DS_Store 用到的对象类型
 *  （dict/array/string/data/int/real/bool/date/uid），`<data>` 直接返回 Buffer、
 *  UID 返回 `{ uid }` 占位。纯函数、无子进程、无依赖。
 *
 *  为什么不走 plutil：`plutil -convert json` 对 Finder 写的 .icvp 直接报
 *  "Invalid object in plist for JSON format"（本机实测；别名字段无法
 *  JSON 化），而 `plutil -extract` 要逐键调用。这里读 32 字节 trailer + 偏移
 *  表，一百行左右，测试里还能用真实 bplist 直测。 */
export function parseBinaryPlist(buffer) {
  if (buffer.length < 40 || buffer.toString('latin1', 0, 8) !== 'bplist00') {
    throw new Error('不是 bplist00 二进制 plist')
  }
  const readSized = (at, size) => {
    let value = 0
    for (let i = 0; i < size; i += 1) value = value * 256 + buffer.readUInt8(at + i)
    return value
  }
  const trailer = buffer.length - 32
  const offsetIntSize = buffer.readUInt8(trailer + 6)
  const objectRefSize = buffer.readUInt8(trailer + 7)
  // 畸形输入护栏：42 字节的伪造 trailer 会让解析吃到 ~3GB RSS。
  if (![1, 2, 4, 8].includes(offsetIntSize) || ![1, 2, 4, 8].includes(objectRefSize)) {
    throw new Error('非法 bplist 偏移宽度：' + offsetIntSize + '/' + objectRefSize)
  }
  const numObjects = readSized(trailer + 8, 8)
  const topObject = readSized(trailer + 16, 8)
  const offsetTableOffset = readSized(trailer + 24, 8)
  if (numObjects > buffer.length || offsetTableOffset + numObjects * offsetIntSize > buffer.length) {
    throw new Error('bplist 对象数超出输入长度：' + numObjects)
  }
  const offsets = []
  for (let i = 0; i < numObjects; i += 1) {
    offsets.push(readSized(offsetTableOffset + i * offsetIntSize, offsetIntSize))
  }
  const parseAt = (offset, depth) => {
    if (depth > 64) throw new Error('plist 嵌套过深')
    const marker = buffer.readUInt8(offset)
    const type = marker >> 4
    const info = marker & 0x0f
    const sized = (at) => {
      if (info !== 0x0f) return { length: info, next: at }
      const intSize = 2 ** (buffer.readUInt8(at) & 0x0f)
      const length = readSized(at + 1, intSize)
      // 计数按输入长度封顶（否则伪造的 2^40 长度会让循环撑爆内存）。
      if (length > buffer.length) throw new Error('bplist 长度超出输入：' + length)
      return { length, next: at + 1 + intSize }
    }
    if (type === 0x0) {
      if (info === 0x08) return false
      if (info === 0x09) return true
      return null
    }
    if (type === 0x1) {
      const size = 2 ** info
      // 与 plutil/CFBinaryPlist 同语义（实测 `plutil -convert binary1` → `-extract raw`）：
      // 1/2/4/16 字节按**无符号**读（Apple 对非负值用最小宽度：128 → 1 字节 0x80、255 → 0xFF、
      // 65535 → 2 字节；真实 .icvp 的 viewOptionsVersion 是可达的 16 字节整数），
      // 只有 8 字节按二补码有符号（-5 → 0x13 + fffffffffffffffb，读回 -5）。
      if (size === 8) return Number(buffer.readBigInt64BE(offset + 1))
      if (size === 16) return Number(BigInt('0x' + buffer.toString('hex', offset + 1, offset + 17)))
      if (size > 16) throw new Error('不支持的 plist 整数宽度：' + size + ' 字节')
      return readSized(offset + 1, size)
    }
    if (type === 0x2) {
      const size = 2 ** info
      return size === 8 ? buffer.readDoubleBE(offset + 1) : buffer.readFloatBE(offset + 1)
    }
    if (type === 0x3) return new Date(buffer.readDoubleBE(offset + 1) * 1000 + 978307200000)
    if (type === 0x4) {
      const { length, next } = sized(offset + 1)
      return buffer.subarray(next, next + length)
    }
    if (type === 0x5) {
      const { length, next } = sized(offset + 1)
      return buffer.toString('latin1', next, next + length)
    }
    if (type === 0x6) {
      const { length, next } = sized(offset + 1)
      return Buffer.from(buffer.subarray(next, next + length * 2)).swap16().toString('utf16le')
    }
    if (type === 0x8) return { uid: readSized(offset + 1, info + 1) }
    if (type === 0xa || type === 0xc) {
      const { length, next } = sized(offset + 1)
      if (next + length * objectRefSize > buffer.length) throw new Error('bplist 引用数超出输入：' + length)
      const items = []
      for (let i = 0; i < length; i += 1) {
        items.push(parseAt(offsets[readSized(next + i * objectRefSize, objectRefSize)], depth + 1))
      }
      return items
    }
    if (type === 0xd) {
      const { length, next } = sized(offset + 1)
      if (next + 2 * length * objectRefSize > buffer.length) throw new Error('bplist 引用数超出输入：' + length)
      const dict = {}
      for (let i = 0; i < length; i += 1) {
        const key = parseAt(offsets[readSized(next + i * objectRefSize, objectRefSize)], depth + 1)
        const value = parseAt(offsets[readSized(next + (length + i) * objectRefSize, objectRefSize)], depth + 1)
        dict[String(key)] = value
      }
      return dict
    }
    throw new Error('不支持的 plist 对象类型 0x' + type.toString(16))
  }
  return parseAt(offsets[topObject], 0)
}

/** UTF-16BE 编码（Finder 在 Iloc 记录里以大端序存条目名）。 */
function utf16be(text) {
  return Buffer.from(text, 'utf16le').swap16()
}

/**
 * `.DS_Store` 里每个图标一条记录，形态为
 * `[u16 名长][UTF-16BE 名]["Ilocblob"][u32 坐标长][16 字节坐标]`——**名字与记录头相邻**。
 * 实测：Iloc 的载荷只有 16 字节坐标、不含名字（名字末尾紧接 `Ilocblob`），
 * 所以条目名必须在记录头一侧查，不能去载荷里搜。
 */
export function dsStoreIlocEntries(buffer) {
  const marker = Buffer.from('Ilocblob', 'latin1')
  const entries = []
  let at = buffer.indexOf(marker, 0, 'latin1')
  while (at >= 0) {
    // 名长未知：按候选长度回溯 `[u16 名长][名]`，取第一个自洽的长度。
    for (let length = 1; length <= 255; length += 1) {
      const start = at - length * 2 - 2
      if (start < 0) break
      if (buffer.readUInt16BE(start) !== length) continue
      const name = Buffer.from(buffer.subarray(start + 2, at)).swap16().toString('utf16le')
      if (name.length === length) entries.push(name)
      break
    }
    at = buffer.indexOf(marker, at + 1, 'latin1')
  }
  return entries
}

/** 条目名是否登记了图标坐标：名字字节必须**紧邻**一条 `Ilocblob` 记录头（空名字恒 false）。 */
export function dsStoreHasIlocEntry(buffer, name) {
  if (!name) return false
  return buffer.includes(Buffer.concat([utf16be(name), Buffer.from('Ilocblob', 'latin1')]))
}

/**
 * .DS_Store 里的 Finder 布局事实（内容级校验的输入；纯函数，plist 解析可注入）：
 *   - iconView：图标视图记录（backgroundType / backgroundImageAlias / iconSize）
 *   - window：窗口记录（WindowBounds）
 *   - ilocEntries：登记了坐标的条目名（来自 Iloc 记录头）
 * 「设了但没写进 .DS_Store」「别名没指向卷内背景图」这类缺陷只有在这里才抓得到——
 * 只断言文件存在会漏掉这类（DMG 没有拖拽提示却全绿）。
 */
export function dmgLayoutFacts(buffer, options = {}) {
  const parsePlist = options.parsePlist ?? parseBinaryPlist
  const facts = { iconView: null, window: null, ilocEntries: [] }
  for (const blob of dsStoreBlobs(buffer)) {
    let parsed
    try {
      parsed = parsePlist(blob)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    if ('backgroundType' in parsed || 'backgroundImageAlias' in parsed) facts.iconView = parsed
    else if ('WindowBounds' in parsed) facts.window = parsed
  }
  facts.ilocEntries = dsStoreIlocEntries(buffer)
  return facts
}

/**
 * 内容级判据（纯函数，接收 dmgLayoutFacts 的返回值）：verifyDmgLayout 与单测共用同一
 * 份判据——负例直接构造 facts 即可，不必造一整个 DMG。通过时返回
 * 已校验的事实（供日志用）。
 */
export function assertDmgLayoutFacts(facts, appName) {
  const iconView = facts?.iconView
  if (iconView === null || iconView === undefined) {
    throw new Error('.DS_Store 里没有 Finder 视图记录（.icvp）——拖拽布局没有落盘')
  }
  if (iconView.backgroundType !== 2) {
    throw new Error('背景必须是图像模式（backgroundType=2），实际 '
      + JSON.stringify(iconView.backgroundType) + '——Finder 不会显示提示')
  }
  const alias = iconView.backgroundImageAlias
  if (!(alias instanceof Uint8Array) || alias.length === 0) {
    throw new Error('.DS_Store 缺 backgroundImageAlias——背景图没有真正设置，Finder 不会显示提示')
  }
  const aliasText = Buffer.from(alias).toString('latin1')
  if (!aliasText.includes(DMG_BACKGROUND_DIR_NAME) || !aliasText.includes(DMG_BACKGROUND_FILE_NAME)) {
    throw new Error('背景别名没有指向卷内 ' + DMG_BACKGROUND_DIR_NAME + '/' + DMG_BACKGROUND_FILE_NAME
      + '——Finder 解析不到')
  }
  // 别名必须属于本卷：只查相对路径会放过「指向另一卷同路径」的别名。
  // 卷名 = appName（createStyledDmg 以 appName 作卷名）；非 ASCII 卷名在别名字节里编码不同，跳过。
  if (/^[\x20-\x7e]+$/.test(appName) && !aliasText.includes(appName)) {
    throw new Error('背景别名不属于本卷（卷名 ' + appName + ' 不在别名字节里）——Finder 解析不到')
  }
  if (iconView.iconSize !== DMG_ICON_SIZE) {
    throw new Error('图标尺寸未落盘：期望 ' + DMG_ICON_SIZE + '，实际 ' + JSON.stringify(iconView.iconSize))
  }
  const bounds = facts.window?.WindowBounds
  // 只比尺寸：窗口原点由 Finder 按屏幕重排（本机实测 y=482、x 保留），不是我们的输入；
  // 窄屏/异形屏下夹取 x 会让精确前缀断言误红。
  const expectedSuffix = ', {' + DMG_WINDOW.width + ', ' + DMG_WINDOW.height + '}}'
  if (typeof bounds !== 'string' || !bounds.startsWith('{{') || !bounds.endsWith(expectedSuffix)) {
    throw new Error('窗口尺寸未落盘：期望 <原点>' + expectedSuffix + '，实际 ' + JSON.stringify(bounds))
  }
  const ilocEntries = facts.ilocEntries ?? []
  if (ilocEntries.length === 0) {
    throw new Error('图标坐标记录（Iloc）缺失——两个图标没有就位')
  }
  const missing = [appName + '.app', DMG_APPLICATIONS_LINK]
    .filter((entry) => !ilocEntries.includes(entry))
  if (missing.length > 0) {
    throw new Error('图标坐标记录（Iloc）缺条目：' + missing.join(' / '))
  }
  return { bounds }
}

/**
 * 产物级校验（headless）：挂载成品并断言 /Applications 链接、.app、.DS_Store、
 * .background/背景图都在，**并按内容级判据（assertDmgLayoutFacts）确认**背景=图像模式、
 * 别名指向卷内背景图、窗口尺寸与两条图标坐标都已落盘。只断言文件存在的话，「设了但
 * 没写进去」的 DMG 照样全绿——那正是本模块要防的「没有拖拽提示」缺陷。
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

      // 内容级校验：.DS_Store 里必须真的写着「图像背景 + 指向卷内背景图的别名 +
      // 窗口尺寸 + 两条图标坐标」。只查文件存在会放过「设了但没落盘」的 DMG。
      const { bounds } = assertDmgLayoutFacts(dmgLayoutFacts(readFileSync(dsStore)), appName)
      io.log('[dmg] 校验通过：.app + /Applications + .DS_Store（backgroundType=2、背景别名指向卷内、窗口 '
        + bounds + '、坐标 2 条）+ 背景图齐全')
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
