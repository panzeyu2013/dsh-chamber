/**
 * Mux stream client protocol tests (packages/gateway/src/features/remote-stream.ts).
 *
 * A real `ws` server stands in for the dsh 0.1.2 RemoteStreamMuxServer: it
 * asserts the client's `open` frame shape and serves item/error/end frames —
 * pinning the 0.1.2 mux protocol the gateway's $events/session-control
 * consumers depend on (upstream stream-protocol.ts, dsh-v0.1.2-alpha.1).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import { clearAuthCookie, registerAuthCookie } from '@dsh-chamber/control-plane'
import {
  openRemoteStream,
  parseRemoteStreamServerMessage,
  REMOTE_STREAM_MUX_PATH,
} from '../src/features/remote-stream.ts'

async function withServer(handler: (socket: WebSocket) => void): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (socket, request) => {
    assert.equal(request.url, REMOTE_STREAM_MUX_PATH)
    handler(socket)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { wss.close(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

test('openRemoteStream carries the 0.1.2 browser-auth cookie in the mux handshake', async () => {
  // review-round4 P1 / round5 coverage: the gateway's own mux client must
  // present the spawn-minted cookie — the 0.1.2 stream gate 401s without it.
  let seenCookie: string | undefined
  const server = createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (socket, request) => {
    seenCookie = request.headers.cookie
    socket.on('message', data => {
      const frame = JSON.parse(String(data)) as { streamId?: unknown }
      socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'c1', host: { home: '/' } } }))
      socket.send(JSON.stringify({ type: 'end', streamId: frame.streamId }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  try {
    registerAuthCookie(base, 'browser-auth=sess')
    const values: unknown[] = []
    for await (const value of openRemoteStream(base, '$events', { args: {} })) {
      values.push(value)
      break
    }
    assert.equal(seenCookie, 'browser-auth=sess')
  } finally {
    clearAuthCookie(base)
    wss.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('openRemoteStream sends the open frame and yields item values', async () => {
  interface OpenFrame { type?: unknown; streamId?: unknown; endpoint?: unknown; payload?: unknown }
  let receivedOpen: OpenFrame | null = null
  const { baseUrl, close } = await withServer(socket => {
    socket.on('message', data => {
      receivedOpen = JSON.parse(String(data)) as OpenFrame
      const streamId = String(receivedOpen?.streamId)
      socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'ready', clientId: 'c1', host: { home: '/' } } }))
      socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'waterfall', event: 'approval/request', eventId: 'a1', agentId: 'ag1', request: { toolName: 'shell' } } }))
      socket.send(JSON.stringify({ type: 'end', streamId }))
    })
  })
  try {
    const values: unknown[] = []
    for await (const value of openRemoteStream(baseUrl, '$events', { args: {} })) {
      values.push(value)
      if (values.length === 2) break
    }
    const openFrame = receivedOpen as OpenFrame | null
    assert.equal(openFrame?.type, 'open')
    assert.equal(typeof openFrame?.streamId, 'string')
    assert.equal(openFrame?.endpoint, '$events')
    assert.deepEqual(openFrame?.payload, { args: {} })
    assert.deepEqual(values[0], { type: 'ready', clientId: 'c1', host: { home: '/' } })
    assert.deepEqual(values[1], { type: 'waterfall', event: 'approval/request', eventId: 'a1', agentId: 'ag1', request: { toolName: 'shell' } })
  } finally {
    await close()
  }
})

test('openRemoteStream surfaces a host error frame and terminates on end', async () => {
  const { baseUrl, close } = await withServer(socket => {
    socket.on('message', () => {
      socket.send(JSON.stringify({ type: 'error', streamId: 's1', error: { code: 'arguments-invalid', message: 'bad args', details: {} } }))
    })
  })
  try {
    await assert.rejects(async () => {
      for await (const value of openRemoteStream(baseUrl, 'session/control', { args: {} })) void value
    }, /arguments-invalid: bad args/)
  } finally {
    await close()
  }
})

test('parseRemoteStreamServerMessage validates item/error/end shapes', () => {
  assert.deepEqual(parseRemoteStreamServerMessage(JSON.stringify({ type: 'item', streamId: 's1', value: { x: 1 } })), { type: 'item', streamId: 's1', value: { x: 1 } })
  assert.deepEqual(parseRemoteStreamServerMessage(JSON.stringify({ type: 'end', streamId: 's1' })), { type: 'end', streamId: 's1' })
  assert.throws(() => parseRemoteStreamServerMessage('not json'))
  assert.throws(() => parseRemoteStreamServerMessage(JSON.stringify({ type: 'nope', streamId: 's1' })))
})
