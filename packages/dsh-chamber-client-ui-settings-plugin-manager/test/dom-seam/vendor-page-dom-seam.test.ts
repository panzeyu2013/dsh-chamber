/**
 * 插件管理页容纳层的上游 DOM 缝锁 + 注册子座席表锁（design 05 §5；checklist §3 末条 / §7 第 6 步）。
 *
 * `EmbeddedPluginManagerPage.module.css` 不认上游的 CSS-module 类名（构建期哈希），只认
 * 页面自己的属性钩子与**页头行的两子序列**。这条缝静默回归过一次：上游把页头 intro 从
 * `<p>` 包成 `div.pageIntro`（intro 文字 + 信息按钮），旧 `h1 + p` 规则不再命中，intro
 * 留在行一、与容纳层提进首轨的首组标题叠绘（实机目检才发现）。本文件直接读 pin 住的
 * vendor 源，把该层依赖的事实逐条钉住：改钩子、改两子序列、改组形即红，维护者按 checklist
 * §7 第 6 步重锚，而不是等下一次实机目检。
 *
 * 断言按**区域**取景，不整文件乱搜：页根的子树（页头行 + 槽调用）与 `renderGroup` 定义
 * （组形）是两个不同区域，整文件搜会命中别处的同名元素（详情标题也是 `h3`）。
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

/** 取 `start` 起、到其后第一个 `end`（含）的一段。 */
const sliceThrough = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start)
  assert.ok(from >= 0, `vendor 源里找不到 ${start}`)
  const to = text.indexOf(end, from + start.length)
  assert.ok(to > from, `vendor 源里 ${start} 之后找不到 ${end}`)
  return text.slice(from, to + end.length)
}

/** 断言 `tokens` 在 `text` 里按序出现（每个都必须存在）。 */
const assertOrder = (text: string, tokens: readonly string[], why: string): void => {
  const positions = tokens.map((token) => {
    const at = text.indexOf(token)
    assert.ok(at >= 0, `vendor 源里找不到 ${token}（容纳层依赖它）`)
    return at
  })
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index - 1]! < positions[index]!,
      `顺序必须是 ${tokens.join(' → ')}（第 ${index + 1} 项越位）：${why}`)
  }
}

/**
 * JSX 元素的**直接子元素**开标签序列（层 1 = `element` 自己的子）。
 *
 * 为什么不用正则数兄弟：`A…B` 配对形态对「多一个兄弟」不敏感——实测在页头两子之间插入第三个
 * `<div>…</div>`、或在控件块后再追加一个，旧的两子正则**都仍然命中**（它把新元素与控件块重新
 * 配对）。而三子会改 subgrid 的按行自动放置（首子→首轨、中项→次轨、真控件被挤到下一行的首轨），
 * 正是本锁要抓的回归。
 *
 * 扫描按标签走，并跳过属性里的 `{…}` 表达式与其中的字符串——上游控件块里就有
 * `icon={<IconPlusOutlineRegular size={13} />}`，按「第一个 `>`」截标签会在这里截错。
 */
const topLevelChildren = (element: string): string[] => {
  const children: string[] = []
  let depth = 0
  let index = 0
  while (index < element.length) {
    const open = element.indexOf('<', index)
    if (open < 0) break
    let cursor = open + 1
    let braces = 0
    let quote: string | undefined
    const closing = element[cursor] === '/'
    if (closing) cursor += 1
    while (cursor < element.length) {
      const char = element[cursor]!
      if (quote !== undefined) {
        if (char === '\\') { cursor += 2; continue }
        if (char === quote) quote = undefined
        cursor += 1
        continue
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; cursor += 1; continue }
      if (char === '{') braces += 1
      else if (char === '}') braces -= 1
      else if (char === '>' && braces === 0) break
      cursor += 1
    }
    assert.ok(cursor < element.length, `JSX 标签未闭合：${element.slice(open, open + 40)}`)
    const tag = element.slice(open, cursor + 1)
    if (closing) depth -= 1
    else {
      if (depth === 1) children.push(tag)
      if (!tag.endsWith('/>')) depth += 1
    }
    index = cursor + 1
  }
  return children
}

vendorTest('页根钩子：data-plugin-panel 仍在页面根的 <section> 上', () => {
  assert.match(pageSource(), /<section\b[^>]*\bdata-plugin-panel\b/u,
    '容纳层的根覆盖、两轨网格与 960 上限全部以 data-plugin-panel 为唯一根钩子（类名是构建期哈希）。')
})

