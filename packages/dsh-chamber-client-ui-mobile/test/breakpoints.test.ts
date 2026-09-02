/**
 * Breakpoint / stylesheet strategy tests (design 17 §18.4.2): the CSS must
 * be fully media-query scoped (desktop untouched), both tiers must carry
 * the coarse-pointer guard (the "PC leak" lesson), and the JS behavior
 * layer must share the same tier query.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MOBILE_CSS, VIEWPORT_TOKENS } from '../src/client/styles.ts'
import { TOUCH_TIER_QUERY } from '../src/client/composer.ts'

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

test('the hamburger has an explicit desktop default: none (no ghost button)', () => {
  // The media-query-free default hides both overlay entries; the touch tier
  // flips the hamburger to inline-flex.
  const outside = MOBILE_CSS.slice(0, MOBILE_CSS.indexOf('@media (max-width: 1023px)'))
  assert.ok(outside.includes('.dsh-mobile-nav-toggle,'))
  assert.ok(outside.includes('.dsh-mobile-backdrop'))
  assert.ok(outside.includes('display: none;'))
  assert.ok(MOBILE_CSS.includes('display: inline-flex'))
})

test('drawer stays within the official sidebar width (280px) and uses official elevation', () => {
  assert.ok(MOBILE_CSS.includes('width: min(86vw, 280px)'))
  assert.ok(MOBILE_CSS.includes('var(--dsw-shadow-lv3'))
})

test('motion uses official tokens with a reduced-motion branch', () => {
  assert.ok(MOBILE_CSS.includes('var(--ds-transition-duration-slow'))
  assert.ok(MOBILE_CSS.includes('var(--ds-ease-in-out'))
  assert.ok(MOBILE_CSS.includes('@media (prefers-reduced-motion: reduce)'))
})

test('backdrop dims the conversation behind the open drawer', () => {
  assert.ok(MOBILE_CSS.includes('.dsh-mobile-backdrop'))
  assert.ok(MOBILE_CSS.includes('var(--dsw-alias-bg-mask-1'))
  assert.ok(MOBILE_CSS.includes('z-index: 39'))
})

test('settings full-screen rule targets the official settings dialog shape', () => {
  assert.ok(MOBILE_CSS.includes('[role="dialog"][aria-modal="true"]:has([data-slot="settings.header"])'))
})

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
