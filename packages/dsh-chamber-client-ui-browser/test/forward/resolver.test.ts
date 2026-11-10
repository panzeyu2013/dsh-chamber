/**
 * ForwardFrameResolver — the carrier's ONLY behavior fork diff: mapping a logical
 * Browser target onto the native guest target (design 28 v3 §2.10/§3).
 *
 * Local / non-loopback targets resolve to the direct URL. An SSH source's remote
 * loopback target attaches the per-tab SSH forward lease
 * (`BrowserForwardController` + `forward-bridge.ts`) and answers a forward
 * recordRef — main loads the alias itself, the bar/history keep the logical URL,
 * and the external exit uses the composed alias URL. A refused attach yields
 * `undefined` (upstream failure bar). Leaving the target / disposing releases the
 * consumer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createForwardFrameResolver } from '../../src/client/browser/ForwardFrameResolver.ts'
import type { BrowserTarget } from '../../src/client/browser/url.ts'
import type { BrowserForwardBridge, ForwardRequestResult } from '../../src/shared/forward-bridge.ts'
import { FORWARD_CONSUMER_PATTERN } from '../../src/shared/forward-bridge.ts'
import { parseBrowserSource } from '../../src/shared/source.ts'

const FINGERPRINT = 'a'.repeat(64)
const DSH = parseBrowserSource('dsh-alpha', 'ssh')!
const LOCAL = parseBrowserSource('local', 'local')!

function target(url: string): BrowserTarget {
  return { kind: url.startsWith('https:') ? 'https' : 'http', url, title: new URL(url).hostname }
}

function boundRecord(port: number): ForwardRequestResult {
  return {
    ok: true,
    record: {
      id: 'fwd-0123456789abcdef', remotePort: port, localPort: 41000, scheme: 'http',
      aliasHost: '127.0.0.9', state: 'bound', stale: false,
    },
    frameUrl: 'http://127.0.0.9:41000/',
  }
}

/** Fake forward bridge that records every call. */
function fakeBridge(answer?: (port: number) => ForwardRequestResult) {
  const calls: { request: unknown[]; release: unknown[] } = { request: [], release: [] }
  const bridge: BrowserForwardBridge = {
    async request(input) { calls.request.push(input); return answer?.(input.port) ?? boundRecord(input.port) },
    async release(input) { calls.release.push(input); return { ok: true } },
    async list() { return { ok: true, records: [] } },
    async openInBrowser() { return { ok: true } },
  }
  return { bridge, calls }
}

test('local source never forwards: every target resolves direct', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: LOCAL, sourceFingerprint: 'local', bridge })
  assert.deepEqual(await resolver.resolve(target('http://127.0.0.1:3000/a?b=1')), { kind: 'direct', url: 'http://127.0.0.1:3000/a?b=1' })
  assert.deepEqual(await resolver.resolve(target('https://example.com/x')), { kind: 'direct', url: 'https://example.com/x' })
  assert.equal(calls.request.length, 0)
  await resolver.dispose()
})

test('ssh source: remote loopback attaches the lease and answers a forward recordRef', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  const ref = await resolver.resolve(target('http://127.0.0.1:8080/ui?tab=2'))
  assert.deepEqual(ref, {
    kind: 'forward',
    recordId: 'fwd-0123456789abcdef',
    path: '/ui?tab=2',
    externalUrl: 'http://127.0.0.9:41000/ui?tab=2',
  })
  assert.equal(calls.request.length, 1)
  const request = calls.request[0] as { port: number; scheme: string; path: string; consumer?: string; sourceId: string }
  assert.equal(request.port, 8080)
  assert.equal(request.scheme, 'http')
  assert.equal(request.path, '/ui?tab=2')
  assert.equal(request.sourceId, 'dsh-alpha')
  assert.match(request.consumer ?? '', FORWARD_CONSUMER_PATTERN)
  await resolver.dispose()
  assert.equal(calls.release.length, 1)
})

test('ssh source: localhost is the same remote loopback target', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  const ref = await resolver.resolve(target('https://localhost:9443/'))
  assert.equal(ref?.kind, 'forward')
  assert.equal((calls.request[0] as { port: number }).port, 9443)
  assert.equal((calls.request[0] as { scheme: string }).scheme, 'https')
  await resolver.dispose()
})

test('ssh source: a non-loopback host stays direct', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  assert.deepEqual(await resolver.resolve(target('https://dsh.example.com/app')), { kind: 'direct', url: 'https://dsh.example.com/app' })
  assert.equal(calls.request.length, 0)
  await resolver.dispose()
})

test('a refused attach yields undefined (upstream failure bar) and no recordRef', async () => {
  const { bridge } = fakeBridge(() => ({ ok: false, code: 'limit' }))
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  assert.equal(await resolver.resolve(target('http://127.0.0.1:5173/')), undefined)
  await resolver.dispose()
})

test('a page without the forward bridge leaves remote loopback unresolved', async () => {
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge: null })
  assert.equal(await resolver.resolve(target('http://127.0.0.1:5173/')), undefined)
  await resolver.dispose()
})

test('leaving a forwarded target releases that consumer before the direct load', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  assert.equal((await resolver.resolve(target('http://127.0.0.1:8080/')))?.kind, 'forward')
  assert.deepEqual(await resolver.resolve(target('https://example.com/')), { kind: 'direct', url: 'https://example.com/' })
  assert.equal(calls.release.length, 1)
  await resolver.dispose()
  assert.equal(calls.release.length, 1)
})
