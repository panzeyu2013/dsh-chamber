/**
 * Behavior gate for the ConnectionPlugin construction seam (design 05 §4/§6).
 * The production plugin supplies createWebConnectionRpc as the generic RPC
 * factory; this test pins that its explicit per-entry config reaches the
 * constructor (and that a page-owned transport's fetch/stream hooks ride
 * along). Rebased for upstream v0.1.2: the HTTP/WS API-carrier half no longer
 * exists — the assembly owns the generic RPC carrier only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assembleConnectionCarriers } from '../src/client/carrier-assembly.ts'

test('carrier assembly: explicit ConnectionPlugin basePath reaches the generic RPC factory', () => {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as Record<string, unknown>).window = {
    // The explicit per-entry value must win over the legacy page-global fallback.
    __DSH_BASE_PATH__: '/api/i/ssh-wrong',
  }
  const genericRpc = { kind: 'rpc' }
  const rpcOptions: unknown[] = []
  try {
    const assembly = assembleConnectionCarriers(
      '/api/i/ssh-right',
      undefined,
      undefined,
      {
        createRpc(options) {
          rpcOptions.push(options)
          return genericRpc
        },
      },
    )

    assert.equal(assembly.basePath, '/api/i/ssh-right')
    assert.equal(assembly.rpc, genericRpc)
    assert.deepEqual(rpcOptions, [{ basePath: '/api/i/ssh-right' }])
  } finally {
    if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window
    else (globalThis as Record<string, unknown>).window = previousWindow
  }
})

test('carrier assembly: page transport preserves basePath and fans fetch/openStream into the RPC factory', () => {
  const transportFetch = () => Promise.resolve(new Response())
  const openStream = () => async function* stream() { yield undefined }()
  const rpcOptions: unknown[] = []
  const assembly = assembleConnectionCarriers(
    '/api/i/local',
    undefined,
    {
      fetch: transportFetch,
      openStream,
    },
    {
      createRpc(options) {
        rpcOptions.push(options)
        return { kind: 'rpc' }
      },
    },
  )

  assert.equal(assembly.basePath, '/api/i/local')
  assert.deepEqual(rpcOptions, [{ basePath: '/api/i/local', doFetch: transportFetch, openStream }])
})

test('carrier assembly: a page transport without a stream opener passes only the fetch hook', () => {
  const transportFetch = () => Promise.resolve(new Response())
  const rpcOptions: unknown[] = []
  const assembly = assembleConnectionCarriers(
    '/api/i/local',
    undefined,
    { fetch: transportFetch },
    {
      createRpc(options) {
        rpcOptions.push(options)
        return { kind: 'rpc' }
      },
    },
  )

  assert.equal(assembly.basePath, '/api/i/local')
  assert.deepEqual(rpcOptions, [{ basePath: '/api/i/local', doFetch: transportFetch }])
})

test('carrier assembly: fixture owns the RPC half and no web constructor runs', () => {
  const fixtureRpc = { kind: 'fixture-rpc' }
  let factoryCalls = 0
  const assembly = assembleConnectionCarriers(
    '/api/i/local',
    fixtureRpc,
    undefined,
    {
      createRpc() {
        factoryCalls += 1
        return { kind: 'unexpected-rpc' }
      },
    },
  )

  assert.equal(assembly.basePath, '/api/i/local')
  assert.equal(assembly.rpc, fixtureRpc)
  assert.equal(factoryCalls, 0)
})
