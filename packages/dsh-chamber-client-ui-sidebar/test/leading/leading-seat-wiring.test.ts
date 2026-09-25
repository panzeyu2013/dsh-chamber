/**
 * Wiring lock for the `shell.leading` occupant inside the sidebar plugin
 * (workspace W15). `client/index.ts` is a cordis plugin body a node test cannot
 * import, so this SHAPE-only lock (comment-stripped source) pins the links whose
 * deletion recreates the reported break — a declared frame seat with NO occupant,
 * leaving the macOS-collapsed sidebar with no pointer-visible reopen control:
 * 1. the occupant registration exists and waits for the frame declaration;
 * 2. it reuses the shell's inject face and `sidebar` locale (official parity);
 * 3. it stays a default single registration (no id/order/priority);
 * 4. the component renders the two fixed controls and dispatches each directly.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const plugin = stripComments(read('../../src/client/index.ts'))

/** The `shell.leading` occupant effect (comment-stripped source). */
function leadingSeatEffect(source: string): string {
  const at = source.indexOf("ctx.slots.inject('shell.leading'")
  assert.notEqual(at, -1, 'the frame seat must have an occupant')
  const label = "'dsh-chamber: leading seat controls'"
  const end = source.indexOf(label, at)
  assert.notEqual(end, -1, 'the occupancy must be a dedicated ctx effect')
  return source.slice(at, end + label.length)
}

test('the sidebar registers its leading occupant into the frame seat it waits for', () => {
  const body = leadingSeatEffect(plugin)
  assert.match(body, /ctx\.slots\.inject\('shell\.leading', \(\) => ctx\.slots\.register\(\{/)
  assert.match(body, /name: 'shell\.leading',/)
  assert.match(body, /locale: NS,/)
  assert.match(body, /inject: injectProps,/, 'the occupant reuses the shell inject face (official parity)')
  assert.match(body, /\}, SidebarLeadingControls\)\)/, 'the occupant component must be the registration target')
  assert.doesNotMatch(body, /\b(?:id|order|priority):/, 'a default single registration (official parity)')
  // The seat waits for the frame declaration and rolls back with the plugin fiber.
  const effectAt = plugin.lastIndexOf('ctx.effect(', plugin.indexOf("ctx.slots.inject('shell.leading'"))
  assert.notEqual(effectAt, -1)
  assert.match(leadingSeatEffect(plugin), /'dsh-chamber: leading seat controls'/)
  assert.match(plugin, /import \{ SidebarLeadingControls \} from '\.\/SidebarLeadingControls\.tsx'/)
})

test('the occupant renders the two reachable controls and dispatches each directly', () => {
  const component = stripComments(read('../../src/client/SidebarLeadingControls.tsx'))
  assert.match(component, /aria-label=\{t\('toggle\.open'\)\}/, 'each control carries its localized accessible name')
  assert.match(component, /aria-label=\{t\('session\.new\.label'\)\}/)
  assert.match(component, /onClick=\{\(\) => \{ toggleSidebar\(\) \}\}/, 'the reopen control runs the layout toggle')
  assert.match(component, /onClick=\{\(\) => \{ startSession\(\) \}\}/)
  assert.match(component, /\(useShortcuts as ShortcutsHook\)\(rows => rows\.find\(row => row\.id === 'sidebar\.left\.toggle'\)\)/)
  assert.match(component, /\(useShortcuts as ShortcutsHook\)\(rows => rows\.find\(row => row\.id === 'session\.new'\)\)/)
  assert.match(component, /IconPanelLeftOutlineRegular/)
  assert.match(component, /IconNewChatOutlineRegular/)
  assert.doesNotMatch(component, /SIDEBAR_LEADING_CONTROLS/, 'the seat is a fixed two-control projection, not a table')
})

test('the seat prices the frame band the frame actually reserves (two 28px controls, 8px gap)', () => {
  // AppFrame.module.css computes --dsh-frame-leading-clearance as 88 + 28 + 8 + 28 + 8:
  // a bigger control or gap would land content under the window chrome.
  const css = read('../../src/client/SidebarLeadingControls.module.css')
  assert.match(css, /\.controls \{[\s\S]*?gap: 8px;/)
  assert.match(css, /\.iconButton \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/)
})
