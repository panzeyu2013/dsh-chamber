/**
 * Source-scoped panel-axis placement lock (design 05 §2 / design 06 §4.7): the
 * `sidebar.panellist` rows the WIDE column renders hang under the source that
 * owns the registration, while the collapsed rail keeps the upstream global
 * glyph axis — exactly one mount per entry at any time.
 *
 * WHY source text: this package runs under plain node (no DOM/React), so the
 * placement contract is pinned the way seat-position.test.ts pins the
 * transferred session-row seats. The row's own behaviour (glyph binding, click
 * chain, aria state, tooltip/title form) is pinned against the source it copies
 * from upstream verbatim.
 *
 * Anchors are chosen to survive formatting: occurrence counts are asserted for
 * every literal the index comparisons rely on, so a second mount site or a
 * duplicated fold marker fails loud instead of silently re-anchoring.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string => stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))

const root = read('../../src/client/SidebarRoot.tsx')
const section = read('../../src/client/ServerSection.tsx')
const panels = read('../../src/client/ServerSectionPanels.tsx')
const chrome = read('../../src/client/sidebar-root-chrome.tsx')

test('the global axis is rail-only and the wide row renders inside the owning section above the fold', () => {
  // Rail axis: guarded by the column state; Root owns exactly ONE row site.
  assert.match(root, /!wide && panels\.length > 0 && \(/,
    'the global axis must be guarded by the rail state')
  assert.equal((root.match(/<PanelRow/g) ?? []).length, 1,
    'SidebarRoot owns exactly ONE row site (the rail)')
  assert.equal((root.match(/<ServerSectionPanels/g) ?? []).length, 0,
    'the wide rows come from the section, never from Root')

  // The per-source sections (and with them the wide rows) live in the WIDE branch.
  // `orderedServers.map` occurs TWICE (the wide sections and the rail dots); pin the count so
  // the index chain below can never silently re-anchor onto a future third occurrence.
  assert.equal((root.match(/orderedServers\.map/g) ?? []).length, 2,
    'expected exactly two orderedServers.map sites (wide sections + rail dots)')
  // `cc.chamberList` is the unique scroll container of the wide branch; using it as the middle
  // anchor keeps the chain meaningful even if the rail dot list is refactored.
  assert.equal((root.match(/cc\.chamberList/g) ?? []).length, 1,
    'expected exactly one chamberList container (the wide branch scroll box)')
  const wideBranch = root.indexOf('{wide ? (')
  const sectionMap = root.indexOf('orderedServers.map')
  const chamberList = root.indexOf('cc.chamberList')
  const railDots = root.indexOf('cc.railDots')
  assert.ok(wideBranch !== -1 && chamberList > wideBranch && sectionMap > chamberList && railDots > sectionMap,
    'sections render only in the wide branch (rail = dots), so a row can never be mounted twice')

  // Mount site: exactly one, behind the owning-instance guard, above the fold.
  assert.equal((section.match(/<ServerSectionPanels/g) ?? []).length, 1,
    'exactly one mount site')
  assert.equal((section.match(/!sourceFolded/g) ?? []).length, 1,
    'exactly one fold-region marker (the index comparison below depends on it)')
  assert.ok(section.indexOf('<ServerSectionPanels') < section.indexOf('!sourceFolded'),
    'the panel rows sit ABOVE the foldable region (a folded source keeps them)')
  assert.match(section, /\{server\.id === chamberInstanceId && <ServerSectionPanels \/>\}/,
    'the mount is behind the owning-instance guard')
})

test('the row keeps the upstream container, glyph binding, click chain, aria and tooltip form', () => {
  assert.match(panels, /className=\{cc\.sectionPanels\}/,
    'the chamber container class carries the section inset')
  assert.match(panels, /aria-label=\{t\('panels\.label'\)\}/,
    'the upstream nav accessible name')
  assert.match(panels, /panels\.map\(/, 'one row per ledger entry of THIS ctx')
  assert.match(panels, /key=\{panel\.id\}/, 'list rows key by the panel id (upstream)')
  assert.match(chrome, /renderSlot\('sidebar\.panellist', \{ size: wide \? 16 : 18, active \}, \{ only: id \}\)/,
    'the glyph comes from the owner-props binding, exactly as upstream')
  assert.match(chrome, /onClick=\{\(\) => \{ selectPanel\(id\) \}\}/,
    'the click forwards to the injected selectPanel')
  assert.match(chrome, /aria-current=\{active \? 'page' : undefined\}/,
    'the active row keeps the upstream aria state')
  assert.match(chrome, /<Tooltip label=\{label\} delayMs=\{500\} disabled=\{wide\}>/,
    'the upstream tooltip contract (label / 500ms / wide-disabled)')
  assert.match(chrome, /\{wide && <span className=\{css\.panelTitle\}>\{label\}<\/span>\}/,
    'the title renders only wide, exactly as upstream')
})
