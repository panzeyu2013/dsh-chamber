/**
 * Icon hit-box geometry lock (design 06 §7「图标钮命中区 = 视觉盒」).
 *
 * Six sub-24px icon controls deliberately use their VISUAL box as the hit box:
 * a 24px rim squeezes the row/header plain band to ~0-1px and re-opens the
 * native pointerleave-only failure the discipline mitigates. Their sizes are a
 * contract, not styling — a silent resize must fail here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../../src/client/sidebar-chamber.module.css', import.meta.url), 'utf8')

/** The declaration body of one top-level rule (class selectors end with a bare `}` line). */
function rule(selector: string): string {
  const start = css.indexOf(selector + ' {')
  assert.notEqual(start, -1, selector + ' rule must exist')
  const end = css.indexOf('\n}', start)
  assert.notEqual(end, -1, selector + ' rule must close')
  return css.slice(start, end)
}

const boxes: [selector: string, size: number][] = [
  ['.actionIcon', 20],
  ['.searchButton', 20],
  ['.searchClear', 18],
  ['.foldToggle', 16],
  ['.sourceFoldToggle', 16],
  ['.railDotButton', 16],
]

test('the six sub-24px icon controls keep hit box = visual box', () => {
  for (const [selector, size] of boxes) {
    const body = rule(selector)
    assert.ok(body.includes('width: ' + size + 'px;'), selector + ' keeps its ' + size + 'px width')
    assert.ok(body.includes('height: ' + size + 'px;'), selector + ' keeps its ' + size + 'px height')
    assert.ok(body.includes('padding: 0;') || body.includes('box-sizing: border-box;'),
      selector + ' must not grow the visual box into a rim')
  }
})

test('icon radii follow the discipline: r-xs for the sub-24px buttons, none on the rail dot', () => {
  for (const selector of ['.actionIcon', '.searchButton', '.searchClear', '.foldToggle', '.sourceFoldToggle']) {
    assert.ok(rule(selector).includes('border-radius: var(--dsw-radius-xs);'),
      selector + ' 的圆角是 r-xs')
  }
  const rail = rule('.railDotButton')
  assert.ok(!rail.includes('border-radius'), 'the rail dot is an 8px-dot hit area with no radius')
  assert.ok(rail.includes('margin: -4px 0;'), 'the rail dot keeps its -4px vertical pitch compensation')
})