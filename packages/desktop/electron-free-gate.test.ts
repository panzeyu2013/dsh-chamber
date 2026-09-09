/**
 * electron-free-gate.test.ts — core 对 electron 零 import 门禁（W-14）
 *
 * design 25 §4.1 判定标准 + companion §四批 4：Electron 依赖面收敛为白名单
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
 * 注：electron-edges.ts 已于 W-10 S0 落位并加入白名单（Electron HostEdges
 * 实现，含 from 'electron' import——面 B 正例）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const ELECTRON_IMPORT = /(?:from\s*['"]electron['"]|require\s*\(\s*['"]electron['"]\s*\)|import\s*\(\s*['"]electron['"]\s*\))/

/** 剥离 // 与 /* *\/ 注释后的代码文本（逐行/块状态机，足够本门禁使用）。 */
function stripComments(source: string): string {
  let out = ''
  let inBlock = false
  const lines = source.split('\n')
  for (const line of lines) {
    let cleaned = ''
    let i = 0
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i)
        if (end === -1) break
        inBlock = false
        i = end + 2
        continue
      }
      if (line[i] === '/' && line[i + 1] === '*') {
        inBlock = true
        i += 2
        continue
      }
      if (line[i] === '/' && line[i + 1] === '/') break
      cleaned += line[i]
      i += 1
    }
    out += cleaned + '\n'
  }
  return out
}

const topLevelSources = readdirSync(dir)
  .filter((name) => /\.(ts|cts)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name))
  .sort()

const whitelist = new Set(['main.ts', 'preload.cts', 'updater.ts', 'electron-edges.ts'])
const coreFamily = new Set(['shell-core.ts', 'node-edges.ts', 'sidecar-entry.ts'])

test('W-14 面 A：白名单外顶层源码零 electron import', () => {
  const offenders: string[] = []
  for (const name of topLevelSources) {
    if (whitelist.has(name)) continue
    const code = stripComments(readFileSync(path.join(dir, name), 'utf8'))
    if (ELECTRON_IMPORT.test(code)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], '白名单外文件不得 import/require electron')
})

test('W-14 面 D：core 家族的相对 import 传递闭包零 electron（2026-09 模块评审 medium #2）', () => {
  // 面 A 只看顶层直接 import——闭包检查沿相对导入递归，任何一层引入 electron
  // （或白名单文件）都会被抓到，避免"白名单文件把 electron 藏在被 import 的
  // 模块里"。
  const RELATIVE_IMPORT = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g
  // 闭包只看**加载期**的 electron 依赖（顶层 import / 顶层 require）：
  // updater.ts 的 require('electron') 在函数体内（懒加载，模块加载不需要
  // electron），把它算进来会让「core 模块图不加载 electron」这一断言失真。
  const STATIC_ELECTRON_IMPORT =
    /^(?:import[^\n]*from\s*['"]electron['"]|(?:const|let|var)\s+[^\n]*require\s*\(\s*['"]electron['"]\s*\))/m
  const visited = new Set<string>()
  const offenders: string[] = []
  const queue = [...coreFamily]
  while (queue.length > 0) {
    const name = queue.shift()
    if (name === undefined || visited.has(name)) continue
    visited.add(name)
    if (!topLevelSources.includes(name)) continue
    const code = stripComments(readFileSync(path.join(dir, name), 'utf8'))
    if (STATIC_ELECTRON_IMPORT.test(code)) {
      offenders.push(name)
      continue
    }
    for (const match of code.matchAll(RELATIVE_IMPORT)) {
      const spec = match[1]
      if (spec.startsWith('..')) continue // 包外（workspace 包）不在本门禁范围
      const base = path.posix.basename(spec)
      const candidate = base.endsWith('.ts') || base.endsWith('.cts') ? base : `${base}.ts`
      if (topLevelSources.includes(candidate)) queue.push(candidate)
    }
  }
  assert.deepEqual(offenders, [], 'core 家族闭包内不得出现 electron import')
  // 闭包必须真的走过多个文件（否则规则被空集骗过）。
  assert.ok(visited.size >= coreFamily.size, `闭包遍历文件数异常：${[...visited].join(', ')}`)
})

test('W-14 面 B：白名单文件确实依赖 electron（防腐化）', () => {
  const missing: string[] = []
  for (const name of whitelist) {
    if (!topLevelSources.includes(name)) continue
    const code = stripComments(readFileSync(path.join(dir, name), 'utf8'))
    if (!ELECTRON_IMPORT.test(code)) missing.push(name)
  }
  assert.deepEqual(missing, [], '白名单文件应含 electron 依赖（否则移出白名单）')
})

test('W-14 面 C：core 家族无 ipcMain / webContents.send 字样（IPC_CHANNELS 放行）', () => {
  for (const name of coreFamily) {
    if (!topLevelSources.includes(name)) continue // 未落位成员（node-edges/sidecar-entry）跳过
    const code = stripComments(readFileSync(path.join(dir, name), 'utf8'))
    // 演进（W-10 S1）：shell-core 的 installIpcHandlers 合法引用 IPC_CHANNELS
    // 常量（ipc-events.ts 为纯常量模块、无 electron——core 可 import），故
    // IPC_CHANNELS 自禁列表移除；注册只能经注入 registrar（deps.ipc.handle），
    // ipcMain / webContents.send 拼写仍禁——Electron 注册与 send 面必须留在
    // main.ts / electron-edges.ts 装配侧（'ipcMain' 已覆盖 'ipcMain.handle'）。
    for (const token of ['ipcMain', 'webContents.send']) {
      assert.equal(code.includes(token), false, `${name} 不得出现 ${token}`)
    }
  }
})
