import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionIndex } from '../src/features/index.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('session index refreshes the projection at the poll cadence over session/list (slash)', async () => {
  let listCalls = 0
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger: { log() {}, warn() {}, error() {} },
    reconnectDelayMs: 5,
    pollIntervalMs: 5,
    callDsh: (async (_base: string, method: string, payload?: unknown) => {
      listCalls += 1
      return {
        rpcId: `list-${listCalls}`,
        result: {
          ok: true,
          value: { items: [{
            sessionId: 's1', updatedAt: listCalls, running: listCalls > 1, blank: listCalls === 1,
            projections: { asOfSeq: listCalls, values: { title: `Title ${listCalls}` } },
          }] },
        },
      }
    }) as any,
  })

  index.start()
  await waitFor(() => index.get('s1')?.title === 'Title 1')
  // The removed events.mux/events.host live push is replaced by the bounded
  // poll cadence: the next poll refreshes title + running/blank.
  await waitFor(() => index.get('s1')?.title === 'Title 2' && index.get('s1')?.running === true)
  assert.equal(index.get('s1')?.blank, false)
  index.stop()
  assert.deepEqual(index.list(), [])
})

test('session index drops unknown metadata, truncates display fields and skips malformed rows instead of wedging the generation', async () => {
  const warnings: string[] = []
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger: { log() {}, warn(message) { warnings.push(String(message)) }, error() {} },
    reconnectDelayMs: 5,
    pollIntervalMs: 5,
    callDsh: (async () => ({
      rpcId: 'baseline',
      result: { ok: true, value: { items: [
        // Unknown future metadata key: dropped, row still loads.
        { sessionId: 'future', updatedAt: 1, running: false, blank: true,
          projections: { asOfSeq: 0, values: { sessionListMetadata: { blank: true, lastPromptAt: null, archivedAt: 'x' } } } },
        // Overlong display fields: truncated, not rejected.
        { sessionId: 'long', updatedAt: 1, running: true, blank: false, cwd: 'x'.repeat(40_000),
          projections: { asOfSeq: 0, values: { title: 't'.repeat(5_000) } } },
        // Structurally malformed row: skipped with a warn, other rows survive.
        { sessionId: 42, updatedAt: 1, running: false, blank: true },
        // A forward-incompatible nullable projection container is likewise a
        // bad row, not a generation-ending TypeError.
        { sessionId: 'null-projections', updatedAt: 1, running: false, blank: true, projections: null },
        // Healthy row: must load untouched.
        { sessionId: 'ok', updatedAt: 1, running: false, blank: true,
          projections: { asOfSeq: 0, values: {} } },
      ] } },
    })) as any,
  })

  index.start()
  await waitFor(() => index.get('ok') !== undefined)
  assert.equal(index.get('future')?.metadata?.blank, true)
  assert.equal('archivedAt' in (index.get('future')?.metadata ?? {}), false, 'unknown metadata keys never enter the projection')
  assert.equal(index.get('long')?.title?.length, 4_096, 'overlong titles are truncated to the projection bound')
  assert.equal(index.get('long')?.cwd?.length, 32_768, 'overlong cwds are truncated to the projection bound')
  assert.equal(index.get(42 as never), undefined, 'malformed rows are skipped, not wedging the generation')
  assert.equal(index.get('null-projections'), undefined, 'nullable projection rows are isolated')
  assert.equal(warnings.some(message => message.includes('skipping a malformed session/list row')), true)
  index.stop()
})

test('session index rebuilds its baseline directly from session/list (slash)', async () => {
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger: { log() {}, warn() {}, error() {} },
    reconnectDelayMs: 5,
    pollIntervalMs: 5,
    callDsh: (async () => ({
      rpcId: 'baseline',
      result: { ok: true, value: { items: [{
        sessionId: 'stable', updatedAt: 1, running: false, blank: true,
        projections: { asOfSeq: -1, values: {} },
      }] } },
    })) as any,
  })

  index.start()
  await waitFor(() => index.get('stable') !== undefined)
  assert.equal(index.list().length, 1)
  index.stop()
})

