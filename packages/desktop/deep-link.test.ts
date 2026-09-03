/**
 * VS Code deep-link core (design 16 §3/§4/§5) unit tests — pure Node, no
 * electron, no real VS Code. The OS-level deep link is untrusted input, so
 * the suite drives parseOpenVscodeIntent / buildVscodeRemoteUrl with malicious
 * and boundary inputs, drives detectVscodeAvailability through injected
 * platform + PATH + fs stubs, and drives runVscodeLaunch through an injected
 * VscodeLaunchContext (registry lookup / availability / openExternal are all
 * faked — no real SSH host, no real VS Code).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attemptDeepLinkProtocolRegistration,
  BoundedAckDeliveryQueue,
  BoundedVscodeIntentQueue,
  buildVscodeFileUrl,
  buildVscodeRemoteUrl,
  canDeliverRendererDeepLink,
  canRestoreMainWindow,
  decideDeepLinkProtocolRegistration,
  detectVscodeAvailability,
  ensureLinuxProtocolDesktopFile,
  linuxAutostartDesktopEntry,
  linuxAutostartDirectory,
  linuxProtocolDesktopEntry,
  parseOpenVscodeIntent,
  quoteDesktopExecValue,
  resolveLinuxLaunchExecutable,
  runVscodeLaunch,
} from './deep-link.ts'
import type { VscodeLaunchContext, VscodeLaunchRequest } from './deep-link.ts'
import { NotificationSourceIncarnations } from './notifications.ts'

/** A minimal valid ssh instance for runVscodeLaunch context fakes (v2: the
 *  vscode-remote URL is an ssh-TRANSPORT feature — design 17 §2). */
const sshInstance = { id: 'web-1', host: 'h.example.com', user: 'root', sshPort: null, transport: 'ssh' }

function context(overrides: Partial<VscodeLaunchContext> & { lookup?: VscodeLaunchContext['lookupInstance'] } = {}): VscodeLaunchContext {
  return {
    lookupInstance: overrides.lookupInstance ?? (() => ({ ...sshInstance })),
    vscodeAvailable: overrides.vscodeAvailable ?? (() => true),
    openVscodeUrl: overrides.openVscodeUrl ?? (async () => ({ ok: true })),
  }
}

test('parseOpenVscodeIntent accepts a well-formed deep link', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=web-1&path=%2Fhome%2Fuser%2Fproj')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.intent, { instanceId: 'web-1', path: '/home/user/proj' })
  }
})

test('parseOpenVscodeIntent rejects a non-dsh-chamber scheme', () => {
  const result = parseOpenVscodeIntent('https://open-vscode?instance=web-1&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /scheme/i)
})

test('parseOpenVscodeIntent rejects an unexpected host', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://evil?instance=web-1&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /host/i)
})

test('parseOpenVscodeIntent rejects a missing instance', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /instance/i)
})

test('parseOpenVscodeIntent rejects an invalid instance id', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=bad%2Fid&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /instance/i)
})

test('parseOpenVscodeIntent accepts the reserved local instance id (user decision 2026-08)', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=local&path=/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.intent.instanceId, 'local')
})

test('parseOpenVscodeIntent rejects userinfo in the authority (P2-2)', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://user:pass@open-vscode?instance=web-1&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /userinfo/i)
})

test('parseOpenVscodeIntent rejects a port in the authority (P2-2)', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode:9999?instance=web-1&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /port/i)
})

test('parseOpenVscodeIntent rejects a missing path', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=web-1')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /path/i)
})

test('parseOpenVscodeIntent rejects a relative path', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=web-1&path=foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /absolute|leading \//i)
})

test('parseOpenVscodeIntent rejects a path with control characters', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=web-1&path=%2Ffoo%0Abar')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /control/i)
})

test('parseOpenVscodeIntent rejects an overlong path', () => {
  const longPath = '/' + 'a'.repeat(4096)
  const result = parseOpenVscodeIntent(`dsh-chamber://open-vscode?instance=web-1&path=${encodeURIComponent(longPath)}`)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /4096/)
})

test('parseOpenVscodeIntent rejects malformed URLs without throwing', () => {
  const result = parseOpenVscodeIntent('not a url')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /invalid deep-link/i)
})

