/**
 * electron-free-gate.test.ts — core 对 electron 零 import 门禁（W-14）
 *
 * design 25 §4.1 判定标准 + companion §四批 4：Electron 依赖面收敛为白名单
 * 文件（main.ts / preload.cts / updater.ts），其余 packages/desktop 顶层源码
 * （业务模块与 shell-core 家族）一律不得 import/require electron——拆分后
 * shell-core/node-edges/sidecar-entry 落位时自动被本门禁覆盖。
 *
 * 面 A（禁止）：白名单外文件无 electron import（逐行去注释后检测）。
 * 面 B（正例防腐化）：白名单文件确实含 electron（防白名单滥用）。
 * 面 C（core 纪律扩展）：shell-core.ts 不出现 ipcMain / webContents.send /
 *   IPC_CHANNELS 字面量（IPC 注册只能经 installIpcHandlers 单点——W-10 后
 *   规则不变：channel 注册面在 shell-core 的 installIpcHandlers，不在顶层）。
 * 注：electron-edges.ts 属 W-10 预期文件，落位后须加入白名单（届时同步本
 * 文件白名单并跑绿）。
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

const whitelist = new Set(['main.ts', 'preload.cts', 'updater.ts'])
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

test('W-14 面 B：白名单文件确实依赖 electron（防腐化）', () => {
  const missing: string[] = []
  for (const name of whitelist) {
    if (!topLevelSources.includes(name)) continue
    const code = stripComments(readFileSync(path.join(dir, name), 'utf8'))
    if (!ELECTRON_IMPORT.test(code)) missing.push(name)
  }
  assert.deepEqual(missing, [], '白名单文件应含 electron 依赖（否则移出白名单）')
})

test('W-14 面 C：core 家族无 IPC 注册字面量（shell-core 现态）', () => {
  const coreFile = path.join(dir, 'shell-core.ts')
  if (!topLevelSources.includes('shell-core.ts')) return // W-10 前不存在则跳过
  const code = stripComments(readFileSync(coreFile, 'utf8'))
  for (const token of ['ipcMain', 'webContents.send', 'IPC_CHANNELS']) {
    assert.equal(code.includes(token), false, `shell-core.ts 不得出现 ${token}`)
  }
})
