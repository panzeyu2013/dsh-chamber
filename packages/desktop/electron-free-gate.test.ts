/**
 * electron-free-gate.test.ts — core 对 electron 零 import 门禁（W-14）
 *
 * design 25 §4.1 判定标准 + §8.2：Electron 依赖面收敛为白名单
 * 文件（main.ts / preload.cts / updater.ts / electron-edges.ts），其余
 * packages/desktop 顶层源码（业务模块与 shell-core 家族）一律不得
 * import/require electron——拆分后 shell-core/node-edges/sidecar-entry 落位时
 * 自动被本门禁覆盖。
 *
 * 面 A（禁止）：白名单外文件无 electron import（逐行去注释后检测）。
 * 面 B（正例防腐化）：白名单文件确实含 electron（防白名单滥用）。
 * 面 C（core 纪律扩展）：shell-core.ts 不出现 ipcMain / webContents.send
 *   （IPC 注册只能经 installIpcHandlers 的注入 registrar——W-10 S1 起
 *   installIpcHandlers 落位 shell-core，channel 注册面在 core 侧但 Electron
 *   的 ipcMain 拼写与 send 拼写仍禁：围栏由 main 在注入点包装、send 叶走
 *   HostEdges rendererPush）。**IPC_CHANNELS 自 S1 起放行**：ipc-events.ts 是
 *   纯常量模块（无 electron），installIpcHandlers 合法引用其常量（channel 名
 *   与 preload 的锁步由 ipc-surface-mirror.test.ts 保证）。
 * 面 D（传递闭包）：core 家族的相对 import 传递闭包零**加载期** electron
 *   依赖（2026-09 模块评审 medium #2；面 A 只看顶层直接 import）。
 *
 * 注：electron-edges.ts 已于 W-10 S0 落位并加入白名单（Electron HostEdges
 * 实现，含 from 'electron' import——面 B 正例）。
 *
 * 2026-12 fail-closed 重写（D2a 复审 Major）：旧版在缺文件时静默跳过
 * （visited.add 先于存在性检查、闭包队列预置 coreFamily 使 visited.size
 * 断言恒真、白名单/core 家族缺失即 continue），相对 import 只取 basename
 * （丢子目录）、漏 side-effect-only import 与 require()。现门禁：
 *   - 期望文件（白名单 ∪ core 家族）缺失 = 失败，绝不跳过；
 *   - 相对说明符按**完整路径**解析（含 .js→.ts 的 nodenext 映射与目录
 *     index），四种形态（from / import '…' / import('…') / require('…')）
 *     全部进闭包；
 *   - 实际解析文件数被计数并断言（面 A 逐文件解析、面 D 解析数和种子/边数
 *     自洽），解析不了的相对说明符与跳出包根的说明符都是失败
 *     （跳出包根可经 OUTSIDE_ALLOWLIST 显式放行，当前为空）；
 *   - 文件末尾自测以注入临时 fixture 证明：缺文件、子目录传递依赖、
 *     side-effect import 链、require() 链上的 electron 都会让门禁变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

// 2026-12 第三轮验证：原先的两条正则没有词边界，`prerequire('electron')` /
// `myimport('electron')` / `fromage('electron')` 都会被误判为依赖。它们的能力
// 已被下方带边界与引号面（含模板串/子路径）的扫描函数完整覆盖，故删除。
/** 闭包遍历的相对说明符四形态：from '…' / import '…' / import('…') /
 *  require('…')（2026-12 修复：旧正则只认 from/import(，漏 side-effect-only
 *  import 与 require）。 */
