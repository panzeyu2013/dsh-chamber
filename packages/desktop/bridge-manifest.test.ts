/**
 * bridge-manifest.test.ts — W-17 通道 manifest 生成管线测试（design 25
 * §4.4.3；docs/progress/todo/macos-swift-v1.md W-17 行；§0.1-E8/B12 companion）。
 *
 * 被测管线：scripts/emit-bridge-manifest.mjs（输入 ipc-events.ts 的
 * IPC_CHANNELS 常量表 + main 侧三文件 handle/send 注册事实 → 产出
 * bridge-manifest.json 与 BridgeManifest.swift）。
 *
 * 形态取舍（为何 spawn 而非 import）：生成器核心已做成可 import 的纯函数
 * （computeManifest/renderJsonManifest/renderSwiftManifest），但本测试文件
 * 属根 typecheck 程序（tsconfig include packages/desktop/*.ts，strict +
 * moduleResolution nodenext）：无声明文件的 .mjs import 会报 TS7016，而
 * W-17 的四文件预算内不能再放一个 .d.mts —— 因此本测试 spawn 直跑生成器
 * CLI 到临时目录（位置参数覆盖输出路径），再与提交物逐字节比对。这同时
 * 覆盖了 CLI 的 argv/退出码路径；语义与 import 形态等价（CLI 与导入路径
 * 共用同一 computeManifest 纯函数）。spawn 亦是 desktop 测试既有惯例
 * （sidecar-stdio.test.ts 同族）。
 *
 * 断言面（W-17 退出标准：生成物 == 提交物绿 + 通道数守恒）：
 *   ① 重生成 JSON == 提交物 packages/desktop/bridge-manifest.json（文本级）；
 *   ② 重生成 Swift == 提交物 macos/Sources/DSHChamberPoc/Generated/BridgeManifest.swift；
 *   ③ 通道数守恒：counts {invoke:60, push:8, total:68} 与两列表长度自洽；
 *   ④ 无死键：manifest 键集 == ipc-events.ts IPC_CHANNELS 表键集（68 全覆盖、
 *      键/通道无重复、invoke/push 无交集 —— 生成器内部同样校验并 loud
 *      失败，此处以测试侧复刻解析把该事实变成可见断言）；
 *   ⑤ 方向抽查：dsh-chamber:info / desktop_ssh_instances_get 属 invoke，
 *      dsh-chamber:settings-changed 等 8 个 push 通道为精确集（与 main 侧
 *      rendererPush 注册事实一一对应）；
 *   ⑥ 提交物双件语义一致：Swift 三 Set 的字面量集合与 JSON 通道集逐条对应
 *      （防两提交物手工改坏其一 —— 文本级相等之外的交叉检查）。
 *
 * E8 chamber-bridge.js shim 存根产出不在本批（W-18 范围）——本文件只守
 * manifest 两提交物；W-18 桥面一致性测试可在此扩展。
 *
 * 通道增删纪律：改动 IPC_CHANNELS/注册文件必须同 PR 提交新 manifest 两件，
 * 并把本文件 ③④⑤ 中钉死的数字/清单随事实同步（与 ipc-surface-mirror.test.ts
 * 的 golden 断言同款「同步是故意为之」纪律）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const DESKTOP = import.meta.dirname
const REPO_ROOT = join(DESKTOP, '..', '..')
const GENERATOR = join(DESKTOP, 'scripts', 'emit-bridge-manifest.mjs')
const COMMITTED_JSON_PATH = join(DESKTOP, 'bridge-manifest.json')
const COMMITTED_SWIFT_PATH = join(REPO_ROOT, 'macos', 'Sources', 'DSHChamberPoc', 'Generated', 'BridgeManifest.swift')

/** manifest JSON 的结构形状（与生成器产出 schema 一致）。 */
interface ManifestEntry {
  channel: string
  key: string
}
interface BridgeManifest {
  invoke: ManifestEntry[]
  push: ManifestEntry[]
  counts: { invoke: number; push: number; total: number }
}
interface Regenerated {
  jsonText: string
  swiftText: string
  manifest: BridgeManifest
}