vendorTest('页头行是页根的**首**子元素且带 data-window-drag', () => {
  assert.match(pageSource(), /<section\b[^>]*\bdata-plugin-panel\b[^>]*>\s*(?:\{\s*[A-Za-z_$][\w$]*\s*\?\s*\(\s*)?<header\b[^>]*\bdata-window-drag\b/u,
    '页头行必须是页根的第一个子元素：前插兄弟会先占行一（首组标题落位与「组内 8px」的前提）；'
    + 'data-window-drag 同时是隐藏标题栏下唯一的窗口拖拽面，也是容纳层两条 chrome 行的命中面。')
})

vendorTest('页头行恰两子：标题块（h1 + intro + 说明钮）在前、控件块在后', () => {
  const head = sliceThrough(pageSource(), '<header', '</header>')
  assertOrder(head, ["t('title')", "t('intro')", "t('infoLabel')", 'props.openInstall', '</header>'],
    '容纳层整块隐去首子块（上游重复的标题 + intro），把末子留给次轨并为它定尺寸；顺序一变，隐去的就是别的东西。')
  assert.match(head, /<header\b[^>]*\bdata-window-drag\b[^>]*>\s*<div\b[^>]*>\s*<h1\b/u,
    '页头行首子块必须**以重复的标题（h1）开头**：前插兄弟（哪怕一个空 div）会把首子换成别的东西，'
    + '容纳层整块隐去的就不再是重复标题，intro 重新落回行一。')
  const children = topLevelChildren(head)
  assert.equal(children.length, 2,
    `页头行必须恰好两子（标题块 + 控件块，实得 ${children.length}：${children.join(' / ')}）——`
    + '第三子会改 subgrid 的按行自动放置：中项占掉由控件定尺寸的次轨，真控件被挤到下一行的首轨；'
    + '只 pin 子元素个数与顺序，不 pin 标题/控件的标签或类名（类名是构建期哈希）。')
  assert.match(children[0]!, /^<div\b/u, '首子必须是标题块：是一个 div，其内全部内容被容纳层隐去。')
  assert.match(children[1]!, /^<div\b/u, '末子必须是控件块：也是一个 div，次轨由它定尺寸。')
})

// 负控挂在 vendorTest 下（它本身不读 vendor）：本文件必须保持「全跳过 = 全红」，加一个裸 test()
// 会让缺树 + 显式 opt-out 从红变绿，把缺 vendor 的诚实失败换成假绿。
vendorTest('负控：页头子元素计数把第三个兄弟判红（旧的两子正则形态放行）', () => {
  const two = '<header className={css.pageHead} data-window-drag>'
    + "<div><h1>{t('title')}</h1><div className={css.pageIntro}>{t('intro')}</div></div>"
    + '<div className={css.toolbar}><Button icon={<IconPlusOutlineRegular size={13} />} onClick={props.openInstall} /></div>'
    + '</header>'
  const thirdBetween = two.replace('<div className={css.toolbar}>', '<div className={css.stray}><span>x</span></div><div className={css.toolbar}>')
  const thirdAppended = two.replace('</header>', '<div className={css.stray}><span>x</span></div></header>')
  assert.equal(topLevelChildren(two).length, 2,
    '两子形态必须数成 2——控件块的属性里嵌着 icon={<Icon… />}，标签边界不能按第一个 `>` 截。')
  assert.equal(topLevelChildren(thirdBetween).length, 3, '两子之间插第三子必须数成 3。')
  assert.equal(topLevelChildren(thirdAppended).length, 3, '控件块之后追加第三子必须数成 3。')
  // 负控的立论：旧的配对形态对两个变异都绿（实测），计数器因此不是过度设计。
  const pairingForm = /<header\b[^>]*\bdata-window-drag\b[^>]*>\s*<div\b[^>]*>[\s\S]*?<\/div>\s*<div\b[^>]*>[\s\S]*?<\/div>\s*<\/header>/u
  assert.ok(pairingForm.test(thirdBetween) && pairingForm.test(thirdAppended),
    '负控前提：旧的配对形态确实对「第三子」放行——它若哪天变红，说明对照已无价值，可删该负控。')
})

vendorTest('分组缝：section[data-plugin-group] = [组头（h3 + 计数）在前、ul 卡列表在后]', () => {
  const group = sliceThrough(pageSource(), 'const renderGroup', 'return (')
  assert.match(group, /<section\b[^>]*\bdata-plugin-group=\{id\}>\s*<div\b[^>]*>[\s\S]*?data-plugin-count[\s\S]*?<\/div>\s*<ul\b[^>]*>[\s\S]*?<\/ul>\s*<\/section>/u,
    '组形必须是「首子 = 组头 div（带 data-plugin-count 计数）在前、末子 = ul 卡列表在后」：'
    + '容纳层据此把组盒 display:contents、把首组头提进页头行首轨，卡列表留在流里；只 pin 嵌套与顺序。')
})

vendorTest('首组是 Official、次组是已安装（首轨该放谁的语义锚）', () => {
  const page = pageSource()
  assert.match(page, /\brenderGroup\('official', t\('officialTitle'\),/u,
    '首组必须是 Official：容纳层把**第一个** data-plugin-group 的组头提进行一（官方 7 那一行）。')
  assert.match(page, /\brenderGroup\('bundles', t\('bundlesTitle'\),/u,
    '次组（已安装）的渲染调用必须仍在；组序变化即复核首轨该放谁，并同步 checklist §3 登记。')
  assertOrder(page, ["renderGroup('official'", "renderGroup('bundles'"], 'Official 必须仍是第一个渲染的组。')
})

vendorTest('两条 chrome 行：页头 + 详情头各带 data-window-drag', () => {
  const count = pageSource().split('data-window-drag').length - 1
  assert.equal(count, 2,
    `本页应恰有两条 data-window-drag（页头行 + 详情头，实得 ${count}）：容纳层按属性命中两条 chrome 行`
    + '（padding-top: 0），多一条少一条都要重锚 checklist §3 末条。')
})

vendorTest('页根自身的槽锚点 plugins.bundle.activation 仍是直接子表达式', () => {
  assert.match(pageSource(), /\brenderSlot\('plugins\.bundle\.activation'/u,
    '容纳层给 [data-plugin-panel] > [data-slot] > * 的跨轨与 960 上限是按这条直接子槽写的：'
    + '槽调用若挪进别的容器，占用者将拿不到轨道定位。')
})

/**
 * 注册子座席表锁（v0.2.1-alpha.1 升级补）：本包内嵌官方插件管理页组件，但不加载其 apply()
 * （官方行在复合壳里是 covered-skip），页面里的 renderSlot(...) 绑定的是本包 registration 的
 * children 表。React 把 {renderSlot('plugins.add.actions', …)} 作为 children 传给 Menu 时即求值
 * （与菜单是否展开无关），未声明就抛 SlotOwnershipError: slot 'plugins.add.actions' is not
 * declared by this entry's children —— 打开「设置 → 内置插件」即崩。上游本代新增的
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
