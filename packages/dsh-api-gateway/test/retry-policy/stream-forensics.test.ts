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
import { createForensicsRing } from '@dsh-chamber/dsh-stream-state'
import {
  createStreamForensicsReporter,
  installStreamForensicsSnapshotBridge,
  STREAM_FORENSICS_CAUSE_MAX,
  STREAM_FORENSICS_EVENT,
  STREAM_FORENSICS_REQUEST_EVENT,
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

test('every fact is retained in the bounded ring and flushed through the sink', () => {
  const report = createStreamForensicsReporter({ dispatch: () => {}, ring: createForensicsRing({ cap: 2 }) })
  report('socket-lost', 'one')
  report('opening-timeout', 'two')
  report('socket-reconnect', 'three')
  assert.deepEqual(report.snapshot().map((entry) => entry.detail), ['two', 'three'], 'the resident tail is bounded, oldest evicted')
  const flushed: string[] = []
  assert.equal(report.flush((entry) => { flushed.push(entry.detail) }), 2)
  assert.deepEqual(flushed, ['two', 'three'], 'flush is oldest-first')
  assert.equal(report.snapshot().length, 0, 'flush transfers the tail instead of copying it')

  const throwing = createStreamForensicsReporter({ dispatch: () => {}, ring: createForensicsRing({ cap: 1 }) })
  throwing('socket-lost', 'x')
  assert.equal(throwing.flush(() => { throw new Error('export path exploded') }), 0, 'a throwing sink cannot break the reporter')
  assert.equal(throwing.snapshot().length, 0, 'the transfer still empties the ring')
})

test('a request probe flushes the retained tail as bounded snapshot events', () => {
  const listeners = new Map<string, Array<() => void>>()
  const dispatched: Array<{ type: string; detail: { instanceId?: string; entry: { detail: string } } }> = []
  const page = globalThis as unknown as {
    addEventListener?: unknown
    dispatchEvent?: unknown
    CustomEvent?: unknown
  }
  const saved = { add: page.addEventListener, dispatch: page.dispatchEvent, custom: page.CustomEvent }
  try {
    page.addEventListener = (type: string, listener: () => void): void => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    }
    page.dispatchEvent = (event: { type: string; detail: { instanceId?: string; entry: { detail: string } } }): boolean => {
      dispatched.push(event)
      return true
    }
    page.CustomEvent = class {
      readonly type: string
      readonly detail: { instanceId?: string; entry: { detail: string } }
      constructor(type: string, init: { detail: { instanceId?: string; entry: { detail: string } } }) {
        this.type = type
        this.detail = init.detail
      }
    }
    const report = createStreamForensicsReporter({ dispatch: () => {} })
    installStreamForensicsSnapshotBridge(report, 'local')
    report('socket-lost', 'a')
    report('opening-timeout', 'b')
    for (const listener of listeners.get(STREAM_FORENSICS_REQUEST_EVENT) ?? []) listener()
    assert.deepEqual(dispatched.map((event) => event.detail.entry.detail), ['a', 'b'])
    assert.deepEqual(dispatched.map((event) => event.detail.instanceId), ['local', 'local'])
    assert.equal(report.snapshot().length, 0, 'the probe transfer empties the tail')
  } finally {
    page.addEventListener = saved.add
    page.dispatchEvent = saved.dispatch
    page.CustomEvent = saved.custom
  }
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
  // R2: the ONE opening diagnostic is the non-terminal `opening-timeout`, published
  // through the bounded opening reporter (endpoint, attempt id, wait); the retired
  // verdict/acceptance names must not reappear in the source.
  assert.match(client, /reportOpening\(\s*'opening-timeout'/u)
  const retiredOpeningNames = ['orphaned', 'budget-exhausted', 'accepted', 'miss'].map(name => 'opening-' + name)
  assert.doesNotMatch(client, new RegExp(retiredOpeningNames.join('|'), 'u'))
  assert.match(client, /const detail: StreamForensicsDetail = \{\s*\n\s*endpoint,\s*\n\s*streamId,\s*\n\s*waitedMs,/u)
  assert.match(client, /constructor\(basePath = '', private readonly forensics\?: StreamForensicsReporter\)/u)
  assert.match(service, /forensics\(\s*\n\s*active === undefined \? 'generation-lost' : 'generation-ready'/u)
  assert.match(service, /new RemoteStreamMuxClient\(basePath, forensics\)/u)
  assert.match(service, /unsubscribeForensics\(\)/u, 'the generation subscription must be released on dispose')
})
