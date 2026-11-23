/**
 * Retryable carrier-loss judgement (alpha.1 replay, design 14 §D4 / deviation G43):
 * the retry lane follows the `gateway/carrier-lost` CODE, never the carrier class.
 *
 * Why this is a behaviour suite: a source-text lock cannot prove the classifier.
 * The vendor leaves the real `stream-client.ts` needs are stubbed, so this imports
 * the SHIPPED module and pins the three boundary cases the replay must hold:
 * a domain `ended()` may return a plain Error with the code (retry), the carrier
 * class carries it (retry), and a Host `RemoteError` with the same code terminates
 * (the code is only produced inside this Client process).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  isRemoteStreamCarrierFailure,
  RemoteStreamAuthError,
  RemoteStreamCarrierError,
} from '../../src/client/stream-client.ts'

test('the carrier class carries the documented retryable code', () => {
  assert.equal(new RemoteStreamCarrierError('socket lost').code, 'gateway/carrier-lost')
})

test('a plain Error carrying the code is a retryable carrier loss (domain ended() may return one)', () => {
  const loss = Object.assign(new Error('domain stream ended'), { code: 'gateway/carrier-lost' })
  assert.equal(isRemoteStreamCarrierFailure(loss), true)
})

test('a Host RemoteError carrying the same code is terminal, never a carrier loss', () => {
  const host = new RemoteError('gateway/carrier-lost' as never, 'host reused the carrier code', {})
  assert.equal(isRemoteStreamCarrierFailure(host), false)
})

test('unrelated errors and non-errors are not carrier losses', () => {
  assert.equal(isRemoteStreamCarrierFailure(new Error('boom')), false)
  assert.equal(isRemoteStreamCarrierFailure('gateway/carrier-lost'), false)
  assert.equal(isRemoteStreamCarrierFailure(undefined), false)
})

test('the auth close is a carrier subtype by code but keeps its own terminal identity', () => {
  const auth = new RemoteStreamAuthError('unauthorized', 4401)
  assert.equal(isRemoteStreamCarrierFailure(auth), true)
  assert.equal(auth.code, 'gateway/carrier-lost')
  assert.equal(auth.closeCode, 4401)
})
