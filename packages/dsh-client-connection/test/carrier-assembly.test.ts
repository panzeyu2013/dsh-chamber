/**
 * Behavior gate for the ConnectionPlugin construction seam (design 05 §4/§6).
 * The production plugin supplies WebApiClient as the single HTTP + WebSocket
 * carrier factory and createWebConnectionRpc as the generic RPC factory; this
 * test pins that its explicit per-entry config reaches BOTH constructors.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assembleConnectionCarriers } from '../src/client/carrier-assembly.ts'

test('carrier assembly: explicit ConnectionPlugin basePath reaches HTTP/WS and generic RPC', () => {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as Record<string, unknown>).window = {
    // The explicit per-entry value must win over the legacy page-global fallback.
    __DSH_BASE_PATH__: '/api/i/ssh-wrong',
  }
  const httpAndWebSocketApi = { kind: 'web-api' }
  const genericRpc = { kind: 'rpc' }
  const apiOptions: unknown[] = []
  const rpcOptions: unknown[] = []
  try {
    const assembly = assembleConnectionCarriers(
      '/api/i/ssh-right',
      undefined,
      undefined,
      {
        createHttpAndWebSocketApi(options) {
          apiOptions.push(options)
          return httpAndWebSocketApi
        },
        createRpc(options) {
          rpcOptions.push(options)
          return genericRpc
        },
      },
    )

    assert.equal(assembly.basePath, '/api/i/ssh-right')
    assert.equal(assembly.api, httpAndWebSocketApi)
    assert.equal(assembly.rpc, genericRpc)
    assert.deepEqual(apiOptions, [{ basePath: '/api/i/ssh-right' }])
    assert.deepEqual(rpcOptions, [{ basePath: '/api/i/ssh-right' }])
  } finally {
    if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window
    else (globalThis as Record<string, unknown>).window = previousWindow
  }
})

test('carrier assembly: page transport replaces HTTP/WS but preserves basePath for generic RPC', () => {
  const transportApi = { kind: 'transport-api' }
  const transportFetch = () => Promise.resolve(new Response())
  let webApiCalls = 0
  const rpcOptions: unknown[] = []
  const assembly = assembleConnectionCarriers(
    '/api/i/local',
    undefined,
    {
      createApiClient: () => transportApi,
      fetch: transportFetch,
    },
    {
      createHttpAndWebSocketApi() {
        webApiCalls += 1
        return { kind: 'unexpected-web-api' }
      },
      createRpc(options) {
        rpcOptions.push(options)
        return { kind: 'rpc' }
      },
    },
  )

  assert.equal(assembly.api, transportApi)
  assert.equal(webApiCalls, 0)
  assert.deepEqual(rpcOptions, [{ basePath: '/api/i/local', doFetch: transportFetch }])
})

test('carrier assembly: fixture owns both halves and no web constructor runs', () => {
  const fixtureRpc = { kind: 'fixture-rpc' }
  const fixture = { kind: 'fixture-api', rpc: fixtureRpc }
  let factoryCalls = 0
  const assembly = assembleConnectionCarriers(
    '/api/i/local',
    fixture,
    undefined,
    {
      createHttpAndWebSocketApi() {
        factoryCalls += 1
        return { kind: 'unexpected-api' }
      },
      createRpc() {
        factoryCalls += 1
        return { kind: 'unexpected-rpc' }
      },
    },
  )

  assert.equal(assembly.api, fixture)
  assert.equal(assembly.rpc, fixtureRpc)
  assert.equal(factoryCalls, 0)
})
