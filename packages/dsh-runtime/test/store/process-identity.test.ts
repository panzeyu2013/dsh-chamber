/**
 * process-identity unit tests: the two kernel facts the installer pid evidence carries
 * (Linux boot id + /proc start ticks) and the conservative staleness truth table. The
 * cleanup integration is covered in dsh-runtime-store.test.ts; these tests pin the
 * pure boundary: parsing fail-closed, legacy compatibility, and when identity mismatch
 * may reclaim a slot (design 18 §4).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPidEvidenceStale,
  parsePidEvidence,
  readBootId,
  readProcessStartTicks,
  serializePidEvidence,
} from '../../src/process-identity.ts'

function probe(bootId: string | null, ticks: number | null, alive: (pid: number, group?: boolean) => boolean) {
  return { bootId: () => bootId, startTicks: () => ticks, alive }
}

test('parsePidEvidence: legacy bare pid stays readable (forward compatibility)', () => {
  assert.deepEqual(parsePidEvidence('4242'), { kind: 'legacy', pid: 4242 })
  assert.deepEqual(parsePidEvidence(' 4242\n'), { kind: 'legacy', pid: 4242 })
})

test('parsePidEvidence: v1 JSON identity, each half nullable', () => {
  assert.deepEqual(
    parsePidEvidence(JSON.stringify({ v: 1, pid: 7, bootId: 'boot-a', startTicks: 99 })),
    { kind: 'identity', pid: 7, bootId: 'boot-a', startTicks: 99 },
  )
  assert.deepEqual(
    parsePidEvidence(JSON.stringify({ v: 1, pid: 7, bootId: null, startTicks: null })),
    { kind: 'identity', pid: 7, bootId: null, startTicks: null },
  )
  // A malformed half degrades to null rather than poisoning the whole record.
  assert.deepEqual(
    parsePidEvidence(JSON.stringify({ v: 1, pid: 7, bootId: 5, startTicks: 'x' })),
    { kind: 'identity', pid: 7, bootId: null, startTicks: null },
  )
})

test('parsePidEvidence: junk is null (fail-closed, never a fabricated pid)', () => {
  for (const junk of ['', '   ', 'abc', '0', '-3', '1.5', '{}', '[]', 'null', '{"v":2,"pid":7}', '{"v":1,"pid":0}', '{"v":1,"pid":"7"}', '{"v":1,"pid":7,"bootId":undefined}']) {
    assert.equal(parsePidEvidence(junk), null, 'junk must not parse: ' + junk)
  }
})

test('isPidEvidenceStale: legacy evidence trusts the liveness probe', () => {
  const evidence = { kind: 'legacy' as const, pid: 424242 }
  assert.equal(isPidEvidenceStale(evidence, probe('boot-a', 5, (pid, group) => group !== true && pid === 424242)), false)
  // The group outlives a crashed leader: never reclaim while it is live.
  assert.equal(isPidEvidenceStale(evidence, probe('boot-a', null, (pid, group) => group === true && pid === 424242)), false)
  assert.equal(isPidEvidenceStale(evidence, probe('boot-a', null, () => false)), true)
})

test('isPidEvidenceStale: another boot cannot describe a live writer', () => {
  const evidence = { kind: 'identity' as const, pid: 424242, bootId: 'boot-old', startTicks: 777 }
  // The pid may even be alive now — it is a NEW process reusing the number.
  assert.equal(isPidEvidenceStale(evidence, probe('boot-new', 777, () => true)), true)
})

test('isPidEvidenceStale: same boot with different start ticks = recycled pid', () => {
  const evidence = { kind: 'identity' as const, pid: 424242, bootId: 'boot-a', startTicks: 777 }
  assert.equal(isPidEvidenceStale(evidence, probe('boot-a', 888, (pid, group) => group !== true && pid === 424242)), true)
  // A still-live process GROUP keeps the evidence: a leftover descendant may own it.
  assert.equal(isPidEvidenceStale(evidence, probe('boot-a', 888, (pid, group) => group === true && pid === 424242)), false)
  // Matching ticks: the recorded process is the live one.
  assert.equal(isPidEvidenceStale(evidence, probe('boot-a', 777, () => true)), false)
})

test('isPidEvidenceStale: without a kernel identity the liveness probe decides', () => {
  const evidence = { kind: 'identity' as const, pid: 424242, bootId: null, startTicks: null }
  assert.equal(isPidEvidenceStale(evidence, probe(null, null, () => true)), false)
  assert.equal(isPidEvidenceStale(evidence, probe(null, null, () => false)), true)
})

test('serializePidEvidence round-trips through parsePidEvidence on every platform', () => {
  const text = serializePidEvidence(process.pid)
  const parsed = parsePidEvidence(text)
  assert.ok(parsed !== null, 'serialized evidence must parse: ' + text)
  assert.equal(parsed.pid, process.pid)
})

test('readBootId / readProcessStartTicks fail soft rather than throw', () => {
  // /proc is absent on macOS/Windows: both halves must be null, never an exception.
  const bootId = readBootId()
  assert.ok(bootId === null || typeof bootId === 'string')
  assert.equal(readProcessStartTicks(2 ** 30), null, 'a never-used pid has no start ticks')
  assert.equal(readProcessStartTicks(0), null)
})

test('on Linux the /proc parser yields a positive, stable start tick', { skip: process.platform !== 'linux' }, () => {
  assert.notEqual(readBootId(), null)
  const first = readProcessStartTicks(process.pid)
  assert.ok(typeof first === 'number' && first >= 0, 'pid start ticks must parse: ' + String(first))
  assert.equal(readProcessStartTicks(process.pid), first)
})
