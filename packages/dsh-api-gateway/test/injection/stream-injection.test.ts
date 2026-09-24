/**
 * Cross-shell acceptance (P1): the page harness drives the SHIPPED carrier
 * composition end to end.
 *
 * The wrapper options below are exactly the ones $stream installs (the page
 * global reader and RemoteStreamCarrierError), so a break observed here is the
 * retryable error the retry lane owns - not a test-only lookalike. The last case
 * proves the carrier leg's evidence lands in the one incident ring the renderer
 * reads back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IncidentInstrument,
  createInjectionHarness,
  installIncidentInstrument,
  installInjectionHarness,
  readInjectionHarness,
  wrapOpenWithInjection,
} from '@dsh-chamber/dsh-stream-state'
import { RemoteStreamCarrierError } from '../../src/client/stream-client.ts'

/** The documented page global (a literal so a rename is a cross-shell failure). */
const INJECTION_GLOBAL = '__dshChamberInjection'
/** The documented incident global the renderer installs and every shell reads. */
const INCIDENT_GLOBAL = '__dshChamberIncident'

/** Exactly the composition `$stream` installs. */
function shippedWrapper<Item>(open: (signal: AbortSignal) => AsyncIterable<Item>) {
  return wrapOpenWithInjection(open, {
    name: 'acceptance',
    harness: () => readInjectionHarness(globalThis),
    makeBreakError: reason => new RemoteStreamCarrierError(reason),
  })
}

test('without an installed harness the shipped wrapper forwards items unchanged', async () => {
  delete (globalThis as Record<string, unknown>)[INJECTION_GLOBAL]
  async function* source(): AsyncGenerator<number> {
    yield 1
    yield 2
  }
  const seen: number[] = []
  for await (const item of shippedWrapper(source)(new AbortController().signal)) seen.push(item)
  assert.deepEqual(seen, [1, 2])
})

test('an armed break-streams fault surfaces as the retryable carrier error', async () => {
  const harness = createInjectionHarness()
  installInjectionHarness(globalThis, harness)
  try {
    async function* source(): AsyncGenerator<number> {
      yield 1
    }
    harness.arm({ scenario: 'break-streams', everyMs: 0, count: 1 })
    await assert.rejects(async () => {
      for await (const _item of shippedWrapper(source)(new AbortController().signal)) { /* consume */ }
    }, (error: unknown) => error instanceof RemoteStreamCarrierError,
    'the retry lane must receive its own carrier error type, not a generic Error')
  } finally {
    harness.clear()
    delete (globalThis as Record<string, unknown>)[INJECTION_GLOBAL]
  }
})

test('an armed append-silent fault starves the consumer until the generation aborts', async () => {
  const harness = createInjectionHarness()
  installInjectionHarness(globalThis, harness)
  try {
    async function* source(): AsyncGenerator<number> {
      yield 1
      await new Promise<void>(() => {})
    }
    harness.arm({ scenario: 'append-silent', everyMs: 0, count: 1 })
    const abort = new AbortController()
    const seen: number[] = []
    const consuming = (async (): Promise<void> => {
      for await (const item of shippedWrapper(source)(abort.signal)) seen.push(item)
    })()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(seen, [], 'bytes were appended but never signaled')
    abort.abort()
    await consuming
    assert.deepEqual(seen, [])
  } finally {
    harness.clear()
    delete (globalThis as Record<string, unknown>)[INJECTION_GLOBAL]
  }
})

test('the carrier leg records the break into the one incident ring', () => {
  const incident = new IncidentInstrument()
  installIncidentInstrument(globalThis, incident)
  try {
    incident.record({
      at: 1_000,
      source: 'carrier',
      kind: 'carrier-break',
      runId: 'host:turn%2F7',
      sessionId: 's1',
      symptom: 'content-stall',
      detail: 'socket closed mid-frame',
    })
    const view = (globalThis as Record<string, unknown>)[INCIDENT_GLOBAL] as {
      entries(): readonly Record<string, unknown>[]
    }
    const last = view.entries().at(-1)
    assert.equal(last?.source, 'carrier')
    assert.equal(last?.kind, 'carrier-break')
    assert.equal(last?.runId, 'host:turn%2F7', 'the run identity travels with the evidence')
    assert.equal(last?.sessionId, 's1')
    assert.equal(last?.symptom, 'content-stall')
    assert.equal(last?.detail, 'socket closed mid-frame')
  } finally {
    delete (globalThis as Record<string, unknown>)[INCIDENT_GLOBAL]
  }
})
