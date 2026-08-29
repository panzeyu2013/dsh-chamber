/**
 * open-in registry (open-in.ts) unit tests — pure Node, no electron, no real
 * VS Code, no real file manager. The renderer IPC payload is untrusted input,
 * so the suite drives runOpenInLaunch with unknown appIds / malformed instance
 * ids / malicious paths, drives listOpenInApps through injected vscode
 * availability deps (the suite must not depend on whether the machine has
 * VS Code), and drives every app.open through an injected OpenInLaunchContext
 * (registry lookup / vscode availability / url-open / stat / openPath /
 * showItemInFolder are all faked — nothing ever touches the OS).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyLocalPath,
  getOpenInApp,
  invokeOpenPath,
  listOpenInApps,
  normalizeOpenPathError,
  runOpenInLaunch,
  shouldRevealDirectoryInsteadOfOpen,
} from './open-in.ts'
import type { OpenInLaunchContext } from './open-in.ts'

/** A context fake: every host capability is injected, nothing touches the OS. */
function context(overrides: Partial<OpenInLaunchContext> = {}): OpenInLaunchContext {
  return {
    platform: overrides.platform ?? 'linux',
    lookupInstance: overrides.lookupInstance ?? (() => ({ id: 'web-1', host: 'h.example.com', user: 'root', sshPort: null, transport: 'ssh' })),
    vscodeAvailable: overrides.vscodeAvailable ?? (() => true),
    openVscodeUrl: overrides.openVscodeUrl ?? (async () => ({ ok: true })),
    stat: overrides.stat ?? (async () => ({ kind: 'dir' })),
    openPath: overrides.openPath ?? (async () => null),
    showItemInFolder: overrides.showItemInFolder ?? (() => {}),
  }
}

test('listOpenInApps returns finder and vscode in the fixed order [finder, vscode]', () => {
  const apps = listOpenInApps(context({ platform: 'darwin', vscodeAvailable: () => true }))
  assert.deepEqual(apps.map(app => app.id), ['finder', 'vscode'])
  assert.deepEqual(apps.map(app => app.displayKind), ['file-manager', 'vscode'])
})

test('listOpenInApps finder projection: remoteCapable false and always available', () => {
  const apps = listOpenInApps(context({ vscodeAvailable: () => false }))
  const finder = apps.find(app => app.id === 'finder')
  assert.ok(finder !== undefined)
  assert.equal(finder.remoteCapable, false)
  assert.equal(finder.available, true)
})

test('listOpenInApps vscode projection: remoteCapable true', () => {
  const apps = listOpenInApps(context({ vscodeAvailable: () => true }))
  const vscode = apps.find(app => app.id === 'vscode')
  assert.ok(vscode !== undefined)
  assert.equal(vscode.remoteCapable, true)
  assert.equal(vscode.available, true)
})

test('listOpenInApps vscode availability follows the injected deps (true/false)', () => {
  const withTrue = listOpenInApps(context({ vscodeAvailable: () => true }))
  assert.equal(withTrue.find(app => app.id === 'vscode')!.available, true)
  const withFalse = listOpenInApps(context({ vscodeAvailable: () => false }))
  assert.equal(withFalse.find(app => app.id === 'vscode')!.available, false)
})

test('listOpenInApps fails a throwing availability probe closed without rejecting the list', () => {
  const reported: Array<{ appId: string; error: string }> = []
  const apps = listOpenInApps(
    context({ vscodeAvailable: () => { throw new Error('probe exploded') } }),
    (appId, error) => reported.push({ appId, error }),
  )
  assert.deepEqual(apps, [
    { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true },
    { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: false },
  ])
  assert.deepEqual(reported, [{ appId: 'vscode', error: 'probe exploded' }], 'provider failure is loud per entry')
})

test('classifyLocalPath maps only ENOENT/ENOTDIR to missing and propagates other stat errors', async () => {
  assert.deepEqual(
    await classifyLocalPath(async () => ({ isDirectory: () => true }), '/dir'),
    { kind: 'dir' },
  )
  assert.deepEqual(
    await classifyLocalPath(async () => ({ isDirectory: () => false }), '/file'),
    { kind: 'file' },
  )
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const error = Object.assign(new Error(code), { code })
    assert.equal(await classifyLocalPath(async () => Promise.reject(error), '/missing'), null)
  }
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  await assert.rejects(
    classifyLocalPath(async () => Promise.reject(denied), '/secret'),
    error => error === denied,
  )
})

test('runOpenInLaunch fails loudly for an unknown appId', async () => {
  const result = await runOpenInLaunch({ appId: 'cursor', instanceId: 'local', path: '/foo' }, context())
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /unknown open-in app/)
})