/** spawn 生成器 CLI 到临时目录（绝不写仓库内提交物路径——若生成器带病，
 *  测试要先红而不是悄悄覆盖提交物）。两路径参数 = 生成器的位置参数。 */
function regenerate(): Regenerated {
  const outDir = mkdtempSync(join(tmpdir(), 'bridge-manifest-'))
  try {
    const jsonPath = join(outDir, 'bridge-manifest.json')
    const swiftPath = join(outDir, 'BridgeManifest.swift')
    const run = spawnSync(process.execPath, [GENERATOR, jsonPath, swiftPath], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(run.status, 0, `生成器非 0 退出（stderr：${run.stderr?.trim() ?? ''}）`)
    const jsonText = readFileSync(jsonPath, 'utf8')
    const swiftText = readFileSync(swiftPath, 'utf8')
    return { jsonText, swiftText, manifest: JSON.parse(jsonText) as BridgeManifest }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

/** 单例生成（node:test 同文件内测试串行执行；全部断言共享一次重生成结果）。 */
let cached: Regenerated | undefined
function regenerated(): Regenerated {
  if (cached === undefined) cached = regenerate()
  return cached
}

/** ipc-events.ts IPC_CHANNELS 全键/通道表——测试侧保守正则复刻（整行
 *  `KEY: 'channel'` 形状，注释行以 / 或 * 开头天然跳过；与生成器
 *  parseIpcChannels 同纪律：形状变化时生成器先 loud 红，此处复验把
 *  「无死键」变成测试内可见断言）。 */
function ipcChannelTable(): ManifestEntry[] {
  const source = readFileSync(join(DESKTOP, 'ipc-events.ts'), 'utf8')
  const entries: ManifestEntry[] = []
  const linePattern = /^\s*([A-Z][A-Z0-9_]*):\s*'([^']+)',?$/gm
  let hit: RegExpExecArray | null
  while ((hit = linePattern.exec(source)) !== null) {
    entries.push({ key: hit[1], channel: hit[2] })
  }
  return entries
}

test('① 重生成 JSON 与提交物 bridge-manifest.json 逐字节一致', () => {
  assert.equal(
    regenerated().jsonText,
    readFileSync(COMMITTED_JSON_PATH, 'utf8'),
    '重新生成的 JSON 必须 == 提交物（通道增删改必须同 PR 提交新 manifest）',
  )
})

test('② 重生成 Swift 与提交物 BridgeManifest.swift 逐字节一致', () => {
  assert.equal(
    regenerated().swiftText,
    readFileSync(COMMITTED_SWIFT_PATH, 'utf8'),
    '重新生成的 Swift 必须 == 提交生成物',
  )
})

test('③ 通道数守恒：counts {invoke:60, push:8, total:68} 与两列表长度自洽', () => {
  const { manifest } = regenerated()
  // 当前仓库事实（68 = 60 + 8，与 ipc-surface-mirror.test.ts 的 B8 集合断言
  // 同一批事实）；通道增删时须与两提交物同步更新。
  assert.deepEqual(manifest.counts, { invoke: 60, push: 8, total: 68 })
  assert.equal(manifest.invoke.length, manifest.counts.invoke)
  assert.equal(manifest.push.length, manifest.counts.push)
  assert.equal(manifest.invoke.length + manifest.push.length, manifest.counts.total)
})

test('④ 无死键：manifest 键/通道集 == ipc-events.ts IPC_CHANNELS 表（68 全覆盖、无重复、无交集）', () => {
  const table = ipcChannelTable()
  assert.equal(table.length, 68, 'IPC_CHANNELS 应恰为 68 键（当前事实）')
  const { manifest } = regenerated()
  const covered = [...manifest.invoke, ...manifest.push]
  assert.equal(covered.length, table.length, '两向条目总数必须 == 常量表键数（无死键/无幻影键）')

  const coveredKeys = new Set<string>()
  const coveredChannels = new Set<string>()
  for (const entry of covered) {
    assert.ok(!coveredKeys.has(entry.key), `manifest 键重复：${entry.key}`)
    assert.ok(!coveredChannels.has(entry.channel), `manifest 通道名重复：${entry.channel}`)
    coveredKeys.add(entry.key)
    coveredChannels.add(entry.channel)
  }
  for (const { key, channel } of table) {
    assert.ok(coveredKeys.has(key), `IPC_CHANNELS 键 ${key}（${channel}）未进 manifest —— 死键`)
    assert.ok(coveredChannels.has(channel), `IPC_CHANNELS 通道 ${channel} 未进 manifest —— 死通道`)
  }
  // invoke/push 两向通道无交集（同一通道不会既是 invoke 又是 push）。
  const pushChannels = new Set(manifest.push.map(entry => entry.channel))
  for (const { channel } of manifest.invoke) {
    assert.ok(!pushChannels.has(channel), `通道 ${channel} 同时出现在 invoke 与 push`)
  }
})

test('⑤ 方向抽查：invoke/push 归属与 main 侧注册事实一致（含 8 push 精确集）', () => {
  const { manifest } = regenerated()
  const directionOf = (channel: string): 'invoke' | 'push' | 'unknown' => {
    if (manifest.invoke.some(entry => entry.channel === channel)) return 'invoke'
    if (manifest.push.some(entry => entry.channel === channel)) return 'push'
    return 'unknown'
  }
  // 抽查样本：invoke 面（handle 注册事实）……
  assert.equal(directionOf('dsh-chamber:info'), 'invoke')
  assert.equal(directionOf('desktop_ssh_instances_get'), 'invoke')
  assert.equal(directionOf('dsh-chamber:runtime-restart'), 'invoke')
  // ……与键↔通道配对。
  const info = manifest.invoke.find(entry => entry.channel === 'dsh-chamber:info')
  assert.equal(info?.key, 'INFO')
  // push 面精确集：与 main 侧 8 处 rendererPush 注册点一一对应
  // （shell-core.ts: SYSTEM_RESUME / NOTIFICATION_OPEN / DEEP_LINK_INTENT /
  // SETTINGS_CHANGED / UPDATE_STATE_CHANGED；main.ts: SSH_STATUS_CHANGED /
  // SSH_INSTANCES_CHANGED / RUNTIME_STATE_CHANGED）。
  const goldenPushChannels = [
    'dsh-chamber:settings-changed',
    'dsh-chamber:notification-open',
    'dsh-chamber:update-state-changed',
    'dsh-chamber:deep-link-intent',
    'dsh-chamber:system-resume',
    'desktop_ssh_status_changed',
    'desktop_ssh_instances_changed',
    'dsh-chamber:runtime-state-changed',
  ].sort()
  assert.deepEqual(
    manifest.push.map(entry => entry.channel).sort(),
    goldenPushChannels,
    'push 通道集必须 == main 侧 8 个推送注册点的精确集',
  )
  for (const channel of goldenPushChannels) {
    assert.equal(directionOf(channel), 'push')
  }
})

test('⑥ 提交物双件语义一致：Swift 字面量集合与 JSON 通道集逐条对应', () => {
  // ① ② 已保证「重生成 == 提交物」，两者同源出自一次生成；本测试在文本
  // 相等之外做交叉检查——即便双件被手工改坏成「互相一致但偏离生成器」，
  // ① ② 仍会红，此处再钉死 Swift 三个 Set 与 JSON 集合的字面量对应。
  const { swiftText, manifest } = regenerated()
  assert.match(swiftText, /static let invokeChannels: Set<String> = \[/)
  assert.match(swiftText, /static let pushChannels: Set<String> = \[/)
  assert.match(swiftText, /static let allChannels: Set<String> = invokeChannels\.union\(pushChannels\)/)
  assert.ok(!swiftText.includes('static let allChannels: Set<String> = ['), 'allChannels 应为推导而非第三次字面量')
  for (const { channel } of manifest.invoke) {
    assert.ok(swiftText.includes(`"${channel}"`), `Swift invokeChannels 缺通道字面量：${channel}`)
  }
  for (const { channel } of manifest.push) {
    assert.ok(swiftText.includes(`"${channel}"`), `Swift pushChannels 缺通道字面量：${channel}`)
  }
})
