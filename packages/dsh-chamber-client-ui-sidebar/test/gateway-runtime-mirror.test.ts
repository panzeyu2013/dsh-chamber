/**
 * Gateway runtime shared-face MIRROR LOCKSTEP (design 21 §5.2): the sidebar
 * shared gateway-runtime core is consumed by OTHER packages through
 * handwritten ambient declarations — each consumer maps
 * `@dsh-chamber/dsh-client-ui-sidebar/shared` to its own `src/ambient/*.d.ts`
 * via tsconfig paths and never typechecks the real sidebar sources. This
 * plain-node test keeps those consumer mirrors in sync with the REAL modules:
 *
 *  - settings-bridge `src/ambient/chamber-bridge.d.ts` mirrors the moved
 *    gateway-runtime + gateway-runtime-poll faces (its rewired client imports
 *    the parsers/gates/errors/poll from shared);
 *  - connections `src/ambient/sidebar-shared.d.ts` mirrors the poll face (its
 *    restart button consumes pollGatewayReady from shared).
 *
 * RUNTIME (const/function/class) exports are enumerated from the real module
 * namespace; type-only exports are erased at runtime, so they are checked
 * textually from the real module source with the same top-level
 * `export (declare )?(const|function|type|interface|class) NAME` shape the
 * ambient mirrors declare.
 *
 * NOTE: the consumer ambients were extended as part of the settings-bridge
 * rewire (design 21 §5.2 ambient mirror sync; MIRROR WARNING headers) and now
 * declare the full moved export set — including the recover-metadata-era
 * additions (metadataHealth/metadataComponents/canRecoverMetadata,
 * removableVersions and the cleanup-version/restore-pre-rollback/
 * recover-metadata action kinds). The assertions below are the lockstep
 * contract: they stay green and catch every future drift of either side.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const SETTINGS_BRIDGE_AMBIENT = new URL(
  '../../dsh-chamber-client-ui-settings-bridge/src/ambient/chamber-bridge.d.ts',
  import.meta.url,
)
const CONNECTIONS_AMBIENT = new URL(
  '../../dsh-chamber-client-ui-settings-connections/src/ambient/sidebar-shared.d.ts',
  import.meta.url,
)
const GATEWAY_RUNTIME_SOURCE = new URL('../src/shared/gateway-runtime.ts', import.meta.url)
const GATEWAY_RUNTIME_POLL_SOURCE = new URL('../src/shared/gateway-runtime-poll.ts', import.meta.url)

/** Top-level `export (declare )?(const|function|type|interface|class) NAME`. */
const EXPORT_DECLARATION = /^[ \t]*export (?:declare )?(const|function|type|interface|class) ([A-Za-z_$][A-Za-z0-9_$]*)/gm

function declaredExportNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(EXPORT_DECLARATION)) names.add(match[2]!)
  return names
}

/** Type-only export names (type/interface/class) — erased at runtime, so the
 *  mirror check for them is textual over the real module source. */
function declaredTypeExportNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(EXPORT_DECLARATION)) {
    const keyword = match[1]!
    if (keyword === 'type' || keyword === 'interface' || keyword === 'class') names.add(match[2]!)
  }
  return names
}

function missingFrom(realNames: Iterable<string>, ambientNames: ReadonlySet<string>): string[] {
  return [...realNames].filter((name) => !ambientNames.has(name)).sort()
}

test('gateway-runtime.ts runtime exports are declared in the settings-bridge ambient (chamber-bridge.d.ts)', async () => {
  const ambientNames = declaredExportNames(await readFile(SETTINGS_BRIDGE_AMBIENT, 'utf8'))
  assert.ok(ambientNames.size > 0, 'settings-bridge ambient parse found no declarations (regex drift?)')
  const real = await import('../src/shared/gateway-runtime.ts')
  const runtimeNames = Object.keys(real).filter((name) => name !== 'default')
  assert.ok(runtimeNames.length > 0, 'gateway-runtime.ts exposes no runtime exports')
  const missing = missingFrom(runtimeNames, ambientNames)
  assert.deepEqual(
    missing,
    [],
    'settings-bridge ambient (packages/dsh-chamber-client-ui-settings-bridge/src/ambient/chamber-bridge.d.ts) '
      + 'does not declare these moved gateway-runtime runtime export(s): '
      + `${missing.join(', ')} — extend the ambient with the shared gateway-runtime face `
      + '(design 21 §5.2 ambient mirror sync; real module: src/shared/gateway-runtime.ts).',
  )
})

