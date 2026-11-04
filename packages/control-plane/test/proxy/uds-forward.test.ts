/**
 * POSIX ssh-tunnel UDS forwarding (P2-1) over REAL Unix sockets:
 * - registration carries socketPath and the proxy dials the socket while the
 *   Host/path semantics stay those of the remote loopback authority;
 * - HTTP and WebSocket upgrade both ride it, including the keep-alive pool
 *   (Node v24 Agent.getName includes socketPath, so two listeners can never
 *   cross on the same agent);
 * - the probe carrier (postClientRequest) has the same capability, which is what
 *   lets verifyUp prove identity through a UDS tunnel.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { get, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createInstanceProxy } from '../../src/instance-proxy.ts'
import { createProxyAgentPair } from '../../src/proxy-forward.ts'
import { postClientRequest } from '../../src/rpc-envelope.ts'
import { quietLogger } from '../support/proxy-fakes.ts'

function tempSocket(t: { after(fn: () => void): void }, name = 'up.sock'): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cp-uds-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, path: join(dir, name) }
}

async function listenUds(server: Server, socketPath: string): Promise<void> {
  server.listen(socketPath)
  await once(server, 'listening')
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
}

function listenTcp(server: Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
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

test('HTTP forward dials the registered socketPath while Host/path keep their authority semantics', async (t) => {
  const { path: socketPath } = tempSocket(t)
  const seen: Array<{ url?: string; host?: string }> = []
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  })
  await listenUds(upstream, socketPath)
  t.after(() => closeServer(upstream))

  const proxy = createInstanceProxy({ logger: quietLogger, getLocalState: () => 'idle', getLocalDshPort: () => null })
  t.after(() => proxy.closeAllStreams())
  proxy.registerTransport('dsh:uds', 'http://127.0.0.1:2222', undefined, { transport: 'ssh', socketPath })
  const proxyServer = createServer((req, res) => { void proxy.handleHttp(req as never, res as never) })
  const proxyPort = await listenTcp(proxyServer)
  t.after(() => closeServer(proxyServer))

  const response = await fetchThrough(proxyPort, '/api/i/dsh-uds/api/session/list?cursor=1')
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.url, '/api/session/list?cursor=1')
  assert.equal(seen[0]!.host, '127.0.0.1:2222', 'the Host header is the remote loopback authority, not a local port')
})

test('registerTransport refuses a relative socket path and a direct-http socket', () => {
  const proxy = createInstanceProxy({ logger: quietLogger, getLocalState: () => 'idle', getLocalDshPort: () => null })
  assert.throws(
    () => proxy.registerTransport('dsh:x', 'http://127.0.0.1:2222', undefined, { transport: 'ssh', socketPath: 'relative.sock' }),
    /absolute filesystem path/u,
  )
  assert.throws(
    () => proxy.registerTransport('dsh:y', 'http://127.0.0.1:2222', undefined, { transport: 'http', socketPath: '/tmp/x.sock' }),
    /direct http transport cannot use a Unix socket/u,
  )
})

test('WS upgrade forwards through the socketPath (real 101 handshake + splice)', async (t) => {
  const { path: socketPath } = tempSocket(t, 'ws.sock')
  const upstream = createServer()
  await listenUds(upstream, socketPath)
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', socket => {
    socket.on('message', data => socket.send(`echo:${data.toString()}`))
  })
  t.after(() => {
    // Terminate first: wss.close() waits for every accepted upgrade socket.
    for (const socket of wss.clients) socket.terminate()
    wss.close()
    return closeServer(upstream)
  })

  const proxy = createInstanceProxy({ logger: quietLogger, getLocalState: () => 'idle', getLocalDshPort: () => null })
  t.after(() => proxy.closeAllStreams())
  proxy.registerTransport('dsh:uds-ws', 'http://127.0.0.1:2222', undefined, { transport: 'ssh', socketPath })
  const proxyServer = createServer((_req, res) => { res.writeHead(404); res.end() })
  proxyServer.on('upgrade', (req, socket, head) => { void proxy.handleUpgrade(req as never, socket as never, head) })
  const proxyPort = await listenTcp(proxyServer)
  t.after(() => closeServer(proxyServer))

  const client = new WebSocket(`ws://127.0.0.1:${String(proxyPort)}/api/i/dsh-uds-ws/api/remote.mux`)
  await once(client, 'open')
  client.send('hello')
  const [message] = await once(client, 'message') as [Buffer]
  assert.equal(message.toString(), 'echo:hello')
  client.terminate()
})

test('the keep-alive agent cannot cross two socketPaths (Agent.getName includes socketPath)', async (t) => {
  const a = tempSocket(t, 'a.sock')
  const b = tempSocket(t, 'b.sock')
  const make = (tag: string) => {
    const server = createServer((_req, res) => { res.end(tag) })
    return server
  }
  const serverA = make('A')
  const serverB = make('B')
  await listenUds(serverA, a.path)
  await listenUds(serverB, b.path)
  t.after(() => Promise.all([closeServer(serverA), closeServer(serverB)]))

  const pair = createProxyAgentPair()
  t.after(() => pair.destroy())
  const call = (socketPath: string): Promise<string> => new Promise((resolve, reject) => {
    const req = httpRequest(new URL('http://127.0.0.1:2222/ping'), { agent: pair.http, socketPath }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(await call(a.path), 'A')
  assert.equal(await call(b.path), 'B')
  assert.equal(await call(a.path), 'A', 'a reused socket must still belong to listener A')
  const freeSockets = pair.http.freeSockets as Record<string, unknown[]>
  const keys = Object.keys(freeSockets)
  assert.ok(keys.some(key => key.includes(a.path)), 'pool entry keyed by socket A')
  assert.ok(keys.some(key => key.includes(b.path)), 'pool entry keyed by socket B')
})

test('postClientRequest (the verifyUp carrier) can probe a UDS endpoint', async (t) => {
  const { path: socketPath } = tempSocket(t, 'rpc.sock')
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: true } }))
  })
  await listenUds(upstream, socketPath)
  t.after(() => closeServer(upstream))
  const outcome = await postClientRequest({
    url: 'http://127.0.0.1:2222/api/session/canOpenWorkspacePath',
    envelope: { type: 'client-request', rpcId: 'r1', method: 'session/canOpenWorkspacePath', payload: { args: [] } },
    timeoutMs: 1_000,
    maxBodyBytes: 4_096,
    socketPath,
  })
  assert.equal(outcome.status, 200)
  assert.deepEqual(outcome.body, { type: 'server-response', rpcId: 'r1', result: { ok: true, value: true } })
})
