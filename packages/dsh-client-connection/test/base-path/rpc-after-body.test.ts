/**
 * chamber patch (design 27 §3.5): the official unary carrier must recognize the
 * proxy's after-body marker, so a lost answer is not reported as a plain HTTP
 * failure the UI invites the user to retry. The marker is a stable wire fact:
 * 502/504 + `{ details: { phase: 'after-body' } }`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createWebConnectionRpc } from '../../src/client/rpc.ts'

function clientWith(response: Response) {
  return createWebConnectionRpc({
    basePath: '/api/i/local',
    doFetch: async () => response,
  })
}

const JSON_HEADERS = { 'content-type': 'application/json' }

test('a 504 after-body answer says the call may have applied', async () => {
  const rpc = clientWith(new Response(JSON.stringify({
    error: 'upstream timed out after the body was sent',
    code: 'upstream_timeout',
    details: { phase: 'after-body' },
  }), { status: 504, headers: JSON_HEADERS }))
  await assert.rejects(
    rpc.call('/api', 'session/rename', {}),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /may have applied/)
      assert.match(error.message, /refresh before retrying/)
      assert.doesNotMatch(error.message, /transport failure/)
      return true
    },
  )
})

test('a 502 after-body answer is the same classified loss', async () => {
  const rpc = clientWith(new Response(JSON.stringify({
    error: 'upstream failed', code: 'upstream_failed', details: { phase: 'after-body' },
  }), { status: 502, headers: JSON_HEADERS }))
  await assert.rejects(rpc.call('/api', 'workspace/delete', {}), /may have applied/)
})

test('a plain 502/504 keeps the transport wording (no marker, no claim)', async () => {
  for (const status of [502, 504]) {
    const rpc = clientWith(new Response(JSON.stringify({ error: 'boom', code: 'upstream_failed' }), {
      status, headers: JSON_HEADERS,
    }))
    await assert.rejects(rpc.call('/api', 'session/list', {}), /transport failure/)
  }
})

test('a non-JSON 504 body stays a transport failure (bounded, fail-soft)', async () => {
  const rpc = clientWith(new Response('<html>bad gateway</html>', {
    status: 504, headers: { 'content-type': 'text/html' },
  }))
  await assert.rejects(rpc.call('/api', 'session/list', {}), /transport failure/)
})

test('an oversized error body is never buffered to find the marker', async () => {
  const rpc = clientWith(new Response(JSON.stringify({
    error: 'x'.repeat(5000), code: 'upstream_failed', details: { phase: 'after-body' },
  }), { status: 504, headers: JSON_HEADERS }))
  // The 4KiB cap cancels the read before the marker is complete: the caller keeps
  // the plain transport wording (conservative, never a claim).
  await assert.rejects(rpc.call('/api', 'session/rename', {}), /transport failure/)
})

