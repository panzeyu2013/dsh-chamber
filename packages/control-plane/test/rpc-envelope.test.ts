/**
 * rpc-envelope.ts unit tests (A2 cross-package protocol single-sourcing):
 *   - buildClientRequest: the exact client-request wire shape (key order
 *     included — JSON.stringify order is the wire order);
 *   - parseServerResponse: the three-way classification the consumers rely
 *     on (ok / no-envelope / malformed-result), including the deliberate
 *     leniency about `result.ok` (the strictness is each caller's own);
 *   - postClientRequest: the raw node:http unary carrier — 200 echo, garbage
 *     body, non-200, total deadline on a silent endpoint, oversized-body
 *     cap, connection failure.
 * Run directly: node packages/control-plane/test/rpc-envelope.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  buildClientRequest,
  mintRpcId,
  parseServerResponse,
  postClientRequest,
} from '../src/rpc-envelope.ts'

test('mintRpcId returns distinct UUIDs (the initiator mints every rpcId)', () => {
  const a = mintRpcId()
  const b = mintRpcId()
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(a, b)
})

test('buildClientRequest produces the exact client-request wire shape with canonical key order', () => {
  const envelope = buildClientRequest('rpc-1', 'session/list', {})
  assert.deepEqual(envelope, { type: 'client-request', rpcId: 'rpc-1', method: 'session/list', payload: {} })
  // JSON.stringify key order is the wire order — pin it so a reorder (which
  // would still be valid YAML/JSON) cannot silently change the wire bytes.
  assert.equal(
    JSON.stringify(envelope),
    '{"type":"client-request","rpcId":"rpc-1","method":"session/list","payload":{}}',
  )
  // The Remote-probe shape (`payload: { args }`) passes through verbatim.
  assert.deepEqual(
    buildClientRequest('rpc-2', 'clientGraph/graph', { args: {} }).payload,
    { args: {} },
  )
})

test('parseServerResponse accepts a matching server-response with an object result slot', () => {
  const parsed = parseServerResponse(
    { type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { entries: [] } } },
    'rpc-1',
  )
  assert.equal(parsed.kind, 'ok')
  if (parsed.kind !== 'ok') return
  assert.equal(parsed.envelope.type, 'server-response')
  assert.equal(parsed.envelope.rpcId, 'rpc-1')
  assert.equal(parsed.envelope.result.ok, true)
})

test('parseServerResponse never guesses: non-object bodies and wrong types/rpcIds are no-envelope', () => {
  for (const body of [null, undefined, 'text', 42, [], { result: { ok: true } }, { type: 'server-response' }, { type: 'other', rpcId: 'rpc-1', result: {} }]) {
    assert.equal(parseServerResponse(body, 'rpc-1').kind, 'no-envelope', `body ${JSON.stringify(body)} must be no-envelope`)
  }
  // An rpcId mismatch is a protocol violation, never silently accepted.
  const mismatch = parseServerResponse({ type: 'server-response', rpcId: 'other', result: { ok: true } }, 'rpc-1')
  assert.equal(mismatch.kind, 'no-envelope')
})

test('parseServerResponse classifies a non-object result slot as malformed-result', () => {
  for (const result of [null, 'ok', 42, undefined]) {
    const parsed = parseServerResponse({ type: 'server-response', rpcId: 'rpc-1', result }, 'rpc-1')
    assert.equal(parsed.kind, 'malformed-result', `result ${JSON.stringify(result)} must be malformed-result`)
  }
})

test('parseServerResponse stays lenient about result.ok — strictness is the callers own', () => {
  // The desktop probes treat `ok === true` vs anything else differently from
  // the unary client (which requires a boolean); the shared parse only
  // validates the structure, so a missing ok still parses as 'ok'.
  const parsed = parseServerResponse({ type: 'server-response', rpcId: 'rpc-1', result: {} }, 'rpc-1')
  assert.equal(parsed.kind, 'ok')
  if (parsed.kind !== 'ok') return
  assert.equal(parsed.envelope.result.ok, undefined)
  const nonBoolean = parseServerResponse({ type: 'server-response', rpcId: 'rpc-1', result: { ok: 'yes' } }, 'rpc-1')
  assert.equal(nonBoolean.kind, 'ok')
  if (nonBoolean.kind !== 'ok') return
  assert.equal(nonBoolean.envelope.result.ok, 'yes')
})

/** Listen on an ephemeral loopback port; returns the port and a cleanup. */
async function listen(server: Server): Promise<{ port: number; close(): Promise<void> }> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

