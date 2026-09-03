/**
 * control-plane.ts REST client tests (plain node:test, no dsh, no React):
 * the gateway host-logs endpoint rides the per-instance proxy with the same
 * control-plane host-logs shape the local card parses (design 17 §9.3).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cp,
  gatewayChamberSeedCache,
  gatewayInstalled,
  gatewayPluginApply,
  gatewayPluginSync,
  gatewayTasks,
} from '../src/client/control-plane.ts'

/** Define the page origin the shared client reads (controlPlaneUrl prefers
 *  window.location.origin; the browser shell is served by the control plane). */
function withPageOrigin(origin: string): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin } },
  })
  return () => {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', previous)
  }
}

interface FetchCall { url: string; init: RequestInit }

function stubFetch(status: number, body: unknown): { calls: FetchCall[]; restore(): void } {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch
  return {
    calls,
    restore(): void { globalThis.fetch = original },
  }
}

const hostLogsBody = {
  port: 30801,
  lines: [
    { ts: 1753000000000, stream: 'stdout', line: 'gateway dsh boot line' },
    { ts: 1753000001000, stream: 'stderr', line: 'gateway dsh warn' },
  ],
  truncated: false,
}

test('cp.gatewayHostLogs: targets the instance proxy with limit/offset and parses the local-compatible shape', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, hostLogsBody)
  try {
    const result = await cp.gatewayHostLogs('gw-prod', 200, 0)
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0]!.url, 'http://127.0.0.1:17500/api/i/gateway-gw-prod/api/host/logs?limit=200&offset=0')
    assert.deepEqual(result, hostLogsBody)
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('cp.gatewayHostLogs: no params → bare endpoint (defaults live server-side)', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, hostLogsBody)
  try {
    await cp.gatewayHostLogs('gw-prod')
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0]!.url, 'http://127.0.0.1:17500/api/i/gateway-gw-prod/api/host/logs')
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('cp.gatewayHostLogs: limit-only and offset-only query forms', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, hostLogsBody)
  try {
    await cp.gatewayHostLogs('gw-prod', 100)
    assert.equal(stub.calls[0]!.url, 'http://127.0.0.1:17500/api/i/gateway-gw-prod/api/host/logs?limit=100')
    await cp.gatewayHostLogs('gw-prod', undefined, 40)
    assert.equal(stub.calls[1]!.url, 'http://127.0.0.1:17500/api/i/gateway-gw-prod/api/host/logs?offset=40')
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('cp.gatewayHostLogs: a gateway refusal surfaces loud as an ApiError with status', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(503, { error: 'quarantined', code: 'quarantined' })
  try {
    await assert.rejects(cp.gatewayHostLogs('gw-prod', 200, 0), (err: unknown) => {
      const apiError = err as { status?: number; body?: { code?: string } | null }
      assert.equal(apiError.status, 503)
      assert.equal(apiError.body?.code, 'quarantined')
      return true
    })
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

/* ---- Gateway A0 read side (design 21 §6.2, plan Phase 3): the seed-cache
 * projection and the readManifest (installed) wrapper over the per-instance
 * proxy, plus the gateway_plugin_sync IPC wrapper (design 21 §6.5). ---- */

const installedOkBody = {
  ok: true,
  dependencies: { '@deepseek-ai/dsh-demo': '^1.0.0', '@dsh-chamber/picked': 'file:<hidden>' },
  bundles: ['@dsh-chamber/picked'],
  profileExists: true,
}

test('gatewayChamberSeedCache: GETs the seed cache through the instance proxy', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, {
    items: [
      { name: '@dsh-chamber/dsh-host-client-graph', version: '1.0.0' },
      { name: '@dsh-chamber/dsh-host-git-worktree', version: null },
    ],
  })
  try {
    const result = await gatewayChamberSeedCache('gw-prod')
    assert.equal(stub.calls.length, 1)
    // The shared request() follows this package's GET convention (no explicit
    // method option — init.method stays undefined, the browser defaults to
    // GET), so only the URL is asserted, matching the gatewayHostLogs tests.
    assert.equal(stub.calls[0]!.url, 'http://127.0.0.1:17500/api/i/gateway-gw-prod/chamber/plugins')
    assert.deepEqual(result.items.map(item => item.version), ['1.0.0', null])
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('gatewayChamberSeedCache: a non-2xx answer throws the shared ApiError, never a silent list', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(503, { error: 'quarantined', code: 'quarantined' })
  try {
    await assert.rejects(gatewayChamberSeedCache('gw-prod'), (err: unknown) => {
      assert.equal((err as { status?: number }).status, 503)
      return true
    })
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('gatewayInstalled: the 200 readManifest projection passes through', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, installedOkBody)
  try {
    const result = await gatewayInstalled('gw-prod')
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0]!.url, 'http://127.0.0.1:17500/api/i/gateway-gw-prod/chamber/plugins/installed')
    assert.deepEqual(result, installedOkBody)
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('gatewayInstalled: 404 profile_absent and 500 profile_corrupt map to codes', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const absent = stubFetch(404, { error: 'managed profile is not initialized', code: 'profile_absent' })
  try {
    assert.deepEqual(await gatewayInstalled('gw-prod'), { ok: false, code: 'profile_absent' })
  } finally {
    absent.restore()
  }
  const corrupt = stubFetch(500, { error: 'managed profile is corrupted', code: 'profile_corrupt' })
  try {
    assert.deepEqual(await gatewayInstalled('gw-prod'), { ok: false, code: 'profile_corrupt' })
  } finally {
    corrupt.restore()
    restoreOrigin()
  }
})

test('gatewayInstalled: any other refusal (503 …) rethrows the ApiError, never an ok shape', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(503, { error: 'quarantined', code: 'quarantined' })
  try {
    await assert.rejects(gatewayInstalled('gw-prod'), (err: unknown) => {
      assert.equal((err as { status?: number }).status, 503)
      return true
    })
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

const tasksBody = {
  ok: true,
  tasks: [
    { id: 'op-1', ts: 1753000002000, kind: 'install', name: 'pkg-a', spec: 'pkg-a@^1.0.0', preImage: 'backups/op-1', initiator: 'my-desktop', status: 'ok', restarted: 'ok' },
    { id: 'op-2', ts: 1753000001000, kind: 'remove', name: 'pkg-b', preImage: null, initiator: 'another-desktop', status: 'failed', error: 'pnpm refused' },
  ],
  deferred: [
    { id: 'intent-1', ts: 1753000003000, kind: 'install', name: 'pkg-c', spec: 'pkg-c@^2.0.0', initiator: 'my-desktop' },
  ],
  busy: false,
}

test('gatewayTasks: GETs the task projection (journal + deferred + busy) through the instance proxy', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, tasksBody)
  try {
    const result = await gatewayTasks('gw-prod')
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0]!.url, 'http://127.0.0.1:17500/api/i/gateway-gw-prod/chamber/plugins/tasks')
    assert.deepEqual(result, tasksBody)
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('gatewayTasks: a non-2xx refusal throws the shared ApiError, never a silent projection', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(503, { error: 'quarantined', code: 'quarantined' })
  try {
    await assert.rejects(gatewayTasks('gw-prod'), (err: unknown) => {
      assert.equal((err as { status?: number }).status, 503)
      return true
    })
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('gatewayPluginApply: forwards the RAW registry id and the add/remove/deferRestart input verbatim', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const seen: Array<{ id: string; input: unknown }> = []
  const desktopSshStub = {
    gateway_plugin_apply: async (id: string, input: unknown): Promise<unknown> => {
      seen.push({ id, input })
      return id === 'gw-prod'
        ? { ok: true, installed: [], removed: ['pkg-a'], restarted: true }
        : { ok: false, error: 'no active gateway registration' }
    },
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://127.0.0.1:17500' }, dshChamber: { desktopSsh: desktopSshStub } },
  })
  try {
    const executed = await gatewayPluginApply('gw-prod', { add: [], remove: ['pkg-a'], deferRestart: false })
    assert.deepEqual(executed, { ok: true, installed: [], removed: ['pkg-a'], restarted: true })
    const refused = await gatewayPluginApply('gw-missing', { add: [], remove: ['pkg-a'] })
    assert.deepEqual(refused, { ok: false, error: 'no active gateway registration' })
    assert.deepEqual(seen, [
      { id: 'gw-prod', input: { add: [], remove: ['pkg-a'], deferRestart: false } },
      { id: 'gw-missing', input: { add: [], remove: ['pkg-a'] } },
    ])
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', previous)
  }
})

test('gatewayPluginSync: forwards the RAW registry id and passes the ok/error unions through', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const seen: string[] = []
  const desktopSshStub = {
    gateway_plugin_sync: async (id: string): Promise<unknown> => {
      seen.push(id)
      return id === 'gw-prod'
        ? { ok: true, uploaded: true, skipped: false }
        : { ok: false, error: 'no active gateway registration' }
    },
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://127.0.0.1:17500' }, dshChamber: { desktopSsh: desktopSshStub } },
  })
  try {
    const uploaded = await gatewayPluginSync('gw-prod')
    assert.deepEqual(uploaded, { ok: true, uploaded: true, skipped: false })
    const refused = await gatewayPluginSync('gw-missing')
    assert.deepEqual(refused, { ok: false, error: 'no active gateway registration' })
    assert.deepEqual(seen, ['gw-prod', 'gw-missing'])
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', previous)
  }
})
