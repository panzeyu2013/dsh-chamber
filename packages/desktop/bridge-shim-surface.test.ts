/**
 * bridge-shim-surface.test.ts —— 静态面比对：bridge-shim.js（macOS
 * Swift POC A-bridge shim）与 preload.cts 暴露面逐字一致 + 通道引用 ∈
 * bridge-manifest.json invoke/push 集。
 *
 * 断言链（全部静态文本解析，不执行 shim）：
 *  ① 11 命名空间各自的方法名集合：preload（*Api 工厂返回对象）== shim
 *     （var <ns> = {…} 块）——无缺无多（含 on* 订阅方法；update/runtime 的
 *     onStateChanged 等 preload 面外别名不得出现）；
 *  ② 方法→通道逐条映射：同 (命名空间, 方法) 下 preload 的
 *     ipcRenderer.invoke('…') / ipcRenderer.on('…') 字面量与 shim 的
 *     invoke('…') / subscribe(PUSH_EVENTS.KEY) 解析通道相等（含 openIn.apps
 *     的解包方法、ready/ack 的 {deliveryId,attempt} 类形状方法——本测试锁
 *     通道名；update 面两个确认动作的 payload 键由 ⑥ 逐条锁死，其余面的
 *     payload 形状由实现注释与 Swift 集成测试覆盖）；
 *  ③ 顶层面：preload exposeInMainWorld('dshChamber', {…}) 的 15 个键
 *     （4 标量 + 11 命名空间）== shim dshChamberApi 键；
 *  ④ invoke 通道集：preload 全部 invoke 字面量 == shim 全部 invoke 字面量
 *     == manifest invoke 集（58）；push 通道集：preload 全部
 *     ipcRenderer.on 字面量 == shim PUSH_EVENTS 值 == manifest push 集（9）；
 *  ⑤ 无 poc-unimplemented 兜底残留：shim 不含 pocUnimplemented/rejectMethods
 *     代码形态（头部注记文本仅描述 sidecar 桩，不属于兜底代码）。
 *  ⑥ Swift-only A 桥白名单（bridge-swift-only-additions.json，政策见
 *     docs/progress/electron-frozen.md §5.2）：白名单项只存在于 shim（preload 面外），
 *     ①②③④ 的「两侧相等」对它们豁免；但 shim 必须真的实现它（缺方法/缺通道映射仍红），
 *     preload 不得暴露同名成员、manifest 必须已收录该通道。空表 = 全部 no-op。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(dir, '..', '..')
const preloadSource = readFileSync(path.join(dir, 'electron', 'preload.cts'), 'utf8')
const shimSource = readFileSync(
  path.join(repoRoot, 'macos', 'Sources', 'DSHChamber', 'Resources', 'bridge-shim.js'),
  'utf8',
)
const manifest = JSON.parse(
  readFileSync(path.join(dir, 'bridge-manifest.json'), 'utf8'),
) as { invoke: { channel: string }[]; push: { channel: string }[]; counts: { invoke: number; push: number } }
const manifestInvoke = new Set(manifest.invoke.map((e) => e.channel))
const manifestPush = new Set(manifest.push.map((e) => e.channel))
/** Swift-only A 桥 additions 白名单（docs/progress/electron-frozen.md §5.2）：只存在于
 *  Swift shim、无需 Electron preload / 主进程注册的通道。空表时下面所有豁免都是
 *  no-op——本文件的断言行为与加白名单前逐字一致。 */
interface SwiftOnlyAddition {
  channel: string
  key: string
  direction: 'invoke' | 'push'
  namespace: string
  method: string
  reason: string
}
const swiftOnlyAdditions: SwiftOnlyAddition[] =
  (JSON.parse(readFileSync(path.join(dir, 'bridge-swift-only-additions.json'), 'utf8')) as {
    entries: SwiftOnlyAddition[]
  }).entries
