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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

// src/** 的反向源锁扫描面：本包没有 typecheck 程序，源码形态只能在这里钉。
const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url))
const srcSources = readdirSync(SRC_DIR, { recursive: true })
  .filter(relative => /\.(?:ts|tsx)$/u.test(relative))
  .map(relative => ({ relative, code: stripComments(readFileSync(join(SRC_DIR, relative), 'utf8')) }))

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
  assert.match(pmIndex, /ctx\.get\('chamberSettingsNavigation'\)/)
  assert.match(pmIndex, /ctx\.inject\(\['chamberSettingsNavigation'\], \(\) => \{ navigation\.retryOpen\(\) \}\)/)
  assert.match(pmIndex, /seat\.open\(PLUGIN_SECTION_ID\)/)
  assert.match(pmIndex, /ctx\.reflect\.provide\('pluginNavigation', navigation\.provider\)/)
  assert.match(pmIndex, /yield navigation\.attach\(applyNavigation\)/)
  // The one-way provider (store only, never opens the dialog) must not come back.
  assert.doesNotMatch(pmIndex, /let openPackage/)
  assert.doesNotMatch(pmIndex, /openBundle: \(packageName: string\) => \{ openPackage/)
})

test('the seat is declared by module augmentation and read with the key-only ctx.get', () => {
  // 声明合并是本包唯一的类型来源：删掉声明后 get 会落到 get(name: string): any 重载，
  // key 形态照旧编译、静默退化成 any；没有 typecheck 程序时只能靠源锁。
  assert.match(pmIndex, /chamberSettingsNavigation\?: \{ open\(sectionId: string\): void \}/)
  assert.match(pmIndex, /ctx\.get\('chamberSettingsNavigation'\)/)
  // 反向源锁：cordis 的 get 只接受 key（`K extends string & keyof this`），显式类型实参
  // 在声明合并前后都可能编译通过或被当成 any；扫描前先剥注释，避免注释里的写法假红。
  const offenders = srcSources
    .filter(({ code }) => /ctx\.get</u.test(code))
    .map(({ relative }) => relative)
  assert.deepEqual(offenders, [], 'ctx.get 不得带显式类型实参：座席一律用模块增补声明')
})

test('the settings shell provides the per-ctx seat and consumes it with a forced source + ack', () => {
  assert.match(bridgeIndex, /ctx\.reflect\.provide\('chamberSettingsNavigation', navigation\)/)
  assert.match(bridgeIndex, /chamberInstanceId, navigation/)
  assert.match(shell, /settingsOpenCommand\(navigation\.getRequest\(\), lastOpenSeq\.current\)/)
  assert.match(shell, /setSelectedId\(chamberInstanceId\)/)
  assert.match(shell, /setActiveId\(command\.sectionId\)/)
  assert.match(shell, /const \[pendingAck, setPendingAck\] = useState<SettingsOpenCommand \| undefined>\(undefined\)/)
  assert.match(shell, /setPendingAck\(command\)/)
  // 决策在渲染期由 settingsAckPlan 派生；effect 只执行 ackPlan（见
  // test/shell/settings-ack-wiring.test.ts 的依赖数组锁）。
  assert.match(shell, /settingsAckPlan\(pendingAck, open, activeId\)/)
  assert.match(shell, /if \(ackPlan\.kind !== 'ack' && ackPlan\.kind !== 'drop'\) return/)
  assert.match(shell, /navigation\.acknowledge\(ackPlan\.seq\)/)
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
