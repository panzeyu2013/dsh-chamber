#!/usr/bin/env node
/**
 * emit-bridge-manifest.mjs — W-17 通道 manifest 生成管线（design 25 §4.4.3；
 * docs/progress/todo/macos-swift-v1.md W-17 行）。
 *
 * 输入（两份，缺一不可）：
 *   ① 名单源 packages/desktop/ipc-events.ts 的 `IPC_CHANNELS` 常量表：
 *      值 = 通道名、键 = 常量名（当前 68 键）。表即全量通道集合。
 *   ② 方向维度（实测集合法，不靠常量名启发）：main 侧注册事实 ——
 *      packages/desktop/{main.ts, shell-core.ts, electron-edges.ts}
 *      （MAIN_SIDE_FILES，与 ipc-surface-mirror.test.ts 的 B12/E8 扫描面
 *      一致）中 `IPC_CHANNELS.X` 的注册调用：
 *        `(?:ipcMain|deps\.ipc).handle(IPC_CHANNELS.X`  →  invoke（60）
 *        `(?:webContents\.send|rendererPush)(IPC_CHANNELS.X` →  push（8）
 *      注释先剥离再扫描（与镜像测试的逐字扫描器同语义——shell-core.ts 注释
 *      里就有 rendererPush(IPC_CHANNELS.DEEP_LINK_INTENT 的措辞，不剥离会
 *      误计）。不重扫 preload.cts：ipc-surface-mirror.test.ts 已机械断言
 *      main 侧 handle/send 集合 == preload invoke/on 集合，manifest 只需
 *      全量 + 方向两个维度。
 *
 * 产出（写入位置默认相对本脚本所在仓库）：
 *   A. packages/desktop/bridge-manifest.json（提交物）——
 *      { "invoke": [{channel,key}×60], "push": [{channel,key}×8],
 *        "counts": {invoke,push,total} }，两数组均按 IPC_CHANNELS 定义序。
 *   B. macos/Sources/Generated/BridgeManifest.swift（生成物、提交）——
 *      `enum BridgeManifest` 三份 Set<String>（invokeChannels / pushChannels
 *      / allChannels = 前两者并集推导，不重复字面量）。
 *   C. chamber-bridge.js（E8）shim 存根产出**不在本批**（W-18 范围）——W-18
 *      直接 import 本模块的纯函数即可复用解析/方向/渲染，无需复制逻辑。
 *
 * 用法（工作目录 packages/desktop）：
 *   node scripts/emit-bridge-manifest.mjs                # 写两个提交物默认位
 *   node scripts/emit-bridge-manifest.mjs <json> <swift> # 写指定路径（测试用）
 *
 * 稳定性承诺：产物不含时间戳/绝对路径等易漂移内容；同输入两次运行字节一致。
 * 错误纪律：解析/校验失败一律 loud（stderr 中文原因 + 非 0 退出），绝不带病
 * 产出部分 manifest。生成物 == 提交物由 bridge-manifest.test.ts 守住。
 *
 * 导出（供 JS 侧复用；.mjs ↔ .mjs 直接 import，无类型声明问题）：
 *   MAIN_SIDE_FILES / parseIpcChannels(source) /
 *   computeManifest(sourceIpc?, sourceFiles?) /
 *   renderJsonManifest(manifest) / renderSwiftManifest(manifest)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(desktopDir, '..', '..')

/** main 侧注册文件集（handle/send 调用所在；与 ipc-surface-mirror.test.ts 的
 *  MAIN_SIDE_FILES 同集 —— 若 W-10 收口后注册点再迁移文件，两处须同步）。 */
export const MAIN_SIDE_FILES = ['main.ts', 'shell-core.ts', 'electron-edges.ts']

/** 提交物/生成物默认路径（CLI 无参时写入）。 */
export const COMMITTED_MANIFEST = join(desktopDir, 'bridge-manifest.json')
export const COMMITTED_SWIFT = join(repoRoot, 'macos', 'Sources', 'Generated', 'BridgeManifest.swift')

/** IPC_CHANNELS 常量表整块（保守正则，见头部注释）：块内不允许出现 `}`，
 *  注释行由逐行解析跳过。当前 ipc-events.ts 块内确无 `}`（先 grep 实测再
 *  写）；未来若注释引入 `}` 会块截断 → 解析失败 loud，不会带病产出。 */
const IPC_CHANNELS_BLOCK = /(?:const\s+)?IPC_CHANNELS\s*=\s*\{([^}]*)\}/
/** 逐条键值行：`  KEY: 'channel',`（键名同镜像测试的 [A-Z][A-Z0-9_]* 形）。 */
const ENTRY_LINE = /^([A-Z][A-Z0-9_]*):\s*'([^']+)',?$/

