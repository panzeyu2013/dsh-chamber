/**
 * Theme-presenter lifecycle lock (design 06 §4.6; alpha.1 upstream change).
 *
 * The fork has always used ONE page-wide vendor `ThemePresenter` for the shared
 * document (instance teardown never disposes it — that would strip the ACTIVE
 * view's palette). alpha.1 gave that presenter a second half: `start()` installs
 * a MutationObserver on `document.head` so `meta[name="theme-color"]` is
 * refreshed when a stylesheet is installed or replaced AFTER the theme
 * initialization (the pinned framework now installs client-plugin styles at
 * materialize time, and N-ctx shells materialize one by one).
 *
 * Two arms, because both failure modes are silent:
 * 1. OURS — the page-wide singleton must call `start()` exactly once, on
 *    creation. A per-shell start would mean N observers + N `getComputedStyle`
 *    calls per head mutation; no start at all leaves the meta stale.
 * 2. VENDOR — the pinned presenter must still own that lifecycle. If a future
 *    pin removes `start()` this lock fails so the fork is revisited knowingly
 *    (the repo-level loose vendor face declares the presenter without the method,
 *    so typecheck cannot see the removal).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripComments } from '../../../scripts/dev/test-support/source-text.ts'

const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const code = stripComments(source)

/** The pinned vendor presenter our singleton instantiates. */
const VENDOR_PRESENTER = new URL(
  '../../../vendor/harness-checkout/packages/client/ui-layout/src/client/theme-presenter.ts',
  import.meta.url,
)

/** The creation site of the page-wide singleton: `if (documentThemePresenter === undefined) { … }`. */
function creationSite(): string {
  const guard = code.indexOf('if (documentThemePresenter === undefined) {')
  assert.notEqual(guard, -1, 'src/client/index.ts guards the page-wide presenter creation')
  const open = code.indexOf('{', guard)
  let depth = 0
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1
    else if (code[index] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(open, index + 1)
    }
  }
  assert.fail('the presenter creation block is unterminated')
}

test('the page-wide presenter is created exactly once and started on creation', () => {
  const site = creationSite()
  assert.equal((site.match(/new ThemePresenter\(\)/gu) ?? []).length, 1,
    'the creation site mints the singleton presenter once')
  assert.equal((code.match(/new ThemePresenter\(\)/gu) ?? []).length, 1,
    'no second ThemePresenter instance is minted anywhere in the fork (one page-wide writer)')
  assert.match(site, /\.start\?\.\(\)/u, 'the creation site starts the observer lifecycle')
  // Order: mint, start, then hand to the projector — never `apply` on a
  // presenter whose observer was armed after the first projection.
  assert.ok(site.indexOf('.start?.()') < site.indexOf('documentThemePresenter = presenter'),
    'start() runs before the singleton becomes reachable')
  // The disposer half is deliberately absent: the page-wide presenter is never disposed.
  assert.doesNotMatch(code, /documentThemePresenter\.dispose|documentThemePresenter\?\.dispose/u,
    'the page-wide presenter must never be disposed by an instance teardown')
})

test('the pinned vendor presenter still owns the stylesheet observer lifecycle', () => {
  const vendor = stripComments(readFileSync(VENDOR_PRESENTER, 'utf8'))
  assert.match(vendor, /start\(\): void/u,
    'the pinned ThemePresenter must expose start(); a pin without it needs a fork revisit (remove the call)')
  assert.match(vendor, /MutationObserver\(/u, 'start() installs the stylesheet observer')
  assert.match(vendor, /observe\(document\.head/u, 'the observer watches document.head')
  assert.match(vendor, /refreshThemeColor\(\)/u, 'a head change refreshes the theme-color meta')
})
