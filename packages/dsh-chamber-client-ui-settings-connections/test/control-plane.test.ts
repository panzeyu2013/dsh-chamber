/**
 * control-plane.ts REST client tests (plain node:test, no dsh, no React):
 * the gateway host-logs endpoint rides the per-instance proxy with the same
 * control-plane host-logs shape the local card parses (design 17 §9.3).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp } from '../src/client/control-plane.ts'

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
