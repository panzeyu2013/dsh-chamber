/**
 * Local serviceability gate: `degraded` is still serving (design 02 §3.5) and
 * must keep local aggregate polling alive; `starting`/`restarting` must not.
 * The remote transport arm stays strict (`ready` only): its `degraded` phase is
 * a reconnect state, not a serving fact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  instanceConnected,
  isServiceableLocalStatus,
  partitionSourceReachability,
  sourceIdForTransport,
  statusWriteAccepted,
} from '../../src/transport-source.ts'
import type { HealthResponse } from '../../src/api.ts'
import type { SshInstanceSpec, SshStatusProjection } from '../../src/global.d.ts'

const health = (status: string): HealthResponse => ({ ok: true, dsh: { status, port: 17510 } }) as HealthResponse

/** One renderer-side remote row (packages/renderer/src/global.d.ts SshInstanceSpec). */
const remoteRow = (id: string, transport: 'ssh' | 'http', kind: 'dsh' | 'gateway' = 'dsh'): SshInstanceSpec => ({
  id, label: id, kind, transport, host: '127.0.0.1', user: 'u', sshPort: 22, remotePort: 4080,
  serviceName: null, remoteDshHome: null, sourceFingerprint: 'b'.repeat(64), insecureHttp: false,
})

/** A complete status projection; overrides carry the case. */
const status = (overrides: Partial<SshStatusProjection> = {}): SshStatusProjection => ({
  kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'ready', localPort: null,
  transportSocket: 'tcp', sshPort: 22, remotePort: 4080, remoteDshHome: null, retryAttempt: 0,
  requiresUserAction: false, userActionKind: null, serviceActive: null, logSummary: '',
  ...overrides,
})

test('isServiceableLocalStatus: ready and degraded only', () => {
  assert.equal(isServiceableLocalStatus('ready'), true)
  assert.equal(isServiceableLocalStatus('degraded'), true)
  for (const state of ['starting', 'restarting', 'stopped', 'error', 'restart-exhausted']) {
    assert.equal(isServiceableLocalStatus(state), false, state)
  }
  assert.equal(isServiceableLocalStatus(undefined), false)
})

test('instanceConnected: local degraded still polls; local starting does not', () => {
  assert.equal(instanceConnected('local', health('degraded'), {}, 'local'), true)
  assert.equal(instanceConnected('local', health('ready'), {}, 'local'), true)
  assert.equal(instanceConnected('local', health('starting'), {}, 'local'), false)
})

test('instanceConnected: remote transport degraded is still not connected', () => {
  assert.equal(instanceConnected('gateway', null, { gw: { kind: 'gateway', phase: 'degraded' } } as never, 'gw'), false)
  assert.equal(instanceConnected('gateway', null, { gw: { kind: 'gateway', phase: 'ready' } } as never, 'gw'), true)
})

test('App and the extracted hooks gate all three local-source seams through the helper (contract lock)', () => {
  // design 04 §4.2: `degraded` must not park the local page-channel link, must not
  // wake it as a real change, and must not reach createLocal (startImpl would tear
  // a serving child down). The leaf helper alone cannot lock those three call sites.
  // The seams now live in App.tsx (link.ready) and the two extracted app-hooks; the
  // lock follows the call sites instead of pinning them to one file.
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const sites = [
    ['App.tsx', read('../../src/App.tsx'), 'isServiceableLocalStatus(healthRef.current?.dsh?.status)',
      'page-channel link.ready must read the helper (degraded stays subscribed)'],
    ['use-page-channel-link-notify.ts', read('../../src/app-hooks/use-page-channel-link-notify.ts'),
      'isServiceableLocalStatus(health.dsh?.status)',
      'the local link epoch must key on the helper (no epoch bump across ready/degraded)'],
    ['use-connection-bootstrap.ts', read('../../src/app-hooks/use-connection-bootstrap.ts'),
      'isServiceableLocalStatus(local.status)',
      'the auto-start gate must read the helper (never createLocal from degraded)'],
  ]
  for (const [name, text, needle, why] of sites) {
    assert.ok(text.includes(needle), name + ': ' + why)
    assert.ok(!text.includes("dsh?.status === 'ready'"), name + ': no residual ready-only comparison may shadow the helper')
    assert.ok(!text.includes("local.status === 'ready'"), name + ': the auto-start gate must not fall back to a ready-only comparison')
  }
})

