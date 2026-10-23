/**
 * Behavioural coverage for generated unary results (api-gateway client half).
 *
 * Two upstream contract points are easy to lose when the fork is replayed:
 * a unary result whose codec carries a type-specific `decode` must be decoded
 * before the caller sees it (binary fields and similar), and an abort that
 * races a successful wire reply is still a cancellation. Both are exercised
 * against the REAL `apply()` service and a recording fake Connection.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'
import { apply } from '../../src/client/index.ts'
import { createFakeContext } from '../support/client-service-context.ts'

/** One strict codec over a string, mirroring the upstream fixture's shape. */
function stringCodec(typeSymbol: string): TypertCodec {
  return { mode: 'strict', typeSymbol, create: () => z.string() }
}

/** A unary method with one string parameter and the given result codec. */
function unaryDescriptor(
  method: string,
  result: TypertCodec,
  cancellation = false,
): InvocationDescriptor {
  return {
    id: `@fixture/probe#probe/${method}`,
    service: 'probe',
    namespace: 'probe',
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'value',
      wire: 'value',
      source: 'json',
      codec: stringCodec('@fixture#Input'),
    }],
    ...(cancellation ? { cancellation: { parameter: 'signal' } } : {}),
    result,
  }
}

/** The generated unary methods as the mounted namespace exposes them. */
interface GeneratedUnaryProbe {
  decode(value: string): Promise<RemoteResult<unknown>>
  echo(value: string, signal?: AbortSignal): Promise<RemoteResult<unknown>>
}

/** Every unary call the fake Connection observed. */
interface CallRecorder {
  readonly calls: Array<{
    endpoint: string
    payload: unknown
    signal: AbortSignal
  }>
}

/**
 * The Connection surface the client service touches: a defined `rpc.open`
 * (so the service never starts the WebSocket mux) and the recording unary
 * `call` under test.
 */
function fakeConnection(
  recorder: CallRecorder,
  call: (signal: AbortSignal) => Promise<
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string; details: object } }
  >,
) {
  return {
    rpc: {
      open: () => {
        throw new Error('the unary suite never opens a stream')
      },
      call: async (_api: string, endpoint: string, payload: unknown, signal: AbortSignal) => {
        recorder.calls.push({ endpoint, payload, signal })
        return call(signal)
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

/** Install one unary descriptor and return the generated namespace method. */
async function mountProbe(
  connection: unknown,
  descriptor: InvocationDescriptor,
): Promise<GeneratedUnaryProbe> {
  const ctx = createFakeContext(connection)
  apply(ctx as unknown as Context)
  const remote = ctx.remote
  assert.ok(remote !== undefined, 'apply() must register the remote service')
  await remote.$mount({ package: '@fixture/probe', descriptors: [descriptor] })
  const probe = remote.probe
  assert.ok(probe !== undefined, 'the namespace service must expose the generated method')
  return probe as GeneratedUnaryProbe
}

test('a unary result passes through descriptor.result.decode', async () => {
  const recorder: CallRecorder = { calls: [] }
  const decoded: TypertCodec = {
    ...stringCodec('@fixture#DecodedResult'),
    decode: (value: unknown) => ({ decoded: value }),
  }
  const probe = await mountProbe(
    fakeConnection(recorder, async () => ({ ok: true, value: 'wire-value' })),
    unaryDescriptor('decode', decoded),
  )
  const result = await probe.decode('input')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { decoded: 'wire-value' }, 'the caller receives the decoded value, not the wire shape')
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0]?.endpoint, 'probe/decode')
})

test('an abort racing a successful unary reply is still a cancellation', async () => {
  const recorder: CallRecorder = { calls: [] }
  const controller = new AbortController()
  const probe = await mountProbe(
    fakeConnection(recorder, async () => {
      controller.abort()
      return { ok: true, value: 'wire-value' }
    }),
    unaryDescriptor('echo', stringCodec('@fixture#EchoResult'), true),
  )
  const result = await probe.echo('input', controller.signal)
  assert.equal(result.ok, false, 'a cancellation must not report the raced success')
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.error.code, 'gateway/cancelled')
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0]?.signal.aborted, true)
})

test('an abort racing an error reply is still a cancellation', async () => {
  const recorder: CallRecorder = { calls: [] }
  const controller = new AbortController()
  const probe = await mountProbe(
    fakeConnection(recorder, async () => {
      controller.abort()
      return { ok: false, error: { code: 'probe/failed', message: 'host failed', details: {} } }
    }),
    unaryDescriptor('echo', stringCodec('@fixture#EchoResult'), true),
  )
  const result = await probe.echo('input', controller.signal)
  assert.equal(result.ok, false, 'a cancellation must not report the raced host error')
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.error.code, 'gateway/cancelled')
  assert.equal(recorder.calls.length, 1)
})
