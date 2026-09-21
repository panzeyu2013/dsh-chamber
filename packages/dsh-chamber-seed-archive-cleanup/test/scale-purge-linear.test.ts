/**
 * Full-capacity scale lock for the purge tail (audit P1).
 *
 * `purge`'s last two loops used Array.includes over clearIds/writeIds: at the
 * documented MAX_PURGE_SESSIONS = 65,536 capacity that is ~4.3e9 comparisons in
 * EACH loop, so a legitimate full-capacity run burned minutes in comparison
 * only (content already deleted). This test exercises the exact capacity
 * boundary and source-locks the Set membership shape, so the quadratic tail
 * cannot silently return.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ArchiveCleanupCore, MAX_PURGE_SESSIONS } from '../src/core.ts'
import { FakeHost, state } from './support/archive-host.ts'

test('purge at the full MAX_PURGE_SESSIONS capacity completes linearly', async () => {
  const host = new FakeHost()
  for (let index = 0; index < MAX_PURGE_SESSIONS; index += 1) {
    const id = `s-${index}`
    host.archived.add(id)
    host.states.set(id, state(id))
  }
  const core = new ArchiveCleanupCore(host)
  const started = performance.now()
  const result = await core.purge()
  const elapsed = performance.now() - started

  assert.equal(result.deletedSessions, MAX_PURGE_SESSIONS)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(result.skippedRunning, 0)
  assert.deepEqual(result.errors, [])
  assert.equal(host.deleteLog.length, MAX_PURGE_SESSIONS)
  assert.equal(host.removedFromArchived.length, MAX_PURGE_SESSIONS)
  // Coarse quadratic detector, not a benchmark: the Set implementation is one
  // pass over the same arrays the old includes scan walked n times.
  assert.ok(elapsed < 20_000, `full-capacity purge took ${Math.round(elapsed)}ms — the O(n²) tail is back`)
})

test('purge tail keeps Set membership (source lock against Array.includes regression)', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/core.ts', import.meta.url)), 'utf8')
  assert.match(source, /const clearIdSet = new Set\(clearIds\)/u)
  assert.match(source, /const writeIdSet = new Set\(writeIds\)/u)
  assert.match(source, /clearIdSet\.has\(root\)/u)
  assert.match(source, /writeIdSet\.has\(id\)/u)
  assert.doesNotMatch(source, /clearIds\.includes\(/u)
  assert.doesNotMatch(source, /writeIds\.includes\(/u)
})
