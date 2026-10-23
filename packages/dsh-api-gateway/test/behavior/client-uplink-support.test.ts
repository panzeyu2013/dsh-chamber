/**
 * Behavioural coverage for the generated stream's uplink half (G43).
 *
 * WHY THIS FILE EXISTS. The official api-gateway client half opens a generated
 * stream through a ClientStreamHandle whose send/end side is a
 * ClientUplinkQueue built from `descriptor.uplink`. The chamber fork is a
 * second-implementation fork; it originally copied only the downlink path and
 * refused uplink descriptors at call time (fail-loud, G43), which left the
 * official terminal plugin unable to attach: `terminal/attach` carries input
 * through exactly this uplink. The fork now restores the handle contract, so
 * this suite drives the REAL `apply()` service and asserts that `send`/`end`
 * reach the selected carrier, that disposal terminates the generation, and that
 * the no-uplink stream path still works.
 *
 * The fixture (descriptor, codec, mount) lives in `test/support/generated-probe.ts`
 * so the mux suite drives the same generated handle over the real wire; the
 * Cordis Context is the shared fake that file installs.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/client/index.ts'
import { ClientUplinkQueue } from '../../src/client/stream-client.ts'
import { createFakeContext } from '../support/client-service-context.ts'
import { mountProbe } from '../support/generated-probe.ts'

/** Every logical stream the fake Connection was asked to open. */
interface StreamOpenRecorder {
  readonly streams: Array<{
    endpoint: string
    payload: unknown
    signal: AbortSignal
    uplink: AsyncIterable<unknown> | undefined
  }>
}

/**
 * The upstream Connection surface the client service touches: a recording
 * `rpc.open` (defined, so the service never starts the WebSocket mux), a
 * generation source with no snapshot, and a no-op loop start.
 */
function fakeConnection(recorder: StreamOpenRecorder, values: readonly unknown[]) {
  return {
    rpc: {
      open: (_api: string, endpoint: string, payload: unknown, signal: AbortSignal, uplink?: AsyncIterable<unknown>) => {
        recorder.streams.push({ endpoint, payload, signal, uplink })
        return (async function *deliver() {
          for (const value of values) yield value
        })()
      },
    },
    generation: {
      subscribe: () => () => {},
      getSnapshot: () => undefined,
    },
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
    isLoopback: true,
  }
}

test('a generated stream with descriptor.uplink returns a handle that feeds the carrier queue', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const { probe } = await mountProbe(fakeConnection(recorder, ['one', 'two']), true)
  const handle = probe.attach('topic')
  assert.equal(recorder.streams.length, 1, 'the method must open the logical stream synchronously')

  const opened = recorder.streams[0]!
  assert.equal(opened.endpoint, 'probe/attach')
  assert.ok(opened.uplink instanceof ClientUplinkQueue, 'the carrier receives the generated stream uplink queue')
  const payload = opened.payload as { args: Record<string, unknown> }
  assert.deepEqual(Object.entries(payload.args), [['topic', 'topic']])

  const first = { type: 'write', data: 'ls' }
  handle.send(first)
  handle.send(undefined)
  handle.end()
  assert.deepEqual(await opened.uplink.next(), { value: first, done: false }, 'send() queues the first item')
  assert.deepEqual(await opened.uplink.next(), { value: undefined, done: false }, 'a top-level undefined is a valid uplink item')
  assert.deepEqual(await opened.uplink.next(), { value: undefined, done: true }, 'end() half-closes the uplink')
  assert.throws(() => handle.send('late'), /uplink was ended/u)

  const seen: unknown[] = []
  for await (const value of handle) seen.push(value)
  assert.deepEqual(seen, ['one', 'two'], 'the downlink keeps yielding after the uplink half-closes')
  assert.equal(opened.signal.aborted, true, 'natural completion disposes the generation')
})

test('send() refuses a value that cannot travel losslessly as one uplink item', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const { probe } = await mountProbe(fakeConnection(recorder, []), true)
  const handle = probe.attach('topic')
  assert.throws(() => handle.send(() => {}), /uplink item is not a lossless JSON value/u)
  handle.dispose()
  assert.throws(() => handle.send('after-dispose'), /stream has terminated/u)
})

test('dispose() aborts the generation and closes the uplink queue', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const { probe } = await mountProbe(fakeConnection(recorder, ['never-delivered']), true)
  const handle = probe.attach('topic')
  const opened = recorder.streams[0]!
  handle.dispose()
  assert.equal(opened.signal.aborted, true, 'disposing the handle aborts the generation signal')
  assert.throws(() => handle.send('late'), /stream has terminated/u)
  const iterator = handle[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { value: undefined, done: true }, 'a disposed handle ends quietly')
})

test('the handle takes one consumer and a return before the first read disposes it', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const { probe } = await mountProbe(fakeConnection(recorder, ['one']), true)

  const consumed = probe.attach('topic')
  consumed[Symbol.asyncIterator]()
  assert.throws(() => consumed[Symbol.asyncIterator](), /stream has one consumer/u,
    'a second iteration must be refused instead of duplicating the downlink')

  const returned = probe.attach('topic')
  const opened = recorder.streams[1]!
  const iterator = returned[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.return?.(undefined), { value: undefined, done: true },
    'a return before the first read ends the handle quietly')
  assert.equal(opened.signal.aborted, true, 'the early return disposes the generation even though nothing was read')
  assert.deepEqual(await iterator.next(), { value: undefined, done: true }, 'the handle stays done after the early return')
})

test('the same generated stream without an uplink still opens and yields the downlink', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const { probe } = await mountProbe(fakeConnection(recorder, ['one', 'two']), false)
  const handle = probe.attach('topic')
  const seen: unknown[] = []
  for await (const value of handle) seen.push(value)
  assert.deepEqual(seen, ['one', 'two'], 'the no-uplink stream path must keep working unchanged')
  assert.equal(recorder.streams.length, 1)
  assert.equal(recorder.streams[0]?.endpoint, 'probe/attach')
  // The args bag is built with a null prototype, so read the one wire field.
  const payload = recorder.streams[0]?.payload as { args: Record<string, unknown> }
  assert.deepEqual(Object.entries(payload.args), [['topic', 'topic']])
  assert.equal(typeof handle.send, 'function', 'every generated stream returns the upstream handle shape')
})

test('the answer leg registers exactly one generation source (real Connection semantics)', () => {
  // The alpha.3 merge once constructed ClientRemoteEvents twice; the second
  // registerGenerationSource throws on a real handle, but the shared fake is a
  // no-op and stayed green. Pin the single-construction contract with real semantics.
  let generationSources = 0
  const connection = {
    ...fakeConnection({ streams: [] }, ['never-delivered']),
    interactions: 'answer',
    registerGenerationSource: () => {
      generationSources += 1
      if (generationSources > 1) {
        throw new Error('connection: a generation source is already registered')
      }
      return () => {}
    },
  }
  const ctx = createFakeContext(connection)
  assert.doesNotThrow(() => apply(ctx as unknown as Context),
    'apply() must not register the events channel twice')
  assert.equal(generationSources, 1, 'exactly one generation source must be registered')
})
