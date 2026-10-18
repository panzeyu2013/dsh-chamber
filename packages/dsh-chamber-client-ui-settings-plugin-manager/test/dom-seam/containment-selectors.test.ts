/**
 * 容纳层消费面锁：管理页是设置面的独立分节，页面自己的页头/intro/More/详情/分组全部交给上游；
 * 本层只做三件事：root 去主面板 padding/height/scroll、三条 chrome 行清零 28px inset、
 * 页根 activation 槽占位者取页面列宽。
 *
 * 回归史：2026-10 实机截图显示「更多」页标题右移、返回图标消失——旧规则把所有
 * [data-window-drag] 当页头做 subgrid 并隐藏首子内容，More 头的首子是返回按钮，
 * 于是图标被 display:none、标题被放进控件轨。同一套规则还假设分组是页根直接子
 * （data-plugin-group 提轨），在当前 pin 的 installedPanel 包装下早已不命中。
 * 本文件把「只消费这三个自有钩子、不得重新引入隐藏/两轨/分组规则」钉死。
 *
 * 此处不读 vendor，因此不随 `DSH_CHAMBER_VENDOR_ABSENT` 跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = fileURLToPath(new URL('../../src/client/EmbeddedPluginManagerPage.module.css', import.meta.url))

/**
 * CSS-only 注释剥离（与 packages/dsh-chamber-client-ui-mobile/test/behavior/composer-guard.test.ts
 * 同形）：注释掉的规则不得把消费面锁喂饱。不复用 JS 版 stripComments：它把 / 按表达式位置
 * 判正则，而 CSS 值里仍有 /（百分比/比例）等除号形态，剥注释的边界会随写法漂移。
 */
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '')

const css = stripCssComments(readFileSync(CSS, 'utf8'))

test('容纳层仍以上游自有属性为缝（类名是构建期哈希，不可寻址）', () => {
  for (const hook of ['[data-plugin-panel]', '[data-window-drag]', '[data-slot]']) {
    assert.ok(css.includes(hook),
      `容纳层必须继续消费 ${hook}：上游 CSS-module 类名是构建期哈希，属性缝是唯一稳定面（design 05 §5）。`)
  }
  assert.ok(!css.includes('[data-plugin-group]'),
    '分组提轨规则已退役：当前 pin 的分组在 installedPanel 包装下，直系选择器本来就不命中；重新引入必须同时改 DOM 契约与 design 05 §5。')
})

test('root 只去主面板的 padding/height/scroll，且只命中 wrapper 的直接子页根', () => {
  assert.match(css, /\.embedded\s*>\s*\[data-plugin-panel\]\s*\{[^}]*height:\s*auto[^}]*overflow:\s*visible[^}]*padding:\s*0/u,
    '页根必须退回设置分节体：height:auto / overflow:visible / padding:0；使用 > 以免误伤贡献分页里的嵌套 [data-plugin-panel]。')
})

test('三条 chrome 行只清零 28px inset，不再按页头两子序列做任何重排', () => {
  assert.match(css, /\[data-plugin-panel\]\s*\[data-window-drag\]\s*\{[^}]*padding-top:\s*0/u,
    '页头/More 头/详情头共享 padding-top:0；它们各自的上游布局必须保持原样。')
  assert.doesNotMatch(css, /\[data-window-drag\][^{]*\{[^}]*grid-(?:area|template)/u,
    '不得再把 [data-window-drag] 变成网格/两轨；More 头与页头的子序列不同，任何按行一的假设都会右移它。')
})

test('CSS 的 activation 槽规则按上游 renderSlot 的直接子位置取宽', () => {
  assert.match(css, /\[data-plugin-panel\]\s*>\s*\[data-slot\]\s*>\s*\*\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*960px/u,
    '占位者必须与页根其它直接子同宽同上限；这条是未来 plugins.bundle.activation 占用者的唯一定位规则。')
})

test('不得隐藏任何页面 chrome，也不得重新引入两轨/分组/:has 规则', () => {
  assert.doesNotMatch(css, /display:\s*none|visibility:\s*hidden|opacity:\s*0(?:[;\s}]|$)|clip-path/u,
    '页面自己的 h1/intro、More 返回按钮与详情 crumb 必须保持可见；隐藏任何一处都要在 design 05 §5 重新裁决。')
  assert.doesNotMatch(css, /nth-child|nth-of-type/u,
    '不得按子序隐藏/重排：More 头的首子是返回按钮，非首子选择器同样能藏它。')
  assert.doesNotMatch(css, /subgrid|grid-template|display:\s*grid|grid-auto-flow/u,
    '两轨/ subgrid/ grid-template 简写都已随 tab→section 退役；页头与 More 头不再共享列轨道。')
  assert.doesNotMatch(css, /:has\(/u,
    '容纳层只按自有属性与直接子位置取景，不需要 :has 的结构探测。')
  assert.doesNotMatch(css, />\s*:first-child/u,
    '不得再按「首子内容」隐藏/重排：More 头的首子是返回按钮，这正是 2026-10 回归的入口。')
})

test('每条容纳规则都限定在 .embedded 作用域内', () => {
  assert.doesNotMatch(css, /@(media|supports)\b/u, '容纳层不得把规则藏进 at-rule；at-rule 内的作用域不在本抽取面内。')
  const selectors = [...css.matchAll(/(?:^|\})\s*([^{}@]+)\{/gu)].map(match => match[1]!.trim()).filter(selector => selector.length > 0)
  assert.ok(selectors.length > 0, '抽取失效即红，别把空集当绿')
  for (const group of selectors) {
    for (const selector of group.split(',')) {
      assert.match(selector.trim(), /\.embedded/u, '容纳规则不得逃出 .embedded: ' + selector)
    }
  }
})

test('wrapper 只把页根作为 .embedded 的直接子（三条规则的前提）', () => {
  const wrapper = readFileSync(fileURLToPath(new URL('../../src/client/EmbeddedPluginManagerPage.tsx', import.meta.url)), 'utf8')
  assert.match(wrapper, /<div className=\{css\.embedded\}>\s*<Page \{\.\.\.props\} \/>\s*<\/div>/u,
    '页根必须是 wrapper 的直接子：多包一层 div 会让 .embedded > [data-plugin-panel] 的三条规则全部失配，而 CSS 锁仍绿。')
})

test('负控：注释掉的隐藏规则不得被当成存在', () => {
  const rule = '.embedded > [data-plugin-panel] > [data-window-drag] > :first-child > * { display: none; }'
  const commented = `/* ${rule} */`
  const stripped = stripCssComments(commented)
  assert.ok(commented.includes('display: none'), '负控前提：原文确实带隐藏规则')
  assert.ok(!stripped.includes('display: none'), '剥离注释后该规则必须消失')
  assert.doesNotMatch(stripped, /display:\s*none/u, '剥离后的注释不得满足「无隐藏规则」断言')
})
