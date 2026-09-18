/**
 * Carrier-churn fact contract (chamber fork, design 14 §D4): the fact that closes
 * the "sustained carrier failure is silent" window opened by the retry patch.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CARRIER_FACT_MESSAGE_MAX,
  createCarrierFailureReporter,
  STREAM_CARRIER_FAILED_EVENT,
} from '../../src/client/stream-carrier-fact.ts'

const carrierError = (message = 'api gateway: Remote stream WebSocket failed'): Error => {
  const error = new Error(message)
  error.name = 'RemoteStreamCarrierError'
  return error
}

test('the event name is the documented page channel', () => {
  assert.equal(STREAM_CARRIER_FAILED_EVENT, 'dsh-chamber:stream-carrier-failed')
})

test('every carrier failure publishes one counted, attributed fact', () => {
  const facts: unknown[] = []
  const report = createCarrierFailureReporter({
    instanceId: 'gateway-pve-ct-harness',
    now: () => 1_700_000_000_000,
    dispatch: fact => { facts.push(fact) },
  })
  report(carrierError())
  report(carrierError('api gateway: Remote stream reconnect requested'))
  assert.deepEqual(facts, [
    {
      instanceId: 'gateway-pve-ct-harness',
      stream: 'RemoteStreamCarrierError',
      at: 1_700_000_000_000,
      count: 1,
      message: 'api gateway: Remote stream WebSocket failed',
    },
    {
      instanceId: 'gateway-pve-ct-harness',
      stream: 'RemoteStreamCarrierError',
      at: 1_700_000_000_000,
      count: 2,
      message: 'api gateway: Remote stream reconnect requested',
    },
  ])
})

test('the payload is bounded and never carries anything secret-shaped', () => {
  const facts: { message: string }[] = []
  const report = createCarrierFailureReporter({ dispatch: fact => { facts.push({ message: fact.message }) } })
  report(carrierError('x'.repeat(1000)))
  assert.equal(facts[0].message.length, CARRIER_FACT_MESSAGE_MAX)
})

test('a throwing dispatch can never break the reconnect lane', () => {
  const report = createCarrierFailureReporter({ dispatch: () => { throw new Error('listener exploded') } })
  assert.doesNotThrow(() => { report(carrierError()) })
})

test('a non-Error carrier failure still yields a shaped fact', () => {
  const facts: unknown[] = []
  const report = createCarrierFailureReporter({ now: () => 7, dispatch: fact => { facts.push(fact) } })
  report('plain string failure')
  assert.deepEqual(facts[0], {
    instanceId: undefined,
    stream: 'RemoteStreamCarrierError',
    at: 7,
    count: 1,
    message: 'plain string failure',
  })
})

test('missing instance attribution and a missing dispatch seam are both tolerated', () => {
  const report = createCarrierFailureReporter({})
  assert.doesNotThrow(() => { report(carrierError()) })
})
