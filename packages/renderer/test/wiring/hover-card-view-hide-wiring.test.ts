/**
 * View-hide → row hover-card dismissal wiring lock (2026-12 hover-card fix,
 * DEFECT 3).
 *
 * `InstanceView.tsx` cannot be imported by a plain `node test/…` run (it boots a
 * whole dsh shell through `bootInstanceShell`), so this is the same SOURCE-TEXT
 * contract pattern the renderer already uses
 * (`sidebar-right-heal-wiring.test.ts`, helper notes in `source-text.ts`).
 *
 * The defect it pins: the sidebar row hover card is portaled to `document.body`,
 * so `.instance-hidden` / `.instance-pending` — `visibility: hidden; opacity: 0;
 * pointer-events: none` on the view (`styles.css:123-141`) — hide neither the
 * card nor its hit testing, and deliver it no pointer event at all. A card open
 * while the pointer rests on it therefore stayed painted over the incoming view
 * until the next pointer move (found in a real-Chrome harness during the
 * 2026-09 review; that harness was scratch work and is deliberately NOT cited as
 * repo evidence — this file and the unit cases below are the evidence). The hide
 * path must close it explicitly, in the SAME commit that applies the class (a
 * passive effect would leave one painted frame of stale card over the new view).
 *
 * LIMITS, stated honestly: this is source text — it proves the call sits in the
 * hide path, not that it runs (there is no DOM runner in this repo). The
 * closer's own behavior is unit-tested in the sidebar package
 * (`packages/dsh-chamber-client-ui-sidebar/test/session-rows/hover-intent.test.ts`, the three
 * `dismissVisibleRowCard` cases), and the marker attributes the acceptance
 * probes use are locked in that package's `hover-card-wiring.test.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from '../support/source-text.ts'

/** Comment-stripped, whitespace-collapsed source: the semantic text of a file. */
const read = (rel: string): string =>
  normalize(stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')))

test('a view leaving the active state dismisses the page-global row hover card', () => {
  const view = read('../../src/components/InstanceView.tsx')
  // Imported through the package barrel — the same door App.tsx uses.
  assert.match(
    view,
    /import \{ dismissVisibleRowCard \} from '@dsh-chamber\/dsh-chamber-client-ui-sidebar\/shared'/,
    'the view must import the closer from the sidebar barrel',
  )
  // The class application point this dismissal accompanies: the two hidden
  // classes (`styles.css:123-141`) are decided HERE, not in App.tsx.
  assert.match(
    view,
    /const viewClass = active \? 'instance-view' : settled \? 'instance-view instance-hidden' : 'instance-view instance-pending'/,
    'the hidden/pending classes must still be applied in this component',
  )
  // The dismissal: useLayoutEffect (before paint) and ONLY on the active
  // true→false transition. An inactive view MOUNTING (idle prewarm, background
  // boot) must not close the active view's card, which is why a plain
  // `if (!active)` effect is not enough.
  assert.match(view, /const wasActiveRef = useRef\(active\)/, 'the previous-active tracking must exist')
  assert.match(
    view,
    /useLayoutEffect\(\(\) => \{ if \(wasActiveRef\.current === active\) return wasActiveRef\.current = active if \(!active\) dismissVisibleRowCard\(\) \}, \[active\]\)/,
    'the hide transition must dismiss the visible card in the same commit',
  )
})

test('the sidebar exports the closer the renderer imports, through the one page slot', () => {
  const shared = read('../../../dsh-chamber-client-ui-sidebar/src/shared/index.ts')
  assert.match(
    shared,
    /export \* from '\.\/hover-intent\.ts'/,
    'the renderer imports the package barrel — the closer must be re-exported there (a missing export is undefined at the call site)',
  )
  const intent = read('../../../dsh-chamber-client-ui-sidebar/src/shared/hover-intent.ts')
  assert.match(
    intent,
    /export function dismissVisibleRowCard\(\): void \{ dismissVisibleCard\(\) \}/,
    'the closer must go through the one page-global slot, never a second registry',
  )
  assert.match(intent, /let visibleCard: \(\(\) => void\) \| null = null/)
})
