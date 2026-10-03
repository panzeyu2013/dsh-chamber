/**
 * Plugin-refresh wiring lock (cross-package source lock; the dom-seam group's precedent):
 * the manager's settle trigger, the shell's control face + forwarding, the App-level retry
 * relay and the panel's three notice actions. The control face is a string key + structural
 * type, so a rename on either side would compile and silently no-op at runtime; the shapes
 * (above all: the start time must not be dropped) are therefore pinned as source text.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const pmIndex = read('../../src/client/index.ts')
const shell = read('../../../../packages/renderer/src/shell.ts')
const control = read('../../../../packages/renderer/src/plugin-refresh-control.ts')
const hook = read('../../../../packages/renderer/src/app-hooks/use-bridge-subscriptions.ts')
const panel = read('../../../../packages/dsh-chamber-client-ui-settings-bridge/src/client/SettingsShell.tsx')

test('the manager settle edge calls the control with the action start; a start closes the window', () => {
  assert.match(pmIndex, /createPluginActionTracker\(isInstallPending\)/)
  assert.match(pmIndex, /transition\?\.kind === 'started'\) pluginRefresh\.actionStarted\(\)/)
  assert.match(pmIndex, /transition\?\.kind === 'settled'\) pluginRefresh\.requestRefresh\(transition\.startedAt\)/)
  assert.match(pmIndex, /requestRefresh\(startedAt: number\): void/)
  assert.match(pmIndex, /actionStarted\(\): void/)
  assert.match(pmIndex, /chamberPluginRefresh control missing/)
})

test('the shell provides the control and forwards both members without dropping the start time', () => {
  assert.match(shell, /ctx\.provide\('chamberPluginRefresh', \{/)
  assert.match(shell, /requestRefresh: \(startedAt: number\) => \{ pluginRefresh\.requestRefresh\(startedAt\) \}/)
  assert.match(shell, /actionStarted: \(\) => \{ pluginRefresh\.actionStarted\(\) \}/)
  assert.match(control, /shouldReloadForPluginRefresh\(storage\(\), now\(\)\)/)
  // No frame-freshness shortcut may come back: every settle must re-subscribe (a frame
  // that arrived during the action does not prove the final graph arrived).
  assert.doesNotMatch(shell, /lastFrameAt/)
  assert.doesNotMatch(control, /lastFrameAt/)
  assert.match(shell, /entries\.get\(instanceId\)\?\.liveSync\?\.resync\(\) \?\? false/)
  // The per-boot control is disposed with its ctx (the window/subscription must not
  // outlive the boot generation it was armed for).
  assert.match(shell, /ctx\.effect\?\.\(\(\) => \(\) => \{ pluginRefresh\.dispose\(\) \}, 'shell: plugin refresh convergence'\)/)
})

test('the renderer forwards a page-level resync request to the mounted shell', () => {
  assert.match(hook, /onClientGraphResyncRequest/)
  assert.match(hook, /resyncInstanceClientGraph/)
})

test('the panel exposes the three notice actions and the manual retry request', () => {
  assert.match(panel, /pluginNotice\(selected\?\.pluginDiagnostic\)/)
  assert.match(panel, /requestClientGraphResync\(selected\.id\)/)
  assert.match(panel, /onSelectSection\(CONNECTIONS_SECTION_ID\)/)
  assert.match(panel, /window\.location\.reload\(\)/)
})