const RELATIVE_SPECIFIER = /(?:\bfrom\b\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g

/** 三种引号（含模板串；模板串用码点构造，避免本文件出现嵌套引号）。 */
const SPECIFIER_QUOTES: readonly string[] = ["'", '"', String.fromCharCode(96)]

/** 调用位窗口：说明符前 24 字符内必须出现 from/import/require，否则
 *  'electron' 只是壳 flavor 标识（shell-core.ts:1458、chamber-lock.ts:147 的
 *  `'electron' | 'swift'`）或普通函数实参（pickFlavor('electron')）——都不
 *  是模块依赖。2026-12 第二轮验证：曾把 '(' 也算调用位，导致实参误报。 */
const SPECIFIER_CALLERS = ['from', 'import', 'require']

function hasSpecifierCaller(code: string, quoteIndex: number): boolean {
  // 窗口放宽到 64（2026-12 第四轮验证：require( + 30 空格 + 'electron' 曾漏检），
  // 但**不得跨行/跨语句**——否则上一行的 import 会把本行的 flavor 字面量误判成
  // 依赖（第四轮验证的误报正是跨行窗口造成的）；同时把「成员访问」排除在调用位
  // 外（Buffer.from('electron') / loader.import(...) 不是模块依赖）。
  const newline = String.fromCharCode(10)
  const lineStart = Math.max(
    code.lastIndexOf(newline, quoteIndex - 1),
    code.lastIndexOf(';', quoteIndex - 1),
    code.lastIndexOf(',', quoteIndex - 1),
  ) + 1
  const windowStart = Math.max(lineStart, quoteIndex - 64)
  const before = code.slice(windowStart, quoteIndex)
  for (const caller of SPECIFIER_CALLERS) {
    let index = before.indexOf(caller)
    while (index !== -1) {
      const absolute = windowStart + index
      const previous = absolute > 0 ? code[absolute - 1] ?? '' : ''
      const after = code[absolute + caller.length] ?? ''
      const wordChar = /[A-Za-z0-9_$]/
      // 成员访问一般不是模块依赖（Buffer.from / loader.import），但
      // module.require('electron') 是真实的 CJS 加载（2026-12 第五轮验证的漏检）。
      const memberAccess = previous === '.' && caller !== 'require'
      if (!memberAccess && !wordChar.test(previous) && !wordChar.test(after)) return true
      index = before.indexOf(caller, index + 1)
    }
  }
  return false
}

/** 说明符扫描扩展（2026-12 验证轮）：模板串与子路径说明符（'electron/main'）。
 *  旧正则只认单双引号 + 裸 'electron'，两者都能绕；这里补上，同时用调用位窗口
 *  排除「'electron' 作为壳 flavor 字面量」的合法用法。 */
function mentionsElectronSpecifier(code: string): boolean {
  for (const quote of SPECIFIER_QUOTES) {
    const needle = quote + 'electron'
    let index = code.indexOf(needle)
    while (index !== -1) {
      const rest = code.slice(index + needle.length)
      if ((rest.startsWith(quote) || rest.startsWith('/')) && hasSpecifierCaller(code, index)) return true
      index = code.indexOf(needle, index + 1)
    }
  }
  return false
}

/** 面 D 扩展：加载期 electron 依赖（2026-12 第三轮验证收口）。逐行启发式会漏掉
 *  `export { app } from 'electron/main'` 与多行 import/export-from（续行带缩进被
 *  当成懒加载）。这里维护跨行**深度**：只有顶格且深度为 0 的行算加载期语句；
 *  `import`/`export` 开头的语句把头部（含花括号组）累积到深度归零再判定，
 *  函数体内的懒加载因深度 > 0 永不参与判定；import type 仍是类型位置。 */
function hasStaticElectronSpecifier(code: string): boolean {
  const depthDelta = (text: string): number => {
    let delta = 0
    for (const char of text) {
      if (char === '(' || char === '{' || char === '[') delta += 1
      else if (char === ')' || char === '}' || char === ']') delta -= 1
    }
    return delta
  }
  const lines = code.split(String.fromCharCode(10))
  let depth = 0
  let header = ''
  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === '') continue
    if (header !== '') {
      header += ' ' + trimmed
      depth += depthDelta(blankStringContents(rawLine))
      if (depth <= 0) {
        const text = header
        header = ''
        depth = 0
        if (!text.startsWith('import type') && mentionsElectronSpecifier(text)) return true
      }
      continue
    }
    const topLevel = trimmed === rawLine && depth === 0
    depth = Math.max(0, depth + depthDelta(blankStringContents(rawLine)))
    if (!topLevel) continue
    // 函数/类体是懒加载（即使顶格）；import 与 export-from 才可能跨行累积头部。
    if (trimmed.startsWith('export function') || trimmed.startsWith('export async function')
      || trimmed.startsWith('export class') || trimmed.startsWith('export default function')) {
      continue
    }
    if (trimmed.startsWith('import') || trimmed.startsWith('export {') || trimmed.startsWith('export *')) {
      if (trimmed.startsWith('import type')) continue
      if (depth > 0) { header = trimmed; continue }
      if (mentionsElectronSpecifier(trimmed)) return true
      continue
    }
    if (mentionsElectronSpecifier(trimmed)) return true
  }
  if (header !== '' && !header.startsWith('import type') && mentionsElectronSpecifier(header)) return true
  return false
}

