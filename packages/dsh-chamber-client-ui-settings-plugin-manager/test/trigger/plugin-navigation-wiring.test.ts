/**
 * Settings-navigation wiring lock (cross-package source lock, the plugin-refresh
 * wiring precedent): the service key (`pluginNavigation`), the seat key
 * (`chamberSettingsNavigation`) and the shell's consume path are string keys + structural
 * types, so a rename on either side would compile and silently no-op at runtime. These
 * shapes are therefore pinned as source text; the behavior truth tables live in
 * `plugin-navigation.test.ts` and `settings-open-seat.test.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const pmIndex = read('../../src/client/index.ts')
const navModule = read('../../src/client/plugin-navigation.ts')
const bridgeIndex = read('../../../../packages/dsh-chamber-client-ui-settings-bridge/src/client/index.ts')
const seatModule = read('../../../../packages/dsh-chamber-client-ui-settings-bridge/src/client/settings-navigation.ts')
const shell = read('../../../../packages/dsh-chamber-client-ui-settings-bridge/src/client/SettingsShell.tsx')

test('the provider owns both upstream methods and queues the page target', () => {
  assert.match(navModule, /openList: \(\) => \{ request\('list'\) \}/)
  assert.match(navModule, /openBundle: \(packageName\) => \{ request\(\{ kind: 'package', name: packageName \}\) \}/)
  assert.match(navModule, /openPending = !deps\.openSection\(\)/)
})

test('the plugin body provides the service, reads the seat, and flushes a queued open', () => {
  assert.match(pmIndex, /createPluginNavigation\(\{/)
  assert.match(pmIndex, /ctx\.get<\{ open\(sectionId: string\): void \} \| undefined>\('chamberSettingsNavigation'\)/)
  assert.match(pmIndex, /ctx\.inject\(\['chamberSettingsNavigation'\], \(\) => \{ navigation\.retryOpen\(\) \}\)/)
  assert.match(pmIndex, /seat\.open\(PLUGIN_SECTION_ID\)/)
  assert.match(pmIndex, /ctx\.reflect\.provide\('pluginNavigation', navigation\.provider\)/)
  assert.match(pmIndex, /yield navigation\.attach\(applyNavigation\)/)
  // The one-way provider (store only, never opens the dialog) must not come back.
  assert.doesNotMatch(pmIndex, /let openPackage/)
  assert.doesNotMatch(pmIndex, /openBundle: \(packageName: string\) => \{ openPackage/)
})

test('the settings shell provides the per-ctx seat and consumes it with a forced source + ack', () => {
  assert.match(bridgeIndex, /ctx\.reflect\.provide\('chamberSettingsNavigation', navigation\)/)
  assert.match(bridgeIndex, /chamberInstanceId, navigation/)
  assert.match(shell, /settingsOpenCommand\(navigation\.getRequest\(\), lastOpenSeq\.current\)/)
  assert.match(shell, /setSelectedId\(chamberInstanceId\)/)
  assert.match(shell, /setActiveId\(command\.sectionId\)/)
  assert.match(shell, /const \[pendingAck, setPendingAck\] = useState<SettingsOpenCommand \| undefined>\(undefined\)/)
  assert.match(shell, /setPendingAck\(command\)/)
  assert.match(shell, /settingsAckDecision\(pendingAck, open, activeId\)/)
  assert.match(shell, /if \(decision !== 'ack' && decision !== 'drop'\) return/)
  assert.match(shell, /navigation\.acknowledge\(pendingAck\.seq\)/)
  assert.match(shell, /setPendingAck\(undefined\)/)
  // Commit-bound state, not a ref/tick: the ack belongs to the render that shows
  // the requested section, and a manual visit/close is decided by the pure helper.
  assert.doesNotMatch(shell, /pendingAck\.current|requestTick/)
  assert.doesNotMatch(shell, /navigation\.acknowledge\(command\.seq\)/, 'the ack must not run inline in the consume effect')
  assert.match(shell, /navigation\.subscribe\(consume\)/)
})

test('the seat acknowledges only the matching sequence (a stale ack cannot clear a newer request)', () => {
  assert.match(seatModule, /open: \(sectionId\) => \{/)
  assert.match(seatModule, /acknowledge: \(consumedSeq\) => \{/)
  assert.match(seatModule, /if \(request\?\.seq === consumedSeq\) request = undefined/)
})
