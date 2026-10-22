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
 * The suite uses a fake Cordis Context (the vendor checkout ships cordis source
 * only, with no built lib the package exports point at) and a recording
 * Connection, so the generated method is observed end to end.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {
  InvocationDescriptor,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'
import { apply } from '../../src/client/index.ts'
import { ClientUplinkQueue } from '../../src/client/stream-client.ts'
import { createFakeContext } from '../support/client-service-context.ts'

/** One strict codec over a string, mirroring the upstream fixture's shape. */
function stringCodec(typeSymbol: string): TypertCodec {
  return { mode: 'strict', typeSymbol, create: () => z.string() }
}

/**
 * The upstream `attachDescriptor()` fixture: mode 'stream', one strict topic
 * parameter, optional strict uplink codec, cancellation.
 */
function attachDescriptor(withUplink: boolean): InvocationDescriptor {
  return {
    id: '@fixture/probe#probe/attach',
    service: 'probe',
    namespace: 'probe',
    method: 'attach',
    mode: 'stream',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'topic',
      wire: 'topic',
      source: 'json',
      codec: stringCodec('@fixture#Topic'),
    }],
    ...(withUplink ? { uplink: { codec: stringCodec('@fixture#AttachInput') } } : {}),
    cancellation: { parameter: 'signal' },
    result: stringCodec('@fixture#AttachItem'),
  }
}

/** The generated handle as the mounted namespace exposes it. */
interface GeneratedStreamHandle<T> extends AsyncIterable<T> {
  send(item: unknown): void
  end(): void
  dispose(): void
}

/** The generated method as the mounted namespace exposes it. */
interface GeneratedProbe {
  attach(topic: string, signal?: AbortSignal): GeneratedStreamHandle<unknown>
}

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

/** Install the contribution and return the generated namespace method. */
async function mountProbe(connection: unknown, withUplink: boolean): Promise<GeneratedProbe> {
  const ctx = createFakeContext(connection)
  apply(ctx as unknown as Context)
  const remote = ctx.remote
  assert.ok(remote !== undefined, 'apply() must register the remote service')
  await remote.$mount({ package: '@fixture/probe', descriptors: [attachDescriptor(withUplink)] })
  const probe = remote.probe
  assert.ok(probe !== undefined, 'the namespace service must expose the generated method')
  return probe as GeneratedProbe
}

test('a generated stream with descriptor.uplink returns a handle that feeds the carrier queue', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const probe = await mountProbe(fakeConnection(recorder, ['one', 'two']), true)
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
  const probe = await mountProbe(fakeConnection(recorder, []), true)
  const handle = probe.attach('topic')
  assert.throws(() => handle.send(() => {}), /uplink item is not a lossless JSON value/u)
  handle.dispose()
  assert.throws(() => handle.send('after-dispose'), /stream has terminated/u)
})

test('dispose() aborts the generation and closes the uplink queue', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const probe = await mountProbe(fakeConnection(recorder, ['never-delivered']), true)
  const handle = probe.attach('topic')
  const opened = recorder.streams[0]!
  handle.dispose()
  assert.equal(opened.signal.aborted, true, 'disposing the handle aborts the generation signal')
  assert.throws(() => handle.send('late'), /stream has terminated/u)
  const iterator = handle[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { value: undefined, done: true }, 'a disposed handle ends quietly')
})

test('the same generated stream without an uplink still opens and yields the downlink', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const probe = await mountProbe(fakeConnection(recorder, ['one', 'two']), false)
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
  // registerGenerationSource throws on a real handle, but the shared fake above is a
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
