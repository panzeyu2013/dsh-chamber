/**
 * open-in registry (open-in.ts) unit tests — pure Node, no electron, no real
 * VS Code. Batch 3 Phase 2: the main-process registry is vscode-only (the
 * local file manager and every other local app come from the instance's own
 * official host catalog over the per-instance proxy), so this suite pins the
 * vscode provider, the vscode-only negotiation, and the shared execution
 * pipeline over untrusted renderer payloads. Every host capability
 * (registry lookup / vscode availability / url-open) is injected through
 * OpenInLaunchContext — nothing ever touches the OS.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getOpenInApp,
  listOpenInApps,
  runOpenInLaunch,
} from './open-in.ts'
import type { OpenInLaunchContext } from './open-in.ts'

/** A context fake: every host capability is injected, nothing touches the OS. */
function context(overrides: Partial<OpenInLaunchContext> = {}): OpenInLaunchContext {
  return {
    platform: overrides.platform ?? 'linux',
    lookupInstance: overrides.lookupInstance ?? (() => ({ id: 'web-1', host: 'h.example.com', user: 'root', sshPort: null, transport: 'ssh' })),
    vscodeAvailable: overrides.vscodeAvailable ?? (() => true),
    openVscodeUrl: overrides.openVscodeUrl ?? (async () => ({ ok: true })),
  }
}

test('listOpenInApps is vscode-only (the local file manager moved to the instance catalog)', () => {
  const apps = listOpenInApps(context({ platform: 'darwin', vscodeAvailable: () => true }))
  assert.deepEqual(apps.map(app => app.id), ['vscode'])
  assert.deepEqual(apps.map(app => app.displayKind), ['vscode'])
})

test('listOpenInApps vscode projection: remoteCapable true', () => {
  const apps = listOpenInApps(context({ vscodeAvailable: () => true }))
  const vscode = apps.find(app => app.id === 'vscode')
  assert.ok(vscode !== undefined)
  assert.equal(vscode.remoteCapable, true)
  assert.equal(vscode.available, true)
})

test('listOpenInApps vscode availability follows the injected deps (true/false)', () => {
  assert.equal(listOpenInApps(context({ vscodeAvailable: () => true }))[0]?.available, true)
  assert.equal(listOpenInApps(context({ vscodeAvailable: () => false }))[0]?.available, false)
})

test('listOpenInApps fails a throwing availability probe closed without rejecting the list', () => {
  const reported: Array<{ appId: string; error: string }> = []
  const apps = listOpenInApps(
    context({ vscodeAvailable: () => { throw new Error('probe exploded') } }),
    (appId, error) => { reported.push({ appId, error }) },
  )
  assert.equal(apps.length, 1)
  assert.equal(apps[0]?.available, false)
  assert.deepEqual(reported, [{ appId: 'vscode', error: 'probe exploded' }])
})

test('getOpenInApp resolves vscode and refuses the retired finder id', () => {
  assert.equal(getOpenInApp('vscode')?.id, 'vscode')
  assert.equal(getOpenInApp('finder'), null, 'finder is no longer a main-process provider')
  assert.equal(getOpenInApp('explorer'), null)
  assert.equal(getOpenInApp('unknown-app'), null)
})

test('runOpenInLaunch fails loudly for an unknown appId', async () => {
  const result = await runOpenInLaunch({ appId: 'finder', instanceId: 'local', path: '/home/user/proj' }, context())
  assert.deepEqual(result, { ok: false, error: 'unknown open-in app: finder' })
})

test('runOpenInLaunch fails loudly for a non-string appId (never guessed)', async () => {
  const result = await runOpenInLaunch({ appId: 42 as unknown as string, instanceId: 'local', path: '/home/user/proj' }, context())
  assert.deepEqual(result, { ok: false, error: 'unknown open-in app: <invalid>' })
})

test('runOpenInLaunch never stringifies a hostile non-string appId', async () => {
  const hostile = { toString() { throw new Error('toString') } }
  const result = await runOpenInLaunch({ appId: hostile as unknown as string, instanceId: 'local', path: '/home/user/proj' }, context())
  assert.deepEqual(result, { ok: false, error: 'unknown open-in app: <invalid>' })
})

test('runOpenInLaunch rejects an instanceId that fails INSTANCE_ID_PATTERN (bad/id)', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 'bad/id', path: '/home/user/proj' }, context())
  assert.deepEqual(result, { ok: false, error: 'invalid instance id' })
})

test('runOpenInLaunch rejects an empty instanceId', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: '', path: '/home/user/proj' }, context())
  assert.deepEqual(result, { ok: false, error: 'invalid instance id' })
})