test('postClientRequest POSTs the envelope verbatim and parses a 200 JSON answer', async () => {
  let received: unknown = null
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      received = body
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: {} } }))
    })
  })
  const { port, close } = await listen(server)
  try {
    const envelope = buildClientRequest('rpc-1', 'session/list', {})
    const outcome = await postClientRequest({ url: `http://127.0.0.1:${port}/api/session/list`, envelope, timeoutMs: 2000, maxBodyBytes: 1024 })
    assert.equal(outcome.status, 200)
    assert.equal(outcome.timeout, false)
    assert.equal(outcome.oversized, false)
    // The wire bytes are the envelope's exact JSON (key order preserved).
    assert.equal(received, JSON.stringify(envelope))
    assert.deepEqual(outcome.body, { type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: {} } })
  } finally {
    await close()
  }
})

test('postClientRequest collapses a garbage 200 body to body null', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{not json')
  })
  const { port, close } = await listen(server)
  try {
    const outcome = await postClientRequest({
      url: `http://127.0.0.1:${port}/api/session/list`,
      envelope: buildClientRequest('rpc-1', 'session/list', {}),
      timeoutMs: 2000,
      maxBodyBytes: 1024,
    })
    assert.equal(outcome.status, 200)
    assert.equal(outcome.body, null, 'an unparseable body is not an envelope')
  } finally {
    await close()
  }
})

test('postClientRequest resolves a non-200 answer with its status and no body', async () => {
  const server = createServer((_req, res) => { res.writeHead(404); res.end() })
  const { port, close } = await listen(server)
  try {
    const outcome = await postClientRequest({
      url: `http://127.0.0.1:${port}/api/session/list`,
      envelope: buildClientRequest('rpc-1', 'session/list', {}),
      timeoutMs: 2000,
      maxBodyBytes: 1024,
    })
    assert.equal(outcome.status, 404)
    assert.equal(outcome.body, null)
    assert.equal(outcome.timeout, false)
  } finally {
    await close()
  }
})

test('postClientRequest enforces the TOTAL deadline on a silent endpoint', async () => {
  const server = createServer(() => { /* never answer */ })
  const { port, close } = await listen(server)
  try {
    const started = Date.now()
    const outcome = await postClientRequest({
      url: `http://127.0.0.1:${port}/api/session/list`,
      envelope: buildClientRequest('rpc-1', 'session/list', {}),
      timeoutMs: 80,
      maxBodyBytes: 1024,
    })
    assert.equal(outcome.status, null)
    assert.equal(outcome.timeout, true, 'a silent endpoint fires the total deadline')
    assert.ok(Date.now() - started < 2000, 'the deadline bounds the call')
  } finally {
    await close()
  }
})

test('postClientRequest caps the 200 body at maxBodyBytes', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ padding: 'x'.repeat(64 * 1024) }))
  })
  const { port, close } = await listen(server)
  try {
    const outcome = await postClientRequest({
      url: `http://127.0.0.1:${port}/api/session/list`,
      envelope: buildClientRequest('rpc-1', 'session/list', {}),
      timeoutMs: 2000,
      maxBodyBytes: 1024,
    })
    assert.equal(outcome.oversized, true, 'an oversized answer is flagged instead of buffered unbounded')
    assert.equal(outcome.body, null)
  } finally {
    await close()
  }
})

test('postClientRequest reports a connection failure as no-answer (status null, not a timeout)', async () => {
  // An ephemeral port that nothing listens on: ECONNREFUSED.
  const probe = createServer(() => {})
  const { port, close } = await listen(probe)
  await close()
  const outcome = await postClientRequest({
    url: `http://127.0.0.1:${port}/api/session/list`,
    envelope: buildClientRequest('rpc-1', 'session/list', {}),
    timeoutMs: 2000,
    maxBodyBytes: 1024,
  })
  assert.equal(outcome.status, null)
  assert.equal(outcome.timeout, false, 'a connection failure is not mislabeled as a timeout')
})