test('BoundedVscodeIntentQueue deduplicates normalized intents while pending/in-flight and allows a later retry', () => {
  const first = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=local&path=/foo')
  const equivalent = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=local&path=%2Ffoo#ignored')
  assert.equal(first.ok, true)
  assert.equal(equivalent.ok, true)
  if (!first.ok || !equivalent.ok) return

  const queue = new BoundedVscodeIntentQueue(2)
  assert.deepEqual(queue.enqueue(first.intent), { accepted: true, dropped: null })
  assert.deepEqual(queue.enqueue(equivalent.intent), { accepted: false, dropped: null, reason: 'duplicate' })
  const inFlight = queue.shift()
  assert.deepEqual(inFlight, first.intent)
  assert.deepEqual(
    queue.enqueue(equivalent.intent),
    { accepted: false, dropped: null, reason: 'duplicate' },
    'key stays tracked while in flight',
  )
  queue.complete(inFlight!)
  assert.deepEqual(queue.enqueue(equivalent.intent), { accepted: true, dropped: null }, 'later deliberate reopen is accepted')
})

test('BoundedVscodeIntentQueue drops the oldest pending intent at its hard limit', () => {
  const queue = new BoundedVscodeIntentQueue(2)
  const one = { instanceId: 'local', path: '/one' }
  const two = { instanceId: 'local', path: '/two' }
  const three = { instanceId: 'local', path: '/three' }
  queue.enqueue(one)
  queue.enqueue(two)
  const result = queue.enqueue(three)
  assert.deepEqual(result, { accepted: true, dropped: one })
  assert.equal(queue.pendingCount, 2)
  assert.deepEqual(queue.shift(), two)
  assert.deepEqual(queue.shift(), three)
})

test('BoundedVscodeIntentQueue hard limit covers pending plus in-flight keys', () => {
  const queue = new BoundedVscodeIntentQueue(2)
  const one = { instanceId: 'local', path: '/one' }
  const two = { instanceId: 'local', path: '/two' }
  const three = { instanceId: 'local', path: '/three' }
  queue.enqueue(one)
  queue.enqueue(two)
  assert.deepEqual(queue.shift(), one)
  assert.equal(queue.trackedCount, 2, 'shifted intent remains part of capacity while in flight')
  assert.deepEqual(queue.enqueue(three), { accepted: true, dropped: two })
  assert.equal(queue.trackedCount, 2, 'pending + in-flight must never exceed the hard limit')
  assert.deepEqual(queue.shift(), three)
  queue.complete(one)
  queue.complete(three)
  assert.equal(queue.trackedCount, 0)
})

test('BoundedVscodeIntentQueue reports saturated when capacity is entirely in flight', () => {
  const queue = new BoundedVscodeIntentQueue(1)
  const inFlight = { instanceId: 'local', path: '/one' }
  queue.enqueue(inFlight)
  assert.deepEqual(queue.shift(), inFlight)
  assert.deepEqual(
    queue.enqueue({ instanceId: 'local', path: '/two' }),
    { accepted: false, dropped: null, reason: 'saturated' },
  )
  assert.equal(queue.pendingCount, 0)
  assert.equal(queue.trackedCount, 1)
  queue.complete(inFlight)
  assert.deepEqual(
    queue.enqueue({ instanceId: 'local', path: '/two' }),
    { accepted: true, dropped: null },
  )
})

test('BoundedVscodeIntentQueue retries a failed send A before pending B', () => {
  const queue = new BoundedVscodeIntentQueue(2)
  const a = { instanceId: 'local', path: '/a' }
  const b = { instanceId: 'local', path: '/b' }
  queue.enqueue(a)
  queue.enqueue(b)

  const delivered: VscodeLaunchRequest[] = []
  let failAOnce = true
  const drain = (): boolean => {
    for (;;) {
      const intent = queue.shift()
      if (intent === null) return true
      try {
        if (failAOnce && intent.path === '/a') {
          failAOnce = false
          throw new Error('renderer disappeared')
        }
        delivered.push(intent)
        queue.complete(intent)
      } catch {
        assert.deepEqual(queue.rollbackShift(intent), { restored: true })
        return false
      }
    }
  }

  assert.equal(drain(), false, 'first A send fails and rolls back')
  assert.deepEqual(delivered, [])
  assert.equal(queue.trackedCount, 2, 'rollback does not release or duplicate the tracked key')
  assert.equal(queue.pendingCount, 2, 'rollback remains inside the original hard limit')

  assert.equal(drain(), true)
  assert.deepEqual(delivered, [a, b], 'the retry order remains A then B')
  assert.equal(queue.trackedCount, 0)
})

