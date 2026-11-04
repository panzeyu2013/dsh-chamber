/**
 * Forward IPC log-redaction / non-echo locks (design 28 §7/§8.2, §9).
 *
 * The forward domain can carry ssh material on the MANAGER side (stderr, askpass
 * paths, argv). This suite pins the IPC layer's half of the bargain:
 *   - a registrar-composed refusal never echoes the payload (detail is always
 *     null, so no sourceId / port / id / path / smuggled secret can reach a log
 *     ring or the renderer's error copy);
 *   - the manager's own `detail` is relayed verbatim and never augmented with
 *     payload content (redaction stays a single owner: the manager/launcher);
 *   - the module contains no logging call at all, so this layer cannot leak a
 *     payload into stdout/stderr even by accident;
 *   - the refusals satisfy the wire's `ForwardError` guard (the closed table).
 *
 * The launcher adapter's stderr redaction (`redactSshStderr`, askpass lease) is
 * tested with the ssh child adapter (TODO S1): this file never claims it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { IPC_CHANNELS } from '../../ipc-events.ts'
import { isForwardError } from '../../../dsh-chamber-wire/src/forward.ts'
import {
  FakeForwardService,
  FINGERPRINT,
  FORWARD_ID,
  ForwardIpcHarness,
  SOURCE_ID,
} from './forward-ipc-fixture.ts'

const SECRET = 'ssh-askpass:/run/user/1000/ksshaskpass?token=hunter2'

/** The shared valid envelope every hostile case mutates. */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, port: 5173, id: FORWARD_ID, ...overrides }
}

/** Per-channel hostile payloads: each one is refused by THAT channel. */
function hostilePayloads(): Array<[channel: string, name: string, payload: unknown]> {
  return [
    [IPC_CHANNELS.FORWARD_REQUEST, 'secret in an extra key + bad port', envelope({ port: 0, sshStderr: SECRET })],
    [IPC_CHANNELS.FORWARD_REQUEST, 'secret in sourceId', envelope({ sourceId: 'dsh-' + SECRET })],
    [IPC_CHANNELS.FORWARD_REQUEST, 'secret in the fingerprint', envelope({ sourceFingerprint: SECRET })],
    [IPC_CHANNELS.FORWARD_REQUEST, 'deeply hostile object', envelope({ sourceId: { toString: () => SECRET }, extra: [SECRET] })],
    [IPC_CHANNELS.FORWARD_RELEASE, 'secret in the id', envelope({ id: 'fwd-' + SECRET })],
    [IPC_CHANNELS.FORWARD_RELEASE, 'secret in sourceId', envelope({ sourceId: 'dsh-' + SECRET })],
    [IPC_CHANNELS.FORWARD_LIST, 'secret in sourceId', envelope({ sourceId: 'dsh-' + SECRET })],
    [IPC_CHANNELS.FORWARD_LIST, 'secret in the fingerprint', envelope({ sourceFingerprint: SECRET })],
    [IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER, 'secret as an absolute URL', envelope({ path: 'http://' + SECRET + '/' })],
    [IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER, 'secret in the id', envelope({ id: 'fwd-' + SECRET })],
  ]
}

test('every registrar refusal satisfies the wire ForwardError guard (detail null)', async () => {
  for (const [channel, name, payload] of hostilePayloads()) {
    const harness = new ForwardIpcHarness()
    const service = new FakeForwardService()
    harness.install(service)
    const result = await harness.invoke(channel, payload) as { ok: boolean; error?: unknown }
    assert.equal(result.ok, false, name + ' @ ' + channel)
    assert.ok(isForwardError(result.error), name + ' @ ' + channel + ': refusal must be a wire ForwardError')
    assert.equal((result.error as { detail: string | null }).detail, null,
      name + ' @ ' + channel + ': a registrar-composed detail must stay null')
    assert.deepEqual(service.calls, [], name + ' @ ' + channel + ': hostile payload reached the manager')
    assert.equal(JSON.stringify(result).includes('hunter2'), false,
      name + ' @ ' + channel + ': the refusal echoed payload content')
  }
})

test('the manager detail is relayed verbatim and never augmented with payload content', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  service.requestResult = { ok: false, error: { code: 'auth_failed', detail: 'Authentication failed' } }
  harness.install(service)
  const result = await harness.invoke(IPC_CHANNELS.FORWARD_REQUEST, {
    sourceId: SOURCE_ID,
    sourceFingerprint: FINGERPRINT,
    port: 5173,
    sshStderr: SECRET,
  })
  assert.deepEqual(result, { ok: false, error: { code: 'auth_failed', detail: 'Authentication failed' } })
  assert.equal(JSON.stringify(result).includes('hunter2'), false)
  // The manager receives the frozen argument table only — hostile extras die here.
  assert.deepEqual(Object.keys(service.calls[0]?.args as object).sort(),
    ['port', 'scheme', 'sourceFingerprint', 'sourceId'])
})

test('the registrar module contains no logging call (no path from a payload to the log ring)', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', '..', 'shell-ipc-browser.ts'), 'utf8')
  assert.doesNotMatch(source, /\bconsole\.(?:log|warn|error|info|debug|trace)\s*\(/u,
    'shell-ipc-browser.ts must not log (payload/secret could reach stdout/stderr)')
  assert.doesNotMatch(source, /\bprocess\.(?:stdout|stderr)\.write\s*\(/u,
    'shell-ipc-browser.ts must not write to the process streams')
})

test('the not-assembled detail is a bounded constant accepted by the wire guard', async () => {
  const harness = new ForwardIpcHarness()
  harness.install(null)
  const result = await harness.invoke(IPC_CHANNELS.FORWARD_LIST, {
    sourceId: SOURCE_ID,
    sourceFingerprint: FINGERPRINT,
  }) as { ok: boolean; error?: unknown }
  assert.equal(result.ok, false)
  assert.ok(isForwardError(result.error))
  const detail = (result.error as { detail: string | null }).detail
  assert.equal(typeof detail, 'string')
  assert.ok((detail as string).length <= 512, 'wire detail bound is 512')
  assert.equal((detail as string).includes('hunter2'), false)
})
