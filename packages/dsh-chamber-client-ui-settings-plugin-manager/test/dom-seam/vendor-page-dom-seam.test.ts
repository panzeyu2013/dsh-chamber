/**
 * 插件管理页容纳层的上游 DOM 缝锁（design 05 §5；checklist §3 末条 / §7 第 6 步）。
 *
 * 管理页现在是设置面的独立 `settings.section`，页面自己的页头/intro/工具栏就是分节内容；
 * 容纳层不再消费 h1 的位置、`data-plugin-group` 的组形或 `data-window-drag` 的两子序列。
 * 它只消费三个上游自有事实：
 *   - 页根 `data-plugin-panel`（root 去主面板 padding/height/scroll）；
 *   - 页头/More/详情三处 `data-window-drag`（清零 28px inset）；
 *   - 页根的直接子槽锚点 `[data-slot]`（activation 占位者取得页面列宽）。
 * 另加注册子座席表锁：页面不加载上游 apply()，renderSlot 的每个键都必须在本包 children 表里。
 *
 * 缺 vendor 树的口径与仓内其它 vendor 锁一致：默认**响亮失败**；
 * `DSH_CHAMBER_VENDOR_ABSENT=skip` 只是本地调试出口——本文件每个用例（含不读 vendor 的计数器
 * 负控）都挂 vendorTest，全跳过会被本包 test 的零测试守卫判红，换不来「本地绿」；CI 不设该变量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

/** pin 住的 vendor 链接树（`scripts/dev/ensure-harness-vendor.mjs` 建链）。 */
const VENDOR_PAGE_DIR = fileURLToPath(new URL('../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-plugin-manager/src/client/', import.meta.url))
const MISSING = !existsSync(VENDOR_PAGE_DIR)
const OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

if (MISSING) {
  console.error(`[vendor-lockstep] vendor 树未物化：${VENDOR_PAGE_DIR}`)
  console.error(OPT_OUT
    ? '[vendor-lockstep] DSH_CHAMBER_VENDOR_ABSENT=skip 已显式设置 ⇒ 本文件跳过（CI 不设该变量）。'
    : '[vendor-lockstep] 默认失败：本 lockstep 必须读 pin 住的 vendor 源。'
      + '若确为无 submodule 的本地 worktree，显式设 DSH_CHAMBER_VENDOR_ABSENT=skip。')
}

/** 缺树时：默认按断言失败处理（响亮），只有显式 opt-out 才 skip。 */
const vendorTest = (name: string, body: () => void): void => {
  test(name, { skip: MISSING && OPT_OUT ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false }, () => {
    if (MISSING) {
      assert.fail('vendor/harness-packages 未物化：本 lockstep 读 pin 住的 vendor 源，缺树即失败'
        + '（显式 DSH_CHAMBER_VENDOR_ABSENT=skip 才跳过）。')
    }
    body()
  })
}

/**
 * 按**符号**定位页面文件（与 `vendor-session-fact-contract.test.ts` 同口径）：路径不是契约，
 * 符号才是——上游挪文件不该让锁变红，拆文件/改名才该，且必须恰有一个命中，免得悄悄测到别的文件。
 * 注释先剥掉（`source-text.ts` 的既有口径）：一段描述形状的注释不得把锁喂饱。
 */
let pageSourceCache: string | undefined
const pageSource = (): string => {
  if (pageSourceCache !== undefined) return pageSourceCache
  const hits: string[] = []
  for (const entry of readdirSync(VENDOR_PAGE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/u.test(entry.name)) continue
    const path = VENDOR_PAGE_DIR + entry.name
    if (readFileSync(path, 'utf8').includes('data-plugin-panel')) hits.push(path)
  }
  hits.sort()
  assert.equal(hits.length, 1,
    `vendor 插件管理页里应恰有一个源文件带 data-plugin-panel（找到 ${hits.length}: ${hits.join(', ')}）——`
    + '上游若拆分/改名，维护者须重新指向本锁并按 checklist §7 第 6 步复核容纳层。')
  pageSourceCache = normalize(stripComments(readFileSync(hits[0]!, 'utf8')))
  return pageSourceCache
}

vendorTest('页根钩子：data-plugin-panel 仍在页面根的 <section> 上', () => {
  assert.match(pageSource(), /<section\b[^>]*\bdata-plugin-panel\b/u,
    '容纳层的根去主面板规则以 data-plugin-panel 为唯一根钩子（类名是构建期哈希）。')
})

vendorTest('chrome 行：页头 + more 视图头 + 详情头各带 data-window-drag', () => {
  const count = pageSource().split('data-window-drag').length - 1
  assert.equal(count, 3,
    `本页应恰有三条 data-window-drag（页头、more 视图头、详情头，实得 ${count}）：`
    + '容纳层只按「这些行带 data-window-drag」清零 28px 主面板 inset；新增/删除都要重锚 checklist §3 末条。')
})

