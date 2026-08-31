/**
 * RuntimeHostAdapter seam + shared fake fixture smoke test (design 18 §9.1).
 *
 * Proves the shared core is host-agnostic: the `FakeHostAdapter` satisfies the
 * `RuntimeHostAdapter` interface (re-exported from the package index) over a
 * temp state root, an in-memory clock, and recorded spawn/stop/restart fakes —
 * no Electron/userData/IPC.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { REQUIRED_ACTIVATION_PROBES } from '../src/activation-gate.ts'
import type { RuntimeHostAdapter } from '../src/index.ts'
import { FakeHostAdapter } from './fake-adapter.ts'

test('FakeHostAdapter satisfies RuntimeHostAdapter over a temp state root', async () => {
  const fake = new FakeHostAdapter()
  const adapter: RuntimeHostAdapter = fake // assignability check against the package index
  assert.ok(existsSync(adapter.stateRoot()), 'stateRoot is a real temp dir')
  assert.ok(existsSync(adapter.dshHome()), 'dshHome is a real temp dir')
  assert.equal(adapter.shellVersion(), '0.2.0-beta.1')
  assert.equal(adapter.envOverridePath(), null)
  assert.deepEqual(adapter.builtinAnchors(), [{ path: '/fake/builtin/dsh', version: '0.1.1-rc.2' }])
  assert.deepEqual(adapter.platformGate(), { mutationsAllowed: true })

  const probes = await adapter.spawnAndProbe('1.0.0', false)
  assert.equal(probes.length, REQUIRED_ACTIVATION_PROBES.length)
  assert.ok(probes.every((p) => p.ok))

  await adapter.restartHost()
  await adapter.stopHost()
  adapter.notify({ phase: 'applying', version: '1.0.0' })
  assert.deepEqual(fake.notifications, [{ phase: 'applying', version: '1.0.0' }])
})

test('FakeHostAdapter records spawn calls and honors injectable probes + platform gate', async () => {
  const adapter = new FakeHostAdapter({ mutationsAllowed: false })
  assert.deepEqual(adapter.platformGate(), { mutationsAllowed: false, reason: 'windows-read-only' })

  adapter.setProbeResults([{ name: 'session/list', ok: false, error: 'boom' }])
  const probes = await adapter.spawnAndProbe('2.0.0', true)
  assert.equal(probes.length, 1)
  assert.equal(probes[0]!.ok, false)
  assert.deepEqual(adapter.spawned, [{ version: '2.0.0', isBuiltin: true }])
  assert.equal(adapter.restartCalls, 0)
  assert.equal(adapter.stopCalls, 0)
})

test('FakeHostAdapter exposes an in-memory clock', () => {
  const adapter = new FakeHostAdapter()
  assert.equal(adapter.nowMs, 0)
  assert.equal(adapter.advanceClock(60_000), 60_000)
  assert.equal(adapter.nowMs, 60_000)
})