/** 面 A/B：任意位置的 electron 依赖文本形态（from/import/import()/require，
 *  含 side-effect-only import、模板串、子路径；调用位两侧有词边界）。 */
function referencesElectron(code: string): boolean {
  return mentionsElectronSpecifier(code)
}

/** 面 D：加载期 electron 依赖（顶格且深度 0 的语句；扩展模板串/子路径/
 *  多行 import 与 export-from）。 */
function hasStaticElectronImport(code: string): boolean {
  return hasStaticElectronSpecifier(code)
}
const WHITELIST = ['main.ts', 'preload.cts', 'updater.ts', 'electron-edges.ts']
// 已知扫描边界（2026-12 第五轮验证，均为**构造性**且当前树不触发；面 A 覆盖顶层
// 文件，下列边界仅影响未来新增的子目录闭包文件）：
//   - 跨行断开的调用（`const e =` + 换行 + `require('electron')`）不累积；
//   - 调用位与引号间隔 >56 字符（窗口 64）；
//   - `export function f() {} require(...)` 同一物理行的后半句不判定（函数体豁免）。
// 这些都是文本扫描的固有边界；收紧的代价是更多误报，故保持现状并显式登记。
const CORE_FAMILY = ['shell-core.ts', 'node-edges.ts', 'sidecar-entry.ts']

/** 允许跳出包根的相对 import 说明符前缀（显式登记 + 理由；当前为空——core
 *  家族的包外依赖一律走 bare specifier/workspace 包名，相对路径跳出包根须
 *  评审登记后才可放行）。 */
const OUTSIDE_ALLOWLIST: readonly string[] = []

/** 剥离注释后的代码文本。2026-12 验证轮：旧实现不认字符串/模板串，一个含
 *  `/*` 的字面量（如 'http://host/*'）会打开块注释状态并吞掉其后的所有
 *  代码——真实的 electron import 因此可以躲过面 A/D。这里按字符状态机区分
 *  代码/字符串/模板/注释四态（换行保留，行号与逐行判定仍可用）。 */
function stripComments(source: string): string {
  let out = ''
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  let i = 0
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; i += 2; continue }
      if (char === '/' && next === '*') { state = 'block'; i += 2; continue }
      if (char === "'") { state = 'single'; out += char; i += 1; continue }
      if (char === '"') { state = 'double'; out += char; i += 1; continue }
      if (char === '`') { state = 'template'; out += char; i += 1; continue }
      out += char
      i += 1
      continue
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char }
      i += 1
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; i += 2; continue }
      if (char === '\n') out += char
      i += 1
      continue
    }
    // 字符串/模板串：反斜杠转义整对跳过；闭合引号回 code 态（内容保留，
    // 因为说明符扫描需要看到字面量本身）。
    if (char === '\\') { out += char + (next ?? ''); i += 2; continue }
    if ((state === 'single' && char === "'")
      || (state === 'double' && char === '"')
      || (state === 'template' && char === '`')) {
      state = 'code'
    }
    out += char
    i += 1
  }
  return out
}

/** 把字符串/模板串**内容**替换为空格（保留定界符与换行）：用于括号计数——
 *  2026-12 第五轮验证：形如 const re = '(' 的字面量会让深度计数器失真，从而
 *  让面 D 之后的所有行都被当成"非顶格"而漏检。 */
function blankStringContents(source: string): string {
  const quoteChars = ["'", '"', String.fromCharCode(96)]
  let out = ''
  let state: 'code' | 'single' | 'double' | 'template' = 'code'
  let escaped = false
  for (const char of source) {
    if (state === 'code') {
      if (quoteChars.includes(char)) {
        state = char === "'" ? 'single' : char === '"' ? 'double' : 'template'
      }
      out += char
      continue
    }
    if (char === String.fromCharCode(10)) { out += char; continue }
    if (escaped) { escaped = false; out += ' '; continue }
    if (char === String.fromCharCode(92)) { escaped = true; out += ' '; continue }
    const closes = (state === 'single' && char === "'")
      || (state === 'double' && char === '"')
      || (state === 'template' && char === String.fromCharCode(96))
    if (closes) { state = 'code'; out += char; continue }
    out += ' '
  }
  return out
}

