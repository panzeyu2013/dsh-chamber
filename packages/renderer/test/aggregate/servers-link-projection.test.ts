/**
 * E2 link-availability projection (design 27 §3.1/§3.3, review C9): the ONE fact channel
 * from the transport status projection to the renderer frame / sidebar is
 * ChamberServerAggregate.linkUp + linkState, derived in host/servers.ts with the SAME
 * readings the page-channel selector uses (client-core linkReady / the local serving table).
 *
 * Pinned here:
 *  - the derive matrix (remote ready × healthy/suspect/down; old shim; non-ready phases;
 *    local serving health; the gateway managed fold stays TRANSPORT-only — a healthy tunnel
 *    is never relabelled down by a stopped managed dsh, design 27 P1-D);
 *  - the per-source projection cache key carries the link facts (a link-only flip rebuilds);
 *  - the publish signature carries them (chamberBridge subscribers only repaint when the
 *    signature moves — otherwise a ready-but-down source keeps its green face).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  serversProjectionSignature,
} from '@dsh-chamber/dsh-chamber-client-core'
import { createServerProjectionCache, deriveServers, type ServerProjectionCache } from '../../src/host/servers.ts'
import { instanceConnected, sourceIdForInstance } from '../../src/transport-source.ts'
import { shouldDeferBootForSource } from '../../src/source-readiness.ts'
import type { HealthResponse } from '../../src/api.ts'
import type { SshInstanceSpec, SshStatusProjection } from '../../src/global.d.ts'

const READY_HEALTH = { dsh: { status: 'ready' } } as unknown as HealthResponse

const instance: SshInstanceSpec = {
  id: 'r1', label: 'R1', kind: 'dsh', transport: 'ssh', host: 'h', user: null, sshPort: null,
  remotePort: 1, serviceName: null, remoteDshHome: null, sourceFingerprint: 'b'.repeat(64),
  insecureHttp: false,
}
const REMOTE = sourceIdForInstance(instance)

/** instanceConnected/linkReady only read kind + phase, but the projection type is complete. */
const readyStatus: SshStatusProjection = {
  kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'ready', localPort: null, transportSocket: 'tcp', sshPort: null,
  remotePort: 1, remoteDshHome: null, retryAttempt: 0, requiresUserAction: false, userActionKind: null,
  serviceActive: null, logSummary: '',
}

interface Fixture {
  health?: HealthResponse | null
  instances?: SshInstanceSpec[]
  remoteStatus?: Record<string, SshStatusProjection>
  managedRuntime?: Record<string, string | null>
  cache?: ServerProjectionCache
}

function derive(facts: Fixture = {}) {
  return deriveServers(
    facts.health ?? READY_HEALTH,
    [],
    facts.instances ?? [instance],
    facts.remoteStatus ?? { r1: readyStatus },
    {},
    {}, {}, {},
    'local',
    {}, {},
    facts.managedRuntime ?? {},
    {}, {}, {}, {},
    'zh', {},
    facts.cache,
  )
}

function remoteServer(facts: Fixture = {}) {
  return derive(facts).find(server => server.id === REMOTE)
}

test('derive: a ready remote projects the link sub-state; suspect still forwards', () => {
  const healthy = remoteServer()
  assert.equal(healthy?.linkUp, true)
  assert.equal(healthy?.linkState, 'healthy', 'an old shim without a link field is healthy by contract')

  const withState = (state: 'healthy' | 'suspect' | 'down') => remoteServer({
    remoteStatus: { r1: { ...readyStatus, link: { state, linkEpoch: 1 } } },
  })
  assert.equal(withState('healthy')?.linkState, 'healthy')
  assert.equal(withState('suspect')?.linkState, 'suspect')
  assert.equal(withState('suspect')?.linkUp, true, 'suspect still forwards (design 27 I3)')
  assert.equal(withState('down')?.linkState, 'down')
  assert.equal(withState('down')?.linkUp, false, 'down parks NEW work (the gate facts)')
})

test('derive: a non-ready transport never carries a link sub-state', () => {
  // The desktop projection only means something while ready (its own contract). Outside ready,
  // linkUp is already false through linkReady and linkState must be null instead of a stale value.
  for (const phase of ['connecting', 'degraded', 'error', 'idle'] as const) {
    const server = remoteServer({
      remoteStatus: { r1: { ...readyStatus, phase, link: { state: 'down', linkEpoch: 1 } } },
    })
    assert.equal(server?.linkUp, false, phase)
    assert.equal(server?.linkState, null, phase)
  }
})

test('derive: the local source reads its serving health (design 02 §3.5)', () => {
  const localOnly = (status: string | undefined) => derive({
    instances: [],
    remoteStatus: {},
    health: { dsh: { status } } as unknown as HealthResponse,
  }).find(server => server.id === 'local')
  assert.equal(localOnly('ready')?.linkUp, true)
  assert.equal(localOnly('degraded')?.linkUp, true, 'local degraded still serves')
  assert.equal(localOnly('starting')?.linkUp, false)
  assert.equal(localOnly('error')?.linkUp, false)
  // Local has no transport link projection: the sub-state stays absent/null (never invented).
  for (const status of ['ready', 'degraded', 'error']) assert.equal(localOnly(status)?.linkState, null, status)
})

