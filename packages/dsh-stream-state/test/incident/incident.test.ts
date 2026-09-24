/**
 * The unified incident ring: bounded, sanitized, and readable through the one
 * global view every shell shares.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IncidentInstrument, installIncidentInstrument } from '../../src/incident.ts'

/** The one documented global name, asserted as a literal so a rename is a failure. */
const GLOBAL_KEY = '__dshChamberIncident'

test('the ring is bounded and seq survives eviction', () => {
  const instrument = new IncidentInstrument()
  const target: Record<string, unknown> = {}
  installIncidentInstrument(target, instrument)
  const cap = (target[GLOBAL_KEY] as { cap: number }).cap
  assert.equal(cap, 512, 'the acceptance driver reads the cap from the one global view')
  for (let index = 0; index < cap + 10; index += 1) {
    instrument.record({ at: index, source: 'renderer', kind: 'delivery-symptom', detail: 'x' })
  }
  const entries = instrument.snapshot()
  assert.equal(instrument.size, cap)
  assert.equal(entries.length, cap)
  assert.equal(entries[0]?.seq, 11, 'older entries were evicted, the order counter kept counting')
  assert.equal(entries.at(-1)?.seq, cap + 10)
  assert.equal(instrument.record({ source: 'renderer', kind: 'k' }).seq, cap + 11)
})

test('entries are sanitized: token kind, bounded ids, redacted detail', () => {
  const instrument = new IncidentInstrument()
  const entry = instrument.record({
    at: Number.NaN,
    source: 'not-a-shell' as never,
    kind: 'Frame STOPPED!',
    runId: 'r'.repeat(300),
    sessionId: 's1',
    sourceId: 'gateway-a',
    symptom: 'input block',
    action: 'resync',
    detail: 'Authorization: Bearer super-secret-token connect failed',
  })
  assert.equal(entry.source, 'renderer', 'an unknown source falls back to the resident shell')
  assert.equal(entry.kind, 'frame-stopped')
  assert.equal(entry.at, 0, 'an unusable stamp is conservatively 0')
  assert.equal(entry.runId, undefined, 'an over-long run id is dropped rather than truncated to a wrong id')
  assert.equal(entry.sessionId, 's1')
  assert.equal(entry.sourceId, 'gateway-a')
  assert.equal(entry.symptom, 'input-block')
  assert.equal(entry.action, 'resync')
  assert.ok(!entry.detail.includes('super-secret-token'))
  assert.ok(entry.detail.includes('Authorization=***'))
})

test('the global view writes and reads through one object', () => {
  const target: Record<string, unknown> = {}
  const instrument = new IncidentInstrument()
  installIncidentInstrument(target, instrument)
  const view = target[GLOBAL_KEY] as {
    entries(): readonly unknown[]
    record(draft: { source: 'renderer'; kind: string }): unknown
    clear(): void
  }
  view.record({ source: 'renderer', kind: 'carrier-break' })
  assert.equal(view.entries().length, 1)
  assert.equal(instrument.size, 1, 'the view is live, not a snapshot copy')
  view.clear()
  assert.equal(view.entries().length, 0)
  assert.equal(instrument.size, 0)
})
