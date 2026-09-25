/**
 * desktop-shortcuts-bridge.test.ts — rc.2 原生键盘桥（W8/H10）行为锁。
 *
 * 断言链（真协议 + 内存存储；无 Electron/GUI）：
 *  ① 活动 runtime 树的 dsh-client-shortcuts/protocol 可加载且形状完整；
 *  ② get() 装入命令目录后 revision 生效：命中组合 → preventDefault + 归一化
 *     input（revision 与快照一致）；未命中组合不投递（non-match 不拦截）；
 *  ③ 两键 chord：先按第一键不投递、第二键命中 pair 投递（code/secondCode 排序）；
 *  ④ edit() 真落盘（内存 storage 收到 JSON）、revision 换代后旧键不再命中；
 *  ⑤ closeWindow 的 revision/focus 门与 recording 的菜单抑制形态；
 *  ⑥ desktopKeyEvent 透传 Electron 事实并标注 frame/window；
 *  ⑦ linux 主文档命中不进原生投递段（不 preventDefault、不投递；菜单抑制不变）；
 *  ⑧ linux 嵌入式 frame 命中仍按 upstream 转发（主文档走 DOM、frame 转发）；
 *  ⑨ windows/macos 的原生投递与 chord/priority 分支不落 Linux 门；
 *  ⑩ 形状缺 parseShortcutEdit 的 protocol 候选在加载期被拒（不半接线、名字进错误）；
 *  ⑪ N-ctx 偏差证据锁：命令目录是窗口级单槽（末位实例 get() 独占 match），
 *     投递 input 只带共享 revision、无实例身份（按活动源路由时本用例必须被替换）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DesktopShortcutsBridge,
  DESKTOP_SHORTCUTS_CHANNELS,
  desktopKeyEvent,
  loadDesktopShortcutProtocol,
} from '../../shortcuts-bridge.ts'
import type {
  DesktopKeyEvent,
  ShortcutConfigSnapshot,
  ShortcutPlatform,
  ShortcutStorage,
} from '../../shortcuts-bridge.ts'

const vendorTree = fileURLToPath(new URL('../../vendor/dsh', import.meta.url))

/**
 * 运行树物化探针：CI 的 test 腿与 checkout-only 环境不跑 bundle:dsh，故真协议行为锁在
 * 缺树时按仓库惯例**响亮跳过**（本地物化树仍全跑；跳过原因带修复命令）。
 */
const vendorTreeReady = existsSync(join(vendorTree, 'node_modules', '@deepseek-ai', 'dsh-client-shortcuts', 'package.json'))
const vendorTreeSkip = vendorTreeReady ? false : 'vendor/dsh 运行时树未物化（需 pnpm run bundle:dsh）——真协议行为锁跳过'

/** 需要真协议的用例统一入口（⑥ 是纯函数锁，不带 skip）。 */
function treeTest(name: string, fn: () => Promise<void> | void): void {
  test(name, { skip: vendorTreeSkip }, fn)
}

function memoryStorage(): ShortcutStorage & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    read: () => (writes.length === 0 ? null : writes[writes.length - 1]),
    write: (raw) => { writes.push(raw) },
  }
}

function keyEvent(overrides: Partial<DesktopKeyEvent> = {}): DesktopKeyEvent {
  return {
    type: 'keyDown',
    key: 'k',
    code: 'KeyK',
    control: false,
    alt: false,
    shift: false,
    meta: false,
    isAutoRepeat: false,
    isComposing: false,
    modifiers: [],
    frameName: '',
    windowActive: true,
    ...overrides,
  }
}

async function makeBridge(platform: ShortcutPlatform = 'macos'): Promise<{
  bridge: DesktopShortcutsBridge
  pushes: Array<{ channel: string; payload: unknown }>
  storage: ShortcutStorage & { writes: string[] }
}> {
  const protocol = await loadDesktopShortcutProtocol([vendorTree])
  assert.ok(protocol !== null, 'vendor/dsh 树应携带 dsh-client-shortcuts/protocol')
  const pushes: Array<{ channel: string; payload: unknown }> = []
  const storage = memoryStorage()
  const bridge = new DesktopShortcutsBridge({
    protocol,
    platform,
    storage,
    send: (channel, payload) => { pushes.push({ channel, payload }); return true },
  })
  return { bridge, pushes, storage }
}

/**
 * 造一棵只含 dsh-client-shortcuts/protocol 的假 runtime 树。
 * @param includeParseShortcutEdit - false 时模拟旧树/异形 protocol（缺该成员）。
 * @returns 临时 workspace 根（调用方负责 rmSync）。
 */
