/**
 * P0-3 host-key IPC payload shape: probe/trust handlers registered by
 * shell-ipc-connections, the payload handoff to the guard, and the refusal shapes.
 * The guard is injected (the real one owns the file + probe); this suite locks the WIRE shape.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IPC_CHANNELS } from '../../ipc-events.ts'
import { registerConnectionHandlers } from '../../shell-ipc-connections.ts'
import type { ShellIpcCtx } from '../../shell-ipc-ctx.ts'
import type { HostKeyGuard, HostKeyProbeOutcome, HostKeyTarget } from '../../host-key.ts'
import type { TransportInstanceSpec, TransportStatusProjection } from '../../transport-provider.ts'

const SSH_SPEC: TransportInstanceSpec = {
  id: 'h1', label: 'host', kind: 'dsh', transport: 'ssh', host: 'h.example.com', user: 'u',
  sshPort: null, remotePort: 3080, serviceName: null, remoteDshHome: null, insecureHttp: false,
}
const HTTP_SPEC: TransportInstanceSpec = { ...SSH_SPEC, id: 'g1', transport: 'http', kind: 'gateway' }
const PROJECTION: TransportStatusProjection = {
  kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'error', localPort: null, transportSocket: 'tcp', sshPort: null,
  remotePort: 3080, retryAttempt: 0, requiresUserAction: true, userActionKind: 'hostkey',
  serviceActive: null, remoteDshHome: null, logSummary: 'host key verification failed',
}

const OUTCOME: HostKeyProbeOutcome = {
  state: 'unknown', type: 'ssh-ed25519', blob: 'AAAAB3NzaC1yc2E=', fingerprints: ['SHA256:abc'],
  previousFingerprints: [], changed: false, probedAt: 1234,
}

interface GuardCalls {
  probes: HostKeyTarget[]
  trusts: Array<{ target: HostKeyTarget; candidate: { type: string; blob: string } }>
}

function harness(guardResult: { ok: true; replaced: boolean } | { ok: false; error: string } = { ok: true, replaced: false }) {
  const calls: GuardCalls = { probes: [], trusts: [] }
  const guard: HostKeyGuard = {
    knownHostsFile: '/tmp/app-known-hosts',
    knownHostsArgs: () => ({ knownHostsFile: '/tmp/app-known-hosts', globalKnownHostsFile: '/dev/null' }),
    isKnown: () => false,
    probe: async (target) => { calls.probes.push(target); return OUTCOME },
    projection: () => null,
    trust: async (target, candidate) => {
      calls.trusts.push({ target, candidate: { type: candidate.type, blob: candidate.blob } })
      return guardResult.ok
        ? { ok: true, replaced: guardResult.replaced, projection: { state: 'known', fingerprints: ['SHA256:abc'] } }
        : { ok: false, error: guardResult.error }
    },
  }
  const handlers = new Map<string, (payload: unknown) => unknown>()
  const ctx = {
    deps: {
      ipc: { handle: (channel: string, handler: (payload: unknown) => unknown) => { handlers.set(channel, handler) } },
      ctx: {
        transportManager: {
          listInstances: () => [SSH_SPEC, HTTP_SPEC],
          status: () => PROJECTION,
        },
        gatewaySessions: null,
        publishRegistryTransition: () => [],
        audit: () => {},
        hostKey: guard,
      },
    },
    projectInstances: (instances: TransportInstanceSpec[]) => instances,
  } as unknown as ShellIpcCtx
  registerConnectionHandlers(ctx)
  return { handlers, calls }
}

test('the host-key channels are the exact wire names and are registered', () => {
  assert.equal(IPC_CHANNELS.SSH_HOST_KEY_PROBE, 'desktop_ssh_host_key_probe')
  assert.equal(IPC_CHANNELS.SSH_HOST_KEY_TRUST, 'desktop_ssh_host_key_trust')
  const { handlers } = harness()
  assert.ok(handlers.has('desktop_ssh_host_key_probe'))
  assert.ok(handlers.has('desktop_ssh_host_key_trust'))
})

test('probe: { id } in, { ok, hostKey } out — only for an existing ssh instance', async () => {
  const { handlers, calls } = harness()
  const result = await handlers.get(IPC_CHANNELS.SSH_HOST_KEY_PROBE)!({ id: 'h1' }) as Record<string, unknown>
  assert.deepEqual(result, { ok: true, hostKey: OUTCOME })
  assert.deepEqual(calls.probes, [SSH_SPEC])
  // Unknown id, malformed id, and a non-ssh instance are all refused without a probe.
  for (const payload of [{ id: 'missing' }, { id: 'bad/id' }, { id: 'g1' }, {}, null, { id: 42 }]) {
    const refused = await handlers.get(IPC_CHANNELS.SSH_HOST_KEY_PROBE)!(payload) as Record<string, unknown>
    assert.deepEqual(refused, { ok: false, error: 'unknown ssh instance' }, JSON.stringify(payload))
  }
  assert.equal(calls.probes.length, 1)
})

test('trust: { id, type, blob } reaches the guard verbatim and answers replaced + fresh status', async () => {
  const { handlers, calls } = harness({ ok: true, replaced: true })
  const result = await handlers.get(IPC_CHANNELS.SSH_HOST_KEY_TRUST)!({
    id: 'h1', type: 'ssh-ed25519', blob: 'AAAAB3NzaC1yc2E=',
    // A caller-supplied probedAt (or any extra field) is ignored: the guard owns the TTL.
    probedAt: 1,
  }) as Record<string, unknown>
  assert.deepEqual(result, { ok: true, replaced: true, status: PROJECTION })
  assert.deepEqual(calls.trusts, [{ target: SSH_SPEC, candidate: { type: 'ssh-ed25519', blob: 'AAAAB3NzaC1yc2E=' } }])
})

test('trust refusals: non-string key material never reaches the guard; guard errors pass through', async () => {
  const refused = harness()
  for (const payload of [
    { id: 'h1', type: 'ssh-ed25519' },
    { id: 'h1', blob: 'AAAA' },
    { id: 'h1', type: 42, blob: 'AAAA' },
    { id: 'h1', type: 'ssh-ed25519', blob: null },
    { id: 'g1', type: 'ssh-ed25519', blob: 'AAAA' },
    null,
  ]) {
    const result = await handlersOf(refused).get(IPC_CHANNELS.SSH_HOST_KEY_TRUST)!(payload) as Record<string, unknown>
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  }
  assert.equal(refused.calls.trusts.length, 0, 'the guard never saw an invalid payload')

  const failing = harness({ ok: false, error: 'no recent host-key probe — probe again before trusting' })
  const result = await handlersOf(failing).get(IPC_CHANNELS.SSH_HOST_KEY_TRUST)!({ id: 'h1', type: 'ssh-ed25519', blob: 'AAAA' }) as Record<string, unknown>
  assert.deepEqual(result, { ok: false, error: 'no recent host-key probe — probe again before trusting' })
})

function handlersOf(built: ReturnType<typeof harness>) {
  return built.handlers
}