const swiftOnlyInvoke = new Set(
  swiftOnlyAdditions.filter((entry) => entry.direction === 'invoke').map((entry) => entry.channel),
)
const swiftOnlyPush = new Set(
  swiftOnlyAdditions.filter((entry) => entry.direction === 'push').map((entry) => entry.channel),
)
const swiftOnlyMethods = new Set(swiftOnlyAdditions.map((entry) => entry.namespace + '.' + entry.method))
const swiftOnlyNamespaces = new Set(swiftOnlyAdditions.map((entry) => entry.namespace))
for (const channel of swiftOnlyInvoke) {
  assert.ok(!swiftOnlyPush.has(channel), `Swift-only 白名单通道不得同时声明两个方向：${channel}`)
}

/** preload *Api 工厂名 → 命名空间名（保守显式清单）。 */
const API_FACTORY_TO_NAMESPACE: Record<string, string> = {
  desktopSshApi: 'desktopSsh',
  updateApi: 'update',
  settingsApi: 'settings',
  systemResumeApi: 'systemResume',
  rendererStallApi: 'rendererStall',
  openInApi: 'openIn',
  deepLinkApi: 'deepLink',
  runtimeApi: 'runtime',
  notificationsApi: 'notifications',
  badgeApi: 'badge',
  forwardApi: 'forward',
}
const NAMESPACES = Object.values(API_FACTORY_TO_NAMESPACE)

/** 成员名：4 空格缩进的 `name:` 行（preload 与 shim 的对象字面量成员同形；
 *  更深缩进（≥6 空格）是函数体内续行/嵌套行，不匹配）。 */
function extractMemberNames(blockText: string): string[] {
  const names: string[] = []
  for (const line of blockText.split('\n')) {
    const m = line.match(/^ {4}([a-zA-Z_$][a-zA-Z0-9_$]*):/)
    if (m !== null) names.push(m[1])
  }
  return names
}

/** preload：function <name>Api(): … { … }（0 列 `}` 收尾）块文本。 */
function preloadApiBlock(factoryName: string): string {
  const re = new RegExp(`function ${factoryName}\\(\\)[^\\{]*\\{([\\s\\S]*?)\\n\\}`, 'm')
  const m = preloadSource.match(re)
  assert.ok(m !== null, `preload.cts 应含 function ${factoryName}() { … }`)
  return m[1]
}

/** shim：`  var <ns> = {` 到首个 2 空格 `}` 行之间的块文本。 */
function shimNamespaceBlock(namespace: string): string {
  const re = new RegExp(`^  var ${namespace} = \\{([\\s\\S]*?)\\n  \\}`, 'm')
  const m = shimSource.match(re)
  assert.ok(m !== null, `bridge-shim.js 应含 var ${namespace} = { … } 块`)
  return m[1]
}

/** 把块文本按成员起始行切段：每段 = 一个成员（从 `name:` 行到下一个
 *  `name:` 行之前）。 */
function memberSpans(blockText: string): Map<string, string> {
  const lines = blockText.split('\n')
  const spans = new Map<string, string[]>()
  let current: string | null = null
  for (const line of lines) {
    const m = line.match(/^ {4}([a-zA-Z_$][a-zA-Z0-9_$]*):/)
    if (m !== null) {
      current = m[1]
      spans.set(current, [])
    }
    if (current !== null) {
      const lines_ = spans.get(current)
      lines_?.push(line)
    }
  }
  const out = new Map<string, string>()
  for (const [name, bodyLines] of spans) {
    out.set(name, bodyLines.join('\n'))
  }
  return out
}

/** preload 单成员 → 通道字面量：首个 ipcRenderer.invoke('…') 或
 *  ipcRenderer.on('…')（invoke 的第二实参不参与匹配——payload 形状由
 *  实现注释与 Swift 集成测试覆盖，本测试锁通道名）。 */
function preloadMemberChannel(memberText: string): string {
  const invoke = memberText.match(/ipcRenderer\.invoke\('([^']+)'/)
  if (invoke !== null) return invoke[1]
  const on = memberText.match(/ipcRenderer\.on\('([^']+)'/)
  if (on !== null) return on[1]
  return ''
}

