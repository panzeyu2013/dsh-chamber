/**
 * desktop-carrier-surface.test.ts — dshDesktop 载体（rc.2 官方桌面面）锁步。
 *
 * 为什么不是 ipc-surface-mirror.test.ts 的一部分：那个测试锁的是 **A 桥**
 * （dshChamber <-> Swift sidecar，IPC_CHANNELS / bridge-manifest.json）；本文件
 * 锁的是官方 desktop preload 的 **dshDesktop** 面（apps/desktop/src/ipc.ts
 * DESKTOP_IPC 子集），它不进 A 桥 manifest，也不得与 IPC_CHANNELS 重叠——
 * 否则 Swift 白名单/生成物会被无关通道污染。
 *
 * 断言链:
 *  ① preload 的字面量表 == main 侧 DESKTOP_SHORTCUTS_CHANNELS（单源锁步）；
 *  ② preload 用常量调用 invoke/on；main.ts 用常量 handle；bridge 用常量推送；
 *  ③ dshDesktop 顶层键 = protocolVersion/updates/keyboard/shortcuts；
 *  ④ 两 flavor 都写 dataset.platform（desktop 判定 + keyboard 必需性的触发点）；
 *  ⑤ Swift shim 的 dshDesktop：keyboard.subscribe 的 DOM 源、shortcuts 适配器、
 *     documentStart 暴露；
 *  ⑥ 通道域与 IPC_CHANNELS 零交集（A 桥 manifest 不承载 dshDesktop）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_SHORTCUTS_CHANNELS } from '../../shortcuts-bridge.ts'
import { IPC_CHANNELS } from '../../ipc-events.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const preload = readFileSync(join(ROOT, 'packages', 'desktop', 'preload.cts'), 'utf8')
const main = readFileSync(join(ROOT, 'packages', 'desktop', 'main.ts'), 'utf8')
const bridge = readFileSync(join(ROOT, 'packages', 'desktop', 'shortcuts-bridge.ts'), 'utf8')
const shim = readFileSync(join(ROOT, 'macos', 'Sources', 'DSHChamber', 'Resources', 'bridge-shim.js'), 'utf8')

function preloadChannelTable(): Record<string, string> {
  const block = preload.match(/const DESKTOP_SHORTCUTS_CHANNELS = \{([\s\S]*?)\n\} as const;/)
  assert.ok(block !== null, 'preload.cts 应声明 DESKTOP_SHORTCUTS_CHANNELS 字面量表')
  const table: Record<string, string> = {}
  for (const line of block[1].split('\n')) {
    const row = /^ {2}([A-Z_]+): '([^']+)',$/.exec(line)
    if (row !== null) table[row[1]] = row[2]
  }
  return table
}

test('① preload 通道字面量 == main 侧单源（无缺无多）', () => {
  assert.deepEqual(preloadChannelTable(), { ...DESKTOP_SHORTCUTS_CHANNELS })
})

test('② preload 用常量 invoke/on；main 用常量 handle；bridge 用常量推送', () => {
  for (const key of ['GET', 'EDIT', 'RECORDING', 'CLOSE_WINDOW']) {
    assert.ok(preload.includes(`ipcRenderer.invoke(DESKTOP_SHORTCUTS_CHANNELS.${key}`),
      `preload.cts 应以常量 invoke ${key}`)
    assert.ok(main.includes(`ipcMain.handle(DESKTOP_SHORTCUTS_CHANNELS.${key}`),
      `main.ts 应以常量 handle ${key}`)
  }
  assert.ok(preload.includes('ipcRenderer.on(DESKTOP_SHORTCUTS_CHANNELS.CHANGED'),
    'preload.cts 应订阅 CHANGED 推送')
  assert.ok(bridge.includes('this.send(DESKTOP_SHORTCUTS_CHANNELS.CHANGED, snapshot)'),
    'shortcuts-bridge.ts 的 publish 应推送 CHANGED')
  assert.ok(main.includes('win.webContents.send(DESKTOP_SHORTCUTS_CHANNELS.INPUT'),
    'main.ts 的 before-input-event 应推送 INPUT')
})

test('③ dshDesktop 顶层键 = protocolVersion/updates/keyboard/shortcuts', () => {
  const carrier = preload.match(/exposeInMainWorld\('dshDesktop', \{([\s\S]*?)\n  \}\);/)
  assert.ok(carrier !== null, 'preload.cts 应 exposeInMainWorld dshDesktop')
  const keys = new Set<string>()
  for (const line of carrier[1].split('\n')) {
    const row = /^ {4}([a-zA-Z_$][a-zA-Z0-9_$]*):/.exec(line)
    if (row !== null) keys.add(row[1])
  }
  assert.deepEqual([...keys].sort(), ['keyboard', 'protocolVersion', 'shortcuts', 'updates'])
  const shimCarrier = shim.match(/var dshDesktopApi = \{([\s\S]*?)\n  \}/)
  assert.ok(shimCarrier !== null, 'bridge-shim.js 应声明 dshDesktopApi')
  const shimKeys = new Set<string>()
  for (const line of shimCarrier[1].split('\n')) {
    const row = /^ {4}([a-zA-Z_$][a-zA-Z0-9_$]*):/.exec(line)
    if (row !== null) shimKeys.add(row[1])
  }
  assert.deepEqual([...shimKeys].sort(), ['keyboard', 'protocolVersion', 'shortcuts', 'updates'])
})

test('④ 两 flavor 都写 documentElement.dataset.platform', () => {
  assert.ok(preload.includes('document.documentElement.dataset.platform = process.platform'),
    'preload.cts 的 markDocumentPlatform 必须写平台标记')
  assert.ok(shim.includes('document.documentElement.dataset.platform = platform'),
    'bridge-shim.js 的 markDocumentPlatform 必须写平台标记')
})

test('⑤ Swift shim：DOM 键事件源 + 真 shortcuts 适配器 + documentStart 暴露', () => {
  assert.ok(shim.includes("window.addEventListener('keydown', desktopKeyDown, true)"),
    'shim 键盘桥必须以主文档 keydown(capture) 为事件源')
  assert.ok(shim.includes("window.addEventListener('keyup', desktopKeyUp, true)"),
    'shim 键盘桥必须以 keyup 维护 chord 状态')
  assert.ok(shim.includes('revision: shortcutsRevision'),
    'shim 投递的 input 必须带 shortcuts 适配器持有的 revision')
  assert.ok(shim.includes('defineWindowGlobal(\'dshDesktop\', dshDesktopApi)'),
    'shim 必须在 documentStart 暴露 dshDesktop（不依赖 info 水化）')
  assert.ok(shim.includes('shortcutsApplyEdit(edit)'),
    'shim 的 shortcuts.edit 必须是真实的会话内事务（非空 stub）')
})

test('⑥ dshDesktop 通道域与 A 桥 IPC_CHANNELS 零交集', () => {
  const aBridge = new Set<string>(Object.values(IPC_CHANNELS))
  for (const channel of Object.values(DESKTOP_SHORTCUTS_CHANNELS)) {
    assert.equal(aBridge.has(channel), false, `dshDesktop 通道 ${channel} 不得进入 A 桥 manifest`)
  }
})
