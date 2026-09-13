/**
 * OPEN-IN MENU + FAILURE PRESENTATION LOCKS.
 *
 * The open-in entry used to ship a 458-line bespoke menu whose header claimed
 * the pinned vendor `Menu` "has no focus transfer or roving keyboard
 * navigation" — the pinned source says otherwise (`Menu.tsx:51` documents
 * `autoFocus`, and the official plugin uses the very same primitive at
 * `OpenInAppAction.tsx:175-198` with `dense`, `selection="fill"` and
 * `MenuItem.icon`). The bespoke menu is gone (2026-09-11 upstream-alignment,
 * T13); what stays is the ONE piece the primitive cannot own — the
 * `.instance-view`-scoped dismissal of this N-ctx shell — plus every
 * capability the chamber already shipped (catalog icons, split-button flow,
 * per-source memory, in-flight pick semantics, re-probe on open).
 *
 * The component itself is React + CSS + raster marks (not importable under
 * plain node), so the wiring below is locked as SOURCE TEXT with comments
 * stripped first (precedent:
 * `packages/dsh-chamber-client-ui-sidebar/test/panel-wiring.test.ts:20-27,105`)
 * — several comments name the retired menu, and a lock satisfied by a comment
 * is exactly what these assertions exist to prevent. The pure owner-guard
 * decision is tested directly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { menuOwnerAllowsInteraction, type MenuOwnerSnapshot } from '../src/client/instance-view-guard.ts'
import { en, zh } from '../src/locales.ts'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** Remove line/block comments while preserving string and template literals. */
function stripComments(code: string): string {
  let out = ''
  let quote: string | undefined
  let line = false
  let block = false
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    const next = code[i + 1]
    if (line) {
      if (ch === '\n') { line = false; out += ch } else out += ' '
      continue
    }
    if (block) {
      if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '
      continue
    }
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

const button = stripComments(source('../src/client/OpenInButton.tsx'))
const guard = stripComments(source('../src/client/instance-view-guard.ts'))
const client = stripComments(source('../src/client/index.ts'))
const gates = stripComments(source('../src/client/open-in-gates.ts'))

test('menu owner guard fails closed for hidden, pending, or disconnected N-ctx state', () => {
  const active: MenuOwnerSnapshot = {
    triggerConnected: true,
    ownerConnected: true,
    ownerContainsTrigger: true,
    ownerIsInstanceView: true,
    ownerHasInactiveClass: false,
    ownerHidden: false,
    ownerAriaHidden: false,
    rendered: true,
  }
  assert.equal(menuOwnerAllowsInteraction(active), true)

  for (const key of [
    'triggerConnected',
    'ownerConnected',
    'ownerContainsTrigger',
    'ownerIsInstanceView',
    'rendered',
  ] as const) {
    assert.equal(menuOwnerAllowsInteraction({ ...active, [key]: false }), false, key)
  }
  for (const key of ['ownerHasInactiveClass', 'ownerHidden', 'ownerAriaHidden'] as const) {
    assert.equal(menuOwnerAllowsInteraction({ ...active, [key]: true }), false, key)
  }
})

test('the bespoke accessible menu is replaced by the official Menu primitive', () => {
  const clientDir = new URL('../src/client/', import.meta.url)
  const files = readdirSync(clientDir)
  assert.ok(!files.includes('AccessibleAppMenu.tsx'), 'the hand-rolled menu component must be deleted')
  assert.ok(!files.includes('AccessibleAppMenu.module.css'), 'its hand-rolled stylesheet must be deleted')
  assert.ok(!files.includes('menu-navigation.ts'), 'the bespoke roving-focus module must be deleted')
  assert.ok(existsSync(new URL('instance-view-guard.ts', clientDir)), 'the N-ctx owner guard is the surviving piece')

  assert.match(
    button,
    /import \{\s*IconChevronDownOutline14, Menu, Tooltip, type MenuItem,\s*\} from '@deepseek-ai\/dsh-client-ui-primitives'/u,
  )
  // Upstream's own menu composition (OpenInAppAction.tsx:181-198): fill
  // selection, end alignment, focus transfer + arrow navigation — with the
  // chamber menu-density decision on top (2026-09: `compact` 26px/12px, never
  // upstream's `dense`; design 06 §7, design 20 §1, batch2-visual-locks.test.ts).
  for (const prop of ['autoFocus', 'compact', 'selection="fill"', 'align="end"']) {
    assert.ok(button.includes(prop), `the official Menu must be opened with ${prop}`)
  }
  // Row icons: the app marks the button shows, at the primitive's icon size.
  assert.match(button, /const items: MenuItem\[\] = entries\.map\(entry => \(\{[\s\S]*?icon: appMark\(iconUrl\(entry\.id\), MENU_MARK_SIZE\)/u)
  // The decode-failure memory is keyed by the icon URL, not by app id or
  // source: the page reads ONE machine catalog, so the same URL means the same
  // bytes in every source's button and a failure must fall back everywhere
  // instead of re-decoding once per source (2026-09-12 machine-catalog move).
  assert.ok(button.includes('useState(failedIcons.has(url))'), 'the failed-icon memory is keyed by the icon URL')
  assert.ok(button.includes('failedIcons.add(url)'), 'failures are recorded under that URL')
  // 2026-09-12 thorough unification: upstream's split button is the ONLY form
  // (one app and ten apps render the same control), so the one-entry plain
  // button is gone and the chevron is unconditional.
  assert.ok(!button.includes('entries.length === 1'), 'upstream has no single-entry form; the split is unconditional')
  assert.ok(button.includes('aria-haspopup="menu"'), 'the chevron still advertises the menu')
  assert.ok(button.includes('aria-expanded={open}'), 'the chevron still reports the open state')
})

test('the control is the official split button, never a chamber variant', () => {
  // 2026-09-12 thorough unification: geometry, marks, glyphs and fallbacks are
  // upstream's (OpenInAppAction.module.css / OpenInAppAction.tsx at the pin).
  // Sizes and shapes are locked here as source text because the component (and
  // its CSS module) cannot be imported under the plain node runner.
  assert.ok(
    button.includes('<IconChevronDownOutline14 size={11} />'),
    'the chevron must be the design-system icon at the official 11px size',
  )
  assert.ok(!button.includes('viewBox="0 0 16 16"'), 'no hand-drawn chevron geometry')
  assert.ok(!button.includes('folderMark'), 'the chamber-only folder mark is retired')
  // 2026-09-12: the machine catalog (read once per page from the LOCAL instance)
  // is the only icon source, so the bundled raster, its mark component and the
  // VS Code mark kind are all gone — a missing icon is upstream's square.
  assert.ok(!button.includes('VscodeMark'), 'the bundled VS Code raster mark is retired')
  assert.ok(!button.includes('vscode-icon'), 'the raster asset import is retired')
  // Mark selection is ONE question about the machine catalog's answer: the
  // display family no longer selects anything, so the selector is gone from the
  // gates module and the component decides on the URL alone.
  assert.ok(!button.includes('markKindFor'), 'no display-family mark selector survives')
  assert.ok(!gates.includes('markKindFor'), 'the gates module no longer owns a mark table')
  assert.match(button, /function appMark\(iconUrl: string \| null, size: number\)/u,
    'the mark is chosen by the catalog answer alone')
  assert.ok(
    button.includes('return iconUrl === null ? <GenericAppMark size={size} /> : <CatalogIcon url={iconUrl} size={size} />'),
    "a miss draws upstream's square, a hit the machine's art",
  )
  const clientDir = new URL('../src/client/', import.meta.url)
  assert.ok(!readdirSync(clientDir).includes('vscode-icon.png'), 'the raster asset itself is deleted')
  assert.ok(
    !readdirSync(new URL('../src/', import.meta.url)).includes('assets.d.ts'),
    'the dead asset declaration module is deleted (no bundle asset is imported any more)',
  )
  assert.ok(button.includes('const BUTTON_MARK_SIZE = 15'), 'the button mark uses the official 15px size')
  assert.ok(button.includes('const MENU_MARK_SIZE = 18'), 'the menu mark uses the official 18px size')
  assert.ok(button.includes('viewBox="0 0 24 24"'), "the fallback mark is upstream's rounded square")
  assert.ok(button.includes('strokeWidth="1.8"'), "the fallback mark keeps upstream's stroke weight")

  const css = stripComments(source('../src/client/OpenInButton.module.css'))
  for (const rule of [
    'height: 28px',
    'border: 0.5px solid var(--dsw-alias-border-l4)',
    'border-radius: 14px',
    'overflow: hidden',
    'padding: 5px 6px 5px 7px',
    'padding: 5px 6px 5px 4px',
    'border-left: 0.5px solid var(--dsw-alias-border-l4)',
    'object-fit: contain',
    'flex: none',
  ]) {
    assert.ok(css.includes(rule), `the control must keep upstream's \`${rule}\``)
  }
  assert.ok(!css.includes('border-l2'), 'the chamber hairline token is retired')
  assert.ok(!css.includes('18px'), 'the chamber pill radius is retired')
})

test('the registration mirrors the official row (order), with our own id', () => {
  // 2026-09-12 thorough unification: `order: -10` is the official `open-in-app`
  // row's own value (the official plugin registers `order: -10` at this same
  // slot), so any third-party row sorts exactly as it would upstream.
  assert.ok(client.includes("'conversation.session.header.utilities'"), 'the official header utilities slot')
  assert.ok(client.includes('order: -10'), "the registration must keep upstream's -10 row order")
  assert.ok(!client.includes('order: -1,'), 'the retired chamber order must not come back')
  // The id deliberately stays chamber's own: the slot registry THROWS on a
  // duplicate list id at the same priority, so reusing `open-in-app` would turn
  // an accidentally materialized official row into a load failure.
  assert.ok(client.includes("id: 'open-in'"), 'the entry keeps its own slot id')
  assert.ok(!client.includes("id: 'open-in-app'"), "the official row's id must not be reused")
})

test('the .instance-view dismissal is the only bespoke menu behaviour kept', () => {
  assert.match(button, /useInstanceViewDismissal\(open, groupRef, \(\) => \{ setOpen\(false\) \}\)/u)
  assert.ok(button.includes('ref={groupRef}'), 'the guard anchors on the element the Menu wraps')
  // The guard still reads every N-ctx signal the bespoke menu did.
  for (const signal of ["'instance-hidden'", "'instance-pending'", "'hidden'", "'aria-hidden'"]) {
    assert.ok(guard.includes(signal), `the owner guard must keep watching ${signal}`)
  }
  // The primitive owns dismissal while the owner lives.
  assert.ok(button.includes('onClose={() => { setOpen(false) }}'), 'the primitive dismissal closes the menu')
  // Re-probe on open (the bespoke menu's `onOpening`) stays: the chevron
  // refreshes the pools for BOTH the click and arrow-key paths.
  assert.equal(
    [...button.matchAll(/void refresh\(\)/gu)].length,
    2,
    'opening by click and by arrow key must both re-probe the catalog',
  )
  assert.ok(button.includes("event.key === 'ArrowDown' || event.key === 'ArrowUp'"), 'arrow-key opening stays')
})

test('T5: the main button uses the design-system Tooltip and the existing dictionary keys', () => {
  assert.equal(
    [...button.matchAll(/<Tooltip label=\{tooltip\} side="bottom">/gu)].length,
    1,
    'upstream has one split-button form, so the main button is wrapped once',
  )
  // No native title bubble on the main icon button (the chevron keeps
  // upstream's own `title` + `aria-label` pair). The opening tag ends at the
  // JSX attribute list's own line, so the arrow functions inside it do not
  // truncate the match.
  const mainButton = /className=\{styles\.button\}[\s\S]{0,600}?\n\s*>/u.exec(button)
  assert.ok(mainButton !== null, 'the main button exists')
  assert.ok(!mainButton[0].includes('title='), 'the main button must not carry a native title attribute')
  assert.ok(mainButton[0].includes('aria-label={title}'), 'the accessible name stays on the button')

  // The copy rides the keys the dictionaries already carry.
  assert.match(button, /const title = phase === 'error' \? t\('openError'\) : t\('openTitle', \{ app: appLabel\(activeEntry, t, platform\) \}\)/u)
  assert.match(button, /phase === 'error' \? t\('openError'\) : t\('openTooltip'\)/u)
  assert.match(button, /`\$\{t\('openFailed'\)\}\$\{failureReason\}`/u)
  for (const key of ['openTitle', 'openTooltip', 'openError', 'openFailed', 'menuToggle'] as const) {
    assert.ok(key in zh && key in en, `${key} must exist in both dictionaries`)
  }
})

test('T5: a launch failure is surfaced in the app, never console-logged', () => {
  const clientDir = new URL('../src/client/', import.meta.url)
  for (const entry of readdirSync(clientDir)) {
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
    const stripped = stripComments(readFileSync(new URL(entry, clientDir), 'utf8'))
    assert.ok(!/console\.(error|warn|log)\(/u.test(stripped), `${entry} must not console-log a launch failure`)
  }
  // Both rejection paths (result.ok === false and a transport rejection) set
  // the reason, and the error dress clears it with the phase it belongs to.
  assert.equal(
    [...button.matchAll(/setFailureReason\(/gu)].length,
    5,
    'two failure paths set the reason; a success and the decay timer clear it',
  )
  assert.match(button, /errorTimer\.current = setTimeout\(\(\) => \{\s*setPhase\('idle'\)\s*setFailureReason\(null\)\s*\}, ERROR_DECAY_MS\)/u)
})

test('the aligned launch semantics are unchanged (250ms busy dress, 2s error, in-flight pick)', () => {
  assert.match(button, /const BUSY_DRESS_DELAY_MS = 250/u)
  assert.match(button, /const ERROR_DECAY_MS = 2_000/u)
  const pick = /onSelect=\{\(id\) => \{[\s\S]*?\n {6}\}\}/u.exec(button)
  assert.ok(pick !== null, 'the pick handler exists')
  const chooseAt = pick[0].indexOf('choose(id)')
  const inFlightAt = pick[0].indexOf('if (inFlight.current) return')
  assert.ok(inFlightAt !== -1 && chooseAt > inFlightAt, 'a pick during an in-flight launch is still ignored whole')
  assert.ok(button.includes('if (!result.ok)') || button.includes('if (result.ok)'), 'the launch result gate stays')
})