/** 整文件级注释/字符串剥离单趟状态机（main 侧三文件合并文本用；语义同
 *  ipc-surface-mirror.test.ts 的 stripCommentsRobust：块注释、行注释与三种
 *  字符串字面量一并通过，`IPC_CHANNELS.X` 引用只出现在代码里，行注释中的
 *  `/*` 序列（main.ts 注记含 /api/i/<id>/* 即触发）不会吞掉真实代码）。 */
function stripCommentsRobust(text) {
  let out = ''
  let inBlock = false
  let inString = null
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString !== null) {
      out += ch
      if (ch === '\\' && next !== undefined) {
        out += next
        i += 2
        continue
      }
      if (ch === inString) inString = null
      i += 1
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i += 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') inString = ch
    out += ch
    i += 1
  }
  return out
}

/** 解析 IPC_CHANNELS 常量表，返回按定义序的 [{key, channel}]。
 *  失败 loud：找不到块 / 块内有无法按 `KEY: 'channel'` 解析的行（含键值
 *  引号转义等未来形状变化）/ 键或通道名重复 —— 一律 throw。 */
export function parseIpcChannels(source) {
  const matches = [...source.matchAll(new RegExp(IPC_CHANNELS_BLOCK.source, 'g'))]
  if (matches.length !== 1) {
    throw new Error(
      `ipc-events.ts 中应恰好出现一个 IPC_CHANNELS = { … } 块，实测 ${matches.length} 个`
    )
  }
  const body = matches[0][1]
  const entries = []
  const unparsed = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('/') || line.startsWith('*')) continue // 块内注释行
    const entry = ENTRY_LINE.exec(line)
    if (entry === null) {
      unparsed.push(rawLine)
      continue
    }
    entries.push({ key: entry[1], channel: entry[2] })
  }
  if (unparsed.length > 0) {
    throw new Error(
      `IPC_CHANNELS 块内有无法按 “KEY: 'channel'” 解析的行（块正则或键值形状变化）：\n`
      + unparsed.map(line => `  ${line}`).join('\n')
    )
  }
  if (entries.length === 0) {
    throw new Error('IPC_CHANNELS 块内没有解析到任何键值条目')
  }
  const keys = new Set()
  const channels = new Set()
  for (const { key, channel } of entries) {
    if (keys.has(key)) throw new Error(`IPC_CHANNELS 键重复：${key}`)
    if (channels.has(channel)) throw new Error(`IPC_CHANNELS 通道名重复：${channel}`)
    keys.add(key)
    channels.add(channel)
  }
  return entries
}

/** 计算 manifest（纯函数；两参皆可省略——省略即按仓库相对路径读真实文件）。
 *  sourceIpc：ipc-events.ts 全文；sourceFiles：[{file, text}]，file 必须等于
 *  MAIN_SIDE_FILES 之一且三文件齐全（防调用方漏文件造成方向误判）。
 *  校验（任一不过即 throw，绝不静默）：
 *    - 每个 IPC_CHANNELS 键在 main 侧代码（注释剥离后）恰好引用一次：0 次 =
 *      死键（注册随某批迁出丢失），>1 次 = 意外双引用（镜像测试同款纪律）；
 *    - 任何代码引用不属于常量表成员（残留引用旧键名）→ loud；
 *    - handle/send 调用参数出现裸字符串字面量（绕开常量表）→ loud；
 *    - 引用存在但既不在 handle 调用也不在 send 调用里 → loud；
 *    - 同一键同时被 handle 与 send 引用（方向歧义）→ loud。
 *  返回 { invoke: [{channel,key}×N], push: […], counts:{invoke,push,total} }，
 *  两数组按 IPC_CHANNELS 定义序。 */
