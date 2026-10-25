/**
 * Plugin-inventory read face tests (plain node:test, no dsh, no React):
 * the unary wire client (plugin-inventory-api.ts) envelope parsing +
 * transport failure folding, and the pure display projections
 * (plugin-inventory-text.ts: third-party filter + chamber remote state).
 * The read face is the connections-section plugin surface for gateway /
 * http-direct targets (design 17 §9.3).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inventoryErrorText, loadPluginInventory, type PluginInventorySnapshot } from '../../src/client/plugin-inventory-api.ts'
import {
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  chamberRemoteKey,
} from '../../src/client/plugin-inventory-text.ts'
import { stubFetch, withPageOrigin } from '../support/fixtures.ts'
import {
  acquireHttpBudget,
  configureHttpBudgetForTests,
  resetHttpBudgetForTests,
} from '../../../dsh-chamber-client-core/src/http-budget.ts'
import { HttpBudgetUnscheduledError } from '../../../dsh-chamber-client-core/src/http-budget.ts'
import { InstanceUnavailableError } from '../../../dsh-chamber-client-core/src/wire-error.ts'
import { en, zh } from '../../src/locales.ts'

function serverResponse(rpcId: string, result: unknown): unknown {
  return { type: 'server-response', rpcId, result }
}

const okSnapshot: PluginInventorySnapshot = {
  entries: [
    { entryId: 'p1', moduleName: '@deepseek-ai/dsh-demo', enabled: true, fiberPhase: 'active' },
    { entryId: 'p2', moduleName: '@deepseek-ai/dsh-broken', enabled: true, fiberPhase: 'failed' },
    { entryId: 'p3', moduleName: '@deepseek-ai/dsh-off', enabled: false, fiberPhase: null },
    { entryId: 'p4', moduleName: HOST_GRAPH_PACKAGE, enabled: true, fiberPhase: 'active' },
    { entryId: 'p5', moduleName: GIT_WORKTREE_PACKAGE, enabled: true, fiberPhase: 'active' },
    { entryId: 'p6', moduleName: '@dsh-chamber/user-tool', enabled: true, fiberPhase: 'loading' },
    { entryId: 'p7', moduleName: 'my-third-party-plugin', enabled: false, fiberPhase: 'failed' },
  ],
}

test('loadPluginInventory: posts the client-request envelope to the per-instance proxy and parses the snapshot', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500', 'location')
  const stub = stubFetch(200, serverResponse('rpc-1', { ok: true, value: okSnapshot }))
  try {
    const snapshot = await loadPluginInventory('gateway-west')
    assert.equal(stub.calls.length, 1)
    const call = stub.calls[0]!
    assert.equal(call.url, 'http://127.0.0.1:17500/api/i/gateway-west/api/pluginInventory/list')
    assert.equal(call.init.method, 'POST')
    const envelope = JSON.parse(String(call.init.body)) as { type: string; method: string; payload: unknown }
    assert.equal(envelope.type, 'client-request')
    assert.equal(envelope.method, 'pluginInventory/list')
    assert.deepEqual(envelope.payload, { args: {} })
    assert.deepEqual(snapshot, okSnapshot)
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('loadPluginInventory: a page-budget refusal keeps its provenance and never claims the instance is down', async () => {
  resetHttpBudgetForTests()
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, perSourceQueueMax: 0 })
  let fetches = 0
  try {
    const holder = await acquireHttpBudget({ sourceId: 'other', kind: 'unary', lane: 'foreground' })
    assert.equal(holder.kind, 'granted')
    await assert.rejects(
      loadPluginInventory('gateway-west'),
      (error: unknown) => error instanceof HttpBudgetUnscheduledError,
      'the typed refusal must survive the read face (the dialog localizes it)',
    )
    assert.equal(fetches, 0)
    assert.equal(typeof zh.inventoryNotDispatched, 'string')
    assert.equal(typeof en.inventoryNotDispatched, 'string')
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('loadPluginInventory: a business failure throws a loud message with code, never a silent empty list', async () => {
  const stub = stubFetch(200, serverResponse('rpc-2', {
    ok: false,
    error: { code: 'gateway/not-found', message: 'pluginInventory/list is not mounted' },
  }))
  try {
    await assert.rejects(loadPluginInventory('gateway-west'), /pluginInventory\/list failed: gateway\/not-found: pluginInventory\/list is not mounted/)
  } finally {
    stub.restore()
  }
})

test('inventoryErrorText: a not-ready 503 is localized by phase, never the raw gateway body', () => {
  const t = (key: string) => key
  // A retrying phase and a terminal one must not share copy: a stopped or
  // restart-exhausted instance never becomes ready by waiting.
  for (const state of ['starting', 'restarting', 'degraded', undefined]) {
    assert.equal(inventoryErrorText(new InstanceUnavailableError('x', state), t), 'inventoryInstanceUnavailable', String(state))
  }
  for (const state of ['stopped', 'error']) {
    assert.equal(inventoryErrorText(new InstanceUnavailableError('x', state), t), 'restartNotRunning', state)
  }
  assert.equal(inventoryErrorText(new InstanceUnavailableError('x', 'restart-exhausted'), t), 'inventoryRestartExhausted')
  assert.equal(inventoryErrorText(new Error('boom'), t), 'boom')
})

test('loadPluginInventory: the proxy explicit 503 throws the SHARED not-ready class (carrier identity)', async () => {
  const stub = stubFetch(503, { code: 'instance_unavailable', error: 'no transport is available for this instance' })
  try {
    await assert.rejects(
      () => loadPluginInventory('gateway-west'),
      (error: unknown) => {
        // The carrier itself must throw wire-error's class: a bare Error here would make
        // isInstanceUnavailable() false and leak the raw body into the dialog.
        assert.ok(error instanceof InstanceUnavailableError)
        assert.match(error.message, /实例未就绪：no transport is available for this instance/)
        assert.equal(inventoryErrorText(error, key => key), 'inventoryInstanceUnavailable')
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('loadPluginInventory: a non-2xx answer and a network failure both fold as transport errors (never empty)', async () => {
  const stub = stubFetch(500, { error: 'boom' })
  try {
    await assert.rejects(loadPluginInventory('gateway-west'), /实例不可达：HTTP 500/)
  } finally {
    stub.restore()
  }
  const rejected = stubFetch(0, null, true)
  try {
    await assert.rejects(loadPluginInventory('gateway-west'), /实例不可达：fetch failed/)
  } finally {
    rejected.restore()
  }
})

test('loadPluginInventory: malformed envelopes and invalid snapshots are loud TypeErrors, never silent', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [serverResponse('rpc-3', { ok: true, value: { entries: [{ entryId: 7, moduleName: 'x', enabled: true, fiberPhase: 'active' }] } }), /invalid inventory entry/],
    [serverResponse('rpc-3', { ok: true, value: { entries: 'nope' } }), /invalid snapshot/],
    [serverResponse('rpc-3', { ok: false, error: { code: 7, message: 'x' } }), /invalid server-response failure/],
    [{ type: 'other', rpcId: 'rpc-3', result: {} }, /invalid server-response envelope/],
  ]
  for (const [body, expected] of cases) {
    const stub = stubFetch(200, body)
    try {
      await assert.rejects(loadPluginInventory('gateway-west'), expected)
    } finally {
      stub.restore()
    }
  }
})

/**
 * rc.2 re-anchor (RC-C1): the read view projects ONLY the Loader `entries`. Host display
 * metadata (`meta`), `managementAvailable` and the per-preset `agentPresets` compositions
 * have no consumer in this repo, so they are neither declared nor validated: a payload
 * carrying them parses to exactly the entries projection.
 */