test('runOpenInLaunch fails loudly for a non-string appId (never guessed)', async () => {
  const result = await runOpenInLaunch({ appId: undefined as unknown as string, instanceId: 'local', path: '/foo' }, context())
  assert.deepEqual(result, { ok: false, error: 'unknown open-in app: <invalid>' })
})

test('runOpenInLaunch never stringifies a hostile non-string appId', async () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error('getPrototypeOf trap') },
    get() { throw new Error('get trap') },
  })
  const result = await runOpenInLaunch(
    { appId: hostile as unknown as string, instanceId: 'local', path: '/foo' },
    context(),
  )
  assert.deepEqual(result, { ok: false, error: 'unknown open-in app: <invalid>' })
})

test('runOpenInLaunch rejects an instanceId that fails INSTANCE_ID_PATTERN (bad/id)', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: 'bad/id', path: '/foo' }, context())
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /invalid instance id/)
})

test('runOpenInLaunch rejects an empty instanceId', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: '', path: '/foo' }, context())
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /invalid instance id/)
})

test('runOpenInLaunch rejects a non-string instanceId', async () => {
  const result = await runOpenInLaunch({ appId: 'vscode', instanceId: undefined as unknown as string, path: '/foo' }, context())
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /invalid instance id/)
})

test('runOpenInLaunch refuses a remote instance for finder before the provider runs (no side effects)', async () => {
  let revealed = 0
  let opened = 0
  let statted = 0
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'web-1', path: '/foo' },
    context({
      stat: async () => { statted += 1; return { kind: 'dir' } },
      openPath: async () => { opened += 1; return null },
      showItemInFolder: () => { revealed += 1 },
    }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not available for remote instances/)
  assert.equal(statted, 0, 'finder.open must never run for a remote instance (stat)')
  assert.equal(opened, 0, 'finder.open must never run for a remote instance (openPath)')
  assert.equal(revealed, 0, 'finder.open must never run for a remote instance (showItemInFolder)')
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

test('runOpenInLaunch opens a directory via openPath for local + finder (original path passed)', async () => {
  let openedPath: string | null = null
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'local', path: '/home/user/proj' },
    context({ platform: 'linux', openPath: async path => { openedPath = path; return null } }),
  )
  assert.equal(result.ok, true)
  assert.equal(openedPath, '/home/user/proj')
})

test('macOS reveals every directory and never passes package-like or symlink directories to openPath', async () => {
  let opened = 0
  const revealed: string[] = []
  const candidates = [
    '/tmp/ordinary-project',
    '/tmp/Unknown.third-party-package',
    // Production fsp.stat follows symlinks. A symlink to any directory is
    // therefore covered by the same Darwin-wide reveal-only decision.
    '/tmp/neutral-symlink',
  ]
  for (const candidate of candidates) {
    const result = await runOpenInLaunch(
      { appId: 'finder', instanceId: 'local', path: candidate },
      context({
        platform: 'darwin',
        stat: async () => ({ kind: 'dir' }),
        openPath: async () => { opened += 1; return null },
        showItemInFolder: path => { revealed.push(path) },
      }),
    )
    assert.deepEqual(result, { ok: true })
  }
  assert.equal(opened, 0, 'shell.openPath must never receive any macOS directory')
  assert.deepEqual(revealed, candidates)
})

test('directory reveal policy is Darwin-wide and stays platform-scoped', () => {
  assert.equal(shouldRevealDirectoryInsteadOfOpen('darwin'), true)
  assert.equal(shouldRevealDirectoryInsteadOfOpen('linux'), false)
  assert.equal(shouldRevealDirectoryInsteadOfOpen('win32'), false)
})

test('runOpenInLaunch surfaces an openPath failure loudly', async () => {
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'local', path: '/home/user/proj' },
    context({ openPath: async () => 'boom' }),
  )
  assert.deepEqual(result, { ok: false, error: 'open path failed: boom' })
})

test('runOpenInLaunch converts a rejected finder host adapter into a structured failure', async () => {
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'local', path: '/home/user/proj' },
    context({ stat: async () => { throw new Error('stat exploded') } }),
  )
  assert.deepEqual(result, { ok: false, error: 'finder open failed: stat exploded' })
})

test('runOpenInLaunch survives a hostile thrown value whose traps and toString throw', async () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error('getPrototypeOf trap') },
    get() { throw new Error('get trap') },
  })
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'local', path: '/home/user/proj' },
    context({ stat: async () => Promise.reject(hostile) }),
  )
  assert.deepEqual(result, { ok: false, error: 'finder open failed: unknown error' })
})

test('runOpenInLaunch reveals a file via showItemInFolder for local + finder', async () => {
  let revealed: string | null = null
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'local', path: '/home/user/file.txt' },
    context({ stat: async () => ({ kind: 'file' }), showItemInFolder: path => { revealed = path } }),
  )
  assert.equal(result.ok, true)
  assert.equal(revealed, '/home/user/file.txt')
})

