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
  type GatewayInstalledProjection,
} from '../../src/client/control-plane.ts'
import { gatewayReadFenceText, type GatewayReadFenceKey } from '../../src/client/managed-restart.ts'
import { en, zh } from '../../src/locales.ts'
import { FENCE_BODY, stubFetch, withPageOrigin, type FetchCall } from '../support/fixtures.ts'

/** A stub that consumes its answers in order and repeats the LAST one for any
 *  further call — the read fence's retry needs a 409 → 200 sequence, and the
 *  repeat makes the retry BUDGET observable (calls.length stays finite). */
function stubFetchSequence(answers: Array<{ status: number; body: unknown }>): { calls: FetchCall[]; restore(): void } {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const answer = answers[Math.min(calls.length, answers.length - 1)]!
    calls.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch
  return {
    calls,
    restore(): void { globalThis.fetch = original },
  }
}

const hostLogsBody = { port: 30801, lines: [
  { ts: 1753000000000, stream: 'stdout', line: 'gateway dsh boot line' },
  { ts: 1753000001000, stream: 'stderr', line: 'gateway dsh warn' },
], truncated: false }

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
      return apiError.status === 503 && apiError.body?.code === 'quarantined'
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
  ok: true, dependencies: { '@deepseek-ai/dsh-demo': '^1.0.0', '@dsh-chamber/picked': 'file:<hidden>' },
  bundles: ['@dsh-chamber/picked'], profileExists: true,
}

