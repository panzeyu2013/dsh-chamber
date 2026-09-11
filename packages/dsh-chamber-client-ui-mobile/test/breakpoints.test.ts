/**
 * Breakpoint / stylesheet strategy tests (design 17 §18.4.2): the CSS must
 * be fully media-query scoped (desktop untouched), both tiers must carry
 * the coarse-pointer guard (the "PC leak" lesson), and the JS behavior
 * layer must share the same tier query.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MOBILE_CSS, VIEWPORT_TOKENS } from '../src/client/styles.ts'
import { PHONE_TIER_QUERY, TOUCH_TIER_QUERY } from '../src/client/composer.ts'

test('touch tier guard: drawer rules live under (pointer: coarse)', () => {
  assert.ok(
    MOBILE_CSS.includes('@media (max-width: 1023px) and (pointer: coarse)'),
    'main tier must carry the coarse-pointer guard',
  )
  const drawerBlock = MOBILE_CSS.slice(MOBILE_CSS.indexOf('@media (max-width: 1023px)'))
  assert.ok(drawerBlock.includes('[data-mobile-role="sidebar"]'))
  assert.ok(drawerBlock.includes('grid-template-columns: 0 minmax(0, 1fr) 0'))
})

test('phone tier also carries the coarse-pointer guard', () => {
  assert.ok(MOBILE_CSS.includes('@media (max-width: 768px) and (pointer: coarse)'))
})

test('JS behavior tier query matches the CSS main tier', () => {
  assert.equal(TOUCH_TIER_QUERY, '(max-width: 1023px) and (pointer: coarse)')
})

test('every rule lives inside a media query (desktop byte-identical)', () => {
  // Strip every balanced @media block (brace-paired scan — the CSS contains
  // nested braces like ::before { content: '' }); what remains must be the
  // single deliberate desktop default (hamburger/backdrop hidden) and
  // nothing else — any other rule would leak onto desktop.
  let rest = MOBILE_CSS
  let cursor = 0
  while (true) {
    const start = rest.indexOf('@media', cursor)
    if (start === -1) break
    const open = rest.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let i = open; i < rest.length; i++) {
      if (rest[i] === '{') depth += 1
      else if (rest[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i + 1; break }
      }
    }
    assert.ok(end !== -1, 'unbalanced media block')
    rest = rest.slice(0, start) + rest.slice(end)
    cursor = start
  }
  const stripped = rest.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '')
  assert.equal(
    stripped,
    '.dsh-mobile-nav-toggle,.dsh-mobile-backdrop{display:none;}',
    `unexpected unscoped rules: ${stripped.slice(0, 200)}`,
  )
})

test('the drawer toggle has an explicit desktop default: none (no ghost button)', () => {
  // The media-query-free default hides both overlay entries; the touch tier
  // flips the toggle to inline-flex.
  const outside = MOBILE_CSS.slice(0, MOBILE_CSS.indexOf('@media (max-width: 1023px)'))
  assert.ok(outside.includes('.dsh-mobile-nav-toggle,'))
  assert.ok(outside.includes('.dsh-mobile-backdrop'))
  assert.ok(outside.includes('display: none;'))
  assert.ok(MOBILE_CSS.includes('display: inline-flex'))
})

test('drawer stays within the official sidebar width (280px) and uses official elevation', () => {
  assert.ok(MOBILE_CSS.includes('width: min(86vw, 280px)'))
  // Raised surfaces take an elevation token (0.5px hairline stroke + soft
  // shadows). The legacy --dsw-shadow-lv* scale is what upstream keeps only
  // for Toast / HoverCard / ImageLightbox.
  assert.ok(MOBILE_CSS.includes('box-shadow: var(--dsw-elevation-prominent)'))
  // Prose may NAME the legacy scale while explaining why it is not used, so
  // the assertion targets the declaration, not the string anywhere.
  assert.ok(!MOBILE_CSS.includes('box-shadow: var(--dsw-shadow-lv'),
    'the drawer must not fall back to the legacy shadow scale')
})

test('motion uses official tokens with a reduced-motion branch', () => {
  assert.ok(MOBILE_CSS.includes('var(--ds-transition-duration-slow'))
  assert.ok(MOBILE_CSS.includes('var(--ds-ease-in-out'))
  assert.ok(MOBILE_CSS.includes('@media (prefers-reduced-motion: reduce)'))
})

test('backdrop dims the conversation behind the open drawer', () => {
  assert.ok(MOBILE_CSS.includes('.dsh-mobile-backdrop'))
  assert.ok(MOBILE_CSS.includes('var(--dsw-alias-bg-mask-1'))
  assert.ok(MOBILE_CSS.includes('z-index: 74'))
})

test('mobile layering pairs each selector with its own z-index', () => {
  // Backdrop 74 < drawer 75 < toggle 76 must stay above the official
  // fullscreen right panel (40), its float layer (60) and dockkit (70).
  // Assert the SELECTOR→value pairing (not just that the numbers appear
  // somewhere) so swapping two values fails.
  const tier = normalizeTouchTier()
  const drawer = cssBlock(tier, '[data-mobile-role="sidebar"]')
  assert.ok(drawer !== null && drawer.includes('z-index: 75'), 'drawer must sit at 75')
  const backdrop = cssBlock(tier, '[data-mobile-frame]:not([data-sidebar-collapsed]) .dsh-mobile-backdrop')
  assert.ok(backdrop !== null && backdrop.includes('z-index: 74'), 'backdrop must sit at 74')
  const toggle = cssBlock(tier, '.dsh-mobile-nav-toggle')
  assert.ok(toggle !== null && toggle.includes('z-index: 76'), 'toggle must sit at 76')
})

test('the retired mechanisms leave no trace in the stylesheet', () => {
  assert.ok(!MOBILE_CSS.includes('data-mobile-dismiss'), 'session-log stamping CSS must be gone')
  // No self-drawn right-column overlay: the third track stays grid-locked and
  // the official right surface owns the mobile presentation.
  const tier = normalizeTouchTier()
  const rightColumn = cssBlock(tier, '[data-mobile-role="details"]')
  assert.ok(rightColumn !== null && rightColumn.includes('grid-column: 3'), 'the grid lock stays')
  assert.ok(!/\[data-mobile-role="details"\][^{]*\{[^}]*position:\s*fixed/.test(tier), 'no self-drawn fixed overlay')
  // Dockkit split chrome is hidden on touch.
  assert.ok(MOBILE_CSS.includes('[data-dockkit-divider]'))
  assert.ok(MOBILE_CSS.includes('[data-dockkit-split-button]'))
  // The composer-bar row rules use the production class-name shape:
  // `[hash]_[local]` (upstream cssModules pattern), matched by SUFFIX with a
  // multi-class arm. The old infix form `[class*="_row_"]` matched nothing in
  // the instance bundle — `_<local>_<hash>_<idx>` is the chamber shell's Vite
  // naming, never the served bundle's (2026-09 audit, P1).
  const phone = normalizePhoneTier()
  assert.ok(phone.includes(':is([class$="_row"], [class*="_row "])'))
  assert.ok(phone.includes(':is([class$="_trigger"], [class*="_trigger "])'))
  assert.ok(!/\[class\*="_[A-Za-z]+_"\]/.test(phone), 'no infix local-name selectors remain in the phone tier')
  // 2026-09-11 upstream-alignment T17a: the CSS hamburger is retired with the
  // official panel glyph; no self-drawn control may come back.
  assert.ok(!MOBILE_CSS.includes('dsh-mobile-nav-toggle-bars'), 'the CSS hamburger must be gone')
})

test('settings full-screen rule targets the official settings dialog shape', () => {
  assert.ok(MOBILE_CSS.includes('[role="dialog"][aria-modal="true"]:has([data-slot="settings.header"])'))
})

test('settings sheet stacks vertically with a pinned header and scrolling options', () => {
  // Whitespace-normalized phone tier (comments stripped): assertions are
  // anchored to selector+block pairs, not to raw formatting.
  const phone = normalizePhoneTier()
  const sheet = '[role="dialog"][aria-modal="true"]:has([data-slot="settings.header"])'
  // Panel: desktop flex-row (188px nav rail + content) → phone column stack.
  const panel = cssBlock(phone, sheet)
  assert.ok(panel !== null && panel.includes('position: fixed !important;'), 'sheet goes full-screen')
  assert.ok(panel !== null && panel.includes('flex-direction: column !important;'), 'sheet stacks vertically')
  // Nav rail → top strip: title + horizontal chip row that scrolls.
  const nav = cssBlock(phone, `${sheet} > nav`)
  assert.ok(nav !== null && nav.includes('flex-direction: row;'), 'nav becomes a row strip')
  const navList = cssBlock(phone, `${sheet} > nav > div:last-child`)
  assert.ok(navList !== null && navList.includes('overflow-x: auto;'), 'chip row scrolls horizontally')
  assert.ok(navList !== null && navList.includes('flex-direction: row;'), 'chip row lays out horizontally')
  // The content column keeps a fallback scroll (never a hard lock) and the
  // header row (actions + Close) is pinned — sticky when the column itself
  // ever scrolls; the options area is the inner scroller.
  const content = cssBlock(phone, `${sheet} > div:last-child`)
  assert.ok(content !== null && content.includes('overflow-y: auto;'), 'content column stays a fallback scroller')
  // The header row is anchored on the documented [data-slot="settings.action"]
  // + [data-slot="settings.close"] seams, NOT on a positional div:first-child
  // (2026-09-11 upstream-alignment T17c): the official actions cell holds the
  // action outlet one level down and the close button holds the close outlet,
  // so the row is the only element carrying both.
  const headerRow = cssBlock(
    phone,
    `${sheet} > div:last-child > div:has([data-slot="settings.action"]):has([data-slot="settings.close"])`,
  )
  assert.ok(headerRow !== null && headerRow.includes('position: sticky;'), 'header row is pinned (sticky)')
  assert.ok(headerRow !== null && headerRow.includes('flex: none;'), 'header row never grows')
  const positionalHeader = cssBlock(phone, `${sheet} > div:last-child > div:first-child`)
  assert.equal(positionalHeader, null, 'the sticky row must not be anchored on a positional child index')
  const options = cssBlock(phone, `${sheet} > div:last-child > div:last-child`)
  assert.ok(options !== null && options.includes('overflow-y: auto;'), 'options area is the inner scroller')
})

test('settings section inner grids: only the Models provider row degrades (cards stay upstream-owned)', () => {
  // Suffix match on the production name shape `[hash]_[local]` (plus the
  // multi-class arm) — see the composer-tier case above for why the infix
  // form was dead (2026-09 audit, P1).
  const phone = normalizePhoneTier()
  const modelRow = cssBlock(phone, '[data-slot="settings.section"] :is([class$="_modelRow"], [class*="_modelRow "])')
  assert.ok(modelRow !== null && modelRow.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);'))
  // 2026-09-11 upstream-alignment T17b: the ".cards" arm is DELETED. TWO card
  // grids live under this section, on two different upstream rules: the
  // inventory grid collapses itself at max-width 680px (so the chamber arm
  // only ever contradicted upstream inside 681-768px), while the Agent-presets
  // grid (`repeat(auto-fill, minmax(268px, 1fr))`, no upstream breakpoint) is
  // two-column from about 580px of viewport width — the chamber arm changed
  // ITS layout across about 580-768px, which the previous one-grid note did
  // not cover (2026-09-11 review-fix F3).
  assert.ok(!phone.includes('_cards'), 'the chamber must not override either upstream card grid')
})

test('no blanket aria-modal cap: official dialog geometries own the viewport fit (T6)', () => {
  // 2026-09-11 upstream-alignment T6: the phone tier used to cap EVERY
  // non-settings aria-modal dialog at `100vw - 24px`. That is
  // over-constrained against ui-attachment's ImageLightbox, whose
  // role=dialog backdrop is `position: fixed; inset: 0` (a full-bleed layer
  // with an absolute inset-0 mask): max-width shrank it to 100vw-24px,
  // left-anchored, leaving a 24px undimmed click-through strip on the right.
  // The other two aria-modal producers already fit themselves (the settings
  // panel owns this sheet; the ui-primitives Modal root pads 24px and caps
  // its dialog at min(380px, 100%)). No rule may re-introduce a blanket cap.
  const code = stripComments(MOBILE_CSS)
  assert.ok(
    !/\[role="dialog"\]\[aria-modal="true"\]:not\(/.test(code),
    'no blanket aria-modal cap (the settings sheet :has() rules are the only aria-modal anchors)',
  )
  // The only max-width an aria-modal rule may set is the sheet RELEASING its
  // own desktop cap (`none`); anything numeric is a viewport-fit override.
  const ariaModalMaxWidths = [...code.matchAll(/aria-modal="true"[^{]*\{([^}]*)\}/g)]
    .flatMap(rule => [...rule[1].matchAll(/max-width:\s*([^;]+)/g)].map(value => value[1].trim()))
  assert.deepEqual(ariaModalMaxWidths, ['none !important'], 'no aria-modal dialog may be width-capped')
  // Every aria-modal rule that remains belongs to the settings sheet.
  const ariaModalSelectors = [...code.matchAll(/([^{}]+)\{/g)]
    .map(match => (match[1] ?? '').trim())
    .filter(selector => selector.includes('aria-modal'))
  assert.ok(ariaModalSelectors.length > 0, 'the settings sheet anchors must stay')
  for (const selector of ariaModalSelectors) {
    assert.ok(
      selector.includes(':has([data-slot="settings.header"])'),
      `only settings-sheet rules may anchor on aria-modal: ${selector}`,
    )
  }
  // The 16px focus-zoom floor for dialog fields stays.
  const phone = normalizePhoneTier()
  const fields = cssBlock(
    phone,
    '[role="dialog"] input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), '
      + '[role="dialog"] select, [role="dialog"] textarea',
  )
  assert.ok(fields !== null && fields.includes('max(16px, var(--dsh-content-font-size, 16px)) !important;'))
})

/** The phone tier, whitespace-normalized with comments stripped: whitespace
 *  and formatting changes never break the assertions; comments (which may
 *  quote declarations) never satisfy them. */