function isFile(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isFile()
}

/** 相对说明符 → 包内完整路径（.js→.ts 的 nodenext 映射；无扩展名补
 *  .ts/.cts；目录补 index.ts/index.cts）。找不到存在的文件返回 null。 */
function resolveSpecifier(root: string, importer: string, spec: string): string | null {
  const base = path.resolve(root, path.dirname(importer), spec)
  const candidates: string[] = []
  if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.cts')
  candidates.push(base, base + '.ts', base + '.cts', path.join(base, 'index.ts'), path.join(base, 'index.cts'))
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate
  }
  return null
}

interface GateResult {
  /** 顶层源码发现集（已排序）。 */
  topLevel: string[]
  /** 期望文件（白名单 ∪ core 家族）中不存在的项——缺失即失败。 */
  missingExpected: string[]
  /** 面 A：白名单外顶层源码含 electron 依赖的文件。 */
  faceAOffenders: string[]
  /** 面 A 实际解析（读取并扫描）的文件数——防"扫描集被空集骗过"。 */
  faceAParsed: number
  /** 面 B：白名单文件缺 electron 依赖的清单。 */
  faceBMissing: string[]
  /** 面 C：core 家族里出现禁用拼写的 文件:token 项。 */
  faceCOffenders: string[]
  /** 面 D：闭包内出现加载期 electron 依赖的文件（根相对路径）。 */
  faceDOffenders: string[]
  /** 面 D 实际解析的文件（根相对路径，按入队去重）。 */
  faceDParsed: string[]
  /** 相对说明符无法解析到存在的文件（断链即失败）。 */
  unresolved: string[]
  /** 相对说明符跳出包根（须 ∈ OUTSIDE_ALLOWLIST）。 */
  outside: string[]
  /** 闭包内成功解析并排队的相对 import 边数。 */
  faceDEdges: number
}

/** 对注入根执行全部门禁面（默认根 = 本目录；自测用临时 fixture）。 */
function evaluateGate(root: string): GateResult {
  const topLevel = readdirSync(root)
    .filter((name) => /\.(ts|cts)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name))
    .sort()
  const missingExpected = [...WHITELIST, ...CORE_FAMILY].filter((name) => !isFile(path.join(root, name)))

  // 面 A：白名单外顶层源码零 electron；逐文件解析并计数。
  const faceAOffenders: string[] = []
  let faceAParsed = 0
  for (const name of topLevel) {
    if (WHITELIST.includes(name)) continue
    const code = stripComments(readFileSync(path.join(root, name), 'utf8'))
    faceAParsed += 1
    if (referencesElectron(code)) faceAOffenders.push(name)
  }

  // 面 B：白名单文件确实含 electron（缺失文件已由 missingExpected 捕获）。
  const faceBMissing: string[] = []
  for (const name of WHITELIST) {
    if (!topLevel.includes(name)) continue
    const code = stripComments(readFileSync(path.join(root, name), 'utf8'))
    if (!referencesElectron(code)) faceBMissing.push(name)
  }

  // 面 C：core 家族无 ipcMain / webContents.send 拼写。
  const faceCOffenders: string[] = []
  for (const name of CORE_FAMILY) {
    if (!topLevel.includes(name)) continue
    const code = stripComments(readFileSync(path.join(root, name), 'utf8'))
    for (const token of ['ipcMain', 'webContents.send']) {
      if (code.includes(token)) faceCOffenders.push(name + ':' + token)
    }
  }

  // 面 D：core 家族相对 import 的完整路径传递闭包。
  const queue: string[] = CORE_FAMILY.map((name) => path.join(root, name))
  const parsedSet = new Set<string>()
  const faceDParsed: string[] = []
  const faceDOffenders: string[] = []
  const unresolved: string[] = []
  const outside: string[] = []
  let faceDEdges = 0
  while (queue.length > 0) {
    const absolute = queue.shift()
    if (absolute === undefined) continue
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    if (parsedSet.has(relative)) continue
    // 缺失的期望文件由 missingExpected 报告；此处绝不把缺失文件计入解析数。
    if (!isFile(absolute)) continue
    parsedSet.add(relative)
    faceDParsed.push(relative)
    const code = stripComments(readFileSync(absolute, 'utf8'))
    if (hasStaticElectronImport(code)) faceDOffenders.push(relative)
    for (const match of code.matchAll(RELATIVE_SPECIFIER)) {
      const spec = match[1]
      if (spec === undefined) continue
      const resolved = path.resolve(path.dirname(absolute), spec)
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        outside.push(relative + ' -> ' + spec)
        continue
      }
      const target = resolveSpecifier(root, relative, spec)
      if (target === null) {
        unresolved.push(relative + ' -> ' + spec)
        continue
      }
      faceDEdges += 1
      queue.push(target)
    }
  }

  return {
    topLevel,
    missingExpected,
    faceAOffenders,
    faceAParsed,
    faceBMissing,
    faceCOffenders,
    faceDOffenders,
    faceDParsed,
    unresolved,
    outside,
    faceDEdges,
  }
}

