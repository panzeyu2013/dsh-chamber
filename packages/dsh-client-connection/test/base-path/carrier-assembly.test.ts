/**
 * Behavior gate for the ConnectionPlugin construction seam (design 05 §4/§6).
 * The production plugin supplies createWebConnectionRpc as the generic RPC
 * factory; this test pins that its explicit per-entry config reaches the
 * constructor (and that a page-owned transport's fetch/stream hooks ride
 * along). The assembly owns the generic RPC carrier only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assembleConnectionCarriers } from '../../src/client/carrier-assembly.ts'
import { withWindow } from '../support/global-window.ts'

test('carrier assembly: explicit ConnectionPlugin basePath reaches the generic RPC factory', () => {
  // The explicit per-entry value is the only source; a page global is ignored.
  withWindow({ __DSH_BASE_PATH__: '/api/i/ssh-wrong' }, () => {
    const genericRpc = { kind: 'rpc' }
    const rpcOptions: unknown[] = []
    const assembly = assembleConnectionCarriers('/api/i/ssh-right', undefined, {
      createRpc(options) {
        rpcOptions.push(options)
        return genericRpc
      },
    })

    assert.equal(assembly.basePath, '/api/i/ssh-right')
    assert.equal(assembly.rpc, genericRpc)
    assert.deepEqual(rpcOptions, [{ basePath: '/api/i/ssh-right' }])
  })
})

test('carrier assembly: page transport preserves basePath and fans fetch/openStream into the RPC factory', () => {
  const transportFetch = () => Promise.resolve(new Response())
  const openStream = () => async function* stream() { yield undefined }()
  const rpcOptions: unknown[] = []
  const assembly = assembleConnectionCarriers('/api/i/local', { fetch: transportFetch, openStream }, {
    createRpc(options) {
      rpcOptions.push(options)
      return { kind: 'rpc' }
    },
  })

  assert.equal(assembly.basePath, '/api/i/local')
  assert.deepEqual(rpcOptions, [{ basePath: '/api/i/local', doFetch: transportFetch, openStream }])
})

test('carrier assembly: a transport without hooks still installs the basePath carrier', () => {
  // rc.2 makes ClientTransportHooks.fetch optional; an empty transport must not
  // fabricate a doFetch key (the factory then falls back to the page fetch).
  const rpcOptions: unknown[] = []
  const assembly = assembleConnectionCarriers('/api/i/local', {}, {
    createRpc(options) {
      rpcOptions.push(options)
      return { kind: 'rpc' }
    },
  })

  assert.equal(assembly.basePath, '/api/i/local')
  assert.deepEqual(rpcOptions, [{ basePath: '/api/i/local' }])
})

test('carrier assembly: a page transport without a stream opener passes only the fetch hook', () => {
  const transportFetch = () => Promise.resolve(new Response())
  const rpcOptions: unknown[] = []
  const assembly = assembleConnectionCarriers('/api/i/local', { fetch: transportFetch }, {
    createRpc(options) {
      rpcOptions.push(options)
      return { kind: 'rpc' }
    },
  })

  assert.equal(assembly.basePath, '/api/i/local')
  assert.deepEqual(rpcOptions, [{ basePath: '/api/i/local', doFetch: transportFetch }])
})