test('renderer intent hold/replay waits when ready arrives before did-finish-load', () => {
  const queue = new BoundedVscodeIntentQueue(2)
  queue.enqueue({ instanceId: 'local', path: '/cold-start' })
  const base = { ready: true, currentWindow: true, destroyed: false, crashed: false }
  assert.equal(canDeliverRendererDeepLink({ ...base, loading: true }), false)
  assert.equal(queue.pendingCount, 1, 'ready-before-finish must hold the intent')
  assert.equal(canDeliverRendererDeepLink({ ...base, loading: false }), true)
  const replayed = queue.shift()
  assert.deepEqual(replayed, { instanceId: 'local', path: '/cold-start' })
  queue.complete(replayed!)

  assert.equal(canDeliverRendererDeepLink({ ...base, loading: false, currentWindow: false }), false, 'old windows cannot drain a new window queue')
  assert.equal(canDeliverRendererDeepLink({ ...base, loading: false, destroyed: true }), false)
  assert.equal(canDeliverRendererDeepLink({ ...base, loading: false, crashed: true }), false)
})

test('BoundedAckDeliveryQueue retains sent work until the exact attempt is acknowledged', () => {
  const queue = new BoundedAckDeliveryQueue<VscodeLaunchRequest>(2, BoundedVscodeIntentQueue.key)
  const a = { instanceId: 'local', path: '/a' }
  const b = { instanceId: 'local', path: '/b' }
  assert.equal(queue.enqueue(a).accepted, true)
  assert.equal(queue.enqueue(b).accepted, true)
  const first = queue.shift()!
  const second = queue.shift()!
  assert.deepEqual([first.payload, second.payload], [a, b])
  assert.equal(queue.pendingCount, 0)
  assert.equal(queue.inFlightCount, 2, 'send-return does not commit delivery')
  assert.equal(queue.acknowledge(first.deliveryId, first.attempt + 1), false, 'wrong attempt is stale')
  assert.equal(queue.acknowledge(first.deliveryId, first.attempt), true)
  assert.equal(queue.trackedCount, 1)
  assert.equal(queue.acknowledge(second.deliveryId, second.attempt), true)
  assert.equal(queue.trackedCount, 0)
})

test('BoundedAckDeliveryQueue reload replay preserves FIFO and rejects an old-frame ACK', () => {
  const queue = new BoundedAckDeliveryQueue<VscodeLaunchRequest>(3, BoundedVscodeIntentQueue.key)
  const a = { instanceId: 'local', path: '/a' }
  const b = { instanceId: 'local', path: '/b' }
  const c = { instanceId: 'local', path: '/c' }
  queue.enqueue(a)
  queue.enqueue(b)
  const oldA = queue.shift()!
  const oldB = queue.shift()!
  queue.enqueue(c)
  assert.equal(queue.requeueInFlight(), 2)
  const replayA = queue.shift()!
  const replayB = queue.shift()!
  const firstC = queue.shift()!
  assert.deepEqual([replayA.payload, replayB.payload, firstC.payload], [a, b, c])
  assert.equal(replayA.deliveryId, oldA.deliveryId)
  assert.equal(replayA.attempt, oldA.attempt + 1)
  assert.equal(queue.acknowledge(oldA.deliveryId, oldA.attempt), false, 'dying document cannot commit replay')
  assert.equal(queue.acknowledge(replayA.deliveryId, replayA.attempt), true)
  assert.equal(queue.acknowledge(replayB.deliveryId, replayB.attempt), true)
  assert.equal(queue.acknowledge(firstC.deliveryId, firstC.attempt), true)
  assert.equal(queue.trackedCount, 0)
  assert.equal(oldB.attempt + 1, replayB.attempt)
})

test('BoundedAckDeliveryQueue cap covers unacknowledged sends and single-flight keys', () => {
  const queue = new BoundedAckDeliveryQueue<VscodeLaunchRequest>(1, BoundedVscodeIntentQueue.key)
  const a = { instanceId: 'local', path: '/a' }
  const accepted = queue.enqueue(a)
  assert.equal(accepted.accepted, true)
  const sent = queue.shift()!
  assert.deepEqual(queue.enqueue(a), { accepted: false, dropped: null, reason: 'duplicate' })
  assert.deepEqual(
    queue.enqueue({ instanceId: 'local', path: '/b' }),
    { accepted: false, dropped: null, reason: 'saturated' },
  )
  assert.equal(queue.acknowledge(sent.deliveryId, sent.attempt), true)
  assert.equal(queue.enqueue({ instanceId: 'local', path: '/b' }).accepted, true)
})

