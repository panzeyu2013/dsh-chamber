/**
 * Source lock for the 2026-12 "invisible but clickable" blank-icon fix.
 *
 * An entrance animation whose first frame is `opacity: 0` can be pinned there:
 * a CSS animation only advances while its subtree is rendered, so a hidden
 * instance shell (`content-visibility: hidden`) or an occluded window leaves the
 * element invisible while it stays hit-testable, with no self-heal until a
 * remount (the WKWebView measurement is recorded in STATUS/design 06/14).
 * Content-bearing UI therefore carries no entrance animation at all, and the
 * renderer refuses to create one inside a shell nobody renders.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')
const sidebarCss = source('../../src/client/SidebarRoot.module.css')
const sidebarTsx = source('../../src/client/SidebarRoot.tsx')
const settingsShellCss = source('../../../dsh-chamber-client-ui-settings-bridge/src/client/SettingsShell.module.css')
const rendererCss = source('../../../renderer/src/styles.css')

/** Every `@keyframes` block whose from/0% frame sets `opacity: 0`. */
function entranceKeyframes(css: string): string[] {
  const found: string[] = []
  for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/gu)) {
    const first = /(?:from|0%)\s*\{([\s\S]*?)\}/u.exec(match[2])
    if (first !== null && /opacity\s*:\s*0(?:\.0)?\s*[;}]/u.test(first[1])) found.push(match[1])
  }
  return found
}

test('the sidebar declares no entrance animation that starts invisible', () => {
  assert.deepEqual(entranceKeyframes(sidebarCss), [], 'an opacity-0 first frame can be pinned by a frozen timeline')
  for (const gone of ['wide-in', 'rail-in', 'rail-fade-in']) {
    assert.doesNotMatch(sidebarCss, new RegExp('@keyframes\\s+' + gone + '\\b', 'u'), gone + ' must stay retired')
  }
})

test('the state-driven collapse fade is the only opacity transition left', () => {
  // Class-driven + settle-bounded, so it is NOT a timeline that can freeze.
  assert.match(sidebarCss, /\.fading > \*\s*\{\s*opacity: 0;\s*transition: opacity 150ms/u)
  assert.match(sidebarCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.fading > \*\s*\{\s*transition: none;/u)
})

test('the removed animations are documented and their class hooks stay mounted', () => {
  assert.match(sidebarCss, /2026-12「看不到但能点」的空白图标修复/u)
  assert.match(sidebarTsx, /clsx\(css\.brand, css\.wide\)/u, 'the wide hook still marks the brand row')
  assert.match(sidebarTsx, /css\.railIn/u, 'the railIn hook still marks a live collapse')
})

test('the settings shell panel body carries no entrance animation either', () => {
  assert.deepEqual(entranceKeyframes(settingsShellCss), [])
  assert.doesNotMatch(settingsShellCss, /contentFadeIn/u, 'the per-server wrapper fade must stay retired')
})

test('no chamber stylesheet reintroduces an invisible first frame (repo-wide sweep)', () => {
  // The three files above are the ones this fix touched; the INVARIANT is repo
  // wide, so a new entrance animation in any other chamber package must fail here
  // rather than rely on someone re-running the scan by hand.
  const offenders: string[] = []
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Ignored local dev state (e.g. packages/desktop/.dev-user-data) can carry a
      // nested dev instance's own stylesheets; the invariant is over chamber sources.
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
  assert.match(rendererCss, /\.instance-hidden \.instance-shell \*,\s*\n\.instance-pending \.instance-shell \*\s*\{/u)
  const block = /\.instance-hidden \.instance-shell \*,[\s\S]*?\{([\s\S]*?)\}/u.exec(rendererCss)
  assert.ok(block !== null, 'the gate block must exist')
  assert.match(block![1], /animation: none !important;/u)
  assert.match(block![1], /transition: none !important;/u)
})
