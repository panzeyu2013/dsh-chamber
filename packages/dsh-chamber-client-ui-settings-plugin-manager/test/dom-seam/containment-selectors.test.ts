/**
 * 容纳层消费面锁：CSS 必须继续以页面自有属性为缝、按**页头行首子块**（位置）而不是块内标签
 * 隐去重复标题。
 *
 * 回归史：这条规则写下时上游的 intro 是 `<p>`，于是写成 `:is(h1, h1 + p)`；上游后来把它
 * 包成 `div.pageIntro`（intro 文字 + 信息按钮），规则静默失效，intro 落在行一、与容纳层
 * 提进首轨的首组标题叠绘（实机目检才发现）。位置锚（页头行首子）是这条布局**本来就依赖**的
 * 形状（checklist §3：页头行 = 标题块 + 控件（末子）），标签锚则多押一份上游内部结构。
 * 本文件把该决定钉住：改回标签锚必须同时改这里与 §3 登记。此处不读 vendor，因此不随
 * `DSH_CHAMBER_VENDOR_ABSENT` 跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = fileURLToPath(new URL('../../src/client/EmbeddedPluginManagerPage.module.css', import.meta.url))

test('容纳层仍以上游自有属性为缝（类名是构建期哈希，不可寻址）', () => {
  const css = readFileSync(CSS, 'utf8')
  for (const hook of ['[data-plugin-panel]', '[data-window-drag]', '[data-plugin-group]', '[data-slot]']) {
    assert.ok(css.includes(hook),
      `容纳层必须继续消费 ${hook}：上游 CSS-module 类名是构建期哈希，属性缝是唯一稳定面（design 05 §5）。`)
  }
})

test('重复标题按位置整块隐去（页头行首子），不按块内标签', () => {
  const css = readFileSync(CSS, 'utf8')
  assert.match(css, />\s*\[data-window-drag\]\s*>\s*:first-child\s*>\s*\*\s*\{[^}]*display:\s*none/u,
    '页头行首子块（上游重复的 h1 + intro）必须整块隐去：按标签钉（旧 h1 + p）会随上游换标签静默失效，'
    + 'intro 会叠回首组标题那一轨；块本身必须留着——它是占住首轨、把次轨让给控件的那个 grid item。')
})