export function computeManifest(sourceIpc, sourceFiles) {
  const ipcText = sourceIpc ?? readFileSync(join(desktopDir, 'ipc-events.ts'), 'utf8')
  const files = sourceFiles ?? MAIN_SIDE_FILES.map(file => ({ file, text: readFileSync(join(desktopDir, file), 'utf8') }))
  const entries = parseIpcChannels(ipcText)
  const knownKeys = new Set(entries.map(entry => entry.key))

  // 文件集校验：MAIN_SIDE_FILES 全覆盖、不许夹带未知文件。
  const seenFiles = new Set()
  for (const { file } of files) {
    if (!MAIN_SIDE_FILES.includes(file)) {
      throw new Error(`computeManifest 收到非 main 侧注册文件：${file}（应为 ${MAIN_SIDE_FILES.join(' / ')}）`)
    }
    seenFiles.add(file)
  }
  for (const file of MAIN_SIDE_FILES) {
    if (!seenFiles.has(file)) throw new Error(`computeManifest 缺少 main 侧注册文件：${file}`)
  }
  const code = stripCommentsRobust(files.map(({ text }) => text).join('\n'))

  // ① 未知引用：代码里的 IPC_CHANNELS.<X> 必须都是常量表成员。
  const unknownRefs = []
  for (const match of code.matchAll(/\bIPC_CHANNELS\.([A-Z][A-Z0-9_]*)\b/g)) {
    if (!knownKeys.has(match[1])) unknownRefs.push(match[1])
  }
  if (unknownRefs.length > 0) {
    throw new Error(`main 侧代码引用了 IPC_CHANNELS 表外成员：${[...new Set(unknownRefs)].join(', ')}`)
  }

  // ② 死键/双引用：每个键在代码中恰好出现一次（B12/E8 纪律，同镜像测试）。
  const dead = []
  const duplicated = []
  for (const key of knownKeys) {
    const occurrences = [...code.matchAll(new RegExp(`\\bIPC_CHANNELS\\.${key}\\b`, 'g'))].length
    if (occurrences === 0) dead.push(key)
    else if (occurrences > 1) duplicated.push(key)
  }
  if (dead.length > 0) {
    throw new Error(`IPC_CHANNELS 死键（main 侧代码零引用，manifest 无法定方向）：${dead.join(', ')}`)
  }
  if (duplicated.length > 0) {
    throw new Error(`IPC_CHANNELS 键在 main 侧被引用多次（一次注册/发送纪律被破坏）：${duplicated.join(', ')}`)
  }

  // ③ 裸字面量注册/发送（绕开常量表）→ loud。
  for (const raw of code.matchAll(/(?:ipcMain|deps\.ipc)\.handle\(\s*(['"])([^'"]+)\1/g)) {
    throw new Error(`main 侧 handle 注册用了裸字面量通道名（必须走 IPC_CHANNELS 常量）：${raw[2]}`)
  }
  for (const raw of code.matchAll(/(?:webContents\.send|rendererPush)\(\s*(['"])([^'"]+)\1/g)) {
    throw new Error(`main 侧 send/推送用了裸字面量通道名（必须走 IPC_CHANNELS 常量）：${raw[2]}`)
  }

  // ④ 方向分类：handle 注册 → invoke；webContents.send/rendererPush → push。
  const invokeKeys = new Set()
  const pushKeys = new Set()
  const classify = /(?:ipcMain|deps\.ipc)\.handle\(\s*IPC_CHANNELS\.([A-Z][A-Z0-9_]*)|(?:webContents\.send|rendererPush)\(\s*IPC_CHANNELS\.([A-Z][A-Z0-9_]*)/g
  let hit = null
  while ((hit = classify.exec(code)) !== null) {
    if (hit[1] !== undefined) invokeKeys.add(hit[1])
    else pushKeys.add(hit[2])
  }
  const undirected = [...knownKeys].filter(key => !invokeKeys.has(key) && !pushKeys.has(key))
  if (undirected.length > 0) {
    throw new Error(`引用恰一次但不在 handle/send 注册调用里（方向无法判定）：${undirected.join(', ')}`)
  }
  const ambiguous = [...invokeKeys].filter(key => pushKeys.has(key))
  if (ambiguous.length > 0) {
    throw new Error(`同一通道键同时出现在 handle 与 send 注册（方向歧义）：${ambiguous.join(', ')}`)
  }

  // 按定义序筛出两向条目（上面已保证并集 == 全键集，死键不可能到达这里）。
  const invoke = entries
    .filter(entry => invokeKeys.has(entry.key))
    .map(({ key, channel }) => ({ channel, key }))
  const push = entries
    .filter(entry => pushKeys.has(entry.key))
    .map(({ key, channel }) => ({ channel, key }))

  const manifest = {
    invoke,
    push,
    counts: {
      invoke: invoke.length,
      push: push.length,
      total: entries.length,
    },
  }
  // 自洽终检：并集恰为全键集（无死键、无幻影、无交集遗漏）。
  const union = new Set([...invokeKeys, ...pushKeys])
  if (union.size !== knownKeys.size || ![...knownKeys].every(key => union.has(key))) {
    throw new Error('方向分类并集 != IPC_CHANNELS 全键集（生成器内部自检失败）')
  }
  return manifest
}

/** JSON 提交物文本（固定 2 空格缩进 + 结尾换行；无时间戳）。 */
export function renderJsonManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Swift 字符串字面量转义：反斜杠/双引号/控制字符（\u{XX}）——与仓库手写
 *  Swift 文件同语义，保证两次生成字节一致、字面量无歧义。 */
function swiftStringLiteral(channel) {
  let out = ''
  for (const ch of channel) {
    const code = ch.codePointAt(0)
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (code < 0x20) out += `\\u{${code.toString(16).padStart(2, '0')}}`
    else out += ch
  }
  return out
}

/** Swift 生成物文本：`enum BridgeManifest` 三份 Set<String>。allChannels 取
 *  invoke ∪ push 推导（而非第三次字面量）——与上两集合永不漂移。 */
export function renderSwiftManifest(manifest) {
  const { counts } = manifest
  const lines = [
    '// BridgeManifest.swift — GENERATED, do not edit.',
    '//',
    `// 通道 manifest（W-17 / design 25 §4.4.3）：Swift 侧 IPC 白名单单源`,
    `// （${counts.total} 通道 = ${counts.invoke} invoke + ${counts.push} push）。`,
    '// 重新生成（工作目录 packages/desktop）：node scripts/emit-bridge-manifest.mjs',
    '// 生成器 scripts/emit-bridge-manifest.mjs —— 输入 ipc-events.ts 的',
    '// IPC_CHANNELS 常量表 + main 侧（main.ts ∪ shell-core.ts ∪ electron-edges.ts）',
    '// handle/send 注册事实；与提交物 packages/desktop/bridge-manifest.json 同源。',
    '',
    '/// IPC 通道 manifest —— 生成物，勿手改；增删通道请先改 IPC_CHANNELS 并重新生成。',
    'enum BridgeManifest {',
  ]
  const members = indent => lines => lines.map(line => `${indent}${line}`)
  const indent4 = members('    ')
  const indent8 = members('        ')
  const setBlock = (doc, decl, entries) => {
    for (const line of doc) indent4([line]).forEach(l => lines.push(l))
    indent4([`${decl} = [`]).forEach(l => lines.push(l))
    for (const { channel } of entries) {
      indent8([`"${swiftStringLiteral(channel)}",`]).forEach(l => lines.push(l))
    }
    indent4([']']).forEach(l => lines.push(l))
    lines.push('')
  }
  setBlock(
    [`/// invoke 通道：renderer invoke → main 的 handle 注册面（ipcMain|deps.ipc），共 ${counts.invoke} 条。`],
    'static let invokeChannels: Set<String>',
    manifest.invoke,
  )
  setBlock(
    [`/// push 通道：main → renderer（webContents.send|rendererPush 推送面），共 ${counts.push} 条。`],
    'static let pushChannels: Set<String>',
    manifest.push,
  )
  indent4(['/// 全量通道（invoke ∪ push 推导，不重复字面量 —— 与上两集合永不漂移）。']).forEach(l => lines.push(l))
  indent4(['static let allChannels: Set<String> = invokeChannels.union(pushChannels)']).forEach(l => lines.push(l))
  lines.push('}')
  return `${lines.join('\n')}\n`
}

/** CLI：默认写两个提交物；两个位置参数覆盖输出路径（测试重生成到临时目录）。 */
function main(argv) {
  const positional = argv.filter(arg => !arg.startsWith('-'))
  let jsonOut = COMMITTED_MANIFEST
  let swiftOut = COMMITTED_SWIFT
  if (positional.length === 2) {
    jsonOut = resolve(positional[0])
    swiftOut = resolve(positional[1])
  } else if (positional.length !== 0) {
    console.error(
      '[emit-bridge-manifest] 用法：node scripts/emit-bridge-manifest.mjs [jsonOut swiftOut]'
      + '（不带参数写提交物默认位；两个参数覆盖输出路径）'
    )
    process.exit(2)
  }
  try {
    const manifest = computeManifest()
    const jsonText = renderJsonManifest(manifest)
    const swiftText = renderSwiftManifest(manifest)
    mkdirSync(dirname(jsonOut), { recursive: true })
    mkdirSync(dirname(swiftOut), { recursive: true })
    writeFileSync(jsonOut, jsonText)
    writeFileSync(swiftOut, swiftText)
    const { counts } = manifest
    console.log(
      `[emit-bridge-manifest] ${counts.total} 通道 = ${counts.invoke} invoke + ${counts.push} push`
      + `\n  json  → ${jsonOut}`
      + `\n  swift → ${swiftOut}`
    )
  } catch (error) {
    console.error(`[emit-bridge-manifest] 生成失败：${error.message}`)
    process.exit(1)
  }
}

// Import guard：被测试/W-18 import 纯函数时不得触发 CLI（仓库既有惯例，
// 同 build-host-graph-package.mjs）。
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main(process.argv.slice(2))
