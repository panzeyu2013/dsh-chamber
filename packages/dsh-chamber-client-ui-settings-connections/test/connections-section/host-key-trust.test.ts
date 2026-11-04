/**
 * P0-3 host-key trust (browser half): the trust-panel projection and the probe -> trust
 * sequence. Pure Node; the bridge is a fake, so no desktop/ssh is involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SshHostKeyProbe, SshStatusProjection } from '../../src/global.d.ts'
import { hostKeyTrustActionable, hostKeyTrustView, probeAndTrustHostKey } from '../../src/client/host-key-trust.ts'
import type { HostKeyTrustBridge } from '../../src/client/host-key-trust.ts'

function status(overrides: Partial<SshStatusProjection> = {}): SshStatusProjection {
  return {
    kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'error',
    localPort: null, transportSocket: 'tcp', sshPort: null, remotePort: 30800, retryAttempt: 0,
    requiresUserAction: true, userActionKind: 'hostkey', serviceActive: null, remoteDshHome: null,
    logSummary: 'host key verification failed', ...overrides,
  }
}

const PROBE: SshHostKeyProbe = {
  state: 'unknown', type: 'ssh-ed25519', blob: 'AAAAB3NzaC1yc2E=', fingerprints: ['SHA256:abc'],
  previousFingerprints: [], changed: false, probedAt: 1,
}

function bridge(probe: SshHostKeyProbe | { error: string }, trust: { ok: true; replaced: boolean } | { error: string }): HostKeyTrustBridge & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async host_key_probe(id) {
      calls.push('probe:' + id)
      return 'error' in probe ? { ok: false, error: probe.error } : { ok: true, hostKey: probe }
    },
    async host_key_trust(id, type, blob) {
      calls.push('trust:' + id + ':' + type + ':' + blob)
      return 'error' in trust ? { ok: false, error: trust.error } : { ok: true, replaced: trust.replaced }
    },
  }
}

test('the panel only appears for a terminal hostkey class and mirrors the projection', () => {
  assert.equal(hostKeyTrustView(undefined), null)
  assert.equal(hostKeyTrustView(status({ userActionKind: 'auth' })), null)
  assert.equal(hostKeyTrustView(status({ requiresUserAction: false })), null)
  const view = hostKeyTrustView(status({ hostKey: { state: 'changed', fingerprints: ['SHA256:new'], previousFingerprints: ['SHA256:old'], changed: true } }))
  assert.deepEqual(view, { fingerprints: ['SHA256:new'], previousFingerprints: ['SHA256:old'], changed: true, unavailable: false })
  // No projection yet: actionable (probe on click) but with no invented fingerprint.
  assert.deepEqual(hostKeyTrustView(status()), { fingerprints: [], previousFingerprints: [], changed: false, unavailable: false })
  const unavailable = hostKeyTrustView(status({ hostKey: { state: 'unavailable', fingerprints: [] } }))
  assert.equal(unavailable?.unavailable, true)
  assert.equal(hostKeyTrustActionable(unavailable, false, false), false, 'an unavailable probe cannot be trusted silently')
  assert.equal(hostKeyTrustActionable(view, true, false), false, 'busy card blocks the action')
  assert.equal(hostKeyTrustActionable(view, false, true), false, 'one trust at a time')
  assert.equal(hostKeyTrustActionable(view, false, false), true)
})

test('probe -> trust: the exact probed (type, blob) is what gets trusted, in that order', async () => {
  const fake = bridge(PROBE, { ok: true, replaced: true })
  const result = await probeAndTrustHostKey(fake, 'h1')
  assert.deepEqual(result, { ok: true, replaced: true, fingerprints: ['SHA256:abc'] })
  assert.deepEqual(fake.calls, ['probe:h1', 'trust:h1:ssh-ed25519:AAAAB3NzaC1yc2E='])
})

test('a failed probe refuses before any trust write; a failed trust surfaces its error', async () => {
  const probeFailed = bridge({ error: 'ssh self-proof timed out' }, { ok: true, replaced: false })
  assert.deepEqual(await probeAndTrustHostKey(probeFailed, 'h1'), { ok: false, error: 'ssh self-proof timed out' })
  assert.deepEqual(probeFailed.calls, ['probe:h1'], 'no trust call after a failed probe')

  const trustFailed = bridge(PROBE, { error: 'no recent host-key probe — probe again before trusting' })
  assert.deepEqual(await probeAndTrustHostKey(trustFailed, 'h1'), {
    ok: false, error: 'no recent host-key probe — probe again before trusting',
  })
  assert.equal(trustFailed.calls.length, 2, 'probe then trust')
})

test('a probe that observed no key never writes a known_hosts row', async () => {
  const noKey = bridge({ ...PROBE, state: 'unavailable', type: null, blob: null, fingerprints: [] }, { ok: true, replaced: false })
  const result = await probeAndTrustHostKey(noKey, 'h1')
  assert.equal(result.ok, false)
  assert.deepEqual(noKey.calls, ['probe:h1'])
})
