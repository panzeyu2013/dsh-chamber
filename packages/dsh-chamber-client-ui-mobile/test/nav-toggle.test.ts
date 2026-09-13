/**
 * Drawer-toggle alignment lock (2026-09-11 upstream-alignment T17a).
 *
 * The floating `shell.overlay` entry is the mobile substitute for the
 * official sidebar toggle, and it must BE that control rather than a
 * hand-drawn look-alike: the official panel glyph
 * (`IconPanelLeftOutline16`, ui-primitives — a client baseline module, so the
 * bundle requests it without a package dependency) and the official state
 * label (one state-carrying `aria-label`, no `aria-haspopup`) plus the
 * disclosure state this out-of-canvas substitute needs of its own — the
 * official control carries the label alone, so the claim under test is
 * "official name + one truthful attribute", never "the official attribute
 * list" (2026-09-11 review-fix F4a). The former CSS hamburger and its
 * `aria-haspopup="true"` claim are retired; this spec locks both, plus the
 * parts the touch tier genuinely owns (the 44px box and the tap-absorbing
 * backdrop). Source-text assertions are the family convention for a component
 * whose DOM behavior is device-gated (design 17 §18.6).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MOBILE_CSS } from '../src/client/styles.ts'

const COMPONENT = readFileSync(new URL('../src/client/MobileNavToggle.tsx', import.meta.url), 'utf8')

/** The same source with comments stripped: a rule assertion must be satisfied
 *  (or broken) by CODE, never by prose that names the rule. */
const CODE = COMPONENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The toggle button's JSX opening tag (attributes included). */
function toggleTag(): string {
  const match = /<button\b[^>]*className="dsh-mobile-nav-toggle"[^>]*>/s.exec(CODE)
  assert.ok(match !== null, 'the toggle button must keep its className hook')
  return match[0]
}

test('the toggle draws the official panel glyph from the ui-primitives baseline', () => {
  assert.match(
    CODE,
    /import \{ IconPanelLeftOutline16 \} from '@deepseek-ai\/dsh-client-ui-primitives'/,
    'the official glyph must be imported from the baseline module',
  )
  assert.match(CODE, /<IconPanelLeftOutline16 size=\{18\} \/>/, 'the glyph renders at the official rail size')
})

test('the toggle carries the official state label plus its own disclosure state, and no haspopup', () => {
  const tag = toggleTag()
  const ariaAttributes = [...tag.matchAll(/\baria-[a-z]+(?==)/g)].map(match => match[0])
  assert.deepEqual(
    ariaAttributes,
    ['aria-label', 'aria-expanded'],
    'only the official accessible name and the disclosure state may be claimed',
  )
  // The retired claim is asserted on the COMMENT-STRIPPED source: the module
  // header names aria-haspopup while explaining why it is gone, and prose must
  // never satisfy OR break a rule assertion (the package convention).
  assert.ok(!CODE.includes('aria-haspopup'), 'aria-haspopup was an invented claim: the drawer is not a popup')
  // The label is the official toggle's own open/collapse label pair.
  assert.ok(tag.includes("t('dsh-chamber.mobile.drawer.close')"))
  assert.ok(tag.includes("t('dsh-chamber.mobile.drawer.open')"))
  // The state really is mirrored (the label pair above is state-driven).
  assert.match(CODE, /hasAttribute\('data-sidebar-collapsed'\)/)
})

test('no self-drawn glyph remains, and the icon rides the official rail ink', () => {
  assert.ok(!MOBILE_CSS.includes('dsh-mobile-nav-toggle-bars'), 'the CSS hamburger must stay retired')
  assert.ok(!CODE.includes('dsh-mobile-nav-toggle-bars'), 'the component must not reference the retired bars')
  const toggle = cssBlock(MOBILE_CSS, '.dsh-mobile-nav-toggle')
  assert.ok(toggle !== null, 'the toggle rule must exist')
  assert.ok(
    toggle.includes('color: var(--dsw-alias-label-primary);'),
    'the glyph rides the official collapsed-rail icon ink (it draws currentColor)',
  )
  assert.ok(!/content:\s*''/.test(toggle), 'no pseudo-element glyph may be drawn by hand')
})

test('the touch tier keeps what the official control cannot give it: 44px box + backdrop', () => {
  const toggle = cssBlock(MOBILE_CSS, '.dsh-mobile-nav-toggle')
  assert.ok(toggle !== null && toggle.includes('width: 44px;') && toggle.includes('height: 44px;'))
  assert.ok(toggle.includes('z-index: 76;'), 'the floating entry stays above the backdrop (74) and drawer (75)')
  assert.ok(MOBILE_CSS.includes('.dsh-mobile-backdrop'), 'the tap-absorbing backdrop stays')
})

/** The `selector { … }` block from the (already whitespace-normalized) sheet. */
function cssBlock(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`)
  if (at === -1) return null
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  if (open === -1 || close === -1) return null
  return css.slice(at, close + 1)
}
