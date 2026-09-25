import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPurgedSessionStore,
  legacySessionRecheckDelay,
  legacyStaleSessionCandidates,
  legacyStaleSessionProtectedIds,
  parsePurgedSessionState,
  purgedSessionStateKey,
} from '../../src/client/purged-session-store.ts'

test('purged session state is versioned, source-scoped, and round-trips only bounded ids', () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
  const local = createPurgedSessionStore('local', 'fingerprint-a', storage)
  const remote = createPurgedSessionStore('local', 'fingerprint-b', storage)
  local.save({ purgedIds: ['gone'], knownSessionIds: ['live', 'gone'] })

  assert.deepEqual(local.load(), { purgedIds: ['gone'], knownSessionIds: ['live', 'gone'] })
  assert.equal(remote.load(), undefined, 'a new source incarnation cannot inherit old session ids')
  assert.notEqual(purgedSessionStateKey('local', 'fingerprint-a'), purgedSessionStateKey('local', 'fingerprint-b'))
  assert.equal(parsePurgedSessionState('{bad json'), undefined)
  assert.equal(parsePurgedSessionState('{"v":2,"purgedIds":["gone"]}'), undefined)
})

test('purged session storage tolerates private-mode failures and removes malformed ids', () => {
  const storage = {
    getItem: () => JSON.stringify({ v: 1, purgedIds: ['ok', null, '', 'ok'], knownSessionIds: ['x'] }),
    setItem: () => { throw new Error('quota') },
  }
  const safe = createPurgedSessionStore('local', 'fingerprint-a', storage)
  assert.deepEqual(safe.load(), { purgedIds: ['ok'], knownSessionIds: ['x'] })
  assert.doesNotThrow(() => safe.save({ purgedIds: ['gone'], knownSessionIds: [] }))
})

test('legacy cleanup candidates exclude running, blank and recently active session rows', () => {
  assert.deepEqual([...legacyStaleSessionCandidates({
    deleted: { updatedAt: 0 },
    active: { running: true, updatedAt: 10 },
    blank: { blank: true, updatedAt: 10 },
    recentlyActive: { updatedAt: 59_999 },
    missingActivity: {},
  }, 60_000)].sort(), ['deleted', 'missingActivity'])
})

test('legacy recent-row protection schedules one recheck after grace, while active and blank rows wait for state changes', () => {
  const summaries = {
    recent: { updatedAt: 9_500 },
    running: { running: true, updatedAt: 1_000 },
    blank: { blank: true, updatedAt: 1_000 },
    old: { updatedAt: 8_000 },
    present: { updatedAt: 1_000 },
  }
  const missing = new Set(['recent', 'running', 'blank', 'old'])
  const protectedIds = legacyStaleSessionProtectedIds(summaries, missing, 10_000, 1_000)

  assert.deepEqual([...protectedIds].sort(), ['blank', 'recent', 'running'])
  assert.equal(legacySessionRecheckDelay(summaries, protectedIds, 10_000, 1_000), 500)
  assert.equal(legacySessionRecheckDelay(summaries, protectedIds, 10_500, 1_000), 0)
  assert.equal(legacySessionRecheckDelay(summaries, new Set(['running', 'blank']), 10_000, 1_000), undefined)
})
