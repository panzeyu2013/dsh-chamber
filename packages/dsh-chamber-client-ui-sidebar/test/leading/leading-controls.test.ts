/**
 * `shell.leading` occupant contract (design 05 §2, rc.2 AppFrame): the window-chrome
 * seat is mounted only while the macOS collapse hides the whole sidebar column, so
 * its control set must carry the REOPEN toggle — without it the collapsed state has
 * no pointer-visible way back (the rail itself is clipped by the zero-width column).
 * The seat is a fixed two-control projection, and this package has no React test
 * runtime, so the component source text is read directly; `leading-seat-wiring.test.ts`
 * locks the client/index.ts registration around it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { en, zh, type SidebarKey } from '../../src/client/locales.ts'

const component = stripComments(readFileSync(new URL('../../src/client/SidebarLeadingControls.tsx', import.meta.url), 'utf8'))

/** One <button> body per rendered control, in source order. */
const buttons = (): string[] => [...component.matchAll(/<button[\s\S]*?<\/button>/gu)].map(match => match[0])

test('the reopen toggle comes first and runs the layout toggle; New Session follows', () => {
  const rendered = buttons()
  const [toggle, newSession] = rendered
  assert.equal(rendered.length, 2, 'the seat renders exactly two controls')
  assert.match(toggle as string, /aria-label=\{t\('toggle\.open'\)\}/u)
  assert.match(toggle as string, /onClick=\{\(\) => \{ toggleSidebar\(\) \}\}/u, 'the reopen toggle must not reuse the New Session action')
  assert.match(toggle as string, /IconPanelLeftOutlineRegular/u)
  assert.match(newSession as string, /aria-label=\{t\('session\.new\.label'\)\}/u)
  assert.match(newSession as string, /onClick=\{\(\) => \{ startSession\(\) \}\}/u)
  assert.match(newSession as string, /IconNewChatOutlineRegular/u)
})

test('each control carries its effective shortcut binding, absent while unregistered', () => {
  const [toggle, newSession] = buttons()
  assert.match(component, /\(useShortcuts as ShortcutsHook\)\(rows => rows\.find\(row => row\.id === 'sidebar\.left\.toggle'\)\)/u)
  assert.match(component, /\(useShortcuts as ShortcutsHook\)\(rows => rows\.find\(row => row\.id === 'session\.new'\)\)/u)
  assert.match(toggle as string, /aria-keyshortcuts=\{shortcut\?\.aria\}/u)
  assert.match(newSession as string, /aria-keyshortcuts=\{newShortcut\?\.aria\}/u)
  assert.match(component, /<Tooltip label=\{t\('toggle\.open'\)\} shortcutKeys=\{shortcut\?\.keys\}/u)
  assert.match(component, /<Tooltip label=\{t\('session\.new\.label'\)\} shortcutKeys=\{newShortcut\?\.keys\}/u)
})

test('every label the seat renders lives in the sidebar dictionary in both languages', () => {
  const labelKeys: readonly SidebarKey[] = ['toggle.open', 'session.new.label']
  for (const key of labelKeys) {
    assert.equal(typeof zh[key], 'string', key)
    assert.equal(typeof en[key], 'string', key)
    assert.notEqual(zh[key], '', key)
    assert.notEqual(en[key], '', key)
  }
})