test('runOpenInLaunch rejects a non-string instanceId', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 7 as unknown as string, path: '/home/user/proj' }, context())
  assert.deepEqual(result, { ok: false, error: 'invalid instance id' })
})

test('runOpenInLaunch opens a vscode-remote URL for ssh + vscode (exact target)', async () => {
  let opened: string | null = null
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'web-1', path: '/home/user/proj' },
    context({ openVscodeUrl: async url => { opened = url; return { ok: true } } }),
  )
  assert.equal(result.ok, true)
  assert.equal(opened, 'vscode://vscode-remote/ssh-remote+root@h.example.com/home/user/proj')
})

test('runOpenInLaunch opens a vscode file URL for local + vscode (exact target)', async () => {
  let opened: string | null = null
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'local', path: '/home/user/local-ws' },
    context({ openVscodeUrl: async url => { opened = url; return { ok: true } } }),
  )
  assert.equal(result.ok, true)
  assert.equal(opened, 'vscode://file/home/user/local-ws')
})

test('runOpenInLaunch opens a Windows drive path for the local instance via vscode', async () => {
  let opened: string | null = null
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'local', path: 'C:\\Users\\dev\\proj' },
    context({ platform: 'win32', openVscodeUrl: async url => { opened = url; return { ok: true } } }),
  )
  assert.equal(result.ok, true)
  assert.equal(opened, 'vscode://file/C:/Users/dev/proj')
})

test('runOpenInLaunch still accepts POSIX paths for the local instance', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 'local', path: '/home/user/ws' }, context())
  assert.deepEqual(result, { ok: true })
})

test('remote dsh session paths remain POSIX-only (drive paths fail loudly)', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 'web-1', path: 'C:\\Users\\dev\\proj' }, context())
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /absolute path/)
})

test('runOpenInLaunch fails loudly when vscode is not detected (injected ctx, any machine)', async () => {
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'local', path: '/home/user/ws' },
    context({ vscodeAvailable: () => false }),
  )
  assert.deepEqual(result, { ok: false, error: 'vscode not detected' })
})

test('runOpenInLaunch converts an availability exception into a structured failure', async () => {
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'local', path: '/home/user/ws' },
    context({ vscodeAvailable: () => { throw new Error('probe exploded') } }),
  )
  assert.deepEqual(result, { ok: false, error: 'vscode availability check failed: probe exploded' })
})

test('runOpenInLaunch converts a rejected url-open adapter into a structured failure', async () => {
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'local', path: '/home/user/ws' },
    context({ openVscodeUrl: async () => { throw new Error('shell exploded') } }),
  )
  assert.deepEqual(result, { ok: false, error: 'open vscode url failed: shell exploded' })
})

test('runOpenInLaunch survives a hostile thrown value whose traps and toString throw', async () => {
  const hostile = { toString() { throw new Error('toString') } }
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'local', path: '/home/user/ws' },
    context({ openVscodeUrl: async () => { throw hostile } }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /^open vscode url failed: /)
})

test('runOpenInLaunch rejects a non-string path (untrusted payload, never guessed)', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 'local', path: 42 as unknown as string }, context())
  assert.equal(result.ok, false)
})

test('runOpenInLaunch rejects an empty path', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 'local', path: '' }, context())
  assert.equal(result.ok, false)
})

test('runOpenInLaunch rejects a relative path', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 'local', path: 'relative/ws' }, context())
  assert.equal(result.ok, false)
})

test('runOpenInLaunch rejects a path with control characters', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 'local', path: '/home/user/\u0000ws' }, context())
  assert.equal(result.ok, false)
})

test('runOpenInLaunch rejects an overlong path', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 'local', path: `/${'a'.repeat(5000)}` }, context())
  assert.equal(result.ok, false)
})

test('runOpenInLaunch refuses a remote instance whose registry row is not ssh (no url-open side effect)', async () => {
  let opened = 0
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'web-1', path: '/home/user/proj' },
    context({
      lookupInstance: () => ({ id: 'web-1', host: 'h.example.com', user: 'root', sshPort: null, transport: 'http' }),
      openVscodeUrl: async () => { opened += 1; return { ok: true } },
    }),
  )
  assert.equal(result.ok, false)
  assert.equal(opened, 0, 'the vscode-remote URL is an ssh-transport feature only')
})

test('open-in providers are runtime-frozen and cannot mutate whitelist policy', () => {
  const app = getOpenInApp('vscode')
  assert.ok(app !== null)
  assert.equal(Object.isFrozen(app), true)
  assert.throws(() => {
    // A frozen provider must reject a whitelist mutation attempt.
    ;(app as unknown as { id: string }).id = 'finder'
  })
  assert.equal(getOpenInApp('vscode')?.id, 'vscode')
})
