/**
 * Panel-axis placement lock (design 05 §2 / design 06 §4.7): the WIDE column
 * renders each `sidebar.panellist` registration as a compact action inside the
 * header of the source that owns it — in the same hover-revealed cluster as the
 * view options and to their left — while the collapsed rail keeps the upstream
 * global glyph row (`PanelRow`). The wide mount is gated to the OWNING (active)
 * source's header (`server.id === chamberInstanceId`, the same gate the retired
 * row carried): every projected source renders a section, but the panel ledger
 * belongs to this shell's ctx, so ungated it would appear N times and click into
 * the active shell's layout. Exactly one mount per entry at any time; the
 * retired section-level row container stays retired.
 *
 * WHY source text: this package runs under plain node (no DOM/React), so the
 * placement contract is pinned the way seat-position.test.ts pins the
 * transferred session-row seats. The entry's own behaviour (glyph binding,
 * click chain, aria state, tooltip form) is pinned against the source it copies
 * from upstream.
 *
 * Anchors are chosen to survive formatting (whitespace-collapsed matches plus
 * whole-tree occurrence and slot-binding counts), so a second mount site, a
 * hand-rolled slot binding or a resurrected row container fails loud instead of
 * silently re-anchoring. The owning-gate anchor pins the ENTRY's own gate; a
 * companion test pins that neither the header element, the action cluster nor the
 * section's header site carries a connection gate ("registered is enough").
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string => stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))

const root = read('../../src/client/SidebarRoot.tsx')
const header = read('../../src/client/ServerSectionHeader.tsx')
const chrome = read('../../src/client/sidebar-root-chrome.tsx')
const section = read('../../src/client/ServerSection.tsx')

// The WHOLE client tree (not just the four named files): a new file must not be
// able to add a LITERAL mount site or hand-roll a slot binding without this lock
// going red. Aliased imports / createElement are covered by the slot-binding count.
const CLIENT_DIR = new URL('../../src/client/', import.meta.url)
const clientFiles = (readdirSync(CLIENT_DIR, { recursive: true }) as string[])
  .filter(name => /\.(?:ts|tsx|css)$/u.test(name))
const clientSources = clientFiles
  .filter(name => /\.(?:ts|tsx)$/u.test(name))
  .map(name => stripComments(readFileSync(new URL(name, CLIENT_DIR), 'utf8')))
const clientStyles = clientFiles
  .filter(name => name.endsWith('.css'))
  .map(name => stripComments(readFileSync(new URL(name, CLIENT_DIR), 'utf8')))

test('the global axis is rail-only and the wide entry renders inside the owning source header', () => {
  // Rail axis: guarded by the column state; Root owns exactly ONE row site.
  assert.match(root, /!wide && panels\.length > 0 && \(/,
    'the global axis must be guarded by the rail state')
  assert.equal((root.match(/<PanelRow/g) ?? []).length, 1,
    'SidebarRoot owns exactly ONE row site (the rail)')
  assert.ok(!root.includes('wide={wide}'),
    'the rail row no longer forwards the retired wide prop')
  assert.equal((root.match(/<PanelHeaderEntry/g) ?? []).length, 0,
    'the wide entry comes from the source header, never from Root')

  // The retired section-level row container must not come back: the section
  // renders neither the old component nor the new header entry.
  assert.equal((section.match(/<ServerSectionPanels|<PanelHeaderEntry/g) ?? []).length, 0,
    'the section no longer owns any panel-axis mount site')
  assert.equal((section.match(/ServerSectionPanels/g) ?? []).length, 0,
    'no reference (import included) to the retired component')
  assert.ok(!existsSync(new URL('../../src/client/ServerSectionPanels.tsx', import.meta.url)),
    'the retired wide row component is deleted, not merely unrendered')

  // Pin the two `orderedServers.map` sites so a future third occurrence cannot
  // silently re-anchor; `cc.chamberList` remains the unique wide scroll box.
  assert.equal((root.match(/orderedServers\.map/g) ?? []).length, 2,
    'expected exactly two orderedServers.map sites (wide sections + rail dots)')
  assert.equal((root.match(/cc\.chamberList/g) ?? []).length, 1,
    'expected exactly one chamberList container (the wide branch scroll box)')

  // Mount site: exactly one, inside the header's action cluster, left of the
  // view-options button (the cluster is display:none at rest — the same reveal
  // discipline the other header actions carry).
  assert.equal((header.match(/<PanelHeaderEntry/g) ?? []).length, 1,
    'exactly one mount site')
  // The mount is gated to the OWNING (active) source's header (see the docstring):
  // without the gate the entry renders in every projected source's header while the
  // click still selects THIS shell's layout. The JSX expression OPENS with that gate
  // (a connection gate wrapped around it — server.connected first — breaks the
  // anchor), so a disconnected source keeps rendering its entries (design 06 §4.7).
  // Matched on the whitespace-collapsed text with tolerant parens/spacing so a
  // formatting-only refactor does not false-red.
  assert.match(normalize(header),
    /\{server\.id === chamberInstanceId && \(?panels\.map\(\s*\(?panel\)?\s*=>\s*\(\s*<PanelHeaderEntry/,
    'the mount opens with the owning-source gate, never a connection gate')
  assert.match(normalize(header), /key=\{\s*panel\.id\s*\}/,
    'one keyed entry per ledger registration (order preserved)')
  const mapAt = header.indexOf('panels.map')
  assert.ok(mapAt !== -1 && mapAt < header.indexOf('<PanelHeaderEntry'),
    'the entry comes from this ctx panel ledger')
  const actions = header.indexOf('cc.sourceActions,')
  const entry = header.indexOf('<PanelHeaderEntry')
  const viewOptions = header.indexOf('cc.sortActive')
  assert.ok(actions !== -1 && entry > actions && viewOptions > entry,
    'the entry renders inside .sourceActions, left of the view-options button')
})

test('the wide mount is connection-independent: neither the header nor its cluster is connection-gated', () => {
  // "Registered is enough" (design 06 §4.7): the owning source's header keeps
  // rendering while its source is disconnected, so the entry keeps rendering too.
  // The owning-gate anchor in the first test cannot see a connection gate wrapped
  // AROUND that gate; these locks pin the shape around it:
  // 1. between the header element and the mount there is no server.connected.
  const headerOpenAt = header.indexOf('<header')
  const mountAt = header.indexOf('{server.id === chamberInstanceId && panels.map')
  assert.ok(headerOpenAt !== -1 && mountAt > headerOpenAt,
    'the panel-axis mount lives inside the header element')
  assert.ok(!header.slice(headerOpenAt, mountAt).includes('server.connected'),
    'no connection gate may sit between the header element and the panel-axis mount')
  // 2. the action cluster opens as an unconditional JSX sibling: the last
  // significant character before its element is a sibling boundary — the previous
  // element's '>' (or the '}' of a stripped comment container) — never the '(' /
  // '&' of a conditional wrapper.
  const clusterTagAt = header.lastIndexOf('<span', header.indexOf('cc.sourceActions,'))
  assert.ok(clusterTagAt !== -1, 'the sourceActions cluster element exists')
  assert.match(header.slice(0, clusterTagAt).trimEnd().slice(-1), /[>}]/u,
    'the action cluster is an unconditional sibling, never a conditional wrapper')
  // 3. the section renders the header element itself unconditionally too (design
  // 24 §6: a disconnected source still shows header + status).
  const sectionHeaderAt = section.indexOf('<ServerSectionHeader')
  assert.ok(sectionHeaderAt !== -1, 'the section renders the source header')
  assert.match(section.slice(0, sectionHeaderAt).trimEnd().slice(-1), /[>}]/u,
    'the source header is not behind a conditional wrapper either')
})

test('the axis mounts exactly once per form in the whole client tree and leaves no retired container', () => {
  const occurrences = (pattern: RegExp): number =>
    clientSources.reduce((sum, source) => sum + (source.match(pattern) ?? []).length, 0)
  assert.equal(occurrences(/<PanelHeaderEntry/g), 1,
    'exactly one wide mount in the whole client tree (a new file cannot add another)')
  assert.equal(occurrences(/<PanelRow/g), 1,
    'exactly one rail mount in the whole client tree')
  assert.equal(occurrences(/<ServerSectionPanels/g), 0,
    'the retired section-level container has no mount site anywhere')
  // The two bindings are the ONLY ways the axis may address its slot: a
  // hand-rolled button calling renderSlot directly breaks this count, and an
  // aliased/createdElement mount would have to reuse one of the two bindings.
  assert.equal(occurrences(/renderSlot\('sidebar\.panellist'/g), 2,
    'exactly two slot bindings in the whole client tree (the rail row and the wide header entry)')
  for (const style of clientStyles) {
    assert.ok(!style.includes('.sectionPanels'),
      'the retired container has no stylesheet left in any client CSS file')
    assert.ok(!style.includes('.panelTitle'),
      'the retired wide row title has no stylesheet left either')
  }
})

test('the wide entry keeps the list contract, the compact box and the header click discipline', () => {
  assert.match(chrome, /className=\{clsx\(cc\.actionIcon, active && cc\.actionPanelActive\)\}/,
    'the entry is the compact 20px header action, with the selected state as its own class')
  assert.match(chrome, /renderSlot\('sidebar\.panellist', \{ size: 14, active \}, \{ only: id \}\)/,
    'the glyph comes from the owner-props binding, at the header icon size')
  // Scoped to the PanelHeaderEntry body: the rail row carries the same aria
  // expression, so a chrome-wide match would not pin the wide entry.
  const entryAt = chrome.indexOf('export function PanelHeaderEntry')
  assert.ok(entryAt !== -1, 'the compact header entry component exists')
  assert.match(chrome.slice(entryAt), /aria-current=\{active \? 'page' : undefined\}/,
    'the active entry keeps the upstream aria state')
  assert.match(chrome, /<Tooltip label=\{label\} side="bottom" delayMs=\{500\}>/,
    'the header tooltip form (label / bottom / 500ms)')
  assert.match(chrome, /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\)\s*onSelect\(id\)\s*\}\}/,
    'the click stops the header-activation bubble and forwards to the injected selector')
  assert.match(normalize(header),
    /onSelect=\{\(id\) => \{ if \(suppressClickRef\.current\) return clearPendingClick\(\) selectPanel\(id\) \}\}/,
    'the header passes the same trailing-click / pending-click gate its sibling actions use')

  // The rail row keeps the upstream RAIL form (the wide half moved away with the
  // entry): 18px glyph, the 500ms tooltip, and no disabled/title branch left.
  assert.match(chrome, /className=\{clsx\(css\.panelRow, active && css\.panelActive\)\}/,
    'the rail row keeps the upstream row class pair')
  assert.match(chrome, /onClick=\{\(\) => \{ selectPanel\(id\) \}\}/,
    'the rail row click forwards to the injected selectPanel')
  assert.match(chrome, /<Tooltip label=\{label\} delayMs=\{500\}>/,
    'the upstream rail tooltip contract')
  assert.match(chrome, /renderSlot\('sidebar\.panellist', \{ size: 18, active \}, \{ only: id \}\)/,
    'the rail row renders the upstream rail glyph size')
  // The retired wide half must not linger as unreachable code or dead CSS.
  assert.doesNotMatch(chrome, /\bwide\b/,
    'no wide identifier is left in the chrome (the dead half is deleted, not kept)')
  assert.doesNotMatch(chrome, /panelTitle/,
    'the retired wide title span is gone from the chrome')
})
