/**
 * Carrier-churn fact contract (chamber fork, design 14 §D4): the fact that closes
 * the "sustained carrier failure is silent" window opened by the retry patch.
 *
 * Covers the reporter contract AND both stream boundaries: `$stream`'s
 * RemoteStream and the non-`$stream` opener used by generated endpoint streams
 * and forwarded Remote events, including the shared-reporter dedupe that keeps
 * one physical failure to one fact.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  CARRIER_FACT_MESSAGE_MAX,
  createCarrierFailureReporter,
  reportStreamCarrierFailures,
  STREAM_CARRIER_FAILED_EVENT,
  type CarrierFailureFact,
} from '../../src/client/stream-carrier-fact.ts'

/** The production classifier is `error instanceof RemoteStreamCarrierError`; this
 *  suite cannot import that class (vendor leaves are absent in this group), so
 *  the stand-in keeps the same name-derived classification. */
const isCarrierFailure = (error: unknown): boolean => (
  error instanceof Error && error.name === 'RemoteStreamCarrierError'
)

const carrierError = (message = 'api gateway: Remote stream WebSocket failed'): Error => {
  const error = new Error(message)
  error.name = 'RemoteStreamCarrierError'
  return error
}

/** Run the reporter over `failures` and return the facts it published. */
function reportFacts(options: Parameters<typeof createCarrierFailureReporter>[0], failures: unknown[]): CarrierFailureFact[] {
  const facts: CarrierFailureFact[] = []
  const report = createCarrierFailureReporter({ ...options, dispatch: fact => { facts.push(fact) } })
  for (const failure of failures) report(failure)
  return facts
}

test('the event name is the documented page channel', () => {
  assert.equal(STREAM_CARRIER_FAILED_EVENT, 'dsh-chamber:stream-carrier-failed')
})

test('every carrier failure publishes one counted, attributed fact', () => {
  const facts = reportFacts({ instanceId: 'gateway-pve-ct-harness', now: () => 1_700_000_000_000 },
    [carrierError(), carrierError('api gateway: Remote stream reconnect requested')])
  assert.deepEqual(facts, [
    {
      instanceId: 'gateway-pve-ct-harness', stream: 'RemoteStreamCarrierError', at: 1_700_000_000_000,
      count: 1, message: 'api gateway: Remote stream WebSocket failed',
    },
    {
      instanceId: 'gateway-pve-ct-harness', stream: 'RemoteStreamCarrierError', at: 1_700_000_000_000,
      count: 2, message: 'api gateway: Remote stream reconnect requested',
    },
  ])
})

test('the payload is bounded and never carries anything secret-shaped', () => {
  const facts = reportFacts({}, [carrierError('x'.repeat(1000))])
  assert.equal(facts[0].message.length, CARRIER_FACT_MESSAGE_MAX)
})

test('a throwing dispatch can never break the reconnect lane', () => {
  const report = createCarrierFailureReporter({ dispatch: () => { throw new Error('listener exploded') } })
  assert.doesNotThrow(() => { report(carrierError()) })
})

test('a non-Error carrier failure still yields a shaped fact', () => {
  const facts = reportFacts({ now: () => 7 }, ['plain string failure'])
  assert.deepEqual(facts[0], {
    instanceId: undefined, stream: 'RemoteStreamCarrierError', at: 7,
    count: 1, message: 'plain string failure',
  })
})

test('missing instance attribution and a missing dispatch seam are both tolerated', () => {
  const report = createCarrierFailureReporter({})
  assert.doesNotThrow(() => { report(carrierError()) })
})

test('distinct failures with identical messages still count separately', () => {
  const facts = reportFacts({}, [carrierError('same text'), carrierError('same text')])
  assert.deepEqual(facts.map(fact => fact.count), [1, 2])
})

