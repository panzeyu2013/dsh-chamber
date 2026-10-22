/**
 * The per-connection keep-alive pool (design 27 §3.3) over REAL Node sockets.
 *
 * Fake httpRequest seams never touch an Agent, so the pool's two load-bearing
 * properties — "one connection is reused inside an incarnation" and "a replaced
 * transport starts from a fresh pool" — had no test at all. The socket count on a
 * real upstream server is the only honest observation.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { get } from 'node:http'
import { createInstanceProxy } from '../../src/instance-proxy.ts'
import { quietLogger, sleep } from '../support/proxy-fakes.ts'

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
}

function fetchThrough(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, agent: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
  })
}

test('one connection is reused inside an incarnation and a replacement starts fresh', async () => {
  let connections = 0
  const upstream = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
  upstream.on('connection', () => { connections += 1 })
  const upstreamPort = await listen(upstream)
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => upstreamPort,
  })
  const proxyServer = createServer((req, res) => { void proxy.handleHttp(req as never, res as never) })
  const proxyPort = await listen(proxyServer)
  try {
    proxy.registerTransport('dsh:pool', `http://127.0.0.1:${String(upstreamPort)}`)
    assert.equal((await fetchThrough(proxyPort, '/api/i/dsh-pool/api/x')).status, 200)
    assert.equal((await fetchThrough(proxyPort, '/api/i/dsh-pool/api/y')).status, 200)
    assert.equal(connections, 1, 'the second request reuses the connection this incarnation pooled')

    // Replacing the transport revokes its traffic; the pooled socket belongs to that
    // incarnation and must go with it (a reused socket could be half-open).
    proxy.registerTransport('dsh:pool', `http://127.0.0.1:${String(upstreamPort)}`)
    assert.equal((await fetchThrough(proxyPort, '/api/i/dsh-pool/api/z')).status, 200)
    await sleep(20)
    assert.equal(connections, 2, 'the replacement dials a fresh connection instead of reusing the old pool')

    // Unregistering destroys the pool: the same id, re-registered, dials again.
    proxy.unregisterTransport('dsh:pool')
    assert.equal((await fetchThrough(proxyPort, '/api/i/dsh-pool/api/w')).status, 503)
    proxy.registerTransport('dsh:pool', `http://127.0.0.1:${String(upstreamPort)}`)
    assert.equal((await fetchThrough(proxyPort, '/api/i/dsh-pool/api/v')).status, 200)
    await sleep(20)
    assert.equal(connections, 3, 'an unregistered transport left no pooled socket behind')
  } finally {
    proxy.closeAllStreams()
    await close(proxyServer)
    await close(upstream)
  }
})

test('two connections never share a pool: each incarnation keeps its own socket', async () => {
  let connections = 0
  const upstream = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
  upstream.on('connection', () => { connections += 1 })
  const upstreamPort = await listen(upstream)
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => upstreamPort,
  })
  const proxyServer = createServer((req, res) => { void proxy.handleHttp(req as never, res as never) })
  const proxyPort = await listen(proxyServer)
  try {
    proxy.registerTransport('dsh:one', `http://127.0.0.1:${String(upstreamPort)}`)
    proxy.registerTransport('dsh:two', `http://127.0.0.1:${String(upstreamPort)}`)
    assert.equal((await fetchThrough(proxyPort, '/api/i/dsh-one/api/x')).status, 200)
    assert.equal((await fetchThrough(proxyPort, '/api/i/dsh-two/api/x')).status, 200)
    await sleep(20)
    assert.equal(connections, 2, 'each connection dials its own socket even against the same upstream')
    // Reuse stays INSIDE the incarnation.
    assert.equal((await fetchThrough(proxyPort, '/api/i/dsh-one/api/y')).status, 200)
    await sleep(20)
    assert.equal(connections, 2, 'a second request on the first connection reuses ITS socket')
  } finally {
    proxy.closeAllStreams()
    await close(proxyServer)
    await close(upstream)
  }
})

