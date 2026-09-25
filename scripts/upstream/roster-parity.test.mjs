/**
 * roster 对账门（升级计划 §22.4.3）：我们的「covered」列表（composite 直接注册的
 * 官方客户端行）必须与 pin 的 bundle roster（vendor/harness-checkout/packages/bundle/
 * <pkg>/cordis.patch.yml 的 `name:` 集）对得上。pin 删/改名一行而我们仍声称覆盖 → 红；
 * 例外表（不是 roster 行、却有 composite 覆盖理由的 id）若被 pin 收进 roster → 也红
 * （例外登记过期）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const BUNDLE_DIR = join(ROOT, 'vendor/harness-checkout/packages/bundle')
const COVERED_FILE = join(ROOT, 'packages/renderer/src/chamber-covered.ts')

/**
 * 例外：**不是** bundle roster 行、但我们必须覆盖（否则组合体重复注册/边缺失）的 id。
 * 理由逐条对应 chamber-covered.ts 的注释（该文件是事实来源）。
 */
const NOT_A_ROSTER_ROW = new Map([
  ['@deepseek-ai/dsh-client-store', 'provider group 的平台 store word（PLATFORM_MODULES 种子），由组合体覆盖，不是 loader 行'],
  ['@deepseek-ai/dsh-client-ui-primitives', 'C3：不是 loader 行；进 covered 只为组合体应答 extra bundle 的 platform-word require 边'],
  ['@deepseek-ai/dsh-client-ui-dockkit', 'PLATFORM_MODULES word，组合体的 covered factory 应答；无 dsh.client，永不是宿主图行'],
  ['@deepseek-ai/dsh-client-ui-directory-picker-browse', 'composite pin 住 browse 交互（宿主同 pin），picker-auto 挂载行被覆盖，但 roster 不含它'],
  ['@deepseek-ai/dsh-client-ui-directory-picker-native', '宿主 pin browse ⇒ native face 永不取胜，不是 roster 行'],
])

/** pin 的 bundle roster：所有 bundle 包 cordis.patch.yml 里的 `name:` 集。 */
function pinBundleRosterNames() {
  const names = new Set()
  for (const dir of readdirSync(BUNDLE_DIR)) {
    const file = join(BUNDLE_DIR, dir, 'cordis.patch.yml')
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/name: '?([^'\n]+)'?/gu)) names.add(match[1].trim())
  }
  return names
}

/** chamber-covered.ts 里的 covered id 集（按源码字面量读，避免把模块图拖进测试）。 */
function coveredIds() {
  const text = readFileSync(COVERED_FILE, 'utf8')
  return [...new Set([...text.matchAll(/'(@[^']+)'/gu)].map((match) => match[1]))]
}

test('roster 对账：非 chamber 的 covered id 必须落在 pin 的 bundle roster 里（例外须有登记）', () => {
  const names = pinBundleRosterNames()
  assert.ok(names.size >= 150, 'roster 抽取面异常变小（抽取规则坏了？）：' + names.size)
  const covered = coveredIds()
  assert.ok(covered.length >= 40, 'covered 抽取面异常变小：' + covered.length)
  const external = covered.filter((id) => !id.startsWith('@dsh-chamber/'))
  const unaccounted = external.filter((id) => !names.has(id) && !NOT_A_ROSTER_ROW.has(id))
  assert.deepEqual(unaccounted, [],
    'pin roster 不再包含这些 covered id（行被删/改名？）——必须按升级 checklist 重新判：' + unaccounted.join(', '))
})

test('roster 对账：例外登记不得腐烂（收进 roster 或撤出 covered 都必须删登记）', () => {
  const names = pinBundleRosterNames()
  const external = coveredIds().filter((id) => !id.startsWith('@dsh-chamber/'))
  for (const [id, reason] of NOT_A_ROSTER_ROW) {
    assert.ok(external.includes(id), id + ' 已不在 covered 列表——删掉例外登记')
    assert.ok(!names.has(id), id + ' 已被 pin roster 收录——删掉例外登记')
    assert.ok(reason.length >= 8, id + ' 的例外理由太短')
  }
})