test('runOpenInLaunch converts a synchronous reveal exception into a structured failure', async () => {
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'local', path: '/home/user/file.txt' },
    context({
      stat: async () => ({ kind: 'file' }),
      showItemInFolder: () => { throw new Error('reveal exploded') },
    }),
  )
  assert.deepEqual(result, { ok: false, error: 'finder open failed: reveal exploded' })
})

test('runOpenInLaunch fails loudly when the stat probe reports the path missing', async () => {
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'local', path: '/home/user/ghost' },
    context({ stat: async () => null }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /path does not exist/)
})

test('runOpenInLaunch fails loudly when vscode is not detected (injected ctx, any machine)', async () => {
  // The pipeline's availability gate reads ctx.vscodeAvailable (injected), so
  // this is deterministic on any machine — no real VS Code probe involved.
  let opened = 0
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'local', path: '/home/user/ws' },
    context({ vscodeAvailable: () => false, openVscodeUrl: async () => { opened += 1; return { ok: true } } }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not detected/)
  assert.equal(opened, 0, 'the provider must never run when the availability gate fails')
})

test('runOpenInLaunch converts an availability exception into a structured failure', async () => {
  let opened = 0
  const result = await runOpenInLaunch(
    { appId: 'vscode', instanceId: 'local', path: '/home/user/ws' },
    context({
      vscodeAvailable: () => { throw new Error('availability exploded') },
      openVscodeUrl: async () => { opened += 1; return { ok: true } },
    }),
  )
  assert.deepEqual(result, { ok: false, error: 'vscode availability check failed: availability exploded' })
  assert.equal(opened, 0, 'the provider must never run when its availability probe throws')
})

test('runOpenInLaunch rejects a non-string path (untrusted payload, never guessed)', async () => {
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'local', path: undefined as unknown as string },
    context(),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /path is required/)
})

test('runOpenInLaunch rejects an empty path', async () => {
  const result = await runOpenInLaunch({ appId: 'finder', instanceId: 'local', path: '' }, context())
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /path is required/)
})

test('runOpenInLaunch finder rejects a relative path', async () => {
  const result = await runOpenInLaunch({ appId: 'finder', instanceId: 'local', path: 'relative/path' }, context())
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /absolute path/)
})

test('runOpenInLaunch finder rejects a path with control characters', async () => {
  const result = await runOpenInLaunch({ appId: 'finder', instanceId: 'local', path: '/foo\nbar' }, context())
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /control characters/)
})

test('runOpenInLaunch finder rejects an overlong path', async () => {
  const longPath = '/' + 'a'.repeat(4096)
  const result = await runOpenInLaunch({ appId: 'finder', instanceId: 'local', path: longPath }, context())
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /exceeds/)
})

test('getOpenInApp resolves finder and vscode, returns null for unknown ids', () => {
  const finder = getOpenInApp('finder')
  assert.ok(finder !== null)
  assert.equal(finder.id, 'finder')
  const vscode = getOpenInApp('vscode')
  assert.ok(vscode !== null)
  assert.equal(vscode.id, 'vscode')
  assert.equal(getOpenInApp('cursor'), null)
  assert.equal(getOpenInApp(''), null)
  assert.equal(getOpenInApp(undefined as unknown as string), null)
})

test('open-in providers are runtime-frozen and cannot mutate whitelist policy', () => {
  const finder = getOpenInApp('finder')!
  assert.equal(Object.isFrozen(finder), true)
  assert.equal(Reflect.set(finder, 'remoteCapable', true), false)
  assert.equal(getOpenInApp('finder')!.remoteCapable, false)
})

test('normalizeOpenPathError maps the shell.openPath boundary (success/error)', () => {
  assert.equal(normalizeOpenPathError(''), null, "Electron's success convention (empty string) is success")
  assert.equal(normalizeOpenPathError(undefined), null)
  assert.equal(normalizeOpenPathError(null), null)
  assert.equal(normalizeOpenPathError('The file does not exist.'), 'The file does not exist.')
})

test('invokeOpenPath normalizes Electron resolve/reject without duplicating the provider prefix', async () => {
  assert.equal(await invokeOpenPath(async () => '', '/ok'), null)
  assert.equal(await invokeOpenPath(async () => 'desktop error', '/bad'), 'desktop error')
  assert.equal(
    await invokeOpenPath(async () => { throw new Error('rejected') }, '/reject'),
    'rejected',
  )
  const result = await runOpenInLaunch(
    { appId: 'finder', instanceId: 'local', path: '/reject' },
    context({ openPath: path => invokeOpenPath(async () => { throw new Error('rejected') }, path) }),
  )
  assert.deepEqual(result, { ok: false, error: 'open path failed: rejected' })
})
