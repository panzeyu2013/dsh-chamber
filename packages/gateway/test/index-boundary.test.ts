import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerRequest } from '@dsh-chamber/control-plane'
import { createSessionIndex } from '../src/features/index.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('session index drops mux business frames before the baseline buffer retains them', async () => {
  let releaseBaseline!: () => void
  const baselineGate = new Promise<void>(resolve => { releaseBaseline = resolve })
  let baselineStarted = false
  let eventYielded = false
  let forbidLatePayloadRead = false
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger: { log() {}, warn() {}, error() {} },
    reconnectDelayMs: 5,
    callDsh: (async () => {
      baselineStarted = true
      await baselineGate
      return {
        rpcId: 'baseline',
        result: { ok: true, value: { items: [{
          sessionId: 's1', updatedAt: 1, running: false, blank: true,
          projections: { asOfSeq: -1, values: {} },
        }] } },
      }
    }) as any,
    openStream: async function *(_base, path, signal, onOpen): AsyncGenerator<ServerRequest> {
      onOpen?.()
      if (path.endsWith('mux')) {
        const businessFrame = {
          type: 'server-request' as const,
          rpcId: 'event',
          method: 'session/event',
        } as ServerRequest
        Object.defineProperty(businessFrame, 'payload', {
          enumerable: true,
          get() {
            if (forbidLatePayloadRead) throw new Error('session/event was retained across the baseline')
            return { sessionId: 's1', event: { transcript: 'private session body' } }
          },
        })
        eventYielded = true
        yield businessFrame
        yield {
          type: 'server-request', rpcId: 'title', method: 'session/projection',
          payload: { sessionId: 's1', key: 'title', value: 'Live title', seq: 1 },
        }
      } else {
        yield {
          type: 'server-request', rpcId: 'running', method: 'host/session-status',
          payload: { sessionId: 's1', running: true },
        }
      }
      if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    },
  })

  index.start()
  await waitFor(() => baselineStarted && eventYielded)
  forbidLatePayloadRead = true
  releaseBaseline()
  await waitFor(() => index.get('s1')?.title === 'Live title' && index.get('s1')?.running === true)
  assert.equal(index.get('s1')?.blank, false)
  index.stop()
})

test('session index drops unknown metadata, truncates display fields and skips malformed rows instead of wedging the generation', async () => {
  const warnings: string[] = []
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger: { log() {}, warn(message) { warnings.push(String(message)) }, error() {} },
    reconnectDelayMs: 5,
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
    openStream: async function *(_base, _path, signal, onOpen): AsyncGenerator<ServerRequest> {
      onOpen?.()
      if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    },
  })

  index.start()
  await waitFor(() => index.get('ok') !== undefined)
  assert.equal(index.get('future')?.metadata?.blank, true)
  assert.equal('archivedAt' in (index.get('future')?.metadata ?? {}), false, 'unknown metadata keys never enter the projection')
  assert.equal(index.get('long')?.title?.length, 4_096, 'overlong titles are truncated to the projection bound')
  assert.equal(index.get('long')?.cwd?.length, 32_768, 'overlong cwds are truncated to the projection bound')
  assert.equal(index.get(42 as never), undefined, 'malformed rows are skipped, not wedging the generation')
  assert.equal(index.get('null-projections'), undefined, 'nullable projection rows are isolated')
  assert.equal(warnings.some(message => message.includes('skipping a malformed session.list row')), true)
  index.stop()
})

test('session index bounds relevant control frames while waiting for session.list', async () => {
  let releaseFirstBaseline!: () => void
  const firstBaselineGate = new Promise<void>(resolve => { releaseFirstBaseline = resolve })
  let baselineCalls = 0
  let muxCalls = 0
  let firstFloodFinished = false
  const warnings: string[] = []
  const index = createSessionIndex({
    getDshBaseUrl: () => 'http://127.0.0.1:12345',
    logger: { log() {}, warn(message) { warnings.push(String(message)) }, error() {} },
    reconnectDelayMs: 5,
    callDsh: (async () => {
      baselineCalls += 1
      if (baselineCalls === 1) await firstBaselineGate
      return {
        rpcId: `baseline-${baselineCalls}`,
        result: { ok: true, value: { items: [{
          sessionId: 'stable', updatedAt: 1, running: false, blank: true,
          projections: { asOfSeq: -1, values: {} },
        }] } },
      }
    }) as any,
    openStream: async function *(_base, path, signal, onOpen): AsyncGenerator<ServerRequest> {
      onOpen?.()
      if (path.endsWith('mux')) {
        muxCalls += 1
        if (muxCalls === 1) {
          try {
            for (let i = 0; i < 4_097; i += 1) {
              yield {
                type: 'server-request', rpcId: '', method: 'session/subscribed',
                payload: { sessionId: `buffered-${i}` },
              }
            }
          } finally {
            firstFloodFinished = true
          }
        }
      }
      if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    },
  })

  index.start()
  await waitFor(() => firstFloodFinished)
  releaseFirstBaseline()
  await waitFor(() => warnings.some(message => message.includes('baseline control buffer exceeded')))
  await waitFor(() => baselineCalls >= 2 && index.get('stable') !== undefined)
  assert.equal(index.list().length, 1)
  index.stop()
})
