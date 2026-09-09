import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 文档级 color-scheme 兜底值（2026-12 问题 E 修复）：这份文档的调色板权威是
// dsh 的 token 样式表——design-platform.css 的 `body` 块给出浅色默认，
// `body[data-ds-dark-theme]` 才切深色；活动实例的 ui-layout theme presenter
// 落地后由 `html` 内联值覆盖。因此兜底必须与「无属性即浅色」一致，否则任一
// 投影缺席的窗口就是"浅色界面 + 深色原生控件"（checkbox 深浅错位）。
// 源码级钉子（同 gateway/test/login-page.test.ts 的样式断言先例）：改回 dark
// 不会让任何行为测试变红，只会让用户重新看到错位。

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('the document-level color-scheme fallback stays light, matching the token palette default', () => {
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light/, ':root must declare the light fallback')
  // Scoped dark rules (e.g. a future boot-skeleton rule) stay legal — only the
  // DOCUMENT-level declaration is forbidden.
  assert.doesNotMatch(css, /(?::root|html|body)\s*\{[^}]*color-scheme:\s*dark/,
    'no document-level rule may declare a dark scheme')
})

test('the fallback rule documents why it must match the palette default', () => {
  // The rationale is the only thing preventing a future "make the shell dark
  // again" edit; keep it pinned to the rule.
  assert.match(css, /design-platform\.css/, 'the fallback comment must name the palette authority')
  assert.match(css, /data-ds-dark-theme/, 'the fallback comment must name the dark-palette attribute')
})

test('the App publishes the active source in a layout effect (the producer half of the model)', () => {
  // Without this publish `activeSourceId` stays undefined, the projector's
  // fail-open arm applies to EVERY instance, and the original N-ctx defect
  // returns with all projector/unit tests still green (2026-12 review MAJOR-1).
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*chamberBridge\.setActiveSource\(activeView\)\s*\}, \[activeView\]\)/s,
    'the active view must be published before paint, keyed on activeView')
})