test('BoundedAckDeliveryQueue synchronous send rollback keeps the failed item at FIFO head', () => {
  const queue = new BoundedAckDeliveryQueue<VscodeLaunchRequest>(2)
  queue.enqueue({ instanceId: 'local', path: '/a' })
  queue.enqueue({ instanceId: 'local', path: '/b' })
  const failed = queue.shift()!
  assert.equal(queue.rollback(failed), true)
  const retried = queue.shift()!
  assert.equal(retried.deliveryId, failed.deliveryId)
  assert.equal(retried.attempt, failed.attempt + 1)
  assert.equal(retried.payload.path, '/a')
})

test('registry identity edit retires held and in-flight renderer activations', () => {
  type Activation = VscodeLaunchRequest & { sourceId: string; sourceFingerprint: string; sourceGeneration: number }
  const sources = new NotificationSourceIncarnations()
  sources.replaceRemoteSources([{ sourceId: 'ssh-same', fingerprint: 'host-a' }])
  const old = sources.capture('ssh-same')!
  const queue = new BoundedAckDeliveryQueue<Activation>(4, BoundedVscodeIntentQueue.key)
  queue.enqueue({ instanceId: 'same', path: '/pending', sourceId: old.sourceId, sourceFingerprint: old.fingerprint, sourceGeneration: old.generation })
  queue.enqueue({ instanceId: 'same', path: '/sent', sourceId: old.sourceId, sourceFingerprint: old.fingerprint, sourceGeneration: old.generation })
  const sent = queue.shift()!

  sources.replaceRemoteSources([{ sourceId: 'ssh-same', fingerprint: 'host-b' }])
  assert.equal(queue.discardWhere(intent => intent.sourceId === old.sourceId), 2)
  assert.equal(queue.trackedCount, 0)
  assert.equal(sent.payload.sourceFingerprint, 'host-a', 'an already-sent renderer intent stays tied to the old proof')
  assert.equal(queue.acknowledge(sent.deliveryId, sent.attempt), false)
})

test('an identity edit while VS Code launch awaits prevents post-success renderer enqueue', async () => {
  const sources = new NotificationSourceIncarnations()
  sources.replaceRemoteSources([{ sourceId: 'ssh-same', fingerprint: 'host-a' }])
  const captured = sources.capture('ssh-same')!
  let finishLaunch!: () => void
  const launch = new Promise<void>(resolve => { finishLaunch = resolve })
  const queued: VscodeLaunchRequest[] = []
  const continuation = launch.then(() => {
    if (sources.owns(captured)) queued.push({ instanceId: 'same', path: '/workspace' })
  })
  sources.replaceRemoteSources([{ sourceId: 'ssh-same', fingerprint: 'host-b' }])
  finishLaunch()
  await continuation
  assert.deepEqual(queued, [], 'old launch success never activates the replacement source')
})

test('packaged protocol registration never persists a cold-start URL as a fixed relaunch arg', () => {
  assert.deepEqual(decideDeepLinkProtocolRegistration({ isPackaged: true, platform: 'linux' }), { action: 'register' })
  assert.deepEqual(decideDeepLinkProtocolRegistration({ isPackaged: true, platform: 'darwin' }), { action: 'register' })
  assert.deepEqual(decideDeepLinkProtocolRegistration({ isPackaged: true, platform: 'win32' }), { action: 'skip' })
  assert.deepEqual(decideDeepLinkProtocolRegistration({ isPackaged: false, platform: 'linux' }), { action: 'skip' })
  // The decision intentionally exposes no executable/args fields: packaged
  // registration always calls Electron's no-args form.
  assert.deepEqual(Object.keys(decideDeepLinkProtocolRegistration({ isPackaged: true, platform: 'linux' })), ['action'])
})

test('window restore is terminally fenced once quit is requested', () => {
  assert.equal(canRestoreMainWindow(false), true)
  assert.equal(canRestoreMainWindow(true), false)
})

test('attemptDeepLinkProtocolRegistration reports false/throw without throwing itself', () => {
  assert.deepEqual(attemptDeepLinkProtocolRegistration(() => true), { ok: true })
  assert.deepEqual(
    attemptDeepLinkProtocolRegistration(() => false),
    { ok: false, error: 'setAsDefaultProtocolClient returned false' },
  )
  assert.deepEqual(
    attemptDeepLinkProtocolRegistration(() => { throw new Error('registry denied') }),
    { ok: false, error: 'setAsDefaultProtocolClient failed: registry denied' },
  )
})

test('buildVscodeRemoteUrl omits the user when null', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.url, 'vscode://vscode-remote/ssh-remote+h.example.com/foo')
})

