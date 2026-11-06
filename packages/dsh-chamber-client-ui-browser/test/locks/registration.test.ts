/**
 * Source-text locks for the upstream-fork Browser plugin (design 28 §16).
 *
 * The node runner cannot mount React/DOM, so this suite pins the WIRING and the
 * FORK SURFACE as text:
 *   - the files copied byte-for-byte from upstream
 *     `@deepseek-ai/dsh-client-ui-sidebar-browser` 0.2.2-rc.1 are locked by
 *     SHA-256 digests (a re-copy after an upstream pin upgrade must regenerate
 *     the table deliberately — upstream-touchpoints discipline);
 *   - the documented FORK diff surface is exactly: the chamber source gate +
 *     readiness wait + per-tab forward src resolver + the forwarded page's
 *     external-url projection + the package id;
 *   - the self-built v2 launcher UI is GONE (no panel/list/notice modules);
 *   - the upstream DOM/aria/copy/store/sandbox/definition anchors survive.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { de, en, es, fr, ja, pt, ru, zh } from '../../src/client/locales.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/** Comments quote upstream shapes; every behavioral lock must read CODE. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gmu, '$1')
}

/**
 * SHA-256 of the upstream file texts (ui-sidebar-browser 0.2.2-rc.1) for every
 * file the fork copies VERBATIM. A pin upgrade regenerates this table on purpose.
 */
const UPSTREAM_VERBATIM: Readonly<Record<string, string>> = {
  'src/client/browser/BrowserNavigation.ts': '5f832a734641dce4d4442c58988f260a7cc5416c8ca2210e7fc6c26521d22ebc',
  'src/client/browser/BrowserPage.ts': 'b1da75c554e7245290dc2f61f3dfc67e69f0001a6d5d469b4c9d3ea9f1f826d2',
  'src/client/browser/BrowserPersistence.ts': '8eb0c5db55901a101df62a432ec377cd47dc14946407cc317396b5c8363ad245',
  'src/client/browser/url.ts': 'd182addd84c9a8b080622012ded2176ce6b438f998f4d6b1de220e8bd93ca0f6',
  'src/client/view/BrowserPresentation.ts': '49f421cab07c3e59c056263959af9420c51e5f2e8d753d1f2a0aea8ef0c33f17',
  'src/client/view/BrowserTitle.tsx': '52f0ca11ed86f31b488e165ebd4a5285fe8d45bda1916deb5bae1703491fb728',
  'src/client/view/Browser.module.css': 'b4acf8f453c9692ea66904c75237dc73153c4f15d2db228d751ea0c1ead54880',
  'src/client/locales.ts': 'c1443907749770d62c3c9017ca422d002553be48cb70833810dfa5c3c0961f7c',
  'src/index.ts': 'eda8f35390ed2ed274f44e678fa74d7b12e74c2bef0ba4003452810b194d8fc7',
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

test('every byte-verbatim upstream file still matches its frozen digest', () => {
  for (const [file, digest] of Object.entries(UPSTREAM_VERBATIM)) {
    assert.equal(sha256(read(file)), digest, file + ' drifted from the upstream 0.2.2-rc.1 text')
  }
})

test('package.json is a private, source-targeted chamber client package', () => {
  const manifest = JSON.parse(read('package.json')) as {
    name: string
    private?: boolean
    exports?: Record<string, unknown>
    dsh?: { client?: { platform?: string; inject?: string[] } }
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  assert.equal(manifest.name, '@dsh-chamber/dsh-chamber-client-ui-browser')
  assert.equal(manifest.private, true)
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), ['.', './client', './package.json'])
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.deepEqual(manifest.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-locale',
  ])
  assert.equal(manifest.dependencies, undefined)
  // Upstream imports must be declared (peer + dev): store/slots/primitives/...
  for (const dep of [
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-dockkit',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-shortcuts',
  ]) {
    assert.equal(manifest.peerDependencies?.[dep], 'workspace:*', dep)
    assert.equal(manifest.devDependencies?.[dep], 'workspace:*', dep)
  }
})

