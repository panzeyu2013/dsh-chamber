/**
 * Wiring locks for the mobile client entry's tier-synced assets (design 17
 * §18.4.2 PC-leak invariant). The entry cannot be imported by a plain
 * `node test/…` run (module-scope DOM install + cordis/TSX imports), so
 * the token surgery and the theme mirror live in viewport-assets.ts
 * (behaviorally unit-tested in test/dom/viewport-assets.test.ts) and this file
 * pins the entry's wiring: the matchMedia change drives the sync through the
 * injected module, leaving the tier retracts BOTH assets, and the disposer
 * unhooks the listener, the body observer and the DOM writes together.
 *
 * Source locks match comment-stripped source, so prose cannot satisfy them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')
/** Comment-stripped: a lock must be satisfied by CODE, never by the prose. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the viewport tokens are tier-synced by a live matchMedia change listener', () => {
  assert.match(CODE, /touchTier\.addEventListener\('change', syncAssets\)/,
    'the tier flip must drive the sync, not a one-shot install-time stamp')
  assert.match(CODE, /touchTier\.removeEventListener\('change', syncAssets\)/,
    'the disposer must unhook the tier listener')
  // Leaving the tier RETRACTS both assets (the sync is total, not apply-only).
  assert.match(CODE, /if \(!touchTier\.matches\) \{[\s\S]*?assets\.release\(\)/,
    'a non-matching tier must release without touching a meta')
  assert.match(CODE, /assets\.sync\(\)/, 'a matching tier applies both assets through the module')
})

test('the entry DELEGATES the token surgery to viewport-assets.ts (no shadow copy)', () => {
  assert.match(CODE,
    /import \{ createViewportAssets, type ViewportDocumentLike \} from '\.\/viewport-assets\.ts'/,
    'the entry must consume the injected asset module')
  assert.match(CODE, /createViewportAssets\(\s*document as unknown as ViewportDocumentLike,/,
    'the module must be fed the live document through its injectable face')
  assert.ok(!CODE.includes('applyViewportTokens') && !CODE.includes('stripViewportTokens'),
    'the keyed surgery must not be inlined into the entry (single implementation)')
  assert.ok(!CODE.includes('meta[name="viewport"]'),
    'the entry must not query the viewport meta itself — the module owns the lifecycle')
})

test('theme-color is created/held only inside the touch tier', () => {
  const gate = CODE.indexOf('if (!touchTier.matches)')
  const sync = CODE.indexOf('assets.sync()')
  assert.notEqual(gate, -1, 'the tier gate must exist in the sync')
  assert.notEqual(sync, -1, 'the sync must apply the assets')
  assert.ok(sync > gate,
    'the theme-color meta is only ever touched after the tier gate (no desktop leak)')
  assert.match(CODE, /new MutationObserver\(\(\) => assets\.syncTheme\(\)\)/,
    'the body-attribute observer re-mirrors only theme-color')
  assert.match(CODE, /assets\.release\(\)/, 'leaving the tier must release the theme mirror')
  assert.ok(!CODE.includes('meta[name="theme-color"]'),
    'the theme-color node handling belongs to viewport-assets.ts')
})

test('the disposer retracts the listener, the observer and the DOM writes together', () => {
  assert.match(
    CODE,
    /disposers\.push\(\(\) => \{\s*touchTier\.removeEventListener\('change', syncAssets\)\s*themeObserver\?\.disconnect\(\)\s*themeObserver = null\s*assets\.release\(\)/,
    'one disposer owns the listener, the theme observer and both DOM writes',
  )
})
