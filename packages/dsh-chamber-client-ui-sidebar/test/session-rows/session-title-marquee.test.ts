/**
 * session-title-marquee.ts unit tests (plain node:test, no DOM): the copied
 * upstream placeTitle/restTitle state machine — scroll placement plus the two
 * \`data-*\` fade hooks the stylesheet's masks key on — and the constants a
 * barely-clipped title's no-marquee floor depends on.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  MIN_TITLE_REVEAL_PX, TITLE_MARQUEE_PX_PER_MS, placeTitle, restTitle,
} from '../../src/client/session-title-marquee.ts'

interface FakeTitle {
  scrollCalls: { left: number; behavior: string }[]
  scrollLeft: number
  dataset: Record<string, string>
  scrollTo?: (options: { left: number; behavior: string }) => void
}

function fakeTitle(withScrollTo = true): FakeTitle {
  const element: FakeTitle = { scrollCalls: [], scrollLeft: -1, dataset: {} }
  if (withScrollTo) {
    element.scrollTo = options => { element.scrollCalls.push(options) }
  }
  return element
}

test('constants: the stylesheet masks and the no-marquee floor stay pinned', () => {
  assert.equal(MIN_TITLE_REVEAL_PX, 8)
  assert.equal(TITLE_MARQUEE_PX_PER_MS, 0.03)
  // placeTitle 发布的 data-* 钩子只有配上 stylesheet 的渐隐遮罩才有效果：三条规则的
  // 几何（12px 羽化、两侧方向）与上游 ui-workspace Rows 逐字一致。
  const css = readFileSync(new URL('../../src/client/sidebar-chamber.module.css', import.meta.url), 'utf8')
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const masks: [string, string][] = [
    ['.sessionRow .sessionTitle[data-scrolled]', 'to right, transparent, #000 12px'],
    ['.sessionRow .sessionTitle[data-clipped]', 'to left, transparent, #000 12px'],
    ['.sessionRow .sessionTitle[data-scrolled][data-clipped]',
      'to right, transparent, #000 12px, #000 calc(100% - 12px), transparent'],
  ]
  for (const [selector, gradient] of masks) {
    const rule = new RegExp(escape(selector) + ' \\{([\\s\\S]*?)\\n\\}', 'u').exec(css)
    assert.notEqual(rule, null, selector + ' 必须存在（钩子没有遮罩就没有可见效果）')
    assert.match(rule![1]!, new RegExp('\\n\\s*mask-image: linear-gradient\\(' + escape(gradient) + '\\)', 'u'),
      selector + ' 的渐隐几何必须保持')
  }
})

test('placeTitle: instant placement plus the two fade hooks', () => {
  const start = fakeTitle()
  placeTitle(start as unknown as HTMLElement, 0, 40)
  assert.deepEqual(start.scrollCalls, [{ left: 0, behavior: 'instant' }])
  assert.equal('scrolled' in start.dataset, false, 'at the start there is no left fade')
  assert.equal(start.dataset.clipped, '', 'text beyond the right edge keeps the right fade')

  const middle = fakeTitle()
  placeTitle(middle as unknown as HTMLElement, 12, 40)
  assert.equal(middle.dataset.scrolled, '')
  assert.equal(middle.dataset.clipped, '')

  const end = fakeTitle()
  placeTitle(end as unknown as HTMLElement, 40, 40)
  assert.equal(end.dataset.scrolled, '')
  assert.equal('clipped' in end.dataset, false, 'the far edge has no right fade')
})

test('restTitle: back to the start, both fades off, and clears stale hooks', () => {
  const element = fakeTitle()
  element.dataset.scrolled = ''
  element.dataset.clipped = ''
  restTitle(element as unknown as HTMLElement)
  assert.deepEqual(element.scrollCalls, [{ left: 0, behavior: 'instant' }])
  assert.equal('scrolled' in element.dataset, false)
  assert.equal('clipped' in element.dataset, false)
})

test('a title without scrollTo falls back to the scrollLeft assignment', () => {
  const element = fakeTitle(false)
  placeTitle(element as unknown as HTMLElement, 9, 40)
  assert.equal(element.scrollLeft, 9)
  restTitle(element as unknown as HTMLElement)
  assert.equal(element.scrollLeft, 0)
})