test('buildVscodeRemoteUrl includes the user when present', () => {
  const result = buildVscodeRemoteUrl('h.example.com', 'root', null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.match(result.url, /ssh-remote\+root@h\.example\.com\//)
})

test('buildVscodeRemoteUrl brackets an IPv6 literal', () => {
  const result = buildVscodeRemoteUrl('[::1]', null, null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.url, 'vscode://vscode-remote/ssh-remote+[::1]/foo')
})

test('buildVscodeRemoteUrl re-brackets an unbracketed IPv6 literal', () => {
  const result = buildVscodeRemoteUrl('::1', null, null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.match(result.url, /ssh-remote\+\[::1\]\//)
})

test('buildVscodeRemoteUrl rejects a host:port ambiguity', () => {
  const result = buildVscodeRemoteUrl('host:22', null, null, '/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /IPv6|host:port|冒号/i)
})

test('buildVscodeRemoteUrl accepts sshPort 22', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, 22, '/foo')
  assert.equal(result.ok, true)
})

test('buildVscodeRemoteUrl rejects a non-22 sshPort with the config guidance', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, 2222, '/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /~\/\.ssh\/config/)
})

test('buildVscodeRemoteUrl encodes path segments (space / CJK / # / ? / %)', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, null, '/a b/中文/c#d?e%f')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(
      result.url,
      'vscode://vscode-remote/ssh-remote+h.example.com/a%20b/%E4%B8%AD%E6%96%87/c%23d%3Fe%25f',
    )
    assert.ok(!result.url.includes(' '), 'no raw space survives')
    assert.ok(!result.url.includes('#'), 'no raw # survives')
    assert.ok(!result.url.includes('?'), 'no raw ? survives')
  }
})

test('buildVscodeRemoteUrl hardcodes the vscode: scheme prefix', () => {
  const result = buildVscodeRemoteUrl('h.example.com', 'u', null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.ok(result.url.startsWith('vscode://vscode-remote/ssh-remote+'), 'scheme is hardcoded vscode:')
})

test('buildVscodeRemoteUrl rejects a non-absolute path', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, null, 'relative')
  assert.equal(result.ok, false)
})

