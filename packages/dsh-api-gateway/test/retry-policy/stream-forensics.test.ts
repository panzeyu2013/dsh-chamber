/**
 * Stream-lifecycle forensics contract (chamber fork, design 14 §D4).
 *
 * The facts exist so the next churn investigation can name the transition and
 * the caller without renderer DevTools. This pins the contract: bounded,
 * counted, non-secret, and never able to break the stream lifecycle.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createStreamForensicsReporter,
  STREAM_FORENSICS_CAUSE_MAX,
  STREAM_FORENSICS_EVENT,
  type StreamForensicsFact,
} from '../../src/client/stream-forensics.ts'

const source = (relative: string): string => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')

test('the event name is the documented page channel', () => {
  assert.equal(STREAM_FORENSICS_EVENT, 'dsh-chamber:stream-forensics')
  assert.doesNotMatch(source('src/client/stream-forensics.ts'), /@deepseek-ai\//u, 'the fact module must stay import-free')
})

test('every transition publishes one counted, attributed fact', () => {
  const facts: StreamForensicsFact[] = []
  const report = createStreamForensicsReporter({
    instanceId: 'local',
    now: () => 1_000,
    dispatch: (fact) => { facts.push(fact) },
  })
  report('socket-reconnect', 'reconnect requested by the connection lane')
  report('opening-timeout', '$events waited 30000ms')
  report('socket-attempt-failed', 'connect attempt failed; next attempt in 2000ms')
  report('socket-reconnect', 'again')
  assert.equal(facts.length, 4)
  assert.deepEqual(facts.map(fact => fact.kindCount), [1, 1, 1, 2])
  assert.deepEqual(facts.map(fact => fact.count), [1, 2, 3, 4])
  assert.deepEqual(facts[0], {
    instanceId: 'local',
    kind: 'socket-reconnect',
    cause: 'reconnect requested by the connection lane',
    at: 1_000,
    count: 1,
    kindCount: 1,
  })
})

test('the cause is bounded and never carries more than diagnostic copy', () => {
  const facts: StreamForensicsFact[] = []
  const report = createStreamForensicsReporter({ dispatch: (fact) => { facts.push(fact) } })
  report('socket-lost', 'x'.repeat(STREAM_FORENSICS_CAUSE_MAX * 3))
  assert.equal(facts[0]?.cause.length, STREAM_FORENSICS_CAUSE_MAX)
})

test('a throwing dispatch can never break the stream lifecycle', () => {
  const report = createStreamForensicsReporter({ dispatch: () => { throw new Error('page listener exploded') } })
  assert.doesNotThrow(() => { report('socket-lost', 'closed') })
})

test('missing instance attribution and a missing dispatch seam are both tolerated', () => {
  const facts: StreamForensicsFact[] = []
  const report = createStreamForensicsReporter({ dispatch: (fact) => { facts.push(fact) } })
  report('generation-lost', 'connection generation replaced')
  assert.equal(facts[0]?.instanceId, undefined)
  assert.doesNotThrow(() => { createStreamForensicsReporter()('generation-ready', 'generation 4') })
})

test('the fork reports the transitions the investigation needed', () => {
  const client = source('src/client/stream-client.ts')
  const service = source('src/client/index.ts')
  assert.match(client, /this\.forensics\?\.\('socket-reconnect'/u)
  assert.match(client, /this\.forensics\?\.\('socket-disposed'/u)
  assert.match(client, /this\.forensics\?\.\('socket-lost', error\.message\)/u)
  assert.match(client, /this\.forensics\?\.\('opening-timeout'/u)
  assert.match(client, /constructor\(basePath = '', private readonly forensics\?: StreamForensicsReporter\)/u)
  assert.match(service, /forensics\(\s*\n\s*active === undefined \? 'generation-lost' : 'generation-ready'/u)
  assert.match(service, /new RemoteStreamMuxClient\(basePath, forensics\)/u)
  assert.match(service, /unsubscribeForensics\(\)/u, 'the generation subscription must be released on dispose')
})