test('remote first-contact auto-connect is host-owned: the page keeps no connect arm (v2 §P2-B)', () => {
  // design 05 §3（v2 P2-B）：远程连接权威移到宿主（sidecar 启动对账 + 权威新增对账 + 唤醒票据
  // 复查）；页面只呈现事实、只发显式意图（desktop_ssh_connect / desktop_ssh_disconnect）。本条是
  // 删除后不可复活的文本锁：本地 effect（上面既有的 isServiceableLocalStatus 文本锁）保留，
  // 页面侧远程首连 / knownRemoteIdsRef 第二权威一律不得回来。
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const bootstrap = read('../../src/app-hooks/use-connection-bootstrap.ts')
  assert.ok(!/\.connect\s*\(/.test(bootstrap), 'use-connection-bootstrap.ts must not call desktopSsh.connect (remote arm removed)')
  assert.ok(!bootstrap.includes('remoteInstances'), 'the bootstrap hook takes no remote roster (the host owns remote reconciliation)')
  assert.ok(bootstrap.includes('isServiceableLocalStatus(local.status)'), 'the local auto-start arm must stay')
  const app = read('../../src/App.tsx')
  assert.ok(!app.includes('knownRemoteIdsRef'), 'App.tsx must not track first-seen remote ids (no second connection authority)')
  assert.ok(!app.includes('useConnectionBootstrap({ connections, remoteInstances'), 'the hook is called without a remote roster')
})

test('the control-plane and renderer serviceability tables name the same states (lockstep)', () => {
  // The renderer cannot import control-plane (different runtime), so its table is a
  // documented copy. A cross-package lockstep is the only guard against drift — a
  // one-sided edit would silently stop polling or park the page channel.
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const table = /=== 'ready' \|\| (?:state|status) === 'degraded'/
  assert.match(read('../../../control-plane/src/local-connection.ts'), table,
    'control-plane isServiceableLocalState must stay ready|degraded')
  assert.match(read('../../src/transport-source.ts'), table,
    'renderer isServiceableLocalStatus must name the SAME table as the control plane')
})

test('statusWriteAccepted: a projection from a replaced transport mechanism is refused', () => {
  const live = new Set(['local', 'dsh-r1'])
  const httpRow = remoteRow('r1', 'http')
  assert.equal(sourceIdForTransport('dsh', 'r1'), 'dsh-r1', 'the mechanism is not part of the logical source id')
  assert.equal(statusWriteAccepted({
    id: 'r1', projection: status({ transport: 'ssh', phase: 'ready' }), instances: [httpRow], live, ownerHeld: true,
  }), false, 'an old ssh READY must never land on the replacement http row')
  assert.equal(statusWriteAccepted({
    id: 'r1', projection: null, instances: [httpRow], live, ownerHeld: true,
  }), false, 'an absent projection is never written')
  assert.equal(statusWriteAccepted({
    id: 'r1', projection: status({ transport: 'http' }), instances: [httpRow], live, ownerHeld: true,
  }), true, 'a same-mechanism projection still writes')
  // The remaining acceptance dimensions all gate the write on their own.
  assert.equal(statusWriteAccepted({
    id: 'gone', projection: status({ transport: 'http' }), instances: [httpRow], live, ownerHeld: true,
  }), false, 'write-time row existence')
  assert.equal(statusWriteAccepted({
    id: 'r1', projection: status({ transport: 'http' }), instances: [httpRow], live: new Set(['local']), ownerHeld: true,
  }), false, 'liveness')
  assert.equal(statusWriteAccepted({
    id: 'r1', projection: status({ transport: 'http' }), instances: [httpRow], live, ownerHeld: false,
  }), false, 'owner proof')
  assert.equal(statusWriteAccepted({
    id: 'r1', projection: status({ kind: 'gateway', transport: 'http' }), instances: [httpRow], live, ownerHeld: true,
  }), false, 'the kind-derived source id must match the captured source')
})

test('statusWriteAccepted: write-time instances decide, not a snapshot captured before the await', () => {
  const live = new Set(['local', 'dsh-r1'])
  const oldSshReady = status({ transport: 'ssh', phase: 'ready' })
  // A pre-await snapshot cannot tell the mechanism was replaced, so it would accept the stale READY
  // (that snapshot-shaped gate is exactly what the T4 probe exercised).
  assert.equal(statusWriteAccepted({
    id: 'r1', projection: oldSshReady, instances: [remoteRow('r1', 'ssh')], live,
    expectedSourceId: 'dsh-r1', ownerHeld: true,
  }), true, 'the pre-await row is indistinguishable — no wire generation fact')
  // The wired receiver passes the CURRENT rows at write time: the same projection is refused.
  assert.equal(statusWriteAccepted({
    id: 'r1', projection: oldSshReady, instances: [remoteRow('r1', 'http')], live,
    expectedSourceId: 'dsh-r1', ownerHeld: true,
  }), false, 'the write-time row contains the replacement mechanism')
})

test('partitionSourceReachability: ready+down is parked; suspect refreshes; notReady never includes down', () => {
  const instances = [
    remoteRow('r-ok', 'ssh'),
    remoteRow('r-down', 'ssh'),
    remoteRow('r-suspect', 'http', 'gateway'),
    remoteRow('r-connecting', 'ssh'),
  ]
  const remoteStatus = {
    'r-ok': status({ phase: 'ready' }),
    'r-down': status({ phase: 'ready', link: { state: 'down', linkEpoch: 1 } }),
    'r-suspect': status({ kind: 'gateway', transport: 'http', phase: 'ready', link: { state: 'suspect', linkEpoch: 2 } }),
    'r-connecting': status({ phase: 'connecting' }),
  }
  const partition = partitionSourceReachability(health('ready'), remoteStatus, instances)
  assert.deepEqual(partition.ready, ['local', 'dsh-r-ok', 'gateway-r-suspect'],
    'ready holds the connected-and-link-ready sources; suspect still forwards')
  assert.deepEqual(partition.linkDown, ['dsh-r-down'], 'the down bucket is parked')
  assert.deepEqual(partition.notReady, ['dsh-r-connecting'], 'not-ready holds only non-connected sources')
  assert.equal(partition.ready.includes('dsh-r-down'), false, 'a down link is never refreshable')
  assert.equal(partition.notReady.includes('dsh-r-down'), false,
    'a parked down link must never trigger the not-connected reset (nothing is pruned)')
  // Local has no transport link: serving health is its whole reading.
  assert.deepEqual(partitionSourceReachability(health('starting'), {}, []),
    { ready: [], linkDown: [], notReady: ['local'] })
  // A stale old-kind READY does not pass the kind gate after a mechanism switch.
  assert.deepEqual(partitionSourceReachability(health('ready'), { 'r-ok': status({ kind: 'dsh', phase: 'ready' }) },
    [remoteRow('r-ok', 'http', 'gateway')]).notReady, ['gateway-r-ok'],
  'the stale old-kind READY is not-connected for the replacement row')
})

test('the two status receivers write through ONE acceptance reading (contract lock)', () => {
  // design 06 §4.8: pull and push share the acceptance reading, so no write path can drift.
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const pull = read('../../src/app-hooks/use-remote-refresh.ts')
  const app = read('../../src/App.tsx')
  assert.match(pull, /statusWriteAccepted\(\{/, 'the pull receiver calls the shared acceptance reading')
  assert.match(pull, /ownerHeld: sourceLifecyclesRef\.current!\.owns\(sourceOwner\)/,
    'the pull writer keeps its pre-await owner proof')
  assert.match(pull, /expectedSourceId,/, 'the pull writer forwards the caller expectedSourceId; the write-time row decides when absent')
  assert.equal(pull.includes('sourceIdForTransport(projection.kind'), false,
    'no residual inline source-id condition may survive next to the shared reading')
  assert.match(app, /statusWriteAccepted\(\{/, 'the push receiver calls the same acceptance reading')
  assert.match(app, /ownerHeld: true/, 'push is synchronous: the owner proof is trivially held')
  assert.equal((app.match(/statusWriteAccepted\(/g) ?? []).length, 1, 'exactly ONE push call site')
  assert.equal(app.includes('sourceIdForTransport(payload.status.kind'), false,
    'no residual inline four-condition push gate may survive')
})

test('same-mechanism reconnect has no wire discriminator (documented residual)', () => {
  const live = new Set(['local', 'dsh-r1'])
  const sameMechanismOld = status({ transport: 'ssh', phase: 'ready', link: { state: 'healthy', linkEpoch: 7 } })
  assert.equal(statusWriteAccepted({
    id: 'r1', projection: sameMechanismOld, instances: [remoteRow('r1', 'ssh')], live, ownerHeld: true,
  }), true, 'same-mechanism late projections stay accepted: the wire carries no generation fact')
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  assert.match(read('../../src/transport-source.ts'), /Same-mechanism reconnect churn has NO wire/,
    'the acceptance reading names the residual instead of inventing a projection field')
})