/** 未登记在 OUTSIDE_ALLOWLIST 的跳出包根项。 */
function outsideViolations(result: GateResult): string[] {
  return result.outside.filter((entry) => {
    const spec = entry.split(' -> ')[1] ?? ''
    return !OUTSIDE_ALLOWLIST.some((prefix) => spec.startsWith(prefix))
  })
}

const gate = evaluateGate(dir)

/** 全部门禁面的失败断言集合：任何一面为红即抛。真实根由下面五个面测试
 *  逐面断言；自测用它证明 fixture 缺文件/含违规时确实会红、干净时确实会绿。 */
function assertGateGreen(result: GateResult): void {
  assert.deepEqual(result.missingExpected, [], '白名单/core 家族文件缺失必须先红（不得静默跳过）')
  assert.deepEqual(result.unresolved, [], '闭包内相对 import 必须解析到存在的文件（不得静默丢弃子目录/未知形态）')
  assert.deepEqual(outsideViolations(result), [], '跳出包根的相对 import 必须显式登记在 OUTSIDE_ALLOWLIST')
  assert.deepEqual(result.faceAOffenders, [], '白名单外文件不得 import/require electron')
  const whitelistPresent = result.topLevel.filter((name) => WHITELIST.includes(name)).length
  assert.equal(result.faceAParsed, result.topLevel.length - whitelistPresent, '面 A 必须逐个解析全部非白名单顶层源码')
  assert.deepEqual(result.faceBMissing, [], '白名单文件应含 electron 依赖（否则移出白名单）')
  assert.deepEqual(result.faceCOffenders, [], 'core 家族不得出现 ipcMain / webContents.send')
  assert.deepEqual(result.faceDOffenders, [], 'core 家族闭包内不得出现加载期 electron import')
  for (const seed of CORE_FAMILY) {
    assert.ok(result.faceDParsed.includes(seed), '闭包必须实际解析种子文件：' + seed)
  }
  assert.ok(result.faceDEdges > 0, '闭包未遍历任何相对 import —— 解析正则被空集骗过')
}

test('面 0（前置）：期望文件齐全、闭包相对 import 全部可解析（缺失/断链即失败，不跳过）', () => {
  assert.deepEqual(gate.missingExpected, [], '白名单/core 家族文件缺失必须先红（不得静默跳过）')
  assert.deepEqual(gate.unresolved, [], '闭包内相对 import 必须解析到存在的文件（不得静默丢弃子目录/未知形态）')
  assert.deepEqual(outsideViolations(gate), [], '跳出包根的相对 import 必须显式登记在 OUTSIDE_ALLOWLIST')
})

test('W-14 面 A：白名单外顶层源码零 electron import', () => {
  assert.deepEqual(gate.faceAOffenders, [], '白名单外文件不得 import/require electron')
  const whitelistPresent = gate.topLevel.filter((name) => WHITELIST.includes(name)).length
  assert.equal(gate.faceAParsed, gate.topLevel.length - whitelistPresent, '面 A 必须逐个解析全部非白名单顶层源码')
})

test('W-14 面 B：白名单文件确实依赖 electron（防腐化）', () => {
  assert.deepEqual(gate.faceBMissing, [], '白名单文件应含 electron 依赖（否则移出白名单）')
})

