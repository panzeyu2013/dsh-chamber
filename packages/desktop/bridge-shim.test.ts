/**
 * bridge-shim.test.ts —— W-18 后半 A：E8 shim 存根与 manifest 映射一致性
 *
 * design 25 §4.4.3 E8；companion W-18。断言链：
 *  ① CLI 重生成（json+swift+stub 三产物到临时目录）== 提交物（stub 逐字节）；
 *  ② stub 内 invoke/push 通道数组 == bridge-manifest.json（同序）；
 *  ③ counts 一致；
 *  ④ 以 node:vm 执行提交物 stub：window.__DSH_CHAMBER_MANIFEST__ 形状 +
 *     __dshChamberAssertMethod/__dshChamberAssertEvent 正/负例。
 * 生成器与提交物同源（ipc-events.ts IPC_CHANNELS + main 侧注册事实）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const dir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(dir, '..', '..')
const nodeBin = process.env.NODE_BIN ?? '/Applications/dsh-chamber.app/Contents/MacOS/dsh-chamber'
const generator = path.join(dir, 'scripts', 'emit-bridge-manifest.mjs')
const committedJson = readFileSync(path.join(dir, 'bridge-manifest.json'), 'utf8')
const committedStub = readFileSync(
  path.join(repoRoot, 'macos', 'Sources', 'DSHChamberPoc', 'Resources', 'chamber-bridge.stub.js'),
  'utf8',
)

function regenerateToTemp(): { json: string; stub: string } {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-shim-test-'))
  const jsonOut = path.join(tmp, 'manifest.json')
  const swiftOut = path.join(tmp, 'BridgeManifest.swift')
  const stubOut = path.join(tmp, 'chamber-bridge.stub.js')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  execFileSync(nodeBin, [generator, jsonOut, swiftOut, stubOut], { env, stdio: 'pipe' })
  return { json: readFileSync(jsonOut, 'utf8'), stub: readFileSync(stubOut, 'utf8') }
}

function extractArray(text: string, key: string): string[] {
  const m = text.match(new RegExp(`^\\s{4}${key}: \\[([\\s\\S]*?)\\n    \\],`, 'm'))
  assert.ok(m !== null, `stub 内应能找到 ${key} 数组`)
  const items = [...m[1].matchAll(/^\s{8}"([^"]+)",$/gm)].map((x) => x[1])
  assert.equal(items.length > 0, true, `${key} 数组不应为空`)
  return items
}

test('① 重生成 stub == 提交物（逐字节）', () => {
  const { stub } = regenerateToTemp()
  assert.equal(stub, committedStub)
})

test('② stub invoke/push 数组 == bridge-manifest.json（同序）', () => {
  const parsed = JSON.parse(committedJson) as {
    invoke: { channel: string }[]
    push: { channel: string }[]
  }
  const stubInvoke = extractArray(committedStub, 'invoke')
  const stubPush = extractArray(committedStub, 'push')
  assert.deepEqual(
    stubInvoke,
    parsed.invoke.map((e) => e.channel),
  )
  assert.deepEqual(
    stubPush,
    parsed.push.map((e) => e.channel),
  )
})

test('③ counts 与 manifest 一致', () => {
  const parsed = JSON.parse(committedJson) as { counts: { invoke: number; push: number; total: number } }
  const m = committedStub.match(/counts:\s*\{\s*invoke:\s*(\d+),\s*push:\s*(\d+),\s*total:\s*(\d+)\s*\}/)
  assert.ok(m !== null, 'stub 应含 counts')
  assert.equal(Number(m[1]), parsed.counts.invoke)
  assert.equal(Number(m[2]), parsed.counts.push)
  assert.equal(Number(m[3]), parsed.counts.total)
})

test('④ vm 执行 stub：manifest 形状 + assert 正/负例', () => {
  const context: Record<string, unknown> = {}
  vm.createContext(context)
  vm.runInContext(committedStub, context)
  const manifest = context.__DSH_CHAMBER_MANIFEST__ as {
    invoke: string[]
    push: string[]
    counts: { invoke: number; push: number; total: number }
  }
  assert.ok(Array.isArray(manifest.invoke) && manifest.invoke.length === 60)
  assert.ok(Array.isArray(manifest.push) && manifest.push.length === 8)
  assert.equal(manifest.counts.total, 68)
  // 正例
  vm.runInContext('__dshChamberAssertMethod("dsh-chamber:info")', context)
  vm.runInContext('__dshChamberAssertEvent("dsh-chamber:settings-changed")', context)
  // 负例（表外/非字符串/事件当方法）
  assert.throws(() => vm.runInContext('__dshChamberAssertMethod("zzz.unknown")', context))
  assert.throws(() => vm.runInContext('__dshChamberAssertMethod("dsh-chamber:settings-changed")', context))
  assert.throws(() => vm.runInContext('__dshChamberAssertMethod(42)', context))
  assert.throws(() => vm.runInContext('__dshChamberAssertEvent("dsh-chamber:info")', context))
})

test('⑤ 提交物可写性：descriptor 不可配置/不可写', () => {
  const context: Record<string, unknown> = {}
  vm.createContext(context)
  vm.runInContext(committedStub, context)
  const desc = Object.getOwnPropertyDescriptor(context, '__DSH_CHAMBER_MANIFEST__')
  assert.ok(desc !== undefined)
  assert.equal(desc.configurable, false)
  assert.equal(desc.writable, false)
})

test('⑥ 生成器稳定性：两次重生成字节一致', () => {
  const a = regenerateToTemp()
  const b = regenerateToTemp()
  assert.equal(a.stub, b.stub)
  assert.equal(a.json, b.json)
})
