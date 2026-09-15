/**
 * Restart→reload completion wiring lock (2026-12, design 18 §3.6 item 8).
 *
 * The page-owned completion lives in the sidebar shared face
 * (\`restart-window-reload.ts\`, unit-tested in the sidebar package). This lock
 * pins the CONNECTIONS surfaces that must arm it: dropping an arm silently
 * restores the original defect (the host refreshes its plugin mounts while the
 * window keeps running the pre-restart client plugin set).
 *
 * Plain node + source text on purpose (the package's existing lock technique).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Read one source file of this package. */
function code(relative: string): string {
  return readFileSync(join(HERE, relative), 'utf8')
}

test('the connection cards arm the completion for every plugin-refresh restart', () => {
  const section = code('../../src/client/ConnectionsSection.tsx')
  assert.ok(section.includes('armLocalDshRestartCompletion'),
    'local 「启动」/写者接管 must arm the local completion (a started instance boots a new plugin set)')
  assert.ok(section.includes('armWindowReloadWhenServed'),
    'the gateway card restart/start and the ssh 「重启实例」 must arm the completion')
  assert.ok(section.includes('waitForSourceServing'),
    'the ssh restart leg waits on the shared source-serving gate, not a hand-rolled poll')
  assert.ok(/restartSourceService/.test(section) && section.includes("spec.kind !== 'dsh'"),
    'the systemd service restart is armed only for dsh targets — 「重启网关服务」 is not a plugin-set change')
  assert.ok(section.includes('onClick={() => { void restartSourceService(spec) }}'),
    'the card restart button must go through restartSourceService (which arms only dsh targets)')
  assert.ok(!section.includes("void runServiceOp(spec.id, 'restart_service')"),
    'no JSX call site may bypass the completion with a raw service restart')
})

test('the plugin dialog arms the completion on every restart-to-apply outcome', () => {
  const dialog = code('../../src/client/PluginDialog.tsx')
  assert.ok(dialog.includes("armSourceReload('ssh'"),
    'ssh restart-to-apply (one-click restart, row remove, undo, bulk apply) must arm')
  assert.ok(dialog.includes("armSourceReload('gateway'"),
    'gateway restart-to-apply (row remove, add, materialize, footer restart) must arm')
  assert.ok(dialog.includes('waitForSourceServing') && dialog.includes('pollGatewayReady'),
    'both backends wait on their own readiness primitive')
  assert.ok(dialog.includes('armWindowReloadWhenServed(sourceId'),
    'the dialog footer restart arms the page-owned completion (survives the dialog closing)')
})

test('neither surface navigates itself — the completion owns the single reload', () => {
  for (const file of ['../../src/client/ConnectionsSection.tsx', '../../src/client/PluginDialog.tsx']) {
    const source = code(file)
    for (const banned of ['window.location.reload', 'location.reload()']) {
      assert.ok(!source.includes(banned), `${file} must not navigate itself (${banned})`)
    }
  }
})