function protocolFixture(includeParseShortcutEdit: boolean): string {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'dsh-shortcuts-protocol-'))
  const packageDir = join(workspaceDir, 'node_modules', '@deepseek-ai', 'dsh-client-shortcuts')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(workspaceDir, 'package.json'), '{}\n')
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-client-shortcuts',
    version: '0.0.0-fixture',
    type: 'module',
    exports: { './protocol': './protocol.js' },
  }) + '\n')
  writeFileSync(join(packageDir, 'protocol.js'), [
    'export function ShortcutPersistence() {}',
    'export function parseShortcutDefinitions() { return [] }',
    ...includeParseShortcutEdit ? ['export function parseShortcutEdit(value) { return value }'] : [],
    'export function effectiveShortcuts() { return [] }',
    'export function bindingKey(binding) { return binding.code }',
    '',
  ].join('\n'))
  return workspaceDir
}

/** 捕获一次加载期间 console.error 的行（形状不完整的 fail-loud 证据）。 */
async function captureErrors<T>(run: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const errors: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    return { value: await run(), errors }
  } finally {
    console.error = original
  }
}

const SINGLE = [
  { id: 'test.open', defaults: { 'desktop:macos': { code: 'KeyK', modifiers: ['primary'] } } },
]
const CHORD = [
  { id: 'test.chord', defaults: { 'desktop:macos': { code: 'KeyK', secondCode: 'KeyO', modifiers: ['primary'] } } },
]
const LINUX = [
  { id: 'test.open', defaults: { 'desktop:linux': { code: 'KeyK', modifiers: ['control'] } } },
]
const WINDOWS = [
  { id: 'test.open', defaults: { 'desktop:windows': { code: 'KeyK', modifiers: ['primary'] } } },
]

treeTest('① 活动 runtime 树的 protocol 可加载且形状完整', async () => {
  const protocol = await loadDesktopShortcutProtocol([vendorTree])
  assert.ok(protocol !== null)
  assert.equal(typeof protocol.ShortcutPersistence, 'function')
  assert.equal(typeof protocol.parseShortcutDefinitions, 'function')
  assert.equal(typeof protocol.parseShortcutEdit, 'function')
  assert.equal(typeof protocol.effectiveShortcuts, 'function')
  assert.equal(typeof protocol.bindingKey, 'function')
})

treeTest('② get() 发出已接受 revision；命中组合投递归一化 input，未命中不拦截', async () => {
  const { bridge, pushes } = await makeBridge()
  const snapshot = await bridge.get(SINGLE)
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.usingDefaults, true)
  assert.equal(typeof snapshot.revision, 'string')
  assert.ok(pushes.some((push) => push.channel === DESKTOP_SHORTCUTS_CHANNELS.CHANGED
    && (push.payload as ShortcutConfigSnapshot).revision === snapshot.revision), 'CHANGED 必须带上已接受快照')

  const hit = bridge.handleKeyEvent(keyEvent({ meta: true }))
  assert.equal(hit.preventDefault, true)
  assert.equal(hit.ignoreMenuShortcuts, true)
  assert.ok(hit.input !== null)
  assert.equal(hit.input.revision, snapshot.revision)
  assert.equal(hit.input.kind, 'keyboard')
  if (hit.input.kind !== 'keyboard') throw new Error('unreachable')
  assert.equal(hit.input.code, 'KeyK')
  assert.equal(hit.input.meta, true)
  assert.equal(hit.input.repeat, false)

  const miss = bridge.handleKeyEvent(keyEvent({ key: 'j', code: 'KeyJ', meta: true }))
  assert.equal(miss.preventDefault, false)
  assert.equal(miss.input, null)
  assert.equal(miss.ignoreMenuShortcuts, false)
})

treeTest('③ 两键 chord：第二键命中 pair 时按排序 code/secondCode 投递', async () => {
  const { bridge } = await makeBridge()
  await bridge.get(CHORD)
  const first = bridge.handleKeyEvent(keyEvent({ meta: true }))
  assert.equal(first.input, null, '单键 KeyK 未绑定（pair 命中需第二键），主 frame 不投递')
  const second = bridge.handleKeyEvent(keyEvent({ key: 'o', code: 'KeyO', meta: true }))
  assert.ok(second.input !== null)
  if (second.input.kind !== 'keyboard') throw new Error('unreachable')
  assert.equal(second.input.code, 'KeyK')
  assert.equal(second.input.secondCode, 'KeyO')
  assert.equal(second.preventDefault, true)
})

treeTest('④ edit() 落盘并换代；旧 revision 下的命中在新目录中失效', async () => {
  const { bridge, storage } = await makeBridge()
  const snapshot = await bridge.get(SINGLE)
  const saved = await bridge.edit({ type: 'set', id: 'test.open', binding: null }, snapshot.revision)
  assert.equal(saved.status, 'saved')
  assert.equal(saved.snapshot.usingDefaults, false)
  assert.notEqual(saved.snapshot.revision, snapshot.revision)
  assert.equal(storage.writes.length, 1)
  assert.match(storage.writes[0], /"test\.open": null/)
  const after = bridge.handleKeyEvent(keyEvent({ meta: true }))
  assert.equal(after.input, null, '解绑后 KeyK 不再命中')
})

