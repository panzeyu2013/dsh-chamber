/**
 * bridge-shim-surface.test.ts —— S-B 静态面比对：bridge-shim.poc.js（macOS
 * Swift POC A-bridge shim）与 preload.cts 暴露面逐字一致 + 通道引用 ∈
 * bridge-manifest.json invoke/push 集。
 *
 * 断言链（全部静态文本解析，不执行 shim）：
 *  ① 9 命名空间各自的方法名集合：preload（*Api 工厂返回对象）== shim
 *     （var <ns> = {…} 块）——无缺无多（含 on* 订阅方法；update/runtime 的
 *     onStateChanged 等 preload 面外别名不得出现）；
 *  ② 方法→通道逐条映射：同 (命名空间, 方法) 下 preload 的
 *     ipcRenderer.invoke('…') / ipcRenderer.on('…') 字面量与 shim 的
 *     invoke('…') / subscribe(PUSH_EVENTS.KEY) 解析通道相等（含 openIn.apps
 *     的解包方法、ready/ack 的 {deliveryId,attempt} 类形状方法——本测试锁
 *     通道名，payload 键由实现注释与 Swift 集成测试覆盖）；
 *  ③ 顶层面：preload exposeInMainWorld('dshChamber', {…}) 的 13 个键
 *     （4 标量 + 9 命名空间）== shim dshChamberApi 键；
 *  ④ invoke 通道集：preload 全部 invoke 字面量 == shim 全部 invoke 字面量
 *     == manifest invoke 集（60）；push 通道集：preload 全部
 *     ipcRenderer.on 字面量 == shim PUSH_EVENTS 值 == manifest push 集（8）；
 *  ⑤ 无 poc-unimplemented 兜底残留：shim 不含 pocUnimplemented/rejectMethods
 *     代码形态（头部注记文本仅描述 sidecar 桩，不属于兜底代码）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(dir, '..', '..')
const preloadSource = readFileSync(path.join(dir, 'preload.cts'), 'utf8')
const shimSource = readFileSync(
  path.join(repoRoot, 'macos', 'Sources', 'DSHChamberPoc', 'Resources', 'bridge-shim.poc.js'),
  'utf8',
)
const manifest = JSON.parse(
  readFileSync(path.join(dir, 'bridge-manifest.json'), 'utf8'),
) as { invoke: { channel: string }[]; push: { channel: string }[]; counts: { invoke: number; push: number } }
const manifestInvoke = new Set(manifest.invoke.map((e) => e.channel))
const manifestPush = new Set(manifest.push.map((e) => e.channel))

/** preload *Api 工厂名 → 命名空间名（保守显式清单）。 */
const API_FACTORY_TO_NAMESPACE: Record<string, string> = {
  desktopSshApi: 'desktopSsh',
  updateApi: 'update',
  settingsApi: 'settings',
  systemResumeApi: 'systemResume',
  openInApi: 'openIn',
  deepLinkApi: 'deepLink',
  runtimeApi: 'runtime',
  notificationsApi: 'notifications',
  badgeApi: 'badge',
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
  assert.ok(m !== null, `bridge-shim.poc.js 应含 var ${namespace} = { … } 块`)
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
  assert.ok(m !== null, 'bridge-shim.poc.js 应含 PUSH_EVENTS 表')
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
  assert.ok(m !== null, 'bridge-shim.poc.js 应含 dshChamberApi 对象')
  const keys = new Set<string>()
  for (const line of m[1].split('\n')) {
    const row = line.match(/^ {4}([a-zA-Z_$][a-zA-Z0-9_$]*):/)
    if (row !== null) keys.add(row[1])
  }
  return keys
}

const EXPECTED_SCALARS = ['controlPlaneUrl', 'dshVersion', 'version', 'platform']

test('① 命名空间方法名集合：preload == shim（无缺无多）', () => {
  for (const namespace of NAMESPACES) {
    const factory = Object.keys(API_FACTORY_TO_NAMESPACE).find((k) => API_FACTORY_TO_NAMESPACE[k] === namespace)
    assert.ok(factory !== undefined, `命名空间 ${namespace} 应有工厂名`)
    const preloadNames = extractMemberNames(preloadApiBlock(factory))
    const shimNames = extractMemberNames(shimNamespaceBlock(namespace))
    const missing = preloadNames.filter((n) => !shimNames.includes(n))
    const extra = shimNames.filter((n) => !preloadNames.includes(n))
    assert.deepEqual(
      { namespace, extra },
      { namespace, extra: [] },
      `shim ${namespace} 暴露了 preload 面外的方法（W-04 时代别名如 onStateChanged 不允许残留）`,
    )
    assert.deepEqual(
      { namespace, missing },
      { namespace, missing: [] },
      `shim ${namespace} 缺少 preload 的方法`,
    )
    assert.deepEqual([...shimNames].sort(), [...preloadNames].sort())
  }
})

