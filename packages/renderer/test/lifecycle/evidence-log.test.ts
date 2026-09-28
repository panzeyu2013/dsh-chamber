/**
 * The bounded, persisted evidence ledger (design 14 §D4): every liveness verdict —
 * accepted or rejected — must be answerable after the fact, including across a reload.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVIDENCE_LOG_STORAGE_KEY,
  evidenceLogText,
  readEvidenceLog,
  readPersistedEvidenceLog,
  recordEvidence,
  resetEvidenceLogForTests,
} from '../../../dsh-chamber-client-core/src/evidence-log.ts'

function withFakeStorage<T>(run: (store: Map<string, string>) => T): T {
  const store = new Map<string, string>()
  const fake = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true })
  try {
    return run(store)
  } finally {
    Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

test('every verdict is recorded with its provenance and booking outcome', () => {
  resetEvidenceLogForTests()
  withFakeStorage(() => {
    recordEvidence('mux-facts', 'deadline', { source: 'local', budgetMs: 5_000 }, true)
    recordEvidence('mux-facts', 'unscheduled', { source: 'local', windowMs: 5_100 }, false)
  })
  const entries = readEvidenceLog()
  assert.equal(entries.length, 2)
  assert.equal(entries[0].owner, 'mux-facts')
  assert.equal(entries[0].verdict, 'deadline')
  assert.equal(entries[0].booked, true)
  assert.equal(entries[1].verdict, 'unscheduled')
  assert.equal(entries[1].booked, false)
  assert.equal(entries[1].detail.windowMs, 5_100)
  assert.match(evidenceLogText(), /unscheduled booked=false mux-facts/)
})

test('the ledger survives a reload through bounded, versioned persistence', () => {
  resetEvidenceLogForTests()
  withFakeStorage((store) => {
    recordEvidence('facts-stream', 'unscheduled', { source: 'gateway-pve-ct-harness' }, false)
    assert.equal(store.has(EVIDENCE_LOG_STORAGE_KEY), true)
    const persisted = readPersistedEvidenceLog()
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].verdict, 'unscheduled')
  })
  // Storage gone (a fresh private session) never throws and yields an empty tail.
  assert.deepEqual(readPersistedEvidenceLog(), [])
})