vendorTest('页根仍调用 plugins.bundle.activation（CSS 的 > [data-slot] 规则依赖上游 renderSlot 的直接子位置）', () => {
  assert.match(pageSource(), /\brenderSlot\('plugins\.bundle\.activation'/u,
    '本锁只钉调用存在；直接子位置由上游 renderSlot 在页根 JSX 中的位置决定——若上游把它挪进别的容器，[data-plugin-panel] > [data-slot] > * 的宽度规则会失配，需按 §7 重锚。')
})

/**
 * 注册子座席表锁（v0.2.1-alpha.1 升级补）：本包内嵌官方插件管理页组件，但不加载其 apply()
 * （官方行在复合壳里是 covered-skip），页面里的 renderSlot(...) 绑定的是本包 registration 的
 * children 表。React 把 {renderSlot('plugins.add.actions', …)} 作为 children 传给 Menu 时即求值
 * （与菜单是否展开无关），未声明就抛 SlotOwnershipError: slot 'plugins.add.actions' is not
 * declared by this entry's children —— 打开「设置 → 插件管理」即崩。上游本代新增的
 * plugins.add.actions 正是这样漏进来的；本锁把两表双向钉死。
 */
vendorTest('注册子座席表：MANAGER_CHILDREN 与上游 registration 的 children 双向一致', () => {
  /** 取 start 的 { 起、按括号配平到对应 } 的整块（注释已剥；本表无字符串花括号）。 */
  const bracedBlock = (text: string, start: string): string => {
    const from = text.indexOf(start)
    assert.ok(from >= 0, '源里找不到 ' + start)
    const open = text.indexOf('{', from)
    assert.ok(open >= 0, start + ' 后没有 {')
    let depth = 0
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1
      else if (text[index] === '}') {
        depth -= 1
        if (depth === 0) return text.slice(open, index + 1)
      }
    }
    assert.fail(start + ' 的块未闭合')
  }
  const specsOf = (block: string): Array<{ key: string; kind: string; scope: string }> =>
    [...block.matchAll(/'([^']+)':\s*\{\s*kind:\s*'(single|keyed|list|chain)'\s*[,;]\s*scope:\s*'([a-z-]+)'/gu)]
      .map((match) => ({ key: match[1]!, kind: match[2]!, scope: match[3]! }))
  const occurrences = (block: string): number => (block.match(/:\s*\{\s*kind:\s*'/gu) ?? []).length
  const ownSource = normalize(stripComments(readFileSync(
    new URL('../../src/client/index.ts', import.meta.url), 'utf8')))
  const vendorSource = normalize(stripComments(readFileSync(
    new URL('../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-plugin-manager/src/client/index.ts', import.meta.url), 'utf8')))
  assert.equal(vendorSource.split('children: {').length - 1, 1, '上游 registration 的 children 表应恰有一处')
  assert.equal(ownSource.split('const MANAGER_CHILDREN = {').length - 1, 1, '本包 MANAGER_CHILDREN 应恰有一处')
  const ownBlock = bracedBlock(ownSource, 'const MANAGER_CHILDREN = {')
  const vendorBlock = bracedBlock(vendorSource, 'children: {')
  const own = specsOf(ownBlock)
  const vendor = specsOf(vendorBlock)
  assert.ok(own.length > 0 && vendor.length > 0, '两表都要抽到座席键与 kind/scope')
  assert.equal(own.length, occurrences(ownBlock), '本地每个子座席都必须被抽取（漏抽会静默放过上游新增）')
  assert.equal(vendor.length, occurrences(vendorBlock), '上游每个子座席都必须被抽取（漏抽会静默放过新增）')
  const ownByKey = new Map(own.map((entry) => [entry.key, entry]))
  const vendorByKey = new Map(vendor.map((entry) => [entry.key, entry]))
  const missing = vendor.filter((entry) => !ownByKey.has(entry.key)).map((entry) => entry.key)
  const extra = own.filter((entry) => !vendorByKey.has(entry.key)).map((entry) => entry.key)
  assert.deepEqual(missing, [],
    '上游注册声明了本包未声明的子座席（页面 renderSlot 会抛 SlotOwnershipError）：' + missing.join(', '))
  assert.deepEqual(extra, [],
    '本包声明了上游 registration 没有的子座席（扩展必须显式登记理由并同步本锁）：' + extra.join(', '))
  for (const entry of vendor) {
    const ownSpec = ownByKey.get(entry.key)!
    assert.deepEqual({ kind: ownSpec.kind, scope: ownSpec.scope }, { kind: entry.kind, scope: entry.scope },
      '座席 ' + entry.key + ' 的 kind/scope 与上游 registration 不一致（kind 决定渲染分派，漂移即崩或错渲）')
  }
  // 更强的一臂：页面**实际消费**的 renderSlot 键必须全在本地 children 表里——这正是运行期
  // throw 的充要条件，且不依赖上游把自己的新槽登记进它的 children 表（上游漏登记也照样红）。
  const used = [...new Set([...pageSource().matchAll(/renderSlot\(\s*'([^']+)'/gu)].map((match) => match[1]!))]
  const undeclaredUsage = used.filter((key) => !ownByKey.has(key))
  assert.deepEqual(undeclaredUsage, [],
    '页面 renderSlot 直接消费但本包未声明的子座席（运行期 SlotOwnershipError）：' + undeclaredUsage.join(', '))
  assert.ok(used.length > 0, '页面至少消费一个子座席（抽取失效即红，别把空集当绿）')
  // 负控：夹具证明抽取器能看见 kind/scope 与「少一个键」（首版只比 key、且用恒真式负控）。
  const fixture = specsOf("{ 'plugins.add.actions': { kind: 'list', scope: 'root' }, 'plugins.bundle.config': { kind: 'keyed', scope: 'root' } }")
  assert.deepEqual(fixture, [
    { key: 'plugins.add.actions', kind: 'list', scope: 'root' },
    { key: 'plugins.bundle.config', kind: 'keyed', scope: 'root' },
  ], '负控：kind/scope 必须被抽取')
  assert.deepEqual(fixture.filter((entry) => entry.key !== 'plugins.add.actions').map((entry) => entry.key),
    ['plugins.bundle.config'], '负控：差集必须能看见缺键')
})
