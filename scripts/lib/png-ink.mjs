/**
 * png-ink —— 最小 PNG 解码 + 区域 ink/众数色统计（零依赖，只用 node:zlib）。
 *
 * 与 scripts/dev/svg-resource-probe.mjs:193-263 共用同一份解码器
 * （WKWebView 真机探针的像素半），只支持探针自己产出的 8bit RGB/RGBA。
 * CDP `Page.startScreencast` 的 PNG 同为 8bit RGB/RGBA（Chromium 不产调色板图），
 * 因此同一份解码在两处成立。**零新依赖**：`node:zlib` 的 `inflateSync/deflateSync`
 * 是 Node 内建；CRC32 自带实现（自测的编码器需要它）。
 *
 * 语义（对应 packages/renderer/scripts/switch-frame-verdict.ts 的输入）：
 *  - `modeColor`：区域内出现次数最多的颜色（`#rrggbb`，忽略 alpha）——平面帧的
 *    "那块单色"就是它。**不能用平均色**（内容可能恰好均值等于背景）。
 *  - `modeCoverage`：众数色像素占比（0..1）；≥ flatCoverage 判"平坦帧"。
 *  - `inkRatio`：1 - modeCoverage（"非众数像素占比"）——它的低值**不能**单独证明
 *    有内容（纯平面就是 0），只作证据；判定归 switch-frame-verdict。
 *  - `meanColor`：仅进证据（人读报告用）。
 *
 * 用法：
 *   node scripts/lib/png-ink.mjs --self-test          # 合成 PNG 往返自测（CI 可跑，无 CDP）
 *   node scripts/lib/png-ink.mjs --file shot.png [--rect x,y,w,h] [--scale 1]
 *
 * 边界：不支持 16bit / 灰度+alpha 之外的奇色深组合的语义细分（channels 映射照原实现：
 * 0→1、2→3、4→2、6→4）；不支持交错（interlace=1）——CDP/WKWebView 的截图都不交错，
 * 真遇到时解码结果无意义（IEND 前不会报错，调用方以尺寸/众数占比自检）。
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

/** 平坦帧判据的默认覆盖率阈值（Leg B 探针用；99% 像素同色即视为平面）。 */
export const FLAT_COVERAGE = 0.99

/** 最小 PNG 解码（zlib + 反滤波），只支持 8bit RGB/RGBA/RG。 */
export function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat = []
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const colorType = data.readUInt8(9)
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] ?? 4
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rows = []
  let previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = Buffer.from(raw.subarray(cursor, cursor + stride))
    cursor += stride
    if (filter === 1) for (let x = channels; x < stride; x += 1) line[x] = (line[x] + line[x - channels]) & 255
    else if (filter === 2) for (let x = 0; x < stride; x += 1) line[x] = (line[x] + previous[x]) & 255
    else if (filter === 3) for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      line[x] = (line[x] + ((left + previous[x]) >> 1)) & 255
    } else if (filter === 4) for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      const estimate = left + up - upLeft
      const dLeft = Math.abs(estimate - left)
      const dUp = Math.abs(estimate - up)
      const dUpLeft = Math.abs(estimate - upLeft)
      const predictor = dLeft <= dUp && dLeft <= dUpLeft ? left : (dUp <= dUpLeft ? up : upLeft)
      line[x] = (line[x] + predictor) & 255
    }
    rows.push(line)
    previous = line
  }
  return { width, height, channels, rows }
}

/** 单像素 → `#rrggbb`（1/2 通道按灰度展开；4 通道忽略 alpha）。 */
export function pixelColor(image, x, y) {
  const row = image.rows[y]
  if (row === undefined) return null
  const at = x * image.channels
  const r = row[at] ?? 0
  const g = image.channels >= 3 ? (row[at + 1] ?? r) : r
  const b = image.channels >= 3 ? (row[at + 2] ?? r) : r
  const hex = (channel) => channel.toString(16).padStart(2, '0')
  return '#' + hex(r) + hex(g) + hex(b)
}

/**
 * 区域统计。`rect` 用 CSS 像素（{x,y,w,h}），`scale` = 位图宽 / CSS 宽
 * （CDP screencast 的 maxWidth 会缩放；探针按帧元数据算好传进来）。
 * 区域被裁剪到图像边界内；空区域返回 `null`（调用方按"无法判定"处理，不得当通过）。
 */
export function regionStats(image, rect, scale = 1) {
  const x0 = Math.max(0, Math.round(rect.x * scale))
  const y0 = Math.max(0, Math.round(rect.y * scale))
  const x1 = Math.min(image.width, Math.round((rect.x + rect.w) * scale))
  const y1 = Math.min(image.height, Math.round((rect.y + rect.h) * scale))
  if (x1 <= x0 || y1 <= y0) return null
  const counts = new Map()
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let pixels = 0
  for (let y = y0; y < y1; y += 1) {
    const row = image.rows[y]
    if (row === undefined) continue
    for (let x = x0; x < x1; x += 1) {
      const at = x * image.channels
      const r = row[at] ?? 0
      const g = image.channels >= 3 ? (row[at + 1] ?? r) : r
      const b = image.channels >= 3 ? (row[at + 2] ?? r) : r
      const hex = (channel) => channel.toString(16).padStart(2, '0')
      const key = hex(r) + hex(g) + hex(b)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      sumR += r
      sumG += g
      sumB += b
      pixels += 1
    }
  }
  if (pixels === 0) return null
  let modeColor = '#000000'
  let modeCount = -1
  for (const [color, count] of counts) {
    if (count > modeCount) {
      modeColor = '#' + color
      modeCount = count
    }
  }
  const channel = (sum) => Math.round(sum / pixels).toString(16).padStart(2, '0')
  return {
    pixels,
    colors: counts.size,
    modeColor,
    modeCount,
    modeCoverage: modeCount / pixels,
    inkRatio: 1 - modeCount / pixels,
    meanColor: '#' + channel(sumR) + channel(sumG) + channel(sumB),
  }
}

