/**
 * P0-1: server-level limits + the app-level header deadline.
 *
 * These tests pin the WHY of the module: Node's request deadline is
 * max(headersTimeout, requestTimeout) and is swept by the construction-time
 * connectionsCheckingInterval, so the real 10s header window must be enforced in
 * user space while Node stays a high dead-man switch.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect as netConnect } from 'node:net'
import { request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { applyHttpServerLimits, createLimitedServer, HTTP_SERVER_LIMITS, installHeaderDeadline } from '../../src/http-limits.ts'

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForSocketClose(socket: ReturnType<typeof netConnect>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('close', () => done(true))
    socket.once('error', () => done(true))
  })
}

test('createLimitedServer passes the construction-time options Node honours and applyHttpServerLimits sets the rest', async () => {
  const limits = {
    ...HTTP_SERVER_LIMITS,
    headersTimeoutMs: 12_000,
    requestTimeoutMs: 12_000,
    connectionsCheckingIntervalMs: 50,
    keepAliveTimeoutMs: 77,
    maxRequestsPerSocket: 9,
    maxConnections: 33,
    headerDeadlineMs: 5_000,
  }
  const server = createLimitedServer((_req, res) => res.end('ok'), limits)
  applyHttpServerLimits(server, limits)
  assert.equal(server.headersTimeout, 12_000)
  assert.equal(server.requestTimeout, 12_000)
  assert.equal(server.keepAliveTimeout, 77)
  assert.equal(server.maxRequestsPerSocket, 9)
  assert.equal(server.maxConnections, 33)
  await close(server)
})

test('a connection that never finishes its headers is destroyed at the app deadline', async () => {
  const server = createLimitedServer((_req, res) => res.end('ok'), { ...HTTP_SERVER_LIMITS, headerDeadlineMs: 60 })
  installHeaderDeadline(server, 60)
  const port = await listen(server)
  const socket = netConnect(port, '127.0.0.1')
  socket.resume() // drain responses; a paused socket does not surface FIN promptly
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
  assert.equal(await waitForSocketClose(socket, 1_000), true)
  await close(server)
})

test('a complete request is not killed by the header deadline, and its body may outlive it', async () => {
  const server = createLimitedServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => res.end('ok'))
  }, { ...HTTP_SERVER_LIMITS, headerDeadlineMs: 40 })
  installHeaderDeadline(server, 40)
  const port = await listen(server)
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', headers: { 'content-length': 10 } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    let sent = 0
    const timer = setInterval(() => {
      req.write(Buffer.alloc(1))
      sent += 1
      if (sent >= 10) {
        clearInterval(timer)
        req.end()
      }
    }, 10) // 100ms body, well past the 40ms header deadline
  })
  assert.equal(status, 200)
  await close(server)
})

test('an upgraded socket is not destroyed by the header deadline', async () => {
  const server = createLimitedServer((_req, res) => res.end('ok'), { ...HTTP_SERVER_LIMITS, headerDeadlineMs: 60 })
  let upgraded: import('node:stream').Duplex | null = null
  server.on('upgrade', (_req, socket) => {
    upgraded = socket
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  installHeaderDeadline(server, 60)
  const port = await listen(server)
  const socket = netConnect(port, '127.0.0.1')
  socket.resume()
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  await sleep(150)
  assert.equal(socket.destroyed, false, 'the upgraded socket must outlive the header window')
  ;(upgraded as import('node:stream').Duplex | null)?.destroy()
  socket.destroy()
  await close(server)
})

test('keep-alive re-arms the header deadline for the next request', async () => {
  const server = createLimitedServer((_req, res) => res.end('ok'), { ...HTTP_SERVER_LIMITS, headerDeadlineMs: 500 })
  installHeaderDeadline(server, 500)
  const port = await listen(server)
  const socket = netConnect(port, '127.0.0.1')
  socket.resume() // drain responses; a paused socket does not surface FIN promptly
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n')
  await sleep(100) // first response done; deadline re-armed (500ms window)
  assert.equal(socket.destroyed, false, 'the re-armed window must still be open for the next request')
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
  assert.equal(await waitForSocketClose(socket, 1_000), true)
  await close(server)
})

test('a pipelined second response is not killed by the first response finish (M5)', async () => {
  let count = 0
  const server = createLimitedServer((_req, res) => {
    count += 1
    // Delayed FIRST response forces the finish path (not writableEnded immediate)
    // and leaves the second response pending when the old code would re-arm.
    if (count === 1) setTimeout(() => res.end('one'), 30)
    else setTimeout(() => res.end('two'), 200)
  }, { ...HTTP_SERVER_LIMITS, headerDeadlineMs: 80 })
  installHeaderDeadline(server, 80)
  const port = await listen(server)
  const socket = netConnect(port, '127.0.0.1')
  let text = ''
  socket.on('data', chunk => { text += String(chunk) })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    socket.write('GET /one HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /two HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    await sleep(450)
    assert.equal(count, 2, 'both pipelined requests reached the handler')
    assert.match(text, /one/, 'the first response was written')
    assert.match(text, /two/, 'the second response must not be cut off by the header timer')
  } finally {
    socket.destroy()
    await close(server)
  }
})


function collectUntil(socket: ReturnType<typeof netConnect>, pattern: RegExp, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for ' + String(pattern) + '; got ' + text)) }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      text += String(chunk)
      if (pattern.test(text)) { cleanup(); resolve(text) }
    }
    const cleanup = (): void => { clearTimeout(timer); socket.off('data', onData) }
    socket.on('data', onData)
  })
}

test('Expect: 100-continue is refused with 413 before any body byte (P2-6)', async () => {
  let handled = 0
  const server = createLimitedServer((_req, res) => { handled += 1; res.end('ok') }, {
    ...HTTP_SERVER_LIMITS,
    expectContinueMaxBytes: 4,
  })
  const port = await listen(server)
  const socket = netConnect(port, '127.0.0.1')
  try {
    const text = collectUntil(socket, /HTTP\/1\.1 413/)
    socket.write('POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: 100-continue\r\nContent-Length: 10\r\n\r\n')
    const response = await text
    assert.match(response, /413/)
    assert.doesNotMatch(response, /100 Continue/)
    assert.equal(handled, 0, 'the request handler must not run for a refused body')
  } finally {
    socket.destroy()
    await close(server)
  }
})

test('Expect: 100-continue still accepts a small body normally (P2-6)', async () => {
  let handled = 0
  const server = createLimitedServer((_req, res) => { handled += 1; res.end('ok') }, {
    ...HTTP_SERVER_LIMITS,
    expectContinueMaxBytes: 4,
  })
  const port = await listen(server)
  const socket = netConnect(port, '127.0.0.1')
  try {
    const final = collectUntil(socket, /HTTP\/1\.1 200/)
    socket.write('POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\nhi')
    const response = await final
    assert.match(response, /100 Continue/)
    assert.match(response, /200/)
    assert.equal(handled, 1)
  } finally {
    socket.destroy()
    await close(server)
  }
})


test('an Expect: 100-continue body may outlive the header window (A-M1)', async () => {
  const server = createLimitedServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => res.end('ok'))
  }, { ...HTTP_SERVER_LIMITS, headerDeadlineMs: 80 })
  installHeaderDeadline(server, 80)
  const port = await listen(server)
  const socket = netConnect(port, '127.0.0.1')
  try {
    const interim = collectUntil(socket, /100 Continue/)
    socket.write('POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n')
    await interim
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(socket.destroyed, false, 'the header window must stay cleared while the body arrives')
    const final = collectUntil(socket, /HTTP\/1\.1 200/)
    socket.write('hi')
    assert.match(await final, /200/)
  } finally {
    socket.destroy()
    await close(server)
  }
})