treeTest('⑤ closeWindow revision/focus 门 + recording 抑制菜单加速器', async () => {
  const { bridge } = await makeBridge()
  const snapshot = await bridge.get(SINGLE)
  assert.equal(bridge.closeWindow(snapshot.revision, { focused: true, enabled: true }), true)
  assert.equal(bridge.closeWindow(snapshot.revision, { focused: false, enabled: true }), false)
  assert.equal(bridge.closeWindow('00000000-0000-4000-8000-000000000000', { focused: true, enabled: true }), false)
  assert.equal(bridge.recording(true), true)
  const recorded = bridge.handleKeyEvent(keyEvent({ meta: true }))
  assert.equal(recorded.ignoreMenuShortcuts, true)
  assert.equal(recorded.input, null, '录制态不投递输入')
  assert.equal(bridge.recording(false), false)
})

test('⑥ desktopKeyEvent 透传 Electron 事实并标注 frame/window', () => {
  const fact = desktopKeyEvent({
    type: 'keyDown',
    key: 'k',
    code: 'KeyK',
    control: false,
    alt: false,
    shift: false,
    meta: true,
    isAutoRepeat: true,
    isComposing: false,
    modifiers: ['meta'],
  }, 'preview-frame', false)
  assert.equal(fact.type, 'keyDown')
  assert.equal(fact.meta, true)
  assert.equal(fact.isAutoRepeat, true)
  assert.equal(fact.frameName, 'preview-frame')
  assert.equal(fact.windowActive, false)
})

treeTest('⑦ linux：主文档命中组合不进原生投递段（upstream scopedDesktop 门）', async () => {
  const { bridge } = await makeBridge('linux')
  const snapshot = await bridge.get(LINUX)
  assert.equal(snapshot.status, 'ready')

  // 旧缺陷负控：修复前这里 match 直接抬 priority ⇒ preventDefault + 原生 input，
  // 命中组合的 DOM keydown 被吞（fixed 序列面收不到键）。
  const hit = bridge.handleKeyEvent(keyEvent({ control: true }))
  assert.equal(hit.preventDefault, false, 'Linux 主文档命中不得 preventDefault（键必须留给 DOM 分发）')
  assert.equal(hit.input, null, 'Linux 主文档不得产出 native input')
  assert.equal(hit.ignoreMenuShortcuts, true, '命中仍压住菜单加速器（upstream keyboard.ts:151）')

  const repeat = bridge.handleKeyEvent(keyEvent({ control: true, isAutoRepeat: true }))
  assert.equal(repeat.preventDefault, false)
  assert.equal(repeat.input, null)

  const release = bridge.handleKeyEvent(keyEvent({ type: 'keyUp', control: true }))
  assert.equal(release.preventDefault, false)
  assert.equal(release.input, null)

  const miss = bridge.handleKeyEvent(keyEvent({ key: 'j', code: 'KeyJ', control: true }))
  assert.equal(miss.preventDefault, false)
  assert.equal(miss.input, null)
  assert.equal(miss.ignoreMenuShortcuts, false)
})

treeTest('⑧ linux：嵌入式 frame 命中仍转发（主文档 DOM + frame 原生转发）', async () => {
  const { bridge } = await makeBridge('linux')
  await bridge.get(LINUX)

  const hit = bridge.handleKeyEvent(keyEvent({ control: true, frameName: 'html-preview' }))
  assert.equal(hit.preventDefault, true)
  assert.ok(hit.input !== null)
  assert.equal(hit.input.kind, 'iframe')
  assert.equal(hit.input.frameName, 'html-preview')
  if (hit.input.kind !== 'iframe') throw new Error('unreachable')
  assert.equal(hit.input.code, 'KeyK')
  assert.equal(hit.input.control, true)
  assert.equal(hit.input.repeat, false)

  // upstream keyboard.ts:182-184：命中先 preventDefault，keyUp/char 不再 send。
  const release = bridge.handleKeyEvent(keyEvent({ type: 'keyUp', control: true, frameName: 'html-preview' }))
  assert.equal(release.preventDefault, true)
  assert.equal(release.input, null)

  const miss = bridge.handleKeyEvent(keyEvent({ key: 'j', code: 'KeyJ', control: true, frameName: 'html-preview' }))
  assert.equal(miss.preventDefault, false)
  assert.equal(miss.input, null)
})