test('W-14 面 C：core 家族无 ipcMain / webContents.send 字样（IPC_CHANNELS 放行）', () => {
  // 演进（W-10 S1）：shell-core 的 installIpcHandlers 合法引用 IPC_CHANNELS
  // 常量（ipc-events.ts 为纯常量模块、无 electron——core 可 import），故
  // IPC_CHANNELS 自禁列表移除；注册只能经注入 registrar（deps.ipc.handle），
  // ipcMain / webContents.send 拼写仍禁——Electron 注册与 send 面必须留在
  // main.ts / electron-edges.ts 装配侧（'ipcMain' 已覆盖 'ipcMain.handle'）。
  assert.deepEqual(gate.faceCOffenders, [], 'core 家族不得出现 ipcMain / webContents.send')
})

test('W-14 面 D：core 家族的相对 import 传递闭包零 electron（2026-09 模块评审 medium #2）', () => {
  assert.deepEqual(gate.faceDOffenders, [], 'core 家族闭包内不得出现加载期 electron import')
  for (const seed of CORE_FAMILY) {
    assert.ok(gate.faceDParsed.includes(seed), '闭包必须实际解析种子文件：' + seed)
  }
  assert.ok(gate.faceDEdges > 0, '闭包未遍历任何相对 import —— 解析正则被空集骗过')
})

// ---------------------------------------------------------------------------
// 自测（D2a）：注入临时 fixture，证明门禁对缺陷形态会红、对干净形态会绿。
// 旧版门禁在缺文件时静默跳过且闭包断言恒真——这些 fixture 正是其漏检形态。
// ---------------------------------------------------------------------------

interface FixtureSpec {
  [relativePath: string]: string
}