test('② 方法→通道映射逐条相等（preload 字面量 == shim 解析通道）', () => {
  const pushEvents = shimPushEvents()
  for (const namespace of NAMESPACES) {
    const factory = Object.keys(API_FACTORY_TO_NAMESPACE).find((k) => API_FACTORY_TO_NAMESPACE[k] === namespace)
    assert.ok(factory !== undefined)
    const preloadSpans = memberSpans(preloadApiBlock(factory))
    const shimSpans = memberSpans(shimNamespaceBlock(namespace))
    const preloadNames = [...preloadSpans.keys()]
    const shimNames = [...shimSpans.keys()]
    assert.deepEqual([...shimNames].sort(), [...preloadNames].sort())
    for (const name of preloadNames) {
      const preloadChannel = preloadMemberChannel(preloadSpans.get(name) ?? '')
      const shimChannel = shimMemberChannel(shimSpans.get(name) ?? '', pushEvents)
      assert.ok(preloadChannel !== '', `${namespace}.${name}（preload）应解析出通道`)
      assert.ok(shimChannel !== '', `${namespace}.${name}（shim）应解析出通道`)
      assert.equal(shimChannel, preloadChannel, `${namespace}.${name} 通道映射不一致`)
    }
  }
})

test('③ 顶层面：preload expose 键 == shim dshChamberApi 键（4 标量 + 9 命名空间）', () => {
  const expected = new Set([...EXPECTED_SCALARS, ...NAMESPACES])
  const exposeKeys = extractExposeKeys(preloadSource)
  assert.deepEqual(exposeKeys, expected, 'preload exposeInMainWorld 键应为 4 标量 + 9 命名空间')
  const shimKeys = extractShimTopKeys()
  assert.deepEqual(shimKeys, expected, 'shim dshChamberApi 键应为 4 标量 + 9 命名空间')
})

test('④ invoke/push 通道集：preload == shim == manifest（60 invoke / 8 push）', () => {
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
  preloadInvoke.add('dsh-chamber:info') // info 是 shim/preload 内部 hydration 通道（无暴露方法）
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
  shimInvoke.add('dsh-chamber:info')
  // 集相等：shim 未遗漏/未发明任何 preload 用过的通道。
  assert.deepEqual(shimInvoke, preloadInvoke, 'shim invoke 通道集应与 preload 一致')
  assert.equal(shimInvoke.size, manifest.counts.invoke, `invoke 通道应覆盖 manifest 的 ${manifest.counts.invoke} 条`)
  for (const channel of shimInvoke) {
    assert.ok(manifestInvoke.has(channel), `invoke 通道 ${channel} 应 ∈ manifest invoke 集`)
  }
  assert.equal(manifestInvoke.size, manifest.counts.invoke)
  // push 面：preload on 字面量 == shim PUSH_EVENTS 值 == shim on* 实订阅 ==
  // manifest push 集（无死订阅常量）。
  const shimPush = new Set(Object.values(pushEvents))
  assert.deepEqual(shimPush, preloadPush, 'shim PUSH_EVENTS 应与 preload 订阅字面量一致')
  assert.deepEqual(shimUsedPush, shimPush, 'shim 每个 PUSH_EVENTS 常量都应被某 on* 方法订阅')
  assert.equal(shimPush.size, manifest.counts.push, `push 通道应覆盖 manifest 的 ${manifest.counts.push} 条`)
  for (const channel of shimPush) {
    assert.ok(manifestPush.has(channel), `push 通道 ${channel} 应 ∈ manifest push 集`)
  }
})

test('⑤ 无 poc-unimplemented 兜底残留（代码形态）', () => {
  // 头部注记文本允许提及 poc-unimplemented 字样（描述 sidecar 桩），但
  // 兜底代码形态（pocUnimplemented 标识符 / rejectMethods 填充器）必须为零。
  assert.equal(shimSource.includes('pocUnimplemented'), false, 'shim 不得含 pocUnimplemented 兜底')
  assert.equal(shimSource.includes('rejectMethods'), false, 'shim 不得含 rejectMethods 填充器')
})
