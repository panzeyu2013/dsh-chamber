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
import { existsSync, readFileSync } from 'node:fs'
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

const VENDOR_CSS_MISSING = !existsSync(new URL(
  '../../../../vendor/harness-checkout/packages/client/ui-sidebar/src/client/SidebarRoot.module.css', import.meta.url))
const VENDOR_OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

test('the darwin transparency rules keep the pinned upstream bodies', (context) => {
  // 缺树默认响亮失败，只有显式 opt-out 才 skip——与同包 vendor-session-fact-contract 同一
  // 约定（remote-state-acceptance 的 sidebar 腿正是设该变量跑本包）。
  if (VENDOR_CSS_MISSING) {
    if (VENDOR_OPT_OUT) {
      context.skip('vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip')
      return
    }
    assert.fail('vendor/harness-checkout 未物化：先跑 scripts/dev/ensure-harness-vendor.mjs 再跑本测试'
      + '（显式 DSH_CHAMBER_VENDOR_ABSENT=skip 才跳过）。')
  }
  // design 25 §5.6：这三组规则是「窗口 vibrancy 从侧栏列透出」的承重面，页面自身没有像素判据
  // 能发现它们被删/改。规则体与 pin 住的 vendor ui-sidebar 同名文件逐条比对；本仓选择器多一层
  // data-window-vibrancy 门控（Electron darwin 腿没有 vibrancy，跟着透明会把侧栏压到窗口底色
  // 上，见 design 25 §5.6 的 Rejected alternatives），故比对前只从选择器里去掉该门控。
  // 缺 vendor 子模块时响亮失败并给出补救（仓内同款：control-plane host-log-bridge）——
  // 「本地绿」不能靠静默跳过换来，树在时这条体逐字比对是唯一覆盖；唯一例外是显式
  // DSH_CHAMBER_VENDOR_ABSENT=skip（见函数开头的 opt-out 分支）。
  const vendorPath = '../../../../vendor/harness-checkout/packages/client/ui-sidebar/src/client/SidebarRoot.module.css'
  const vendor = read(vendorPath)
  const gated = (suffix: string): string => ":global([data-platform='darwin'][data-window-vibrancy])" + suffix
  const pinned = (suffix: string): string => ":global([data-platform='darwin'])" + suffix
  // [name, ours selector, vendor selector]: the transparency rules add the
  // vibrancy gate on our side; `.brand` compares its ungated darwin body (the
  // upstream shape, which covers the Electron leg) and the gated twin the Swift
  // cross-language lockstep requires is asserted right after this loop.
  const pairs: [string, string, string][] = [
    ['.root', gated(' .root'), pinned(' .root')],
    ['.brand', pinned(' .brand'), pinned(' .brand')],
    // 同一份 vendor 体也挂在 vibrancy 标记的那条上（Swift 锁步只检查选择器存在，
    // 这里补上「两份规则的声明体都必须等于上游」）。
    ['.brand（vibrancy 标记）', gated(' .brand'), pinned(' .brand')],
    ['.newSession', gated(' .newSession'), pinned(' .newSession')],
    ['.newSession:hover', gated(' .newSession:hover'), pinned(' .newSession:hover')],
    ['[data-ds-dark-theme] .newSession', gated(" :global([data-ds-dark-theme]) .newSession"), pinned(" :global([data-ds-dark-theme]) .newSession")],
    ['[data-ds-dark-theme] .newSession:hover', gated(" :global([data-ds-dark-theme]) .newSession:hover"), pinned(" :global([data-ds-dark-theme]) .newSession:hover")],
  ]
  // 只比声明体：本仓选择器多一层门控，比整条规则会把门控本身算成漂移。
  const body = (source: string, selector: string): string => {
    const at = source.indexOf(selector + ' {')
    assert.notEqual(at, -1, selector + ' must exist')
    const open = source.indexOf('{', at)
    return stripComments(source.slice(open + 1, source.indexOf('}', open)))
      .replace(/\s+/gu, ' ').trim()
  }
  for (const [name, ours, theirs] of pairs) {
    assert.equal(body(css, ours), body(vendor, theirs),
      name + ' 的 darwin 规则体必须与 vendor 逐字一致（删/改会遮住窗口材质）')
  }

  // Swift 侧 CrossLanguageLockstepTests.testWindowVibrancyMarkerLockstep 逐字要求
  // `.root/.brand/.newSession` 三处都带 vibrancy 标记；.brand 的双份规则是有意的
  // （Electron darwin 腿同样命中但无标记）。
  for (const selector of [' .root', ' .brand', ' .newSession'])
    assert.notEqual(css.indexOf(gated(selector) + ' {'), -1,
      selector + ' 必须有一份挂 vibrancy 标记的 darwin 规则（Swift 锁步契约）')
})
