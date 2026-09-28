/**
 * Source lock for the "invisible but clickable" blank-icon fix: an entrance
 * animation first-framed at `opacity: 0` freezes invisible-but-hit-testable in a hidden
 * or occluded shell (no self-heal until remount; WKWebView measurement in design 06/14),
 * so content-bearing UI carries no entrance animation at all and the renderer refuses
 * to create one inside a shell nobody renders.
 *
 * The same symptom still reproduces after the animation retirement. This lock covers the
 * ANIMATION face only; the current root cause (document-level duplicate
 * SVG resource ids x hidden shells) and its fix live in design 05 §4.2.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')
const sidebarCss = source('../../src/client/SidebarRoot.module.css')
const sidebarTsx = stripComments(source('../../src/client/SidebarRoot.tsx'))
const settingsShellCss = source('../../../dsh-chamber-client-ui-settings-bridge/src/client/SettingsShell.module.css')
const rendererCss = source('../../../renderer/src/styles.css')

/** Every `@keyframes` block whose from/0% frame sets `opacity: 0`. */
function entranceKeyframes(css: string): string[] {
  return [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/gu)].flatMap((match) => {
    const first = /(?:from|0%)\s*\{([\s\S]*?)\}/u.exec(match[2])
    return first !== null && /opacity\s*:\s*0(?:\.0)?\s*[;}]/u.test(first[1]) ? [match[1]] : []
  })
}

test('the state-driven collapse fade is the only opacity transition left', () => {
  // Class-driven + settle-bounded, so it is NOT a timeline that can freeze.
  assert.match(sidebarCss, /\.fading > \*\s*\{\s*opacity: 0;\s*transition: opacity 150ms/u)
  assert.match(sidebarCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.fading > \*\s*\{\s*transition: none;/u)
})

test('the retired animation hooks are gone, not left as inert markers', () => {
  // 入场动画退役后 `.wide` / `.railIn` 没有任何 CSS 规则：CSS Modules 对文件内未定义的类
  // 返回 `undefined`，clsx 直接丢弃 ⇒ 留着只是「引用存在但无规则」的假接线。整组删除后
  // 这里锁「不再出现」，防止有人把它们当布局钩子重新挂上。
  assert.doesNotMatch(sidebarTsx, /css\.wide\b|css\.railIn\b/u, 'the retired class hooks must not come back')
  assert.doesNotMatch(stripComments(source('../../src/client/sidebar-root-chrome.tsx')), /css\.wide\b/u)
})

test('the settings shell panel body carries no entrance animation either', () => {
  assert.deepEqual(entranceKeyframes(settingsShellCss), [])
  assert.doesNotMatch(settingsShellCss, /contentFadeIn/u, 'the per-server wrapper fade must stay retired')
})

test('no chamber stylesheet reintroduces an invisible first frame (repo-wide sweep)', () => {
  // The three files above are the ones this lock covers; the INVARIANT is repo-wide, so a
  // new entrance animation in any other chamber package must fail here.
  const offenders: string[] = []
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Local dev state (packages/desktop/.dev-user-data) may hold nested stylesheets; the invariant is over chamber sources.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.css')) {
        const relative = child.pathname.slice(child.pathname.indexOf('/packages/') + 1)
        for (const name of entranceKeyframes(readFileSync(child, 'utf8'))) offenders.push(relative + ' :: ' + name)
      }
    }
  }
  walk(new URL('../../../', import.meta.url))
  assert.deepEqual(offenders, [], 'content-bearing UI must not depend on an entrance timeline to become visible')
})

test('the renderer forbids creating animations inside a shell nobody renders', () => {
  // 遮罩持有期（`.instance-veil-held`，renderer 的 P1 兜底不变量）也在同一门里。
  // 这里不逐字钉"两条选择器 + 紧跟 {"，而是要求**三条隐藏态选择器都在门里**——
  // 语义是"新增隐藏态必须进门"（逐字钉两条选择器的正则会在新增第三条时失配）；
  // 声明体仍逐字断言，门本身没有被放宽。
  // 先剥注释再匹配：否则把第三条选择器写成 `/* … */` 就能骗过本锁。
  const block = /\.instance-hidden \.instance-shell \*,[\s\S]*?\{([\s\S]*?)\}/u.exec(
    rendererCss.replace(/\/\*[\s\S]*?\*\//gu, ''),
  )
  assert.ok(block !== null, 'the gate block must exist')
  for (const selector of [
    '.instance-hidden .instance-shell *',
    '.instance-pending .instance-shell *',
    '.instance-veil-held .instance-shell *',
  ]) {
    assert.ok(block![0].includes(selector), `${selector} must join the hidden-shell animation gate`)
  }
  assert.match(block![1], /animation: none !important;/u)
  assert.match(block![1], /transition: none !important;/u)
})
