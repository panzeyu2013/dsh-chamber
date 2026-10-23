/**
 * Fixtures shared by the api-gateway client behaviour suites: one generated
 * stream method (with or without the uplink half) mounted on the REAL `apply()`
 * service, plus the codec and descriptor shapes both suites assert against.
 *
 * The mount returns the fake Context too, so a suite that starts the service's
 * own mux can tear it down with `ctx.disposeAll()`.
 */
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { InvocationDescriptor, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { apply } from '../../src/client/index.ts'
import { createFakeContext, type FakeContext } from './client-service-context.ts'

/** One strict codec over a string, mirroring the upstream fixture's shape. */
export function stringCodec(typeSymbol: string): TypertCodec {
  return { mode: 'strict', typeSymbol, create: () => z.string() }
}

/**
 * The upstream `attachDescriptor()` fixture: mode 'stream', one strict topic
 * parameter, optional strict uplink codec, cancellation.
 * @param withUplink - whether the method declares the Client send half.
 * @returns the descriptor the generated namespace mounts.
 */
export function attachDescriptor(withUplink: boolean): InvocationDescriptor {
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
export interface GeneratedStreamHandle<T> extends AsyncIterable<T> {
  send(item: unknown): void
  end(): void
  dispose(): void
}

/** The generated method as the mounted namespace exposes it. */
export interface GeneratedProbe {
  attach(topic: string, signal?: AbortSignal): GeneratedStreamHandle<unknown>
}

/** One mounted probe namespace plus the fake Context that owns it. */
export interface MountedProbe {
  readonly ctx: FakeContext
  readonly probe: GeneratedProbe
}

/**
 * Install the contribution and return the generated namespace method.
 * @param connection - the Connection surface `apply()` reads (real semantics optional).
 * @param withUplink - whether the method declares the Client send half.
 * @returns the fake Context (for teardown) and the mounted probe namespace.
 */
export async function mountProbe(connection: unknown, withUplink: boolean): Promise<MountedProbe> {
  const ctx = createFakeContext(connection)
  apply(ctx as unknown as Context)
  const remote = ctx.remote
  assert.ok(remote !== undefined, 'apply() must register the remote service')
  await remote.$mount({ package: '@fixture/probe', descriptors: [attachDescriptor(withUplink)] })
  const probe = remote.probe
  assert.ok(probe !== undefined, 'the namespace service must expose the generated method')
  return { ctx, probe: probe as GeneratedProbe }
}