treeTest('⑨ windows/macos 不受 Linux 门影响：主文档命中仍原生投递', async () => {
  const { bridge: windows } = await makeBridge('windows')
  await windows.get(WINDOWS)
  const hit = windows.handleKeyEvent(keyEvent({ control: true }))
  assert.equal(hit.preventDefault, true)
  assert.ok(hit.input !== null)
  assert.equal(hit.input.kind, 'keyboard')
  if (hit.input.kind !== 'keyboard') throw new Error('unreachable')
  assert.equal(hit.input.code, 'KeyK')

  const { bridge: macos } = await makeBridge('macos')
  await macos.get(CHORD)
  const first = macos.handleKeyEvent(keyEvent({ meta: true }))
  assert.equal(first.input, null)
  const second = macos.handleKeyEvent(keyEvent({ key: 'o', code: 'KeyO', meta: true }))
  assert.ok(second.input !== null, 'macOS chord/priority 分支必须留在 Linux 门之外')
  assert.equal(second.preventDefault, true)
})

treeTest('⑩ 缺 parseShortcutEdit 的 protocol 候选在加载期被拒且名字进错误', async () => {
  const complete = protocolFixture(true)
  const incomplete = protocolFixture(false)
  try {
    // 对照组：同一 fixture 形状补全时可加载 —— 证明拒绝确由缺成员触发，而非解析失败。
    assert.ok(await loadDesktopShortcutProtocol([complete]) !== null)

    const rejected = await captureErrors(() => loadDesktopShortcutProtocol([incomplete]))
    assert.equal(rejected.value, null, '缺 parseShortcutEdit 的候选不得被接受（否则 edit() 才在运行期炸）')
    assert.ok(rejected.errors.some(line => line.includes('parseShortcutEdit')),
      '形状不完整必须 fail-loud 并点名缺失成员，实际：' + JSON.stringify(rejected.errors))

    // 坏候选只淘汰该候选：候选序（活动 runtime → 内置树）语义不变。
    const fallthrough = await captureErrors(() => loadDesktopShortcutProtocol([incomplete, vendorTree]))
    assert.ok(fallthrough.value !== null, '坏候选必须继续尝试后续候选，而不是整体放弃')
    assert.equal(typeof fallthrough.value.parseShortcutEdit, 'function')
  } finally {
    rmSync(complete, { recursive: true, force: true })
    rmSync(incomplete, { recursive: true, force: true })
  }
})

treeTest('⑪ N-ctx 偏差证据：命令目录是窗口级单槽（后一个实例 get() 独占），投递 input 无实例身份', async () => {
  // design 25 §4.4.1 的键盘座席按「单窗口 = 单实例」设计：一个 DesktopShortcutsBridge
  // 持有唯一的 definitions/keys/revision，main.ts 把一个 before-input-event 门喂给它。
  // N-ctx 页面里每个实例的官方 shortcuts 服务都会调用 dshDesktop.shortcuts.get(自己的
  // 目录)，故最后一个 sync 的实例独占 match；input 只带共享 revision 而无实例标记，
  // 页面侧每个实例的 native 适配器只做 revision 比对（vendor native.ts:17），全部实例
  // 都会 accept 并各自 dispatch。本用例把这一偏差钉成机器可见：实现按活动源路由时，
  // 它必须被替换为双实例断言。
  const { bridge } = await makeBridge()
  const instanceA = await bridge.get(SINGLE)
  const instanceB = await bridge.get(CHORD)
  assert.notEqual(instanceA.revision, instanceB.revision,
    '每个实例的 get()/setDefinitions 都会换代：末位实例的 revision 才是 input 携带的那个')

  // A 的独有绑定在 B 的目录装入后不再命中：match 槽被末位实例覆盖。
  const aOnly = bridge.handleKeyEvent(keyEvent({ meta: true }))
  assert.equal(aOnly.input, null, 'A 的 KeyK 单键绑定已不被末位实例目录承认')
  assert.equal(aOnly.ignoreMenuShortcuts, false, '菜单抑制也按末位实例目录判定')

  // B 的 chord 命中；投递结构里没有任何实例身份可被页面用于路由。
  const first = bridge.handleKeyEvent(keyEvent({ meta: true }))
  assert.equal(first.input, null, 'chord 第一键不单独投递')
  const second = bridge.handleKeyEvent(keyEvent({ key: 'o', code: 'KeyO', meta: true }))
  assert.ok(second.input !== null)
  assert.equal(second.input.revision, instanceB.revision)
  assert.equal(Object.hasOwn(second.input, 'instanceId'), false, '原生 input 无实例标记 ⇒ preload 只能广播')
  assert.equal(Object.hasOwn(second.input, 'sourceId'), false)

  // 反向再装 A：槽位翻转，证明是「最后 get 的实例独占」而不是「两个目录合并」。
  await bridge.get(SINGLE)
  const flipped = bridge.handleKeyEvent(keyEvent({ meta: true }))
  assert.ok(flipped.input !== null, '重新装入 A 的目录后 KeyK 再次命中（单槽后写胜出）')
})