test('loadPluginInventory: the rc.2 real shape projects entries; meta/managementAvailable/agentPresets are ignored', async () => {
  const rc2 = {
    managementAvailable: true,
    entries: [{
      entryId: 'p1',
      moduleName: '@deepseek-ai/dsh-demo',
      meta: {
        title: 'Demo',
        description: { en: 'Demo plugin', zh: '演示' },
        icon: 'data:image/png;base64,AA==',
        error: 'icon unreadable',
      },
      enabled: true,
      fiberPhase: 'active',
    }],
    agentPresets: [{
      id: 'default',
      name: '默认组合',
      isDefault: true,
      rows: [{
        entryId: 'row-1',
        moduleName: '@deepseek-ai/dsh-demo',
        meta: { title: { en: 'Demo' } },
        enabled: 'conditional',
        condition: '!!js process.platform === "darwin"',
        fiberPhase: null,
      }],
    }],
  }
  const stub = stubFetch(200, serverResponse('rpc-rc2', { ok: true, value: rc2 }))
  try {
    const snapshot = await loadPluginInventory('gateway-west')
    assert.deepEqual(snapshot, {
      entries: [{ entryId: 'p1', moduleName: '@deepseek-ai/dsh-demo', enabled: true, fiberPhase: 'active' }],
    }, 'only entries is projected; meta/managementAvailable/agentPresets are dropped')
  } finally {
    stub.restore()
  }
})

