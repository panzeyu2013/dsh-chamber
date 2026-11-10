/**
 * Source-text locks for the native-guest Browser plugin (design 28 v3, ADR-0004).
 *
 * The node runner cannot mount React/DOM, so this suite pins the WIRING and the
 * FORK SURFACE as text:
 *   - the files copied byte-for-byte from upstream
 *     `@deepseek-ai/dsh-client-ui-sidebar-browser` 0.2.2-rc.1 are locked by
 *     SHA-256 digests (a re-copy after an upstream pin upgrade must regenerate
 *     the table deliberately — upstream-touchpoints discipline);
 *   - the iframe carrier is GONE: no `IframeImpl`/`IframePresentation`, no
 *     sandbox switch, no `unknown` address state;
 *   - the native guest carrier is present: bridge guard + acquire/navigate/
 *     command/frame + the four pushes, and the forward resolver answers a
 *     recordRef instead of a frame URL.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Files still copied from upstream (v3 carrier keeps the upstream UI, address,
 * persistence and history model; the carrier-only files left this table when the
 * native guest replaced the iframe). BrowserNavigation.ts carries comment-only v3
 * rewording (iframe → native guest); its digest pins that deliberate text so an
 * upstream re-copy is still noticed.
 */
const UPSTREAM_VERBATIM: Readonly<Record<string, string>> = {
  'src/client/browser/BrowserNavigation.ts': '1ae29f62f9f9ed90871c66f96a5ba48d40ab4350cf078d5bf57ff59ffe543f66',
  'src/client/browser/BrowserPersistence.ts': '8eb0c5db55901a101df62a432ec377cd47dc14946407cc317396b5c8363ad245',
  'src/client/browser/url.ts': 'd182addd84c9a8b080622012ded2176ce6b438f998f4d6b1de220e8bd93ca0f6',
  'src/client/view/BrowserPresentation.ts': '49f421cab07c3e59c056263959af9420c51e5f2e8d753d1f2a0aea8ef0c33f17',
  'src/client/view/BrowserTitle.tsx': '52f0ca11ed86f31b488e165ebd4a5285fe8d45bda1916deb5bae1703491fb728',
  'src/index.ts': 'eda8f35390ed2ed274f44e678fa74d7b12e74c2bef0ba4003452810b194d8fc7',
}

test('every upstream-derived file still matches its frozen digest', () => {
  for (const [file, digest] of Object.entries(UPSTREAM_VERBATIM)) {
    assert.equal(sha256(read(file)), digest, file + ' drifted from its frozen 0.2.2-rc.1/v3 text')
  }
})

test('the iframe carrier is deleted, not merely unregistered', () => {
  for (const file of ['src/client/browser/IframeImpl.ts', 'src/client/view/IframePresentation.ts']) {
    assert.equal(existsSync(join(ROOT, file)), false, file + ' must stay deleted (native guest carrier)')
  }
})

test('the native guest carrier exposes the five invokes and four pushes', () => {
  const bridge = read('src/client/browser/BrowserBridge.ts')
  for (const name of ['acquire', 'release', 'navigate', 'command', 'frame']) {
    assert.match(bridge, new RegExp(name + '\\(input'), 'missing invoke ' + name)
  }
  for (const name of ['state', 'openRequested', 'input', 'forwardNeeded']) {
    assert.match(bridge, new RegExp(name + '\\(listener'), 'missing push ' + name)
  }
  assert.match(bridge, /forward-needed/i, 'the forward-needed push must stay documented')
})

test('the page factory is the native guest, and registration is carrier-gated', () => {
  const pages = read('src/client/pages.ts')
  assert.match(pages, /createNativeGuestPage/)
  assert.doesNotMatch(pages, /IframeImpl|IframePresentation/)
  const index = read('src/client/index.ts')
  assert.match(index, /probeBrowserBridge/)
  assert.match(index, /chamberBrowser|dshChamber/)
  assert.match(index, /createNativeGuestPage/)
  assert.doesNotMatch(index, /createIframePage/)
  // keepMounted stays true so switching tabs/sessions never destroys the guest.
  assert.match(index, /keepMounted: true/)
})

test('the forward resolver answers a recordRef, never a frame URL', () => {
  const resolver = read('src/client/browser/ForwardFrameResolver.ts')
  assert.match(resolver, /kind: 'forward'/)
  assert.match(resolver, /recordId/)
  assert.match(resolver, /kind: 'direct'/)
  assert.doesNotMatch(resolver, /frameUrl/)
  // Both loopback spellings are the remote loopback target (design 28 §1).
  assert.match(resolver, /FORWARD_TARGET_HOSTS/)
  assert.match(resolver, /'localhost'/)
})

test('iframe-era chrome is gone: no sandbox switch, no unknown address state', () => {
  const body = read('src/client/view/BrowserBody.tsx')
  assert.doesNotMatch(body, /setSandbox|sandbox\.|addressUnknown|address\.changed|address\.unknown/)
  const frame = read('src/client/browser/BrowserFrame.ts')
  assert.doesNotMatch(frame, /'unknown'|sandboxEnabled|BrowserSandboxControl/)
  const locales = read('src/client/locales.ts')
  assert.doesNotMatch(locales, /sandbox\.|address\.changed|address\.unknown/)
})

test('the tab implementation id stays chamber-owned and the kind stays upstream', () => {
  const definition = read('src/client/definition.tsx')
  assert.match(definition, /'@dsh-chamber\/remote-browser'/)
  assert.match(definition, /BROWSER_KIND = 'browser'/)
})

test('the plugin registers the upstream namespace and the eight locales', () => {
  const index = read('src/client/index.ts')
  assert.match(index, /NAMESPACE = 'sidebarBrowser'/)
  assert.match(index, /zh, en, ja, es, fr, de, ru, pt/)
})
