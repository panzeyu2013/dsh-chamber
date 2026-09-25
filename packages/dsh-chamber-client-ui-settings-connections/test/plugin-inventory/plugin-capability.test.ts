/**
 * Official Plugins page capability gate tests (design 05 §5 + design 21 §6.2
 * 注; C 分层 2026-09): the pure graph verdict, the target → proxy-source-id
 * mapping, and the probe's classification discipline (every unreadable path is
 * `unknown`, never a claim). Plain node:test — no dsh, no React.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PLUGIN_MANAGER_ROW_ID,
  capabilityFromGraph,
  officialPluginsPageSourceId,
  probeOfficialPluginsPage,
} from '../../src/client/plugin-capability.ts'

function serverEnvelope(result: unknown): unknown {
  return { type: 'server-response', rpcId: 'rpc-1', result }
}

interface FetchCall { url: string; init: RequestInit }

function stubFetch(status: number, body: string): { calls: FetchCall[]; impl: typeof fetch } {
  const calls: FetchCall[] = []
  const impl = ((input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    }))
  }) as unknown as typeof fetch
  return { calls, impl }
}

test('capabilityFromGraph: row present → available, readable-but-absent → unavailable', () => {
  assert.equal(capabilityFromGraph({
    entries: [
      { id: '@deepseek-ai/dsh-client-ui-chat', url: '/a.js', rev: 'r1' },
      { id: PLUGIN_MANAGER_ROW_ID, url: '/b.js', rev: 'r1' },
    ],
  }), 'available')
  assert.equal(capabilityFromGraph({
    entries: [{ id: '@deepseek-ai/dsh-client-ui-chat', url: '/a.js', rev: 'r1' }],
  }), 'unavailable')
  // A READABLE graph with no rows at all is still a readable graph.
  assert.equal(capabilityFromGraph({ entries: [] }), 'unavailable')
})

test('capabilityFromGraph: every malformed shape is unknown, never a claim', () => {
  assert.equal(capabilityFromGraph(undefined), 'unknown')
  assert.equal(capabilityFromGraph(null), 'unknown')
  assert.equal(capabilityFromGraph('entries'), 'unknown')
  assert.equal(capabilityFromGraph({}), 'unknown')
  assert.equal(capabilityFromGraph({ entries: {} }), 'unknown')
  assert.equal(capabilityFromGraph({ entries: [null] }), 'unknown')
  assert.equal(capabilityFromGraph({ entries: ['x'] }), 'unknown')
})

test('officialPluginsPageSourceId: the shell/proxy id per target kind', () => {
  assert.equal(officialPluginsPageSourceId({ kind: 'local' }), 'local')
  // An ssh-transported dsh instance is proxied as dsh-<id> (ssh-<id> is the
  // proxy's legacy spelling; the section builds the same <kind>-<id> id for its
  // gateway/http targets).
  assert.equal(officialPluginsPageSourceId({ kind: 'ssh', spec: { kind: 'dsh', id: 'a1' } }), 'dsh-a1')
  assert.equal(officialPluginsPageSourceId({ kind: 'ssh', spec: { kind: 'gateway', id: 'g1' } }), 'gateway-g1')
  assert.equal(officialPluginsPageSourceId({ kind: 'gateway', sourceId: 'gateway-x' }), 'gateway-x')
  assert.equal(officialPluginsPageSourceId({ kind: 'http', sourceId: 'dsh-y' }), 'dsh-y')
})

test('probeOfficialPluginsPage: a readable graph decides the verdict over the proxy', async () => {
  const withRow = stubFetch(200, JSON.stringify(serverEnvelope({
    ok: true,
    value: { entries: [{ id: PLUGIN_MANAGER_ROW_ID, url: '/pm.js', rev: 'r1' }] },
  })))
  assert.equal(await probeOfficialPluginsPage('dsh-a1', { fetchImpl: withRow.impl, origin: 'https://cp.example' }), 'available')
  assert.equal(withRow.calls[0]!.url, 'https://cp.example/api/i/dsh-a1/api/clientGraph/graph')
  assert.equal(withRow.calls[0]!.init.method, 'POST')

  const withoutRow = stubFetch(200, JSON.stringify(serverEnvelope({
    ok: true,
    value: { entries: [{ id: '@deepseek-ai/dsh-client-ui-chat', url: '/c.js', rev: 'r1' }] },
  })))
  assert.equal(await probeOfficialPluginsPage('local', { fetchImpl: withoutRow.impl, origin: 'https://cp.example' }), 'unavailable')
})

test('probeOfficialPluginsPage: unreadable paths are unknown (never a cannot-manage claim)', async () => {
  const notReady = stubFetch(503, JSON.stringify({ code: 'instance_unavailable' }))
  assert.equal(await probeOfficialPluginsPage('dsh-a1', { fetchImpl: notReady.impl, origin: 'https://cp.example' }), 'unknown')

  const notInjected = stubFetch(404, 'not found')
  assert.equal(await probeOfficialPluginsPage('dsh-a1', { fetchImpl: notInjected.impl, origin: 'https://cp.example' }), 'unknown')

  const refusingHost = stubFetch(200, JSON.stringify(serverEnvelope({
    ok: false,
    error: { code: 'unknown_method', message: 'method clientGraph/graph not found' },
  })))
  assert.equal(await probeOfficialPluginsPage('dsh-a1', { fetchImpl: refusingHost.impl, origin: 'https://cp.example' }), 'unknown')

  const notJson = stubFetch(200, '<html>nope</html>')
  assert.equal(await probeOfficialPluginsPage('dsh-a1', { fetchImpl: notJson.impl, origin: 'https://cp.example' }), 'unknown')

  const transportFailure = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch
  assert.equal(await probeOfficialPluginsPage('dsh-a1', { fetchImpl: transportFailure, origin: 'https://cp.example' }), 'unknown')
})

test('dialog wiring: the capability gate renders the unsupported note only on an absent row', () => {
  const source = readFileSync(new URL('../../src/client/PluginDialog.tsx', import.meta.url), 'utf8')
  assert.match(source, /officialPluginsPageSourceId\(target\)/, 'the dialog must derive the proxy source id from the target')
  assert.match(source, /probeOfficialPluginsPage\(officialPageSourceId\)/, 'the dialog must probe the instance graph')
  // The hint is conditional: available keeps the pointer at the official page,
  // unavailable shows the honest note, probing/unknown renders nothing (a failed
  // probe is not a claim).
  assert.match(source, /officialPage === 'available'/, 'the official-page hint must be gated on the verdict')
  assert.match(source, /officialPage === 'unavailable'/, 'the unsupported note must be gated on the verdict')
})