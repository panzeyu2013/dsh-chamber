/**
 * P2-4 server-level connection cap (plan §4.12): Node's `maxConnections` is a
 * silent net hard stop, so the app enforces a 192 soft cap in the `connection`
 * event and answers the 193rd concurrent connection with a raw HTTP 503 +
 * close. The exact 192 → 193 counter edge is driven with synthetic sockets (a
 * real 192-connection fixture would spend ~384 descriptors in one process,
 * above many dev machines' 256 fd soft limit); the real TCP path — refusal,
 * pipelined-request quarantine, slot release and the control-plane wiring — is
 * exercised with a small cap on a REAL http server.
 *
 * Run with `node packages/control-plane/test/proxy/max-connections.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import type { Server } from 'node:http'
import {
  applyHttpServerLimits,
  createLimitedServer,
  HTTP_SERVER_LIMITS,
  installConnectionSoftCap,
} from '../../src/http-limits.ts'
import { hostGraphPlane, tempDir } from '../support/utils.ts'

type NetSocket = ReturnType<typeof netConnect>

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') reject(new Error('no port'))
      else resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  server.closeAllConnections?.()
  return new Promise(resolve => server.close(() => resolve()))
}

function connect(port: number): Promise<NetSocket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

/** Resolve with everything the socket received once the server closes it. */
function readToClose(socket: NetSocket, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    const timer = setTimeout(() => reject(new Error('server neither answered nor closed the refused socket')), timeoutMs)
    socket.on('data', chunk => { data += chunk.toString('utf8') })
    socket.once('close', () => {
      clearTimeout(timer)
      resolve(data)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await sleep(10)
  }
}

test('defaults: the 192 soft cap sits strictly below the 256 net hard cap', () => {
  assert.equal(HTTP_SERVER_LIMITS.connectionSoftCap, 192)
  assert.equal(HTTP_SERVER_LIMITS.maxConnections, 256)
  assert.ok(HTTP_SERVER_LIMITS.connectionSoftCap < HTTP_SERVER_LIMITS.maxConnections)
})

/** A synthetic accepted socket for the exact-192 counter unit: the real TCP
 *  path is covered below at a small cap, because 192 real sockets would cost
 *  ~384 file descriptors in one process (above the 256 soft fd limit of many
 *  dev machines) for no additional logic coverage. */
function fakeConnectionSocket(): EventEmitter & { written: string; ended: boolean; write(chunk: unknown): boolean; end(): void } {
  const socket = new EventEmitter() as EventEmitter & { written: string; ended: boolean; write(chunk: unknown): boolean; end(): void }
  socket.written = ''
  socket.ended = false
  socket.write = (chunk: unknown) => {
    socket.written += String(chunk)
    return true
  }
  socket.end = () => { socket.ended = true }
  return socket
}

test('the 192 soft cap: the first 192 connections are accepted and the 193rd gets a raw 503', () => {
  const server = new EventEmitter()
  const dispose = installConnectionSoftCap(server as unknown as Server, HTTP_SERVER_LIMITS.connectionSoftCap)
  const accepted = Array.from({ length: HTTP_SERVER_LIMITS.connectionSoftCap }, () => fakeConnectionSocket())
  try {
    for (const socket of accepted) server.emit('connection', socket)
    for (const socket of accepted) assert.equal(socket.written, '', 'the accepted set must receive no capacity refusal')

    const refused = fakeConnectionSocket()
    server.emit('connection', refused)
    assert.match(refused.written, /^HTTP\/1\.1 503 Service Unavailable/)
    assert.match(refused.written, /Connection: close/)
    assert.match(refused.written, /"code":"resource_exhausted"/)
    assert.match(refused.written, /"kind":"connection"/)
    assert.equal(refused.ended, true)
    // The refused socket is counted while it closes (same as a real FIN).
    refused.emit('close')

    // Slot accounting: closing one accepted connection admits the next one.
    accepted[0].emit('close')
    const afterRelease = fakeConnectionSocket()
    server.emit('connection', afterRelease)
    assert.equal(afterRelease.written, '')
  } finally {
    dispose()
  }
})

test('a request pipelined on a refused connection never reaches the app handler', async () => {
  let handled = 0
  const server = createLimitedServer((_req, res) => {
    handled += 1
    res.writeHead(200)
    res.end('ok')
  })
  applyHttpServerLimits(server)
  installConnectionSoftCap(server, 1)
  const port = await listen(server)
  const accepted = await connect(port)
  let refused: NetSocket | null = null
  try {
    refused = await connect(port)
    // Send the request immediately: the server's accept handler must both answer
    // 503 and keep this parsed request out of the app handler (a mutation must
    // never apply on a connection the client was told to retry).
    refused.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    const response = await readToClose(refused)
    assert.match(response, /503 Service Unavailable/)
    assert.equal(handled, 0, 'a refused connection must not dispatch its pipelined request')
  } finally {
    accepted.destroy()
    refused?.destroy()
    await close(server)
  }
})

test('the control plane wires the soft cap onto its own listening server', async t => {
  const dir = tempDir(t, 'dsh-cp-softcap-')
  const plane = hostGraphPlane(dir, { httpLimits: { connectionSoftCap: 2 } })
  const clients: NetSocket[] = []
  try {
    await plane.start()
    const port = plane.port
    assert.ok(typeof port === 'number' && port > 0)
    clients.push(await connect(port))
    clients.push(await connect(port))
    // The server-side 'connection' callbacks run in this same process, but the
    // client-connect callback is not ordered against them; give the accept loop
    // one turn before asking for the third verdict.
    await sleep(50)
    const refused = await connect(port)
    const response = await readToClose(refused)
    assert.match(response, /^HTTP\/1\.1 503 Service Unavailable/)
    assert.match(response, /"kind":"connection"/)
  } finally {
    for (const client of clients) client.destroy()
    await plane.stop()
  }
})

test('closing an accepted connection frees its slot for the next connection', async () => {
  const server = createLimitedServer((_req, res) => res.end('ok'))
  applyHttpServerLimits(server)
  installConnectionSoftCap(server, 2)
  const acceptedOnServer: Socket[] = []
  server.on('connection', socket => acceptedOnServer.push(socket))
  const port = await listen(server)
  const clients: NetSocket[] = []
  try {
    const first = await connect(port)
    const second = await connect(port)
    clients.push(first, second)
    await waitFor(() => acceptedOnServer.length === 2)

    const refused = await connect(port)
    const response = await readToClose(refused)
    assert.match(response, /503 Service Unavailable/)
    await waitFor(() => acceptedOnServer.filter(socket => !socket.destroyed).length === 2)

    // Release exactly one accepted connection: its 'close' decrements the app
    // counter, so a fresh connection must be admitted again.
    first.destroy()
    await waitFor(() => acceptedOnServer.filter(socket => !socket.destroyed).length === 1)
    const afterRelease = await connect(port)
    clients.push(afterRelease)
    await sleep(100)
    assert.equal(afterRelease.destroyed, false, 'a released slot must admit the next connection')
    assert.equal(acceptedOnServer.filter(socket => !socket.destroyed).length, 2)
  } finally {
    for (const client of clients) client.destroy()
    await close(server)
  }
})
