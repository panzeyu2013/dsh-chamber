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

  assert.match(button, /import \{ Menu, Tooltip, type MenuItem \} from '@deepseek-ai\/dsh-client-ui-primitives'/u)
  // Upstream's own menu composition (OpenInAppAction.tsx:181-198): dense rows,
  // fill selection, end alignment, focus transfer + arrow navigation.
  for (const prop of ['autoFocus', 'dense', 'selection="fill"', 'align="end"']) {
    assert.ok(button.includes(prop), `the official Menu must be opened with ${prop}`)
  }
  // Row icons: the app marks the button shows, at the primitive's icon size.
  assert.match(button, /const items: MenuItem\[\] = entries\.map\(entry => \(\{[\s\S]*?icon: appMark\(entry, iconUrl\(entry\.id\), MENU_MARK_SIZE\)/u)
  // The split-button flow is unchanged: exactly one entry still renders the
  // plain icon button, the chevron still toggles the menu.
  assert.ok(button.includes('if (entries.length === 1)'), 'the one-entry plain button stays')
  assert.ok(button.includes('aria-haspopup="menu"'), 'the chevron still advertises the menu')
  assert.ok(button.includes('aria-expanded={open}'), 'the chevron still reports the open state')
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
    2,
    'both render paths (single entry, split button) wrap the main button in the tooltip',
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