test('chamberRemoteKey: live Loader state derives the remote label, never a constant claim', () => {
  const { entries } = okSnapshot
  // Present + enabled + active → 已注入并已生效; failed → 加载失败; other
  // phases → 生效状态未知; present-but-DISABLED is never claimed live.
  assert.equal(chamberRemoteKey(entries, HOST_GRAPH_PACKAGE), 'chamberRemoteLive')
  const failed = entries.map(entry => entry.moduleName === GIT_WORKTREE_PACKAGE
    ? { ...entry, fiberPhase: 'failed' as const }
    : entry)
  assert.equal(chamberRemoteKey(failed, GIT_WORKTREE_PACKAGE), 'chamberRemoteFailed')
  const pending = entries.map(entry => entry.moduleName === HOST_GRAPH_PACKAGE
    ? { ...entry, fiberPhase: 'loading' as const }
    : entry)
  assert.equal(chamberRemoteKey(pending, HOST_GRAPH_PACKAGE), 'chamberRemoteInjectedUnknown')
  const disabled = entries.map(entry => entry.moduleName === HOST_GRAPH_PACKAGE
    ? { ...entry, enabled: false, fiberPhase: 'active' as const }
    : entry)
  assert.equal(chamberRemoteKey(disabled, HOST_GRAPH_PACKAGE), 'chamberRemoteInjectedUnknown')
  // Absent → 未注入.
  assert.equal(chamberRemoteKey(entries, '@dsh-chamber/never-installed'), 'chamberRemoteNotInjected')
})

test('inventoryErrorText: the management REST carrier folds the same 503, phase included', () => {
  // /chamber/plugins and the installed list go through request(), which throws an
  // ApiError (status + body), not wire-error's class. Same proxy 503, same copy —
  // and a 503 with another code (resource_exhausted) is NOT a not-ready phase.
  const t = (key: string) => key
  const apiError = Object.assign(new Error('请求失败 503 /api/i/gateway-west/chamber/plugins（instance_unavailable）：the local dsh instance is not ready'), {
    status: 503,
    body: { code: 'instance_unavailable', error: 'the local dsh instance is not ready', details: { state: 'restart-exhausted' } },
  })
  assert.equal(inventoryErrorText(apiError, t), 'inventoryRestartExhausted')
  const stopped = Object.assign(new Error('请求失败 503'), {
    status: 503,
    body: { code: 'instance_unavailable', details: { state: 'stopped' } },
  })
  assert.equal(inventoryErrorText(stopped, t), 'restartNotRunning')
  const otherCode = Object.assign(new Error('请求失败 503 resource_exhausted'), {
    status: 503,
    body: { code: 'resource_exhausted' },
  })
  assert.equal(inventoryErrorText(otherCode, t), '请求失败 503 resource_exhausted')
})