function normalizePhoneTier(): string {
  return MOBILE_CSS
    .slice(MOBILE_CSS.indexOf('@media (max-width: 768px)'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
}

/** The touch tier (1023px) with comments stripped and whitespace normalized —
 *  the drawer/backdrop/toggle and the column grid locks live here, not on the
 *  phone tier. */
function normalizeTouchTier(): string {
  return MOBILE_CSS
    .slice(MOBILE_CSS.indexOf('@media (max-width: 1023px)'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
}

/** The CSS block `selector { … }` (normalized form), or null. Anchored on the
 *  selector followed by its opening brace: a LONGER rule that merely starts
 *  with the same prefix (e.g. `A > B > C` for `A > B`) can never satisfy a
 *  shorter selector's assertion (prefix false-positive). */
function cssBlock(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`)
  if (at === -1) return null
  const open = css.indexOf('{', at)
  if (open === -1) return null
  const close = css.indexOf('}', open)
  if (close === -1) return null
  return css.slice(at, close + 1)
}

test('safe-area tokens present on the phone tier', () => {
  assert.ok(MOBILE_CSS.includes('env(safe-area-inset-bottom)'))
  assert.ok(MOBILE_CSS.includes('env(safe-area-inset-top)'))
})

test('composer font keeps the official content-size preference above 16px', () => {
  assert.ok(MOBILE_CSS.includes('max(16px, var(--dsh-content-font-size, 16px))'))
})

test('no user-scalable lock (WCAG 1.4.4); viewport tokens add fit-cover + resizes-content', () => {
  assert.deepEqual(VIEWPORT_TOKENS, ['viewport-fit=cover', 'interactive-widget=resizes-content'])
  assert.ok(!MOBILE_CSS.includes('user-scalable'))
})

test('phone tier query is the stylesheet phone tier', () => {
  assert.ok(MOBILE_CSS.includes(`@media ${PHONE_TIER_QUERY}`), 'phone tier string must match the stylesheet')
})

test('sticky-hover tooltip suppression is coarse-gated and aria-label scoped', () => {
  // Comments quote selectors verbatim, so every assertion below runs on the
  // COMMENT-STRIPPED sheet: prose must never satisfy a rule assertion
  // (cross-check: the earlier `includes` form passed even after the real rule
  // was reverted to a blanket hide).
  const code = stripComments(MOBILE_CSS)
  // Exactly ONE selector in the whole sheet may TARGET a tooltip bubble —
  // reverting to a blanket `[role="tooltip"]` (or an unquoted/~= variant, or a
  // first-rule-in-block form) makes this set wrong regardless of formatting.
  // `:not(...)` clauses are stripped first: the drag-handle rule legitimately
  // EXCLUDES bubbles via `:not([role="tooltip"])` and must not be counted.
  const tooltipSelectors = [...code.matchAll(/([^{}]+)\{/g)]
    .map(match => (match[1] ?? '').trim())
    .map(selector => selector.replace(/:not\([^)]*\)/g, ''))
    .filter(selector => /\[role\s*[~^$*|]?=\s*["']?tooltip["']?\]/.test(selector))
  assert.deepEqual(
    tooltipSelectors,
    ['button[aria-label] + [role="tooltip"][data-side]'],
    'only bubbles duplicating an accessible name may be hidden',
  )
  // The declaration itself is pinned (a `display: block` mutant must fail).
  assert.match(
    code,
    /button\[aria-label\] \+ \[role="tooltip"\]\[data-side\]\s*\{\s*display:\s*none\s*!important;/,
  )
  // ...and it must sit inside the width-independent coarse+hover tier, which
  // opens before the touch tier (an iPad in landscape is 1024px+ and still
  // taps; a mouse flips hover and stands the rule down).
  const coarseAt = code.indexOf('@media (pointer: coarse) and (hover: none)')
  const touchAt = code.indexOf('@media (max-width: 1023px)')
  const ruleAt = code.indexOf('button[aria-label] + [role="tooltip"][data-side]')
  assert.ok(coarseAt !== -1, 'the coarse+hover chrome tier must exist')
  assert.ok(ruleAt > coarseAt && ruleAt < touchAt, 'the rule must live in the coarse+hover tier, not the touch tier')
})

test('keyboard compensation CSS rides the plugin frame stamp, never official attributes', () => {
  const code = stripComments(MOBILE_CSS)
  assert.ok(code.includes('[data-mobile-frame][data-mobile-kbd] [data-phase="active"] [data-conversation-scroll]'))
  assert.ok(code.includes('padding-bottom: var(--chamber-mobile-kbd-offset, 0px) !important;'))
  assert.ok(code.includes('[data-mobile-frame][data-mobile-kbd] [data-phase="active"] [data-composer-seat]'))
  assert.ok(code.includes('bottom: var(--chamber-mobile-kbd-offset, 0px) !important;'))
  // The phone-tier safe-area inset must be neutralized while armed (up to
  // ~34px of dead space below the raised seat otherwise).
  assert.match(
    code,
    /\[data-mobile-frame\]\[data-mobile-kbd\] \[data-phase="active"\] \[data-composer-seat\]\s*\{[^}]*padding-bottom:\s*0\s*!important;/,
  )
})

test('the drawer fields carry the 16px floor (no iOS focus zoom from the drawer)', () => {
  // iOS focus-zooms on any editable below 16px and the page STAYS zoomed; the
  // drawer's 13px session search was the remaining trigger (cross-check P1).
  const code = stripComments(MOBILE_CSS)
  assert.match(
    code,
    /\[data-mobile-role="sidebar"\] input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\)[^{]*\{\s*font-size:\s*max\(16px, var\(--dsh-content-font-size, 16px\)\) !important;/,
  )
})

/** The sheet with comments stripped: selector/declaration assertions must not
 *  be satisfiable by prose that quotes them. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}
