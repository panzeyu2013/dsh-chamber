/**
 * P0-3 transport-manager integration: the pre-spawn known_hosts gate, the failure-triggered
 * self-proof probe and the 'hostkey' action class. The guard is injected (the real one is built in
 * host-assembly); the SSH argv pin is asserted on the spawned tunnel.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HostKeyGuard, HostKeyProbeOutcome, HostKeyTarget } from '../../host-key.ts'
import { makeManager, waitFor } from '../support/transport-manager-harness.ts'

function outcomeFor(state: 'unknown' | 'known' | 'changed' | 'unavailable'): HostKeyProbeOutcome {
  const changed = state === 'changed'
  return {
    state,
    type: 'ssh-ed25519',
    blob: 'AAAAB3NzaC1yc2E=',
    fingerprints: ['SHA256:presented'],
    previousFingerprints: changed ? ['SHA256:previous'] : [],
    changed,
    probedAt: Date.now(),
  }
}

interface FakeGuard extends HostKeyGuard {
  probes: HostKeyTarget[]
  known: boolean
  state: 'unknown' | 'known' | 'changed' | 'unavailable'
}

function fakeGuard(initial: { known: boolean; state?: FakeGuard['state'] }, delayMs = 0): FakeGuard {
  const guard: FakeGuard = {
    knownHostsFile: '/app/ssh/known_hosts',
    known: initial.known,
    state: initial.state ?? 'unknown',
    probes: [],
    knownHostsArgs: () => ({ knownHostsFile: '/app/ssh/known_hosts', globalKnownHostsFile: '/dev/null' }),
    isKnown: () => guard.known,
    probe: async (target: HostKeyTarget) => {
      guard.probes.push(target)
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      return outcomeFor(guard.state)
    },
    projection: () => null,
    trust: async () => ({ ok: false as const, error: 'not used in this test' }),
  }
  return guard
}

test('an unknown ssh target never spawns: error + requiresUserAction + hostkey + fingerprint', async (t) => {
  const guard = fakeGuard({ known: false, state: 'unknown' })
  const { manager, spawnCalls } = makeManager(t, { hostKey: guard })
  manager.connect('s1')
  await waitFor(() => manager.status('s1')?.phase === 'error', 3000, 'host-key terminal state')
  const status = manager.status('s1')!
  assert.equal(spawnCalls.length, 0, 'the gate refuses before any ssh child exists')
  assert.equal(status.requiresUserAction, true)
  assert.equal(status.userActionKind, 'hostkey')
  assert.deepEqual(status.hostKey, { state: 'unknown', fingerprints: ['SHA256:presented'] })
  assert.equal(guard.probes.length, 1, 'the gate ran exactly one self-proof probe')
  assert.deepEqual(guard.probes[0], { host: 'home.example.com', user: 'alice', sshPort: null, remotePort: 2222, label: 'home-server', id: 's1', kind: 'dsh', transport: 'ssh', serviceName: null, remoteDshHome: null, insecureHttp: false })
  assert.ok(manager.logs('s1').some(entry => /host key is not trusted/.test(entry.message)))
})

test('after trust the tunnel spawns with strict host-key checking against the app store', async (t) => {
  const guard = fakeGuard({ known: false })
  const { manager, spawnCalls, children } = makeManager(t, { hostKey: guard })
  manager.connect('s1')
  await waitFor(() => manager.status('s1')?.phase === 'error', 3000, 'gate refusal')
  guard.known = true
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1, 3000, 'the trusted target spawns')
  const args = spawnCalls[0]!.args
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('UserKnownHostsFile=/app/ssh/known_hosts'))
  assert.ok(args.includes('GlobalKnownHostsFile=/dev/null'))
  assert.ok(!args.some(arg => arg.startsWith('StrictHostKeyChecking=no')))
  // A credential failure still classifies as auth (host-key never steals it).
  children[0]!.stderrWrite('Permission denied (publickey).\n')
  children[0]!.simulateExit(255)
  await waitFor(() => manager.status('s1')?.phase === 'error', 3000, 'auth terminal state')
  const status = manager.status('s1')!
  assert.equal(status.userActionKind, 'auth')
  assert.equal(status.hostKey, undefined, 'no host-key projection for a credential failure')
  assert.equal(guard.probes.length, 1, 'the auth path ran no extra host-key probe')
})

test('a host-key stderr failure probes the presented key and lands on the hostkey class', async (t) => {
  const guard = fakeGuard({ known: true, state: 'changed' })
  const { manager, spawnCalls, children } = makeManager(t, { hostKey: guard })
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1, 3000, 'the trusted target spawns')
  children[0]!.stderrWrite('@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@\n')
  children[0]!.stderrWrite('Host key verification failed.\n')
  children[0]!.simulateExit(255)
  await waitFor(() => manager.status('s1')?.phase === 'error', 3000, 'host-key terminal state')
  const status = manager.status('s1')!
  assert.equal(status.userActionKind, 'hostkey')
  assert.equal(status.requiresUserAction, true)
  assert.deepEqual(status.hostKey, { state: 'changed', fingerprints: ['SHA256:presented'], changed: true, previousFingerprints: ['SHA256:previous'] })
  // The exit handler and the ready loop may both observe the flag; only ONE probe may run.
  assert.equal(guard.probes.length, 1, 'one self-proof probe per attempt')
  assert.ok(manager.logs('s1').some(entry => /host key verification failed/.test(entry.message)))
})

test('disconnect drops a stale host-key projection', async (t) => {
  const guard = fakeGuard({ known: false })
  const { manager } = makeManager(t, { hostKey: guard })
  manager.connect('s1')
  await waitFor(() => manager.status('s1')?.phase === 'error', 3000, 'gate refusal')
  assert.notEqual(manager.status('s1')!.hostKey, undefined)
  manager.disconnect('s1')
  assert.equal(manager.status('s1')!.hostKey, undefined)
  assert.equal(manager.status('s1')!.userActionKind, null)
})

test('a slow probe publishes changed fingerprints after the terminal state (R2-A MAJOR-2)', async (t) => {
  const guard = fakeGuard({ known: true, state: 'changed' }, 120)
  const { manager, children } = makeManager(t, { hostKey: guard })
  const statuses: Array<{ hostKey?: { state: string } | undefined }> = []
  manager.onStatusChanged((_id, status) => { statuses.push(status as never) })
  manager.connect('s1')
  await waitFor(() => children.length === 1, 3000, 'the trusted target spawned')
  children[0]!.stderrWrite('Host key verification failed.\n')
  children[0]!.simulateExit(255)
  await waitFor(() => manager.status('s1')?.phase === 'error', 3000, 'host-key terminal state')
  await waitFor(() => manager.status('s1')?.hostKey?.state === 'changed', 2000, 'late projection lands')
  assert.ok(statuses.some(status => status.hostKey?.state === 'changed'),
    'the late projection must be published, not only stored')
})


test('a probe that outlives disconnect cannot fail the replacement attempt (R1-B M2)', async (t) => {
  const guard = fakeGuard({ known: true, state: 'changed' }, 150)
  const { manager, children, setProbe } = makeManager(t, { hostKey: guard, options: { readyTimeoutMs: 2000 } })
  manager.connect('s1')
  await waitFor(() => children.length === 1, 3000, 'first tunnel spawned')
  children[0]!.stderrWrite('Host key verification failed.\n')
  // Revoke the attempt while the self-proof (150ms) is still in flight, then
  // start a replacement before the old probe resolves.
  manager.disconnect('s1')
  manager.connect('s1')
  await waitFor(() => children.length === 2, 3000, 'replacement tunnel spawned')
  setProbe(true)
  await waitFor(() => manager.status('s1')?.phase === 'ready', 3000, 'replacement becomes ready')
  await new Promise(resolve => setTimeout(resolve, 250))
  const status = manager.status('s1')!
  assert.equal(status.phase, 'ready', 'the stale probe must not terminal the new attempt')
  assert.equal(status.userActionKind, null)
  assert.deepEqual(children[1]!.killCalls, [], 'the replacement child must not be killed by the stale probe')
})
