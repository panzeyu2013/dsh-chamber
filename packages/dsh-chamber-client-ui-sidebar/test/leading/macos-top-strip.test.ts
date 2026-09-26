/**
 * macOS window-chrome lock (expanded state): with the hiddenInset titlebar the
 * traffic lights float over the sidebar column, so the shell's top strip must
 * reserve that band and keep the panel toggle on it — the pinned upstream block
 * (ui-sidebar SidebarRoot.module.css `.topStrip` / `.topStrip + .logoRow`,
 * SidebarRoot.tsx's darwin branch). Deleting it recreates the reported break:
 * the wordmark sits flush under the traffic lights while the web (no window
 * controls) keeps looking normal, and the toggle drops off the y-25 line the
 * collapsed `shell.leading` seat sits on, so collapsing would shift it.
 * Source-text lock: the component renders only inside a live client shell, so a
 * node test can pin the wiring + geometry, not the pixels.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')
const css = read('../../src/client/SidebarRoot.module.css')
const tsx = stripComments(read('../../src/client/SidebarRoot.tsx'))

/** One class rule's declaration body from the sheet. */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(selector + ' {')
  assert.notEqual(at, -1, selector + ' must exist')
  return source.slice(at, source.indexOf('}', at))
}

test('the darwin top strip reserves the traffic-light band at the column top', () => {
  const strip = ruleBody(css, '.topStrip')
  assert.match(strip, /height: 52px;/u, 'the strip is the band the traffic lights sit in')
  assert.match(strip, /margin: -6px calc\(-1 \* var\(--dsh-sidebar-inline-padding\)\) 0;/u,
    'negative margins cancel the root padding so the band spans the column top edge')
  assert.match(strip, /padding: 0 12px 2px;/u,
    'the 2px foot centres the 28px toggle at y=25, level with the collapsed seat')
  // 52 (band) - 2 (foot) - 28 (control) = 22 -> 11..39: the stripped toggle clears
  // the traffic lights and matches the frame leading seat's own `top: 11px`.
  assert.match(ruleBody(css, '.topStrip + .logoRow'), /margin-top: -12px;/u,
    'the logo row tucks back under the 52px band instead of leaving it blank')
})

test('the strip holds the panel toggle on darwin, the logo row keeps it elsewhere', () => {
  assert.match(tsx, /const darwinDesktop = isDarwinDesktop\(\)/u,
    'the hiddenInset marker is read at render time (vendor darwin-desktop.ts)')
  assert.match(tsx, /\{darwinDesktop && <div className=\{css\.topStrip\} data-window-drag>\{toggle\}<\/div>\}/u,
    'the band renders only under the hiddenInset marker and carries the toggle')
  assert.match(tsx, /\{!darwinDesktop && toggle\}/u,
    'the non-darwin logo row keeps its right-edge toggle')
  assert.equal(tsx.split('const toggle =').length, 2,
    'the toggle stays one box rendered into exactly one of the two seats')
})

test('the strip and the logo row carry the window-drag mark', () => {
  // 标记行的盒就是窗口拖拽面（上游 ui-theme app-region 清单 CHROME_ROWS 的同一属性；
  // 单一真源 packages/dsh-client-web/src/window-drag/regions.ts 的 DRAG_MARK）。
  // Swift 壳不认 -webkit-app-region：标记行上的按下经 ShellWindowDrag.swift 的通道转成
  // 原生窗口拖拽（实测 WKWebView.mouseDownCanMoveWindow 恒 false，isMovableByWindowBackground
  // 对页面无效）；Electron 腿的拖拽面来自 base.css 的 app-region 规则。两行漏标 →
  // 顶部带（红绿灯所在带 + 字标行）无法拖动整窗。
  assert.match(tsx, /className=\{css\.topStrip\} data-window-drag/u,
    'the hiddenInset strip is a window-chrome row')
  assert.match(tsx, /className=\{css\.logoRow\} data-window-drag/u,
    'the logo row is a window-chrome row')
})
