/**
 * Source-text locks for the remote-browser plugin wiring.
 *
 * The node runner cannot import the .tsx/apply chain (no React/DOM, no vendor
 * tree in this worktree), so the wiring contract is pinned as text:
 *   - the exported inject face must stay `['slots', 'locale']` (no
 *     sidebarRightTabs) while apply probes the registry with ctx.get();
 *   - the source gate must run before any registration;
 *   - the tab id/kind/guide/seat keys and the locale registration are exact;
 *   - no shortcut, no iframe/webview, no value import of a module this worktree
 *     does not have.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { asSidebarRightTabs } from '../../src/client/sidebar-tabs.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/** Comments quote the shape; every lock below must read CODE, not prose. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gmu, '$1')
}

const index = read('src/client/index.ts')
const indexCode = stripComments(index)

test('package.json is a private, source-targeted chamber client package', () => {
  const manifest = JSON.parse(read('package.json')) as {
    name: string
    private?: boolean
    exports?: Record<string, unknown>
    dsh?: { client?: { platform?: string; inject?: string[] } }
    dependencies?: Record<string, string>
  }
  assert.equal(manifest.name, '@dsh-chamber/dsh-chamber-client-ui-browser')
  assert.equal(manifest.private, true)
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), ['.', './client', './package.json'])
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.deepEqual(manifest.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-locale',
  ])
  // No runtime dependency on a package/tree that may not exist yet.
  assert.equal(manifest.dependencies, undefined)
})

test('the exported inject face does not name sidebarRightTabs', () => {
  const match = /export const inject = \[([^\]]*)\]/u.exec(indexCode)
  assert.notEqual(match, null, 'the inject literal must stay a readable array')
  const members = match![1].split(',').map((member) => member.trim()).filter(Boolean)
  assert.deepEqual(members, ["'slots'", "'locale'"])
  assert.equal(members.some((member) => member.includes('sidebarRight')), false)
})

test('apply probes sidebarRightTabs with ctx.get after the source gate', () => {
  const gateAt = indexCode.indexOf('resolveBrowserEntry(')
  const probeAt = indexCode.indexOf("ctx.get('sidebarRightTabs')")
  const localeAt = indexCode.indexOf('ctx.locale.register(NS')
  const tabTypeAt = indexCode.indexOf('sidebarTabs.register(definition)')
  assert.ok(gateAt >= 0, 'the source gate must exist')
  assert.ok(probeAt > gateAt, 'the probe must run after the source gate')
  assert.ok(localeAt > probeAt, 'copy may only be registered after the registry probe')
  assert.ok(tabTypeAt > localeAt, 'the tab type registers after copy')
  assert.match(indexCode, /if \(sidebarTabs === null\) \{[\s\S]*?return/u)
})

test('the tab type is the frozen id/kind/guide shape', () => {
  assert.equal(indexCode.includes("const TAB_ID = '@dsh-chamber/remote-browser'"), true)
  assert.equal(indexCode.includes("const TAB_KIND = 'chamber-remote-browser'"), true)
  assert.match(indexCode, /id: TAB_ID,/u)
  assert.match(indexCode, /kind: TAB_KIND,/u)
  assert.match(indexCode, /multiple: false,/u)
  assert.match(indexCode, /id: 'open',/u)
  assert.match(indexCode, /order: 40,/u)
  // No shortcut and no command binding: the guide click is ui-sidebar-right's
  // own openTab(entry.kind); a commandId would imply a shortcut registration.
  assert.equal(indexCode.includes('commandId'), false)
  assert.equal(indexCode.includes('shortcuts'), false)
  assert.equal(stripComments(read('src/client/BrowserPanel.tsx')).includes('shortcut'), false)
})

test('body and title seats are keyed by the type id', () => {
  assert.equal(indexCode.includes("const PANE_SLOT = 'sidebar.right.pane.tab' as const"), true)
  assert.equal(indexCode.includes("const TITLE_SLOT = 'sidebar.right.pane.tab.title' as const"), true)
  const keys = indexCode.match(/key: TAB_ID,/gu) ?? []
  assert.equal(keys.length, 2, 'both seats must use key: TAB_ID')
  assert.equal(indexCode.includes('key: TAB_KIND'), false)
})

test('copy is registered for both languages', () => {
  assert.match(indexCode, /ctx\.locale\.register\(NS, \{ zh, en \}\)/u)
  assert.equal(indexCode.includes("const NS = 'dsh-chamber.sidebar.browser'"), true)
})

test('the registry probe validates the service before registering', () => {
  assert.notEqual(asSidebarRightTabs({ register() {} }), null)
  assert.equal(asSidebarRightTabs({}), null)
  assert.equal(asSidebarRightTabs(null), null)
  assert.equal(asSidebarRightTabs({ register: 'nope' }), null)
  assert.match(stripComments(read('src/client/sidebar-tabs.ts')), /typeof register === 'function'/u)
})

test('the panel has the required states and uses the anchor link leg', () => {
  const panel = read('src/client/BrowserPanel.tsx')
  for (const marker of [
    'role="alert"',
    'role="status"',
    'aria-busy={busy}',
    "anchor.target = '_blank'",
    "anchor.rel = 'noopener noreferrer'",
    'data-chamber-browser-panel=""',
  ]) {
    assert.equal(panel.includes(marker), true, marker)
  }
  for (const forbidden of ['<iframe', '<webview', 'srcDoc', 'dangerouslySetInnerHTML']) {
    assert.equal(panel.includes(forbidden), false, forbidden)
  }
})

test('the stylesheet follows the token and hairline rules', () => {
  const css = read('src/client/BrowserPanel.module.css')
  const cssCode = stripComments(css)
  assert.equal(cssCode.includes('box-shadow'), false, 'no elevation shadow beside a neutral border')
  assert.equal(cssCode.includes('position: fixed'), false)
  assert.equal(cssCode.includes('9999px'), false)
  assert.equal(/border-radius:\s*(?:999|50%)/u.test(cssCode), false)
  // Named tokens are pinned to the set the pinned theme declares; an invented
  // name silently unthemes the surface instead of failing. TODO(W0/pin): the
  // final gate is verify:style-tokens against 0.2.2-rc.1.
  const allowed = new Set([
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-label-dimmed',
    '--dsw-alias-label-primary-foreground',
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-border-l2',
    '--dsw-alias-border-l3',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-button-primary-hover',
    '--dsw-alias-button-primary-dimmed',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-link',
    '--dsw-focus-ring-color',
    '--dsw-focus-ring-width',
    '--dsw-font-family',
    '--dsw-font-mono',
    '--dsw-font-xxs-12',
    '--dsw-radius-sm',
    '--dsw-radius-xs',
  ])
  const used = new Set(cssCode.match(/--dsw-[a-z0-9-]+/gu) ?? [])
  for (const token of used) assert.equal(allowed.has(token), true, token)
})

test('sources never value-import a module this worktree does not provide', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const next = join(dir, entry.name)
      if (entry.isDirectory()) walk(next)
      else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(next)
    }
  }
  walk('src')
  assert.ok(files.length >= 8, `expected the package sources, found ${files.length}`)
  for (const file of files) {
    const text = stripComments(read(file))
    for (const match of text.matchAll(/^import\s+(?!type\b)([^'"]*['"]([^'"]+)['"])/gmu)) {
      const specifier = match[2]
      const local = specifier.startsWith('./') || specifier.startsWith('../')
      assert.ok(local || specifier === 'react', `${relative(ROOT, join(ROOT, file))} value-imports ${specifier}`)
    }
  }
})