test('gatewayChamberSeedCache: GETs the seed cache through the instance proxy', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, {
    items: [
      { name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.0.0' },
      { name: '@dsh-chamber/dsh-chamber-seed-git-worktree', version: null },
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
    await assert.rejects(gatewayChamberSeedCache('gw-prod'), (err: unknown) => (err as { status?: number }).status === 503)
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
    assert.equal(absent.calls.length, 1, 'a mapped profile code is final — never retried')
  } finally {
    absent.restore()
  }
  const corrupt = stubFetch(500, { error: 'managed profile is corrupted', code: 'profile_corrupt' })
  try {
    assert.deepEqual(await gatewayInstalled('gw-prod'), { ok: false, code: 'profile_corrupt' })
    assert.equal(corrupt.calls.length, 1, 'a corrupt profile is final — never retried')
  } finally {
    corrupt.restore()
    restoreOrigin()
  }
})

test('gatewayInstalled: any other refusal (503 …) rethrows the ApiError, never an ok shape', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(503, { error: 'quarantined', code: 'quarantined' })
  try {
    await assert.rejects(gatewayInstalled('gw-prod'), (err: unknown) => (err as { status?: number }).status === 503)
    assert.equal(stub.calls.length, 1, 'only the fence 409 retries — a 503 stays a loud read failure')
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

/* ---- design 21 §6.2 读/写面共享栅栏 (2026-12 接线) ----------------------------
 * The gateway withholds `GET /chamber/plugins/installed` with 409 `runtime_busy`
 * while a plugin mutation holds the managed-profile write lease. The tests below pin
 * both halves: a transient fence still yields the real projection with NO error path,
 * and a persistent fence yields the typed busy arm whose copy comes from the
 * DEDICATED dictionary key — never a profile/read-error key. ---- */

/** The fence locale key + its projection (the dialog's call shape). */
const FENCE_KEY: GatewayReadFenceKey = 'gatewayReadFencedBusy'

/** The read fence's arm, narrowed for the field access below (node:assert's
 *  equal carries no asserts-signature, so the narrowing needs its own step). */
type FenceArm = Extract<GatewayInstalledProjection, { ok: false; code: 'runtime_busy' }>

function assertFenceArm(result: GatewayInstalledProjection): asserts result is FenceArm {
  assert.equal(result.ok, false, 'a fenced read is never an ok shape')
  assert.equal(result.code, 'runtime_busy')
}

test('gatewayInstalled: a fenced 409 then 200 lands the real projection, with no error path', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetchSequence([{ status: 409, body: FENCE_BODY }, { status: 200, body: installedOkBody }])
  try {
    const result = await gatewayInstalled('gw-prod')
    // Resolving (not rejecting) is exactly "no error prompt": the dialog's
    // .catch — the only writer of installedError — never runs, and the ok arm
    // renders the list.
    assert.deepEqual(result, installedOkBody)
    assert.equal('code' in result, false)
    assert.equal(stub.calls.length, 2, 'exactly one bounded re-read — never an open-ended poll')
    assert.deepEqual(stub.calls.map(call => call.url), [
      'http://127.0.0.1:17500/api/i/gateway-gw-prod/chamber/plugins/installed',
      'http://127.0.0.1:17500/api/i/gateway-gw-prod/chamber/plugins/installed',
    ])
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('gatewayInstalled: a persistent fence yields the busy arm + the DEDICATED key (never a read-error key)', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetchSequence([{ status: 409, body: FENCE_BODY }])
  try {
    const result = await gatewayInstalled('gw-prod')
    assert.deepEqual(result, { ok: false, code: 'runtime_busy', refusalCode: 'runtime_busy' })
    assert.equal(stub.calls.length, 2, 'the retry budget is bounded: no request storm behind the dialog')
    // The busy arm is neither a profile code nor an ok shape.
    assertFenceArm(result)

    // The copy is the fence KEY (asserted through the dictionary, not through a
    // hardcoded English string) with the server code interpolated…
    const text = gatewayReadFenceText(result.refusalCode, 409, FENCE_KEY, key => zh[key])
    assert.equal(text, zh.gatewayReadFencedBusy.replace('{code}', 'runtime_busy'))
    assert.match(text, /实例正在变更插件/u)
    // …and NOTHING else: not the profile banners, not the raw ApiError text a
    // read failure renders ("请求失败 409 /api/i/… （runtime_busy）：…").
    assert.notEqual(text, zh.profileAbsentBanner)
    assert.notEqual(text, zh.profileCorruptBanner)
    assert.equal(/profile_absent|profile_corrupt/u.test(text), false)
    assert.equal(/请求失败|HTTP/u.test(text), false)
    // zh + en stay in sync (en is Record<SettingsConnectionsKey,string>, so a
    // missing key already fails typecheck; this pins the {code} placeholder).
    assert.match(en.gatewayReadFencedBusy, /\{code\}/u)
    assert.notEqual(en.gatewayReadFencedBusy, zh.gatewayReadFencedBusy)
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('gatewayInstalled: a body-less fenced 409 still yields the busy arm (status stands in for the code)', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetchSequence([{ status: 409, body: {} }])
  try {
    const result = await gatewayInstalled('gw-prod')
    assert.deepEqual(result, { ok: false, code: 'runtime_busy', refusalCode: null })
    assertFenceArm(result)
    assert.equal(
      gatewayReadFenceText(result.refusalCode, 409, FENCE_KEY, key => zh[key]),
      zh.gatewayReadFencedBusy.replace('{code}', '409'),
      'a codeless refusal renders the status — never a blank {code}',
    )
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('gatewayInstalled: an aborted read stays single-shot (an unmounted dialog fires no retry)', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const controller = new AbortController()
  controller.abort()
  const stub = stubFetchSequence([{ status: 409, body: FENCE_BODY }])
  try {
    const result = await gatewayInstalled('gw-prod', { signal: controller.signal })
    assert.deepEqual(result, { ok: false, code: 'runtime_busy', refusalCode: 'runtime_busy' })
    assert.equal(stub.calls.length, 1, 'the retry loop is aborted with the read that asked for it')
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

const tasksBody = {
  ok: true, busy: false,
  tasks: [
    { id: 'op-1', ts: 1753000002000, kind: 'install', name: 'pkg-a', spec: 'pkg-a@^1.0.0', preImage: 'backups/op-1', initiator: 'my-desktop', status: 'ok', restarted: 'ok' },
    { id: 'op-2', ts: 1753000001000, kind: 'remove', name: 'pkg-b', preImage: null, initiator: 'another-desktop', status: 'failed', error: 'pnpm refused' },
  ],
  deferred: [{ id: 'intent-1', ts: 1753000003000, kind: 'install', name: 'pkg-c', spec: 'pkg-c@^2.0.0', initiator: 'my-desktop' }],
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
    await assert.rejects(gatewayTasks('gw-prod'), (err: unknown) => (err as { status?: number }).status === 503)
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

/** Install a `window.dshChamber.desktopSsh` stub for the duration of `run`. */
async function withDesktopSsh<T>(desktopSsh: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://127.0.0.1:17500' }, dshChamber: { desktopSsh } },
  })
  try { return await run() } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', previous)
  }
}

test('gatewayPluginApply: forwards the RAW registry id and the add/remove/deferRestart input verbatim', async () => {
  const seen: Array<{ id: string; input: unknown }> = []
  const desktopSshStub = {
    gateway_plugin_apply: async (id: string, input: unknown): Promise<unknown> => {
      seen.push({ id, input })
      return id === 'gw-prod'
        ? { ok: true, installed: [], removed: ['pkg-a'], restarted: true }
        : { ok: false, error: 'no active gateway registration' }
    },
  }
  await withDesktopSsh(desktopSshStub, async () => {
    const executed = await gatewayPluginApply('gw-prod', { add: [], remove: ['pkg-a'], deferRestart: false })
    assert.deepEqual(executed, { ok: true, installed: [], removed: ['pkg-a'], restarted: true })
    const refused = await gatewayPluginApply('gw-missing', { add: [], remove: ['pkg-a'] })
    assert.deepEqual(refused, { ok: false, error: 'no active gateway registration' })
    assert.deepEqual(seen, [
      { id: 'gw-prod', input: { add: [], remove: ['pkg-a'], deferRestart: false } },
      { id: 'gw-missing', input: { add: [], remove: ['pkg-a'] } },
    ])
  })
})

test('gatewayPluginSync: forwards the RAW registry id and passes the ok/error unions through', async () => {
  const seen: string[] = []
  const desktopSshStub = {
    gateway_plugin_sync: async (id: string): Promise<unknown> => {
      seen.push(id)
      return id === 'gw-prod'
        ? { ok: true, uploaded: true, skipped: false }
        : { ok: false, error: 'no active gateway registration' }
    },
  }
  await withDesktopSsh(desktopSshStub, async () => {
    const uploaded = await gatewayPluginSync('gw-prod')
    assert.deepEqual(uploaded, { ok: true, uploaded: true, skipped: false })
    const refused = await gatewayPluginSync('gw-missing')
    assert.deepEqual(refused, { ok: false, error: 'no active gateway registration' })
    assert.deepEqual(seen, ['gw-prod', 'gw-missing'])
  })
})

// ── writer-quiescence surface (2026-09-10, design 02 §3.4 / 04 §3.2) ───────

const writerBody = {
  quiescent: false, errors: ['a probe failed', 42],
  writers: [
    { name: '4242.json', status: 'kept', pid: 4242, reason: 'identity-unverified', takeOverAvailable: true },
    { name: 'garbage', status: 'nonsense', pid: 'x', reason: 7 },
  ],
}

test('cp.localWriters: normalizes the diagnosis and drops malformed rows', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, writerBody)
  try {
    const diagnosis = await cp.localWriters()
    assert.equal(stub.calls[0].url, 'http://127.0.0.1:17500/api/connections/local/writers')
    assert.equal(diagnosis?.quiescent, false)
    assert.deepEqual(diagnosis?.writers, [{
      name: '4242.json', status: 'kept', pid: 4242, reason: 'identity-unverified', takeOverAvailable: true,
    }])
    assert.deepEqual(diagnosis?.errors, ['a probe failed'])
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('cp.localWriters: a surface without the route answers null instead of throwing', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  for (const status of [501, 404]) {
    const stub = stubFetch(status, { error: 'not_implemented', code: 'not_implemented' })
    try {
      assert.equal(await cp.localWriters(), null)
    } finally {
      stub.restore()
    }
  }
  restoreOrigin()
})

test('cp.reclaimLocal: posts the takeover and returns the reclaimed pids', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, {
    reclaimed: [4242, 'x'],
    connection: { id: 'local', status: 'starting' },
  })
  try {
    const outcome = await cp.reclaimLocal()
    assert.equal(stub.calls[0].url, 'http://127.0.0.1:17500/api/connections/local/reclaim')
    assert.equal(stub.calls[0].init.method, 'POST')
    assert.deepEqual(outcome.reclaimed, [4242])
    assert.equal(outcome.connection.connectionId, 'local')
    assert.equal(outcome.connection.status, 'starting')
  } finally {
    stub.restore()
    restoreOrigin()
  }
})