test('gateway-runtime-poll.ts runtime exports are declared in the settings-bridge ambient (chamber-bridge.d.ts)', async () => {
  const ambientNames = declaredExportNames(await readFile(SETTINGS_BRIDGE_AMBIENT, 'utf8'))
  assert.ok(ambientNames.size > 0, 'settings-bridge ambient parse found no declarations (regex drift?)')
  const real = await import('../src/shared/gateway-runtime-poll.ts')
  const runtimeNames = Object.keys(real).filter((name) => name !== 'default')
  assert.ok(runtimeNames.length > 0, 'gateway-runtime-poll.ts exposes no runtime exports')
  const missing = missingFrom(runtimeNames, ambientNames)
  assert.deepEqual(
    missing,
    [],
    'settings-bridge ambient (packages/dsh-chamber-client-ui-settings-bridge/src/ambient/chamber-bridge.d.ts) '
      + 'does not declare these moved gateway-runtime-poll runtime export(s): '
      + `${missing.join(', ')} — extend the ambient with the shared poll face `
      + '(design 21 §5.2 ambient mirror sync; real module: src/shared/gateway-runtime-poll.ts).',
  )
})

test('gateway-runtime-poll.ts runtime exports are declared in the connections ambient (sidebar-shared.d.ts)', async () => {
  const ambientNames = declaredExportNames(await readFile(CONNECTIONS_AMBIENT, 'utf8'))
  assert.ok(ambientNames.size > 0, 'connections ambient parse found no declarations (regex drift?)')
  const real = await import('../src/shared/gateway-runtime-poll.ts')
  const runtimeNames = Object.keys(real).filter((name) => name !== 'default')
  const missing = missingFrom(runtimeNames, ambientNames)
  assert.deepEqual(
    missing,
    [],
    'connections ambient (packages/dsh-chamber-client-ui-settings-connections/src/ambient/sidebar-shared.d.ts) '
      + 'does not declare these shared poll runtime export(s): '
      + `${missing.join(', ')} — extend the ambient with the shared poll face (design 21 §5.2 ambient mirror sync; `
      + 'the connections restart button consumes pollGatewayReady).',
  )
})

test('gateway-runtime.ts type-only exports are declared in the settings-bridge ambient (chamber-bridge.d.ts)', async () => {
  const [ambientText, realText] = await Promise.all([
    readFile(SETTINGS_BRIDGE_AMBIENT, 'utf8'),
    readFile(GATEWAY_RUNTIME_SOURCE, 'utf8'),
  ])
  const ambientNames = declaredExportNames(ambientText)
  assert.ok(ambientNames.size > 0, 'settings-bridge ambient parse found no declarations (regex drift?)')
  const typeNames = declaredTypeExportNames(realText)
  assert.ok(typeNames.size > 0, 'gateway-runtime.ts exposes no type exports (regex drift?)')
  const missing = missingFrom(typeNames, ambientNames)
  assert.deepEqual(
    missing,
    [],
    'settings-bridge ambient (packages/dsh-chamber-client-ui-settings-bridge/src/ambient/chamber-bridge.d.ts) '
      + 'does not declare these moved gateway-runtime type export(s): '
      + `${missing.join(', ')} — extend the ambient with the shared gateway-runtime export symbol set `
      + '(design 21 §5.2 ambient mirror sync; real module: src/shared/gateway-runtime.ts).',
  )
})

test('gateway-runtime-poll.ts type-only exports are declared in the settings-bridge ambient (chamber-bridge.d.ts)', async () => {
  const [ambientText, realText] = await Promise.all([
    readFile(SETTINGS_BRIDGE_AMBIENT, 'utf8'),
    readFile(GATEWAY_RUNTIME_POLL_SOURCE, 'utf8'),
  ])
  const ambientNames = declaredExportNames(ambientText)
  assert.ok(ambientNames.size > 0, 'settings-bridge ambient parse found no declarations (regex drift?)')
  const typeNames = declaredTypeExportNames(realText)
  assert.ok(typeNames.size > 0, 'gateway-runtime-poll.ts exposes no type exports (regex drift?)')
  const missing = missingFrom(typeNames, ambientNames)
  assert.deepEqual(
    missing,
    [],
    'settings-bridge ambient (packages/dsh-chamber-client-ui-settings-bridge/src/ambient/chamber-bridge.d.ts) '
      + 'does not declare this moved gateway-runtime-poll type export: '
      + `${missing.join(', ')} — extend the ambient with the shared poll export symbol set `
      + '(design 21 §5.2 ambient mirror sync; real module: src/shared/gateway-runtime-poll.ts).',
  )
})
