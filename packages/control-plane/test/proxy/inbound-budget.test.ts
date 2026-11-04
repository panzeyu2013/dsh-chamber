/**
 * P0-1: the inbound total budget on readBody. The idle timer alone lets a
 * trickling client hold a proxy slot forever; the size-derived total budget is
 * the classified 408 the client can act on.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readBody } from '../../src/proxy-forward.ts'
import type { ProxyRequest } from '../../src/instance-proxy.ts'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function slowRequest(chunks: readonly Buffer[], perChunkMs: number): ProxyRequest {
  let index = 0
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Buffer>> {
          if (index >= chunks.length) return { done: true, value: undefined }
          await sleep(perChunkMs)
          return { done: false, value: chunks[index++] }
        },
        async return(): Promise<IteratorResult<Buffer>> {
          return { done: true, value: undefined }
        },
      }
    },
  } as unknown as ProxyRequest
}

test('readBody rejects with request_timeout when the total budget is exhausted', async () => {
  const req = slowRequest([Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1)], 30)
  await assert.rejects(
    () => readBody(req, 1024, 5_000, undefined, 40),
    (error: Error & { code?: string }) => error.code === 'request_timeout' && /total budget/.test(error.message),
  )
})

test('readBody still reports the idle window separately', async () => {
  const req = slowRequest([Buffer.alloc(1), Buffer.alloc(1)], 60)
  await assert.rejects(
    () => readBody(req, 1024, 20, undefined, 5_000),
    (error: Error & { code?: string }) => error.code === 'request_timeout' && /idle/.test(error.message),
  )
})

test('readBody returns the body when it finishes inside the total budget', async () => {
  const req = slowRequest([Buffer.from('ab'), Buffer.from('cd')], 5)
  const body = await readBody(req, 1024, 1_000, undefined, 1_000)
  assert.equal(body.toString('utf8'), 'abcd')
})

test('readBody keeps the hard cap independent of the total budget', async () => {
  const req = slowRequest([Buffer.alloc(100)], 1)
  await assert.rejects(
    () => readBody(req, 50, 1_000, undefined, 1_000),
    (error: Error & { code?: string }) => error.code === 'body_too_large',
  )
})