test('detectVscodeAvailability finds the macOS app bundle', () => {
  const result = detectVscodeAvailability('darwin', {
    exists: target => target === '/Applications/Visual Studio Code.app',
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability finds the per-user macOS app bundle', () => {
  const result = detectVscodeAvailability('darwin', {
    homeDir: '/home/u',
    exists: target => target === '/home/u/Applications/Visual Studio Code.app',
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability finds an executable code in PATH (linux)', () => {
  const result = detectVscodeAvailability('linux', {
    pathEnv: '/a:/b',
    accessX: target => target === '/b/code',
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability treats missing/empty PATH as not found', () => {
  const result = detectVscodeAvailability('linux', {
    pathEnv: '',
    accessX: () => false,
  })
  assert.deepEqual(result, { available: false })
})

test('detectVscodeAvailability treats a DIRECTORY named code as NOT available (real fs, P1-2)', () => {
  // POSIX directories pass access(X_OK); the executable check must also
  // require isFile() — a PATH entry named `code` that is a directory is not
  // VS Code (security-review P1-2).
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deeplink-dir-'))
  try {
    mkdirSync(join(dir, 'code'))
    const result = detectVscodeAvailability('linux', { pathEnv: dir })
    assert.deepEqual(result, { available: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectVscodeAvailability finds a real executable file named code (real fs)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deeplink-exe-'))
  try {
    const bin = join(dir, 'code')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o644 })
    chmodSync(bin, 0o755)
    const result = detectVscodeAvailability('linux', { pathEnv: dir })
    assert.deepEqual(result, { available: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectVscodeAvailability finds Code.exe via LOCALAPPDATA (win32, isFile)', () => {
  const result = detectVscodeAvailability('win32', {
    localAppData: 'C:\\Users\\u\\AppData\\Local',
    exists: target => target.endsWith('Code.exe'),
    isFile: target => target.endsWith('Code.exe'),
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability rejects a DIRECTORY at the Code.exe path (win32)', () => {
  const result = detectVscodeAvailability('win32', {
    localAppData: 'C:\\Users\\u\\AppData\\Local',
    exists: target => target.endsWith('Code.exe'),
    isFile: () => false, // same-named directory: not installed
  })
  assert.deepEqual(result, { available: false })
})

test('detectVscodeAvailability finds code.cmd in PATH (win32)', () => {
  const result = detectVscodeAvailability('win32', {
    pathEnv: 'C:\\x;D:\\y',
    accessX: target => target.endsWith('code.cmd'),
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability returns false for an unknown platform', () => {
  const result = detectVscodeAvailability('sunos', { pathEnv: '', accessX: () => false })
  assert.deepEqual(result, { available: false })
})

test('runVscodeLaunch fails loudly for an unknown instance', async () => {
  const result = await runVscodeLaunch({ instanceId: 'ghost', path: '/foo' }, context({ lookupInstance: () => null }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not found/i)
})

test('runVscodeLaunch rejects an instanceId that fails INSTANCE_ID_PATTERN (P2-3)', async () => {
  const result = await runVscodeLaunch(
    { instanceId: '!!weird!!', path: '/foo' },
    context({ lookupInstance: () => ({ ...sshInstance }) }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /instance/i)
})

test('runVscodeLaunch fails loudly for a non-ssh instance transport', async () => {
  const result = await runVscodeLaunch(
    { instanceId: 'web-1', path: '/foo' },
    context({ lookupInstance: () => ({ ...sshInstance, transport: 'http' }) }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not an ssh transport/i)
})

test('runVscodeLaunch fails loudly when VS Code is not detected', async () => {
  const result = await runVscodeLaunch(
    { instanceId: 'web-1', path: '/foo' },
    context({ vscodeAvailable: () => false }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /vscode not detected/i)
})

test('runVscodeLaunch passes through an openVscodeUrl failure loudly', async () => {
  const result = await runVscodeLaunch(
    { instanceId: 'web-1', path: '/foo' },
    context({ openVscodeUrl: async () => ({ ok: false, error: 'open failed' }) }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'open failed')
})

test('runVscodeLaunch succeeds end-to-end and opens the constructed URL', async () => {
  let opened: string | null = null
  const result = await runVscodeLaunch(
    { instanceId: 'web-1', path: '/home/user/proj' },
    context({
      lookupInstance: () => ({ id: 'web-1', host: 'h.example.com', user: 'root', sshPort: null, transport: 'ssh' }),
      openVscodeUrl: async url => {
        opened = url
        return { ok: true }
      },
    }),
  )
  assert.equal(result.ok, true)
  assert.equal(opened, 'vscode://vscode-remote/ssh-remote+root@h.example.com/home/user/proj')
})

test('buildVscodeFileUrl builds a local file target with encoded path', () => {
  const result = buildVscodeFileUrl('/home/user/我的 项目')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.url, 'vscode://file/home/user/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE')
})

test('buildVscodeFileUrl rejects a relative path', () => {
  const result = buildVscodeFileUrl('relative/path')
  assert.equal(result.ok, false)
})

test('runVscodeLaunch opens a local file URL for instance=local (user decision 2026-08)', async () => {
  let opened: string | null = null
  const result = await runVscodeLaunch(
    { instanceId: 'local', path: '/home/user/local-ws' },
    context({
      lookupInstance: () => null, // local is never in the ssh registry
      openVscodeUrl: async url => {
        opened = url
        return { ok: true }
      },
    }),
  )
  assert.equal(result.ok, true)
  assert.equal(opened, 'vscode://file/home/user/local-ws')
})

test('runVscodeLaunch local branch still re-checks availability', async () => {
  const result = await runVscodeLaunch(
    { instanceId: 'local', path: '/home/user/local-ws' },
    context({ vscodeAvailable: () => false }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /vscode not detected/i)
})

test('runVscodeLaunch converts availability and registry adapter exceptions into structured failures', async () => {
  const availability = await runVscodeLaunch(
    { instanceId: 'local', path: '/home/user/local-ws' },
    context({ vscodeAvailable: () => { throw new Error('probe exploded') } }),
  )
  assert.deepEqual(availability, { ok: false, error: 'vscode launch failed: probe exploded' })

  const registry = await runVscodeLaunch(
    { instanceId: 'web-1', path: '/home/user/remote-ws' },
    context({ lookupInstance: () => { throw new Error('registry exploded') } }),
  )
  assert.deepEqual(registry, { ok: false, error: 'vscode launch failed: registry exploded' })
})

test('runVscodeLaunch cannot be made to reject by a hostile thrown value', async () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error('getPrototypeOf trap') },
    get() { throw new Error('get trap') },
  })
  const result = await runVscodeLaunch(
    { instanceId: 'local', path: '/home/user/local-ws' },
    context({ openVscodeUrl: async () => Promise.reject(hostile) }),
  )
  assert.deepEqual(result, { ok: false, error: 'open vscode url failed: unknown error' })
})

test('quoteDesktopExecValue quotes only when needed and escapes spec-reserved characters', () => {
  assert.equal(quoteDesktopExecValue('/opt/dsh-chamber.AppImage'), '/opt/dsh-chamber.AppImage')
  assert.equal(quoteDesktopExecValue('/opt/my app/dsh-chamber'), '"/opt/my app/dsh-chamber"')
  assert.equal(quoteDesktopExecValue('/opt/a"b$c`d\\e'), '"/opt/a\\"b\\$c\\`d\\\\e"')
  // Literal % is doubled per spec so paths can never parse as field codes.
  assert.equal(quoteDesktopExecValue('/opt/v2%beta/dsh-chamber'), '/opt/v2%%beta/dsh-chamber')
  assert.equal(quoteDesktopExecValue('/opt/100%cute dir/dsh'), '"/opt/100%%cute dir/dsh"')
  assert.equal(quoteDesktopExecValue('/opt/%c'), '/opt/%%c')
})

test('linuxAutostartDirectory honors only an absolute XDG_CONFIG_HOME', () => {
  const home = '/home/user'
  assert.equal(linuxAutostartDirectory({ env: {}, homeDir: home }), '/home/user/.config/autostart')
  assert.equal(
    linuxAutostartDirectory({ env: { XDG_CONFIG_HOME: '/custom/config' }, homeDir: home }),
    '/custom/config/autostart',
  )
  // Empty / relative / ~ values fall back (XDG Base Dir Spec: relative = unset).
  assert.equal(linuxAutostartDirectory({ env: { XDG_CONFIG_HOME: '' }, homeDir: home }), '/home/user/.config/autostart')
  assert.equal(
    linuxAutostartDirectory({ env: { XDG_CONFIG_HOME: 'relative/config' }, homeDir: home }),
    '/home/user/.config/autostart',
  )
  assert.equal(
    linuxAutostartDirectory({ env: { XDG_CONFIG_HOME: '~/config' }, homeDir: home }),
    '/home/user/.config/autostart',
  )
})

test('resolveLinuxLaunchExecutable prefers an absolute APPIMAGE over execPath', () => {
  const execPath = '/tmp/.mount-dsh-chamber-xxx/dsh-chamber'
  assert.equal(resolveLinuxLaunchExecutable({ env: {}, execPath }), execPath)
  assert.equal(
    resolveLinuxLaunchExecutable({ env: { APPIMAGE: '/home/user/bin/dsh-chamber.AppImage' }, execPath }),
    '/home/user/bin/dsh-chamber.AppImage',
  )
  // A relative or empty APPIMAGE must never be persisted.
  assert.equal(resolveLinuxLaunchExecutable({ env: { APPIMAGE: 'dsh-chamber.AppImage' }, execPath }), execPath)
  assert.equal(resolveLinuxLaunchExecutable({ env: { APPIMAGE: '' }, execPath }), execPath)
})

test('linuxAutostartDesktopEntry targets the launch binary with XDG autostart keys', () => {
  const entry = linuxAutostartDesktopEntry({ executable: '/home/user/bin/dsh-chamber.AppImage' })
  assert.ok(entry !== null)
  const lines = (entry as string).split(/\r?\n/)
  for (const required of [
    '[Desktop Entry]',
    'Type=Application',
    'Name=dsh-chamber',
    'Exec=/home/user/bin/dsh-chamber.AppImage',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupWMClass=dsh-chamber',
    'Icon=dsh-chamber',
  ]) {
    assert.ok(lines.includes(required), `autostart entry must contain ${required}`)
  }
  // Quoted when the path has spaces.
  const spaced = linuxAutostartDesktopEntry({ executable: '/opt/my apps/dsh-chamber.AppImage' })
  assert.ok(spaced?.includes('Exec="/opt/my apps/dsh-chamber.AppImage"'))
  // A bare / relative executable is never persisted.
  assert.equal(linuxAutostartDesktopEntry({ executable: 'dsh-chamber.AppImage' }), null)
  assert.equal(linuxAutostartDesktopEntry({ executable: 'sub/dir/dsh-chamber' }), null)
})

test('linuxProtocolDesktopEntry declares the x-scheme-handler MimeType with %u', () => {
  const entry = linuxProtocolDesktopEntry({ executable: '/home/user/bin/dsh-chamber.AppImage' })
  assert.ok(entry !== null)
  const lines = (entry as string).split(/\r?\n/)
  for (const required of [
    '[Desktop Entry]',
    'Type=Application',
    'Name=dsh-chamber',
    'Exec=/home/user/bin/dsh-chamber.AppImage %u',
    'NoDisplay=true',
    'MimeType=x-scheme-handler/dsh-chamber;',
  ]) {
    assert.ok(lines.includes(required), `protocol entry must contain ${required}`)
  }
  assert.equal(linuxProtocolDesktopEntry({ executable: 'relative/path' }), null)
  assert.equal(linuxProtocolDesktopEntry({ scheme: 'dsh chamber', executable: '/opt/x' }), null)
  assert.equal(linuxProtocolDesktopEntry({ scheme: '../evil', executable: '/opt/x' }), null)
  // Scheme must start with an ASCII letter (RFC 3986 / Electron validation).
  assert.equal(linuxProtocolDesktopEntry({ scheme: '1dsh', executable: '/opt/x' }), null)
  assert.equal(linuxProtocolDesktopEntry({ scheme: '-dsh', executable: '/opt/x' }), null)
})

test('ensureLinuxProtocolDesktopFile writes into XDG_DATA_HOME applications and reports loud failures', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-linux-proto-'))
  try {
    const home = join(base, 'home')
    const written: Array<{ file: string; data: string }> = []
    const result = ensureLinuxProtocolDesktopFile({
      executable: '/home/user/bin/dsh-chamber.AppImage',
      env: {},
      homeDir: home,
      writeFileSync: (file, data) => { written.push({ file, data }) },
    })
    assert.equal(result.ok, true)
    assert.equal(written.length, 1)
    assert.ok(written[0].file.endsWith(join('.local', 'share', 'applications', 'dsh-chamber.desktop')))
    assert.ok(written[0].data.includes('MimeType=x-scheme-handler/dsh-chamber;'))

    // A RELATIVE XDG_DATA_HOME is treated as unset (XDG Base Dir Spec) —
    // never a silent write under the cwd.
    written.length = 0
    const relative = ensureLinuxProtocolDesktopFile({
      executable: '/home/user/bin/dsh-chamber.AppImage',
      env: { XDG_DATA_HOME: 'relative/data' },
      homeDir: home,
      writeFileSync: (file, data) => { written.push({ file, data }) },
    })
    assert.equal(relative.ok, true)
    assert.ok(written[0].file.endsWith(join('.local', 'share', 'applications', 'dsh-chamber.desktop')))

    // Custom absolute XDG_DATA_HOME wins over the home fallback.
    written.length = 0
    const custom = ensureLinuxProtocolDesktopFile({
      executable: '/home/user/bin/dsh-chamber.AppImage',
      env: { XDG_DATA_HOME: join(base, 'data') },
      homeDir: home,
      writeFileSync: (file, data) => { written.push({ file, data }) },
    })
    assert.equal(custom.ok, true)
    assert.ok(written[0].file.startsWith(join(base, 'data', 'applications')))

    // Loud failure for an invalid entry — never a silent partial write.
    const bad = ensureLinuxProtocolDesktopFile({
      executable: 'not-absolute',
      homeDir: home,
      writeFileSync: (file, data) => { written.push({ file, data }) },
    })
    assert.deepEqual(bad, { ok: false, error: 'invalid linux protocol desktop entry' })
    assert.equal(written.length, 1, 'no write may happen for an invalid entry')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('ensureLinuxProtocolDesktopFile default fs branch writes a real 0644 file and fails loud on mkdir errors', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-linux-proto-real-'))
  try {
    const home = join(base, 'home')
    const result = ensureLinuxProtocolDesktopFile({
      executable: '/home/user/bin/dsh-chamber.AppImage',
      env: {},
      homeDir: home,
    })
    assert.equal(result.ok, true)
    const file = join(home, '.local', 'share', 'applications', 'dsh-chamber.desktop')
    const stat = statSync(file)
    assert.ok(stat.isFile())
    assert.equal(stat.mode & 0o022, 0, 'the per-user handler entry must not be group/world-writable')
    assert.ok(readFileSync(file, 'utf8').includes('MimeType=x-scheme-handler/dsh-chamber;'))

    // A throwing mkdirSync surfaces as a loud structured failure.
    const denied = ensureLinuxProtocolDesktopFile({
      executable: '/home/user/bin/dsh-chamber.AppImage',
      env: {},
      homeDir: home,
      mkdirSync: () => { throw new Error('EPERM: mkdir denied') },
    })
    assert.deepEqual(denied, { ok: false, error: 'EPERM: mkdir denied' })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
