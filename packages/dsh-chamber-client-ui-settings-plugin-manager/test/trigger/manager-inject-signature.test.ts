/**
 * vendor rc.2 三参 `PluginManagerController.inject` 的源锁（design 05 §5；dsh-upgrade-checklist §3/§7 第 6 步）。
 *
 * 本包没有自己的 tsconfig，根程序与 run-checks 的 13 个 typecheck 步都不含它——三参调用此前
 * 只有运行时测试 + 人读 vendor 两重保障。参数写反在类型剥离的运行期与「多余实参」下不会报错，
 * 也没有门禁会红。这条锁按仓内既有的 vendor 源锁口径（test/dom-seam 同款）读 pin 住的源码：
 *  - vendor `inject` 的参数序列必须是 (configLedger, pluginTabs, resolveText)；
 *  - 第二参在本包调用点必须仍是 `tabLedgerSource(ctx)`，且该函数仍由 vendor `tab-ledger.ts` 导出；
 *  - `hooks.pluginManager` 仍由该 face 提供（刷新收敛块消费它）。
 * 改签名 / 换顺序 / 改导出即红；上游挪文件不该让锁变红（按符号定位，不按路径）。
 *
 * 缺 vendor 树的口径与仓内其它 vendor 锁一致：默认**响亮失败**；`DSH_CHAMBER_VENDOR_ABSENT=skip`
 * 只是本地调试出口（CI 不设该变量）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const VENDOR_CLIENT_DIR = fileURLToPath(new URL('../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-plugin-manager/src/client/', import.meta.url))
const OUR_INDEX = fileURLToPath(new URL('../../src/client/index.ts', import.meta.url))
const MISSING = !existsSync(VENDOR_CLIENT_DIR)
const OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

if (MISSING) {
  console.error(`[vendor-lockstep] vendor 树未物化：${VENDOR_CLIENT_DIR}`)
  console.error(OPT_OUT
    ? '[vendor-lockstep] DSH_CHAMBER_VENDOR_ABSENT=skip 已显式设置 ⇒ 本文件跳过（CI 不设该变量）。'
    : '[vendor-lockstep] 默认失败：本 lockstep 必须读 pin 住的 vendor 源。')
}

const vendorTest = (name: string, body: () => void): void => {
  test(name, { skip: MISSING && OPT_OUT ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false }, () => {
    if (MISSING) {
      assert.fail('vendor/harness-packages 未物化：本 lockstep 读 pin 住的 vendor 源，缺树即失败'
        + '（显式 DSH_CHAMBER_VENDOR_ABSENT=skip 才跳过）。')
    }
    body()
  })
}

/** 按符号定位 vendor 源（恰一个命中）：路径不是契约，符号才是。 */
const vendorSourceWith = (symbol: string): string => {
  const hits = readdirSync(VENDOR_CLIENT_DIR)
    .filter((name) => /\.tsx?$/u.test(name))
    .map((name) => VENDOR_CLIENT_DIR + name)
    .filter((path) => readFileSync(path, 'utf8').includes(symbol))
  hits.sort()
  assert.equal(hits.length, 1,
    `vendor 插件管理页里应恰有一个源文件含 ${symbol}（找到 ${hits.length}: ${hits.join(', ')}）——`
    + '上游若拆分/改名，维护者须重新指向本锁并按 dsh-upgrade-checklist §7 第 6 步复核。')
  return normalize(stripComments(readFileSync(hits[0]!, 'utf8')))
}

/** 取 `start` 起、到其后第一个 `end`（含）的一段。 */
const sliceThrough = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start)
  assert.ok(from >= 0, `vendor 源里找不到 ${start}`)
  const to = text.indexOf(end, from + start.length)
  assert.ok(to > from, `vendor 源里 ${start} 之后找不到 ${end}`)
  return text.slice(from, to + end.length)
}

vendorTest('vendor inject 恰是 (configLedger, pluginTabs, resolveText) 三参序', () => {
  const manager = vendorSourceWith('class PluginManagerController')
  const signature = sliceThrough(manager, 'inject( configLedger:', '): PluginManagerFace')
  assert.match(
    signature,
    /^inject\( configLedger: HostObservable<ConfigLedger>, pluginTabs: HostObservable<readonly PluginTab\[\]>, resolveText: PluginManagerFace\['resolveText'\], \): PluginManagerFace$/u,
    'vendor inject 的参数序列变了（第三参/顺序/类型）——同步本包调用点，再按升级清单重锚本锁',
  )
  assert.match(manager, /hooks: \{ pluginManager: this\.store, configLedger, pluginTabs,/u,
    'face.hooks.pluginManager 是本包刷新收敛块的消费面；vendor 改掉它必须同批改这里')
})

vendorTest('本包调用点按序传入 configLedger、tabLedgerSource(ctx)、resolveText', () => {
  const ourIndex = normalize(stripComments(readFileSync(OUR_INDEX, 'utf8')))
  assert.match(ourIndex, /controller\.inject\(configLedger, tabLedgerSource\(ctx\), resolveText\)/u,
    '调用点必须逐字保持三参序（参数对调不会有类型错误可见面，本锁就是那面）')
  assert.match(ourIndex, /import \{ tabLedgerSource \} from '@deepseek-ai\/dsh-client-ui-plugin-manager\/src\/client\/tab-ledger\.ts'/u,
    'tabLedgerSource 必须仍从 vendor tab-ledger.ts 命名导入')
})

vendorTest('vendor tab-ledger.ts 仍导出 tabLedgerSource(ctx)', () => {
  const tabLedger = vendorSourceWith('export function tabLedgerSource')
  assert.match(tabLedger, /export function tabLedgerSource\(ctx: ClientContext\): HostObservable<readonly PluginTab\[\]>/u,
    'tab-ledger 的导出形状变了——同步本包调用点与 design 09 §3.7 的座席说明')
})