test('the tab definition is upstream verbatim except the package id', () => {
  const definition = stripComments(read('src/client/definition.tsx'))
  assert.match(definition, /export const BROWSER_KIND = 'browser'/u)
  assert.match(definition, /export const BROWSER_ID = '@dsh-chamber\/remote-browser'/u, 'only the id value is chamber-owned')
  assert.match(definition, /multiple: true,/u)
  assert.match(definition, /priority: 'builtin',/u)
  assert.match(definition, /id: 'new', commandId: 'browser.new' as ShortcutCommandId, order: 30,/u)
  assert.match(definition, /title: \(\) => t\('type.label'\)/u)
  assert.match(definition, /description: \(\) => t\('guide.description'\), icon: GuideArtworkBrowser/u)
})

test('the body/title seats and the store are the upstream wiring', () => {
  const index = stripComments(read('src/client/index.ts'))
  assert.match(index, /export const inject = \['slots', 'locale'\]/u)
  // Source gate BEFORE any registration/locale write.
  const gateAt = index.indexOf('resolveBrowserEntry(')
  const localeAt = index.indexOf('ctx.locale.register(NAMESPACE')
  const waitAt = index.indexOf('waitForSidebarHost(')
  assert.ok(gateAt >= 0, 'the chamber source gate must exist')
  assert.ok(localeAt > gateAt, 'copy registers only after the source gate')
  assert.ok(waitAt > localeAt, 'the readiness wait arms after copy')
  // Upstream 8-locale registration.
  assert.match(index, /ctx\.locale\.register\(NAMESPACE, \{ zh, en, ja, es, fr, de, ru, pt \}\)/u)
  // Upstream shortcut, verbatim: id, aliases, KeyT defaults, regions and resolve.
  assert.match(index, /id: 'browser\.new' as ShortcutCommandId/u)
  assert.match(index, /aliases: \['browser', 'new browser tab'\]/u)
  assert.match(index, /'web:macos': \{ code: 'KeyT', modifiers: \['primary', 'alt'\] \}/u)
  assert.match(index, /regions: \['page', 'editable', 'terminal'\], modals: \[\]/u)
  assert.match(index, /ctx\.sidebarRight\.openTabFromTarget\('browser', target\)/u)
  // Upstream store + both keyed seat registrations, keyed by the definition id.
  assert.match(index, /const store = createBrowserStore\(\)/u)
  assert.match(index, /name: 'sidebar\.right\.pane\.tab', key: BROWSER_ID, locale: NAMESPACE, store,/u)
  assert.match(index, /name: 'sidebar\.right\.pane\.tab\.title', key: BROWSER_ID, store,/u)
  assert.match(index, /keepMounted: true/u)
  // No Electron webview carrier fork: both flavors use the iframe page.
  assert.equal(index.includes('createElectronPage'), false)
  assert.equal(index.includes('dshDesktop'), false)
})

