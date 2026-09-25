/**
 * Behavioural coverage for the uplink-backed generated stream refusal (G43).
 *
 * WHY THIS FILE EXISTS. The official api-gateway client half opens a generated
 * stream through a ClientStreamHandle whose send/end side is a
 * ClientUplinkQueue built from `descriptor.uplink`; the chamber fork is a
 * second-implementation fork that never copied that half, so a descriptor with
 * an uplink has no client send path here. The invocation path must refuse the
 * call synchronously — `invokeStream` is an async generator whose body runs on
 * the first `next()`, and a throw that late could arrive after the caller
 * already treated the call as accepted.
 *
 * The suite drives the REAL fork `apply()` service through a fake Cordis
 * Context (the vendor checkout ships cordis source only, with no built lib the
 * package exports point at) and a recording Connection, so both the refusal and
 * the untouched no-uplink stream path are observed at the generated method.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {
  InvocationDescriptor,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { apply } from '../../src/client/index.ts'

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

/** The generated method as the mounted namespace exposes it. */
interface GeneratedProbe {
  attach(topic: string, signal?: AbortSignal): AsyncIterable<unknown>
}

/** Every logical stream the fake Connection was asked to open. */
interface StreamOpenRecorder {
  readonly streams: Array<{ endpoint: string; payload: unknown }>
}

/**
 * The upstream Connection surface the client service touches: a recording
 * `rpc.open` (defined, so the service never starts the WebSocket mux), a
 * generation source with no snapshot, and a no-op loop start.
 */
function fakeConnection(recorder: StreamOpenRecorder, values: readonly unknown[]) {
  return {
    rpc: {
      open: (_api: string, endpoint: string, payload: unknown) => {
        recorder.streams.push({ endpoint, payload })
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

interface FakeContext {
  remote?: {
    $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
    probe?: GeneratedProbe
  }
  readonly reflect: {
    readonly props: Record<string, unknown>
    provide(name: string, service: unknown): void
  }
  get(name: string): unknown
  effect(execute: () => unknown, label?: string): (() => unknown) & { then?: unknown }
  plugin(plugin: { name: string; apply(ctx: unknown): void }): unknown
  emit(name: string): void
  on(name: string, listener: unknown): () => void
}

/**
 * The smallest Cordis Context the client service drives: a service registry
 * (`provide` nests dotted names under `ctx.remote`, as cordis does), the
 * effect/plugin lifecycle the service owns, and the Typert registry seam.
 */
function createFakeContext(connection: unknown): FakeContext {
  const fake = {} as FakeContext & Record<string, unknown>
  const services: Record<string, unknown> = { connection }

  const provide = (name: string, service: unknown): void => {
    const parts = name.split('.')
    let target: Record<string, unknown> = fake
    for (const part of parts.slice(0, -1)) {
      const next = target[part]
      if (next === undefined || typeof next !== 'object') target[part] = {}
      target = target[part] as Record<string, unknown>
    }
    target[parts[parts.length - 1] as string] = service
  }

  const effect: FakeContext['effect'] = execute => {
    const disposers: Array<() => unknown> = []
    const result = execute()
    if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
      void (result as Promise<unknown>).then(value => {
        if (typeof value === 'function') disposers.push(value as () => unknown)
      }, () => {})
    } else if (typeof result === 'function') {
      disposers.push(result)
    }
    let disposal: Promise<unknown> | undefined
    const dispose = (): Promise<unknown> => {
      if (disposal === undefined) {
        let task: Promise<unknown> | undefined
        for (const disposer of disposers.splice(0).reverse()) {
          task = task === undefined ? Promise.resolve(disposer()) : task.then(() => disposer())
        }
        disposal = task ?? Promise.resolve()
      }
      return disposal
    }
    // Cordis's async-effect disposer is itself awaitable; $mount awaits it to
    // know the namespace group is installed. It must resolve to a PLAIN value —
    // resolving to the callable itself would re-enter this thenable forever.
    ;(dispose as { then?: unknown }).then = (onFulfilled?: (value: unknown) => unknown) =>
      Promise.resolve(result).then(() => onFulfilled?.(undefined))
    return dispose
  }

  const plugin: FakeContext['plugin'] = definition => {
    const child = Object.create(fake) as FakeContext
    const result = definition.apply(child)
    return {
      dispose: async () => {},
      then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve(result).then(() => onFulfilled(undefined)),
    }
  }

  Object.assign(fake, {
    reflect: { props: {}, provide },
    get: (name: string) => services[name],
    effect,
    plugin,
    emit: () => {},
    on: () => () => {},
    typert: {
      remotes: { register: () => () => {} },
      contexts: { getClient: () => undefined },
    },
  })
  return fake
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
  return probe
}

test('a generated stream with descriptor.uplink is refused at call time, before any stream opens', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const probe = await mountProbe(fakeConnection(recorder, ['never-delivered']), true)
  assert.throws(
    () => probe.attach('topic'),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'the refusal must be an explicit Error, not a RemoteResult')
      assert.match(error.message, /client api: probe\/attach/)
      assert.match(error.message, /descriptor\.uplink/)
      assert.match(error.message, /does not replay the uplink client half/)
      assert.match(error.message, /G43/)
      assert.match(error.message, /ClientUplinkQueue/)
      return true
    },
  )
  assert.deepEqual(recorder.streams, [], 'the synchronous refusal must land before connection.rpc.open')
})

test('the same generated stream without an uplink still opens and yields the downlink', async () => {
  const recorder: StreamOpenRecorder = { streams: [] }
  const probe = await mountProbe(fakeConnection(recorder, ['one', 'two']), false)
  const seen: unknown[] = []
  for await (const value of probe.attach('topic')) seen.push(value)
  assert.deepEqual(seen, ['one', 'two'], 'the no-uplink stream path must keep working unchanged')
  assert.equal(recorder.streams.length, 1)
  assert.equal(recorder.streams[0]?.endpoint, 'probe/attach')
  // The args bag is built with a null prototype, so read the one wire field.
  const payload = recorder.streams[0]?.payload as { args: Record<string, unknown> }
  assert.deepEqual(Object.entries(payload.args), [['topic', 'topic']])
})