test('derive: the gateway managed fold never relabels the transport link', () => {
  // P1-D: linkReady reads the TRANSPORT projection only. A stopped managed dsh folds into
  // phase/managedRuntimeDown; the healthy tunnel keeps linkUp/linkState transport-true.
  const gatewayInstance: SshInstanceSpec = { ...instance, id: 'g1', kind: 'gateway', label: 'G1' }
  const gatewaySource = sourceIdForInstance(gatewayInstance)
  const server = derive({
    instances: [gatewayInstance],
    remoteStatus: { g1: { ...readyStatus, kind: 'gateway' } },
    managedRuntime: { [gatewaySource]: 'stopped' },
  }).find(candidate => candidate.id === gatewaySource)
  assert.equal(server?.phase, 'stopped', 'the managed state folds into phase')
  assert.equal(server?.managedRuntimeDown, true)
  assert.equal(server?.connected, false)
  assert.equal(server?.linkUp, true, 'the transport link itself is still admissible')
  assert.equal(server?.linkState, 'healthy', 'a healthy tunnel is never called down by the managed fold')
})

test('derive: a stale old-kind projection defines no link facts on the replacement row', () => {
  // Registry kind switch and its IPC pushes are separate messages: the old provider's READY
  // (even one that says link down) is not proof about the replacement provider — the same
  // discipline instanceConnected applies (transport-source.ts:105-108). The kind-validated
  // projection is the ONLY source of the link sub-state, so the stale row can decide neither
  // the boot deferral (App kind-gates the raw phase too) nor prewarm (linkReady ∧ instanceConnected).
  const gateway: SshInstanceSpec = { ...instance, id: 'g1', kind: 'gateway', label: 'G1' }
  const gatewaySource = sourceIdForInstance(gateway)
  const staleDown = { ...readyStatus, kind: 'dsh', link: { state: 'down', linkEpoch: 1 } } as SshStatusProjection
  const stale = derive({ instances: [gateway], remoteStatus: { g1: staleDown } })
    .find(candidate => candidate.id === gatewaySource)
  assert.equal(stale?.connected, false, 'a stale old-kind READY is not the replacement provider being connected')
  assert.equal(stale?.linkUp, false, 'a stale old-kind READY cannot make the new row admissible')
  assert.equal(stale?.linkState, null, 'the ready-period sub-state must not leak across a kind switch')
  // boot defer gate: the App reads the raw phase through the same kind gate, so a kind-mismatched
  // projection reads as absent there too ⇒ no deferral from the old provider's link.
  const staleRawPhase = staleDown.kind === gateway.kind ? staleDown.phase : undefined
  assert.equal(shouldDeferBootForSource(staleRawPhase, stale?.linkState === 'down'), false)
  // prewarm gate: linkReady alone is not enough — the scheduler ANDs the kind-checked instanceConnected.
  assert.equal(instanceConnected('gateway', READY_HEALTH, { g1: staleDown }, 'g1'), false)
  // Control: the SAME link-down reading under the MATCHED kind still defers the boot.
  const matched = derive({
    instances: [gateway],
    remoteStatus: { g1: { ...readyStatus, kind: 'gateway', link: { state: 'down', linkEpoch: 1 } } },
  }).find(candidate => candidate.id === gatewaySource)
  assert.equal(matched?.phase, 'ready')
  assert.equal(matched?.linkState, 'down')
  assert.equal(shouldDeferBootForSource('ready', matched?.linkState === 'down'), true)
})

test('cache: the link facts are a projection-cache key component', () => {
  const cache = createServerProjectionCache()
  const first = remoteServer({ cache })
  assert.equal(remoteServer({ cache }), first, 'identical inputs reuse the per-source entry')

  const down = remoteServer({ cache, remoteStatus: { r1: { ...readyStatus, link: { state: 'down', linkEpoch: 1 } } } })
  assert.notEqual(down, first, 'a link-only flip must rebuild the entry')
  assert.equal(down?.linkState, 'down')
  assert.equal(down?.linkUp, false)

  const recovered = remoteServer({ cache })
  assert.notEqual(recovered, down, 'recovery rebuilds again (no stale down row)')
  assert.equal(recovered?.linkUp, true)
  assert.equal(recovered, remoteServer({ cache }), 'the recovered entry is reusable')
})

test('publish signature: the link facts move the chamberBridge gate', () => {
  assert.equal(
    serversProjectionSignature(derive()),
    serversProjectionSignature(derive()),
    'identical projections sign identically',
  )
  const down = derive({ remoteStatus: { r1: { ...readyStatus, link: { state: 'down', linkEpoch: 1 } } } })
  assert.notEqual(
    serversProjectionSignature(down),
    serversProjectionSignature(derive()),
    'a link-only flip must re-publish or the sidebar dot keeps its green face',
  )
})