test('session index reconnects after a poll failure and reinstalls a fresh baseline', async () => {
  let calls = 0
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger: { log() {}, warn() {}, error() {} },
    reconnectDelayMs: 5,
    pollIntervalMs: 5,
    callDsh: (async (_base: string, method: string, payload?: unknown) => {
      calls += 1
      if (calls === 2) throw new Error('transient poll failure')
      return {
        rpcId: `list-${calls}`,
        result: { ok: true, value: { items: [{
          sessionId: 'stable', updatedAt: calls, running: false, blank: true,
          projections: { asOfSeq: -1, values: {} },
        }] } },
      }
    }) as any,
  })

  index.start()
  await waitFor(() => index.get('stable') !== undefined)
  await waitFor(() => calls >= 4 && index.get('stable') !== undefined)
  assert.equal(index.list().length, 1)
  index.stop()
})

test('session index applies session/control stream frames: baseline projections/queues/jobs + live updates', async () => {
  // review-round3b P1-1: pin the 0.1.2 session/control stream frame decoding
  // (baseline + queue/jobs/projection replacement frames) which the healthy
  // path consumes while the session/list poll keeps the row set fresh.
  let listCalls = 0
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger: { log() {}, warn() {}, error() {} },
    reconnectDelayMs: 5,
    pollIntervalMs: 5,
    callDsh: (async () => {
      listCalls += 1
      return {
        rpcId: 'list',
        result: { ok: true, value: { items: [{
          sessionId: 's1', updatedAt: 1, running: false, blank: true,
          projections: { asOfSeq: 0, values: { title: 'Initial' } },
        }] } },
      }
    }) as any,
    openRemoteStream: (async function *(): AsyncGenerator<unknown> {
      yield {
        type: 'baseline', value: {
          queues: { s1: [{ rpcId: 'q1', mode: 'queue' }] },
          jobs: { s1: [{ jobId: 'j1' }] },
          projections: { s1: { asOfSeq: 1, values: { title: 'From baseline' } } },
        },
      }
      yield { type: 'projection', sessionId: 's1', key: 'title', value: 'From live frame', seq: 2 }
      yield { type: 'queue', sessionId: 's1', items: [{ rpcId: 'q2', mode: 'queue' }] }
      yield { type: 'jobs', sessionId: 's1', jobs: [{ jobId: 'j2' }] }
      await new Promise<void>(resolve => undefined)
    }) as any,
  })
  index.start()
  await waitFor(() => index.get('s1')?.title === 'From live frame')
  assert.deepEqual([...index.getQueues().get('s1') ?? []], [{ rpcId: 'q2', mode: 'queue' }])
  assert.deepEqual([...index.getJobs().get('s1') ?? []], [{ jobId: 'j2' }])
  // The poll loop keeps running in the healthy path (new rows arrive).
  await waitFor(() => listCalls >= 2)
  index.stop()
})

test('session index degrades to polling only when the control stream throws', async () => {
  let listCalls = 0
  let warnings = 0
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger: { log() {}, warn() { warnings += 1 }, error() {} },
    reconnectDelayMs: 5,
    pollIntervalMs: 5,
    callDsh: (async () => {
      listCalls += 1
      return {
        rpcId: 'list',
        result: { ok: true, value: { items: [{
          sessionId: 's1', updatedAt: listCalls, running: false, blank: true,
          projections: { asOfSeq: 0, values: { title: `Title ${listCalls}` } },
        }] } },
      }
    }) as any,
    openRemoteStream: (async function *(): AsyncGenerator<unknown> {
      throw new Error('stream carrier refused')
    }) as any,
  })
  index.start()
  await waitFor(() => index.get('s1')?.title === 'Title 2')
  assert.equal(warnings >= 1, true, 'the stream failure is logged once')
  index.stop()
})