function writeFixture(files: FixtureSpec): string {
  const root = mkdtempSync(path.join(tmpdir(), 'electron-free-gate-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

function without(files: FixtureSpec, omitted: string): FixtureSpec {
  const out: FixtureSpec = {}
  for (const [key, value] of Object.entries(files)) {
    if (key !== omitted) out[key] = value
  }
  return out
}

/** 干净 fixture：白名单正例、子目录传递链、side-effect import 链、require 链。 */
const GREEN_FIXTURE: FixtureSpec = {
  'main.ts': "import { app } from 'electron'\n",
  'preload.cts': "import { contextBridge } from 'electron'\n",
  'updater.ts': "export function init(): void {\n  const electron = require('electron')\n}\n",
  'electron-edges.ts': "import { Notification } from 'electron'\n",
  'shell-core.ts': "import './node-edges.ts'\nimport './sub/helper.ts'\n",
  'node-edges.ts': "import './leaf.ts'\n",
  'sidecar-entry.ts': "import './side-effect-layer.ts'\nconst required = require('./sub/require-leaf.ts')\nexport const entry = required\n",
  'leaf.ts': 'export const leaf = 1\n',
  'sub/helper.ts': "import './deep.ts'\n",
  'sub/deep.ts': 'export const deep = 1\n',
  'side-effect-layer.ts': "import './sub/side-effect-leaf.ts'\n",
  'sub/side-effect-leaf.ts': 'export const effect = 1\n',
  'sub/require-leaf.ts': 'export const required = 1\n',
}

function withFixture(files: FixtureSpec, check: (root: string) => void): void {
  const root = writeFixture(files)
  try {
    check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('自测 ①：干净 fixture 全绿，且子目录/side-effect/require 链确实被解析', () => {
  withFixture(GREEN_FIXTURE, (root) => {
    const result = evaluateGate(root)
    assert.doesNotThrow(() => assertGateGreen(result), '干净 fixture 必须全绿')
    assert.deepEqual(result.missingExpected, [])
    assert.deepEqual(result.faceAOffenders, [])
    assert.deepEqual(result.faceBMissing, [])
    assert.deepEqual(result.faceCOffenders, [])
    assert.deepEqual(result.faceDOffenders, [])
    assert.deepEqual(result.unresolved, [])
    assert.deepEqual(result.outside, [])
    for (const reached of ['leaf.ts', 'sub/helper.ts', 'sub/deep.ts', 'side-effect-layer.ts', 'sub/side-effect-leaf.ts', 'sub/require-leaf.ts']) {
      assert.ok(result.faceDParsed.includes(reached), '闭包应解析 ' + reached)
    }
  })
})

test('自测 ②：缺 sidecar-entry.ts 即红，且缺失文件不计入解析数（旧版 visited.add 缺陷）', () => {
  withFixture(without(GREEN_FIXTURE, 'sidecar-entry.ts'), (root) => {
    const result = evaluateGate(root)
    assert.throws(() => assertGateGreen(result), '缺文件时门禁必须变红（旧版会静默通过）')
    assert.deepEqual(result.missingExpected, ['sidecar-entry.ts'], '缺期望文件必须报告为失败原因')
    assert.ok(!result.faceDParsed.includes('sidecar-entry.ts'), '缺失文件不得计入闭包解析数')
  })
})

test('自测 ③：子目录传递依赖 / side-effect import 链 / require 链上的 electron 全部抓住', () => {
  withFixture(
    {
      ...GREEN_FIXTURE,
      // 只经 sub/helper.ts -> sub/deep.ts 到达；旧版 basename 解析会丢子目录。
      'sub/deep.ts': "export const deep = 1\nconst electron = require('electron')\n",
      // 只经 side-effect-only import 到达（旧正则漏）。
      'sub/side-effect-leaf.ts': "import 'electron'\n",
      // 只经顶层 require 到达（旧正则漏）。
      'sub/require-leaf.ts': "const electron = require('electron')\nexport const required = electron\n",
    },
    (root) => {
      const result = evaluateGate(root)
      for (const offender of ['sub/deep.ts', 'sub/side-effect-leaf.ts', 'sub/require-leaf.ts']) {
        assert.ok(result.faceDOffenders.includes(offender), '闭包应抓住 ' + offender + ' 的 electron 依赖')
      }
    },
  )
})

test('自测 ④：跳出包根的相对 import 未登记即红（不静默跳过）', () => {
  withFixture(
    {
      ...GREEN_FIXTURE,
      'shell-core.ts': "import '../outside.ts'\n",
    },
    (root) => {
      const result = evaluateGate(root)
      assert.equal(result.outside.length, 1, '跳出包根的说明符必须被记录')
      assert.deepEqual(outsideViolations(result), result.outside, '未登记时即为违规')
    },
  )
})

test('自测 ⑤：字符串/注释扫描与说明符形态（2026-12 验证轮的三处绕过 + 一处合法用法）', () => {
  withFixture(
    {
      ...GREEN_FIXTURE,
      // ① 面 A：字符串里的 /* 曾打开块注释状态并吞掉后续代码——真实的 electron
      //    import 因此躲过旧 stripComments。现在必须被抓。注意用不带 // 的
      //    'a/*b'（2026-12 第二轮验证：带 http:// 的样本会先命中 // 行注释分支，
      //    使该用例对「块注释状态机」的变异仍为绿，等于空断言）。两个样本都放。
      'chamber-lock.ts': "export const url = 'a/*b'\nimport { app } from 'electron'\nexport const lock = url + String(app)\n",
      'update-headless.ts': "export const base = 'http://127.0.0.1/*'\nimport { app } from 'electron'\nexport const probe = base + String(app)\n",
      // ② 合法用法：'electron' 作为壳 flavor 字面量（无调用位）与普通函数实参
      //    （pickFlavor('electron')，2026-12 第二轮验证的 '(' 误报样本）都不得误报。
      'shell-core.ts': "import './node-edges.ts'\nimport './sub/helper.ts'\nexport type Flavor = 'electron' | 'swift'\nexport const fallback: Flavor = 'electron'\nconst pick = pickFlavor('electron')\nexport const chosen = pick\n",
      // ③ 面 D：闭包内模板串 require（旧正则只认单双引号）。
      'sub/deep.ts': 'const electron = require(' + String.fromCharCode(96) + 'electron' + String.fromCharCode(96) + ')\nexport const deep = electron\n',
      // ④ 面 D：子路径形态（旧正则只认裸 electron）。
      'sub/require-leaf.ts': "import { app } from 'electron/main'\nexport const required = app\n",
      // ⑤ 面 B：白名单文件用模板串 require 也必须被认作「确实依赖 electron」。
      'updater.ts': 'export const init = () => require(' + String.fromCharCode(96) + 'electron' + String.fromCharCode(96) + ')\n',
    },
    (root) => {
      const result = evaluateGate(root)
      assert.ok(result.faceAOffenders.includes('chamber-lock.ts'),
        '字符串里的 /* 不得吞掉其后的 electron import（旧 stripComments 缺陷）')
      assert.ok(!result.faceAOffenders.includes('shell-core.ts'),
        "'electron' 作为壳 flavor 字面量/普通实参不是模块依赖，不得误报")
      assert.ok(result.faceAOffenders.includes('update-headless.ts'),
        '字符串里的 // 行注释形态同样不得吞掉其后的 electron import')
      for (const offender of ['sub/deep.ts', 'sub/require-leaf.ts']) {
        assert.ok(result.faceDOffenders.includes(offender), '闭包应抓住 ' + offender + ' 的 electron 依赖')
      }
      assert.deepEqual(result.faceBMissing, [], '模板串形态也必须满足白名单正例')
    },
  )
})

test('自测 ⑥：多行 import/export-from 与关键字边界（2026-12 第三轮验证）', () => {
  withFixture(
    {
      ...GREEN_FIXTURE,
      // 面 D：只经闭包到达的子目录文件。旧逐行启发式漏掉 export-from 与多行 import
      // （续行带缩进被当成懒加载）；深度感知扫描必须抓住。
      'sub/deep.ts': "export { app } from 'electron/main'\nexport const deep = 1\n",
      'sub/require-leaf.ts': "import {\n  app\n} from 'electron/main'\nexport const required = app\n",
      // 面 A 误报控制：关键字前后必须是边界（prerequire/myimport/fromage 不是调用位）。
      'chamber-lock.ts': "export const a = prerequire('electron')\nexport const b = myimport('electron')\nexport const c = fromage('electron')\n",
    },
    (root) => {
      const result = evaluateGate(root)
      for (const offender of ['sub/deep.ts', 'sub/require-leaf.ts']) {
        assert.ok(result.faceDOffenders.includes(offender),
          '深度感知扫描应抓住多行/export-from 形态：' + offender)
      }
      assert.ok(!result.faceAOffenders.includes('chamber-lock.ts'),
        'prerequire/myimport/fromage 不是调用位，不得误报')
      assert.deepEqual(result.faceBMissing, [])
    },
  )
})

test('自测 ⑦：调用位窗口、成员访问与函数体懒加载（2026-12 第四轮验证）', () => {
  withFixture(
    {
      ...GREEN_FIXTURE,
      // 误报控制：成员访问不是模块依赖；上一行的 import 也不得污染本行判定。
      'chamber-lock.ts': "import './leaf.ts'\nexport const a = Buffer.from('electron')\nexport const b = loader.import('electron')\nexport const c = pick('electron')\n",
      // 漏检控制：require 与引号之间可以有任意空白（窗口 64 且按行/按语句）。
      'update-headless.ts': "export const mod = require(" + ' '.repeat(30) + "'electron/main')\n",
      // 函数/类体是懒加载：顶格 export function 体内的 require 不算加载期依赖。
      'side-effect-layer.ts': "export function init() { return require('electron') }\n",
      // 字符串里的括号曾让深度计数器失真（之后的行全被当成非顶格）→ 漏检。
      'sub/deep.ts': "const re = '('\nconst electron = require('electron')\nexport const deep = electron\n",
      // module.require(...) 是真实的 CJS 加载（成员访问豁免不得把它挡掉）。
      'sub/require-leaf.ts': "const electron = module.require('electron')\nexport const required = electron\n",
    },
    (root) => {
      const result = evaluateGate(root)
      assert.ok(!result.faceAOffenders.includes('chamber-lock.ts'),
        '成员访问/普通实参不得误报为 electron 依赖')
      assert.ok(result.faceAOffenders.includes('update-headless.ts'),
        'require 与引号之间的长空白也必须命中')
      assert.ok(!result.faceDOffenders.includes('side-effect-layer.ts'),
        'export function 体内是懒加载，不得判成加载期依赖')
      for (const offender of ['sub/deep.ts', 'sub/require-leaf.ts']) {
        assert.ok(result.faceDOffenders.includes(offender),
          '字符串括号不得致盲深度计数、module.require 也必须命中：' + offender)
      }
    },
  )
})