/** 区域是否为"平坦面"（众数色覆盖率 ≥ 阈值）。`stats === null` ⇒ null（无法判定）。 */
export function isFlat(stats, coverage = FLAT_COVERAGE) {
  if (stats === null) return null
  return stats.modeCoverage >= coverage
}

/* ------------------------------------------------------------------ *
 * 自测用的最小 PNG 编码器（8bit RGB，filter 0）。生产路径不使用——只为让"解码器
 * 正确"可离线验证（CI 无截图可用，合成一张已知像素的 PNG 往返是最小证据）。
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, crc])
}

/** 编码一张 8bit RGB PNG（`pixels` 长度 = width*height*3，行优先）。 */
export function encodeRgbPng(width, height, pixels) {
  if (pixels.length !== width * height * 3) throw new Error('encodeRgbPng: pixel buffer size mismatch')
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 3)] = 0
    pixels.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(2, 9)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 合成一张已知像素的图：底色 + 居中一小块"内容"。 */
function syntheticPng(width, height, background, ink) {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= 2 && x < 4 && y >= 2 && y < 4
      const color = inside ? ink : background
      const at = (y * width + x) * 3
      pixels[at] = parseInt(color.slice(1, 3), 16)
      pixels[at + 1] = parseInt(color.slice(3, 5), 16)
      pixels[at + 2] = parseInt(color.slice(5, 7), 16)
    }
  }
  return pixels
}

/** 自测：解码/区域统计/平面判定的已知答案往返（无 CDP、无文件系统依赖）。 */
export function selfTest(log = console.log) {
  const failures = []
  const check = (name, actual, expected) => {
    if (actual !== expected) failures.push(name + ': expected ' + String(expected) + ', got ' + String(actual))
  }
  const image = decodePng(encodeRgbPng(8, 8, syntheticPng(8, 8, '#151517', '#ff0000')))
  check('width', image.width, 8)
  check('height', image.height, 8)
  check('channels', image.channels, 3)
  check('pixel(0,0)', pixelColor(image, 0, 0), '#151517')
  check('pixel(2,2)', pixelColor(image, 2, 2), '#ff0000')
  const all = regionStats(image, { x: 0, y: 0, w: 8, h: 8 }, 1)
  check('all.pixels', all.pixels, 64)
  check('all.modeColor', all.modeColor, '#151517')
  check('all.modeCoverage', all.modeCoverage, 60 / 64)
  check('all.inkRatio', all.inkRatio, 4 / 64)
  const flat = regionStats(image, { x: 0, y: 0, w: 8, h: 2 }, 1)
  check('flat.modeCoverage', flat.modeCoverage, 1)
  check('flat.flat', isFlat(flat), true)
  check('content.flat', isFlat(all), false)
  check('scaled.pixels', regionStats(image, { x: 0, y: 0, w: 4, h: 4 }, 2).pixels, 64)
  // 区域越界按可见部分裁剪：x=-4 宽 8 ⇒ 可见 x∈[0,4) ⇒ 4 列 × 8 行。
  check('clipped.pixels', regionStats(image, { x: -4, y: 0, w: 8, h: 8 }, 1).pixels, 32)
  check('empty', regionStats(image, { x: 20, y: 20, w: 2, h: 2 }, 1), null)
  check('empty.flat', isFlat(null), null)
  if (failures.length > 0) {
    for (const failure of failures) log('FAIL ' + failure)
    log('png-ink self-test: FAILED (' + failures.length + ')')
    return false
  }
  log('png-ink self-test: OK (decode/region-stats/flat/scale/clip = 1 fixture, 15 assertions)')
  return true
}

// CLI（--self-test / --file）只在作为入口运行时执行。
const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('png-ink.mjs')
if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes('--self-test') || args.length === 0) {
    process.exit(selfTest() ? 0 : 1)
  }
  const flag = (name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const file = flag('--file')
  if (file === undefined) {
    console.error('usage: node scripts/lib/png-ink.mjs --self-test | --file shot.png [--rect x,y,w,h] [--scale 1]')
    process.exit(2)
  }
  const image = decodePng(readFileSync(file))
  const rectFlag = flag('--rect')
  const rect = rectFlag === undefined
    ? { x: 0, y: 0, w: image.width, h: image.height }
    : (() => {
        const [x, y, w, h] = rectFlag.split(',').map(Number)
        return { x, y, w, h }
      })()
  const scaleFlag = flag('--scale')
  const stats = regionStats(image, rect, scaleFlag === undefined ? 1 : Number(scaleFlag))
  console.log(JSON.stringify({ file, width: image.width, height: image.height, channels: image.channels, rect, stats, flat: isFlat(stats) }, null, 2))
}