/** shim PUSH_EVENTS 对象 → { 键: 通道 }。 */
function shimPushEvents(): Record<string, string> {
  const m = shimSource.match(/var PUSH_EVENTS = \{([\s\S]*?)\n  \}/)
  assert.ok(m !== null, 'bridge-shim.js 应含 PUSH_EVENTS 表')
  const table: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    // 末行无尾逗号——`,?` 兼容。
    const row = line.match(/^ {4}(\w+): '([^']+)',?$/)
    if (row !== null) table[row[1]] = row[2]
  }
  return table
}

/** shim 单成员 → 通道：首个 invoke('…') 或 subscribe(PUSH_EVENTS.KEY)。 */
function shimMemberChannel(memberText: string, pushEvents: Record<string, string>): string {
  const invoke = memberText.match(/invoke\('([^']+)'/)
  if (invoke !== null) return invoke[1]
  const sub = memberText.match(/subscribe\(PUSH_EVENTS\.(\w+)/)
  if (sub !== null) {
    const channel = pushEvents[sub[1]]
    assert.ok(channel !== undefined, `PUSH_EVENTS.${sub[1]} 应已定义`)
    return channel
  }
  return ''
}

// ---- 顶层键（preload exposeInMainWorld 两分支 / shim dshChamberApi） ------

function extractExposeKeys(source: string): Set<string> {
  const keys = new Set<string>()
  for (const m of source.matchAll(/exposeInMainWorld\('dshChamber', \{([\s\S]*?)\n    \}\)/g)) {
    for (const line of m[1].split('\n')) {
      const row = line.match(/^ {6}([a-zA-Z_$][a-zA-Z0-9_$]*):/)
      if (row !== null) keys.add(row[1])
    }
  }
  return keys
}

function extractShimTopKeys(): Set<string> {
  const m = shimSource.match(/var dshChamberApi = \{([\s\S]*?)\n  \}/)
  assert.ok(m !== null, 'bridge-shim.js 应含 dshChamberApi 对象')
  const keys = new Set<string>()
  for (const line of m[1].split('\n')) {
    const row = line.match(/^ {4}([a-zA-Z_$][a-zA-Z0-9_$]*):/)
    if (row !== null) keys.add(row[1])
  }
  return keys
}

const EXPECTED_SCALARS = ['controlPlaneUrl', 'dshVersion', 'version', 'platform']

test('① 命名空间方法名集合：preload == shim（无缺无多；Swift-only 白名单方法豁免"多"）', () => {
  for (const namespace of NAMESPACES) {
    const factory = Object.keys(API_FACTORY_TO_NAMESPACE).find((k) => API_FACTORY_TO_NAMESPACE[k] === namespace)
    assert.ok(factory !== undefined, `命名空间 ${namespace} 应有工厂名`)
    const preloadNames = extractMemberNames(preloadApiBlock(factory))
    const shimNames = extractMemberNames(shimNamespaceBlock(namespace))
    const missing = preloadNames.filter((n) => !shimNames.includes(n))
    const extra = shimNames.filter(
      (n) => !preloadNames.includes(n) && !swiftOnlyMethods.has(namespace + '.' + n),
    )
    assert.deepEqual(
      { namespace, extra },
      { namespace, extra: [] },
      `shim ${namespace} 暴露了 preload 面外的方法（W-04 时代别名如 onStateChanged 不允许残留；只有 Swift-only 白名单项可豁免）`,
    )
    assert.deepEqual(
      { namespace, missing },
      { namespace, missing: [] },
      `shim ${namespace} 缺少 preload 的方法`,
    )
    // 白名单只描述 Swift-only 方法：shim 必须真实现，preload 不得暴露。
    for (const addition of swiftOnlyAdditions.filter((entry) => entry.namespace === namespace)) {
      assert.ok(
        !preloadNames.includes(addition.method),
        `preload 不得暴露 Swift-only 白名单方法 ${namespace}.${addition.method}`,
      )
      assert.ok(
        shimNames.includes(addition.method),
        `shim 缺少 Swift-only 白名单方法 ${namespace}.${addition.method}`,
      )
    }
    const comparableShimNames = shimNames.filter((n) => !swiftOnlyMethods.has(namespace + '.' + n))
    assert.deepEqual([...comparableShimNames].sort(), [...preloadNames].sort())
  }
  // 全新 Swift-only 命名空间没有 preload 工厂可对拍：只要求 shim 侧存在该命名空间块与方法。
  for (const namespace of [...swiftOnlyNamespaces].filter((name) => !NAMESPACES.includes(name))) {
    const shimNames = extractMemberNames(shimNamespaceBlock(namespace))
    for (const addition of swiftOnlyAdditions.filter((entry) => entry.namespace === namespace)) {
      assert.ok(shimNames.includes(addition.method), `shim 缺少 Swift-only 白名单方法 ${namespace}.${addition.method}`)
    }
  }
})
test('② 方法→通道映射逐条相等（preload 字面量 == shim 解析通道；Swift-only 白名单项另测）', () => {
  const pushEvents = shimPushEvents()
  for (const namespace of NAMESPACES) {
    const factory = Object.keys(API_FACTORY_TO_NAMESPACE).find((k) => API_FACTORY_TO_NAMESPACE[k] === namespace)
    assert.ok(factory !== undefined)
    const preloadSpans = memberSpans(preloadApiBlock(factory))
    const shimSpans = memberSpans(shimNamespaceBlock(namespace))
    const preloadNames = [...preloadSpans.keys()]
    const shimNames = [...shimSpans.keys()].filter((name) => !swiftOnlyMethods.has(namespace + '.' + name))
    assert.deepEqual([...shimNames].sort(), [...preloadNames].sort())
    for (const name of preloadNames) {
      const preloadChannel = preloadMemberChannel(preloadSpans.get(name) ?? '')
      const shimChannel = shimMemberChannel(shimSpans.get(name) ?? '', pushEvents)
      assert.ok(preloadChannel !== '', `${namespace}.${name}（preload）应解析出通道`)
      assert.ok(shimChannel !== '', `${namespace}.${name}（shim）应解析出通道`)
      assert.equal(shimChannel, preloadChannel, `${namespace}.${name} 通道映射不一致`)
    }
    // Swift-only 方法只存在于 shim：它的解析通道必须等于白名单声明的通道。
    for (const addition of swiftOnlyAdditions.filter((entry) => entry.namespace === namespace)) {
      assert.equal(
        shimMemberChannel(shimSpans.get(addition.method) ?? '', pushEvents),
        addition.channel,
        `Swift-only ${namespace}.${addition.method} 的 shim 通道与白名单不一致`,
      )
    }
  }
  for (const namespace of [...swiftOnlyNamespaces].filter((name) => !NAMESPACES.includes(name))) {
    const shimSpans = memberSpans(shimNamespaceBlock(namespace))
    for (const addition of swiftOnlyAdditions.filter((entry) => entry.namespace === namespace)) {
      assert.equal(
        shimMemberChannel(shimSpans.get(addition.method) ?? '', pushEvents),
        addition.channel,
        `Swift-only ${namespace}.${addition.method} 的 shim 通道与白名单不一致`,
      )
    }
  }
})
test('③ 顶层面：preload expose 键 == 4 标量 + 11 命名空间；shim 另可带 Swift-only 命名空间', () => {
  const base = new Set([...EXPECTED_SCALARS, ...NAMESPACES])
  const exposeKeys = extractExposeKeys(preloadSource)
  assert.deepEqual(exposeKeys, base, 'preload exposeInMainWorld 键应为 4 标量 + 11 命名空间（Swift-only 不得进 preload）')
  const shimKeys = extractShimTopKeys()
  assert.deepEqual(
    shimKeys,
    new Set([...base, ...swiftOnlyNamespaces]),
    'shim dshChamberApi 键应为 4 标量 + 11 命名空间 + Swift-only 白名单命名空间',
  )
})
test('④ invoke/push 通道集：preload == shim（Swift-only 白名单项除外）== manifest', () => {
  // 内部 bootstrap 通道（无命名空间方法暴露）：与 verify-shim-payload-shape 的
  // INTERNAL_INVOKE_CHANNELS 同集——info hydration + macOS 主题源 observer。
  const INTERNAL_INVOKE = ['dsh-chamber:info', 'dsh-chamber:native-theme-set']
  const preloadInvoke = new Set<string>()
  const preloadPush = new Set<string>()
  for (const namespace of NAMESPACES) {
    const factory = Object.keys(API_FACTORY_TO_NAMESPACE).find((k) => API_FACTORY_TO_NAMESPACE[k] === namespace)
    assert.ok(factory !== undefined)
    for (const [name, memberText] of memberSpans(preloadApiBlock(factory))) {
      const channel = preloadMemberChannel(memberText)
      if (channel === '') continue
      if (name.startsWith('on')) preloadPush.add(channel)
      else preloadInvoke.add(channel)
    }
  }
  for (const channel of INTERNAL_INVOKE) preloadInvoke.add(channel)
  const shimInvoke = new Set<string>()
  const shimUsedPush = new Set<string>()
  const pushEvents = shimPushEvents()
  for (const namespace of NAMESPACES) {
    for (const [name, memberText] of memberSpans(shimNamespaceBlock(namespace))) {
      const channel = shimMemberChannel(memberText, pushEvents)
      if (channel === '') continue
      if (name.startsWith('on')) shimUsedPush.add(channel)
      else shimInvoke.add(channel)
    }
  }
  for (const namespace of [...swiftOnlyNamespaces].filter((name) => !NAMESPACES.includes(name))) {
    for (const [name, memberText] of memberSpans(shimNamespaceBlock(namespace))) {
      const channel = shimMemberChannel(memberText, pushEvents)
      if (channel === '') continue
      if (name.startsWith('on')) shimUsedPush.add(channel)
      else shimInvoke.add(channel)
    }
  }
  for (const channel of INTERNAL_INVOKE) shimInvoke.add(channel)
  // 集相等：去掉 Swift-only 白名单通道后，shim 未遗漏/未发明任何 preload 用过的通道。
  const shimInvokeShared = new Set([...shimInvoke].filter((channel) => !swiftOnlyInvoke.has(channel)))
  assert.deepEqual(shimInvokeShared, preloadInvoke, 'shim invoke 通道集（扣除 Swift-only 白名单）应与 preload 一致')
  // 白名单项反向：shim 必须真实现，preload 不得暴露，manifest 必须已收录。
  for (const channel of swiftOnlyInvoke) {
    assert.ok(shimInvoke.has(channel), `Swift-only 白名单 invoke 通道未在 shim 实现：${channel}`)
    assert.equal(preloadInvoke.has(channel), false, `Swift-only 白名单通道不得出现在 preload：${channel}`)
    assert.ok(manifestInvoke.has(channel), `Swift-only 白名单通道未进 manifest：${channel}`)
  }
  assert.equal(shimInvoke.size, manifest.counts.invoke, `invoke 通道应覆盖 manifest 的 ${manifest.counts.invoke} 条`)
  for (const channel of shimInvoke) {
    assert.ok(manifestInvoke.has(channel), `invoke 通道 ${channel} 应 ∈ manifest invoke 集`)
  }
  assert.equal(manifestInvoke.size, manifest.counts.invoke)
  // push 面：preload on 字面量 == shim PUSH_EVENTS 值（扣除 Swift-only）== shim on* 实订阅 ==
  // manifest push 集（无死订阅常量）。
  const shimPush = new Set(Object.values(pushEvents))
  const shimPushShared = new Set([...shimPush].filter((channel) => !swiftOnlyPush.has(channel)))
  assert.deepEqual(shimPushShared, preloadPush, 'shim PUSH_EVENTS（扣除 Swift-only 白名单）应与 preload 订阅字面量一致')
  for (const channel of swiftOnlyPush) {
    assert.ok(shimPush.has(channel), `Swift-only 白名单 push 通道未在 shim PUSH_EVENTS 实现：${channel}`)
    assert.equal(preloadPush.has(channel), false, `Swift-only 白名单通道不得出现在 preload：${channel}`)
    assert.ok(manifestPush.has(channel), `Swift-only 白名单通道未进 manifest：${channel}`)
  }
  assert.deepEqual(shimUsedPush, shimPush, 'shim 每个 PUSH_EVENTS 常量都应被某 on* 方法订阅')
  assert.equal(shimPush.size, manifest.counts.push, `push 通道应覆盖 manifest 的 ${manifest.counts.push} 条`)
  for (const channel of shimPush) {
    assert.ok(manifestPush.has(channel), `push 通道 ${channel} 应 ∈ manifest push 集`)
  }
})
test('⑥ update 面 payload 形状锁步：openReleasePage {url} / state|check 无载荷 / 确认动作带 {revision}（G22 的更新面切片）', () => {
  // 更新面的 payload 形状锁步：preload 与 shim 的「动作是否携带 payload、
  // 键叫什么」逐条锁死。更广的 payload 形状（notifications/deepLink/
  // runtime 请求对象）仍靠 Swift 侧监听器校验 + 集成测试。
  const preloadMembers = memberSpans(preloadApiBlock('updateApi'))
  const shimMembers = memberSpans(shimNamespaceBlock('update'))
  const NO_PAYLOAD_ACTIONS: Array<[member: string, channel: string]> = [
    ['state', 'dsh-chamber:update-state'],
    ['check', 'dsh-chamber:update-check'],
  ]
  // 确认动作（download / restartAndInstall）必须回传渲染快照的 revision：design 11 §4
  // 的过期回答护栏在主进程侧，两侧漏传/改键名都会让护栏静默失效——键形状逐字锁死。
  const CONFIRM_ACTIONS: Array<[member: string, channel: string]> = [
    ['download', 'dsh-chamber:update-download'],
    ['restartAndInstall', 'dsh-chamber:update-restart'],
  ]
  for (const [action, channel] of CONFIRM_ACTIONS) {
    assert.match(
      preloadMembers.get(action) ?? '',
      new RegExp(`invoke\\('${channel}',\\s*\\{\\s*revision\\s*\\}\\)`),
      `preload update.${action} 必须携带 { revision }（渲染快照的代际号）`,
    )
    assert.match(
      shimMembers.get(action) ?? '',
      new RegExp(`invoke\\('${channel}',\\s*\\{\\s*revision:\\s*revision\\s*\\}\\)`),
      `shim update.${action} 必须携带 { revision: revision }（与 preload 同形）`,
    )
  }
  for (const [action, channel] of NO_PAYLOAD_ACTIONS) {
    // preload 不传第二实参；shim 显式传 null（同一「无载荷」语义，两种拼写）。
    // 锚定到闭括号：.includes 会被带载荷的 invoke('ch', {…}) 前缀命中而放行。
    assert.match(
      preloadMembers.get(action) ?? '',
      new RegExp(`invoke\\('${channel}'\\)`),
      `preload update.${action} 不得携带 payload（应 invoke('${channel}')）`,
    )
    assert.match(
      shimMembers.get(action) ?? '',
      new RegExp(`invoke\\('${channel}',\\s*null\\)`),
      `shim update.${action} 的无载荷拼写必须是 invoke('${channel}', null)`,
    )
  }
  // openReleasePage 的载荷是字符串：键必须同为 { url }。
  assert.match(preloadMembers.get('openReleasePage') ?? '', /invoke\('dsh-chamber:open-release',\s*\{\s*url\s*\}\)/)
  assert.match(shimMembers.get('openReleasePage') ?? '', /invoke\('dsh-chamber:open-release',\s*\{\s*url:\s*url\s*\}\)/)
})

test('⑤ 无 poc-unimplemented 兜底残留（代码形态）', () => {
  // 头部注记文本允许提及 poc-unimplemented 字样（描述 sidecar 桩），但
  // 兜底代码形态（pocUnimplemented 标识符 / rejectMethods 填充器）必须为零。
  assert.equal(shimSource.includes('pocUnimplemented'), false, 'shim 不得含 pocUnimplemented 兜底')
  assert.equal(shimSource.includes('rejectMethods'), false, 'shim 不得含 rejectMethods 填充器')
})
