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
import { instanceConnected, isServiceableLocalStatus } from '../../src/transport-source.ts'
import type { HealthResponse } from '../../src/api.ts'

const health = (status: string): HealthResponse => ({ ok: true, dsh: { status, port: 17510 } }) as HealthResponse

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