test('the forward seam is the frame src resolver plus the external-url projection', () => {
  const resolver = read('src/client/browser/ForwardFrameResolver.ts')
  assert.match(resolver, /FORWARD_TARGET_HOST = '127\.0\.0\.1'/u)
  assert.match(resolver, /controller\.attach\(/u)
  assert.match(resolver, /detachCurrent\(\)/u)
  assert.match(resolver, /controller\.dispose\(\)/u)
  assert.match(resolver, /return target\.url/u, 'local/direct targets keep the upstream URL')
  const impl = read('src/client/browser/IframeImpl.ts')
  assert.match(impl, /export interface BrowserFrameSrcResolver/u)
  assert.match(impl, /forwards\(target: BrowserTarget\): boolean/u)
  assert.match(impl, /private async resolveAndShow/u)
  assert.match(impl, /this\.handleLoadFailed\(request\.revision\)/u, 'attach failure uses the upstream failure bar')
  assert.match(impl, /this\.externalUrl = this\.resolver\.forwards\(request\.target\) \? null : undefined/u,
    'a forwarded target disables the external exit until its lease settles')
  assert.match(impl, /this\.externalUrl = url === request\.target\.url \? undefined : url/u)
  assert.match(impl, /this\.externalUrl = null/u, 'a failed forward disables the external exit')
  assert.match(resolver, /forwards\(target: BrowserTarget\): boolean \{\s*return this\.mustForward\(target\)/u)
  assert.match(read('src/client/browser/BrowserFrame.ts'), /readonly externalUrl\?: string \| null/u)
  assert.match(read('src/client/view/BrowserBody.tsx'), /frame\.externalUrl === null \? undefined : frame\.externalUrl \?\? target\?\.url/u)
  const presentation = read('src/client/view/IframePresentation.ts')
  assert.match(presentation, /element\.src = current\.url/u, 'the iframe loads the resolved URL')
  assert.match(presentation, /readonly url: string/u)
  assert.match(read('src/client/pages.ts'), /new IframeImpl\(options, presentation, resolver\)/u)
  // The upstream DOM policy is untouched by the seam.
  for (const marker of [
    "element.referrerPolicy = 'no-referrer'",
    "element.dataset.sidebarBrowserFrame = 'iframe'",
    "element.setAttribute('sandbox', WEB_BROWSER_SANDBOX)",
    "export const WEB_BROWSER_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'",
  ]) {
    assert.equal(presentation.includes(marker), true, marker)
  }
})

test('the upstream BrowserBody DOM/aria/state anchors survive', () => {
  const body = read('src/client/view/BrowserBody.tsx')
  for (const marker of [
    'className={css.root}',
    'className={css.toolbar}',
    "aria-label={t('back')}",
    "placeholder={t('address.placeholder')}",
    'className={css.viewport}',
    "window.open(externalUrl, '_blank', 'noopener,noreferrer')",
    "setSandbox(tab.id, !sandboxed)",
    "t('load.failed.detail', { code: String(error.code), description: error.description })",
    "t('restore.previous')",
    'tab.actions.bindCommands({ refresh: () => { reload(tab.id) } })',
    "tab.actions.openTab('browser', { params: { url }, revealIfOpened: false })",
  ]) {
    assert.equal(body.includes(marker), true, marker)
  }
  // The self-built launcher surface is gone.
  for (const forbidden of ['data-chamber-browser-panel', 'remote.section', 'notice.', 'BrowserPanel', 'remote.limit']) {
    assert.equal(body.includes(forbidden), false, forbidden)
  }
})

test('the self-built v2 launcher modules are deleted (no dead faces)', () => {
  for (const gone of [
    'src/client/BrowserPanel.tsx',
    'src/client/BrowserPanel.module.css',
    'src/client/sidebar-tabs.ts',
    'src/shared/address.ts',
    'src/shared/frame-policy.ts',
    'src/shared/launcher-model.ts',
    'src/shared/navigation-model.ts',
    'src/shared/target-store.ts',
    'src/locales.ts',
  ]) {
    assert.equal(existsSync(join(ROOT, gone)), false, gone + ' must be deleted')
  }
})

test('the upstream 8 dictionary key sets stay equal', () => {
  const keys = Object.keys(zh).sort()
  assert.equal(keys.length, 26, 'the upstream dictionary key count changed — re-audit the fork copy')
  for (const [name, dictionary] of Object.entries({ en, ja, es, fr, de, ru, pt })) {
    assert.deepEqual(Object.keys(dictionary).sort(), keys, name + ' dictionary drifted')
    for (const key of keys) assert.notEqual(String((dictionary as Record<string, string>)[key]).trim(), '', name + '.' + key)
  }
  // Upstream copy (zh), frozen: these are the user-visible strings upstream ships.
  assert.equal(zh['type.label'], '浏览器')
  assert.equal(zh['address.placeholder'], '输入 HTTP(S) 地址')
  assert.equal(zh['load.failed'], '页面加载失败；请刷新重试或在系统浏览器中打开。')
  assert.equal(zh['address.unknown'], '页面已跳转；当前载体无法读取新的 URL。')
  assert.equal(en['type.label'], 'Browser')
})

test('the store persists under the upstream key', () => {
  assert.match(read('src/client/browser/store.ts'), /persist: 'dsh\.sidebar-browser\.v1'/u)
})

test('the fork adaptations are the documented type-only ones', () => {
  // dock-kit's repo ambient face is a shorthand module: the named TabId import is
  // replaced by a local alias (type-only; pinned by comment markers).
  for (const file of ['src/client/browser/BrowserController.ts', 'src/client/browser/store.ts']) {
    const source = read(file)
    assert.equal(source.includes("from '@deepseek-ai/dsh-client-ui-dockkit'"), false, file)
    assert.match(source, /type TabId = string/u)
    assert.match(source, /FORK ADAPTATION/u)
  }
})