test('a non-$stream carrier failure publishes exactly one fact', async () => {
  const facts: CarrierFailureFact[] = []
  const report = createCarrierFailureReporter({
    instanceId: 'local', now: () => 42, dispatch: fact => { facts.push(fact) },
  })
  const failure = carrierError('api gateway: Remote stream WebSocket failed')
  async function* source(): AsyncGenerator<number> {
    yield 1
    yield 2
    throw failure
  }
  const items: number[] = []
  await assert.rejects(async () => {
    for await (const item of reportStreamCarrierFailures(source(), isCarrierFailure, report)) items.push(item)
  }, (error: unknown) => error === failure)
  assert.deepEqual(items, [1, 2], 'items before the failure pass through unchanged')
  assert.equal(facts.length, 1, 'the escaped carrier failure publishes exactly one fact')
  assert.deepEqual(facts[0], {
    instanceId: 'local', stream: 'RemoteStreamCarrierError', at: 42,
    count: 1, message: 'api gateway: Remote stream WebSocket failed',
  })
})

test('the same failure crossing both stream boundaries is published once', async () => {
  const facts: CarrierFailureFact[] = []
  const report = createCarrierFailureReporter({ dispatch: fact => { facts.push(fact) } })
  const failure = carrierError()
  async function* source(): AsyncGenerator<never> {
    throw failure
  }
  await assert.rejects(async () => {
    for await (const _item of reportStreamCarrierFailures(source(), isCarrierFailure, report)) { /* consume */ }
  }, (error: unknown) => error === failure)
  // The enclosing $stream RemoteStream composes the SAME reporter and observes
  // the SAME classified object as it leaves the retry lane.
  report(failure)
  assert.equal(facts.length, 1, 'the page fact counts the failure, not the reporting boundary')
  assert.equal(facts[0]?.count, 1)
})

test('a non-carrier escape is rethrown untouched and publishes nothing', async () => {
  const facts: CarrierFailureFact[] = []
  const report = createCarrierFailureReporter({ dispatch: fact => { facts.push(fact) } })
  const failure = new Error('protocol violation')
  async function* source(): AsyncGenerator<never> {
    throw failure
  }
  await assert.rejects(async () => {
    for await (const _item of reportStreamCarrierFailures(source(), isCarrierFailure, report)) { /* consume */ }
  }, (error: unknown) => error === failure)
  assert.equal(facts.length, 0, 'only classified carrier failures publish')
})

/** Read one repository source for the structural ties below. */
const sourceText = (relative: string): string => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')

test('every remote-stream path reaches the one client reporter (source lock)', () => {
  const index = sourceText('src/client/index.ts')
  assert.equal(
    (index.match(/createCarrierFailureReporter\(/gu) ?? []).length,
    1,
    'one reporter per client: both boundaries must share the same instance',
  )
  const opener = index.slice(index.indexOf('private openRemoteStream('))
  const body = opener.slice(0, opener.indexOf('\n  }\n'))
  assert.match(body, /reportStreamCarrierFailures\(/u, 'the non-$stream opener must publish the fact')
  assert.match(body, /error instanceof RemoteStreamCarrierError/u, 'it reports only already-classified carrier failures')
  assert.match(body, /this\.reportCarrierFailure/u, 'it uses the client one reporter')
  assert.match(body, /this\.streams\.open\(endpoint, payload, signal\)/u, 'the mux logical-stream path is covered')
  assert.match(body, /normalizeConnectionStream\(local\)/u, 'the worker-local path is covered')
  assert.match(index, /carrierFailed: \(error: RemoteStreamCarrierError\): void => \{[\s\S]*?this\.reportCarrierFailure\(error\)/u,
    '$stream composition still reports through the same instance')
})

test('every non-$stream consumer opens through openRemoteStream (source lock)', () => {
  const index = sourceText('src/client/index.ts')
  assert.match(index, /this\.openRemoteStream\(endpoint, \{ args: prepared\.args \}, prepared\.signal\)/u,
    'generated endpoint streams (invokeStream)')
  assert.match(index, /\(endpoint, payload, signal\) => this\.openRemoteStream\(endpoint, payload, signal\)/u,
    'the forwarded Remote event stream (ClientRemoteEvents)')
})

