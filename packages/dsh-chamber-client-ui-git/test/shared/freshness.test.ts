/**
 * Action preflight freshness (design 08 §5 / design 26 §D7).
 *
 * A page-dispatch-budget refusal RESOLVES with the previous state instead of
 * rejecting (the polling path's deliberate behaviour), so an action that demands
 * "refresh first" must read the pull's own timestamp — otherwise a removal/adopt
 * would run on facts up to ceil(N/2) x 30s stale while every gate looks passed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { refreshedSince } from '../../src/shared/freshness.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const COORDINATOR = fileURLToPath(new URL('../../src/shared/coordinator.ts', import.meta.url))

test('refreshedSince: only a pull that bumped updatedAt at/after startedAt is fresh', () => {
  assert.equal(refreshedSince(undefined, 1_000), false, 'no state at all is not fresh')
  assert.equal(refreshedSince({}, 1_000), false, 'a state that never completed a pull is not fresh')
  assert.equal(refreshedSince({ updatedAt: 999 }, 1_000), false, 'the previous state (refusal path) is stale')
  assert.equal(refreshedSince({ updatedAt: 1_000 }, 1_000), true, 'same-millisecond completion counts as fresh')
  assert.equal(refreshedSince({ updatedAt: 1_001 }, 1_000), true, 'a completed pull after the action began is fresh')
})

test('lock: every action preflight applies the freshness gate, and a refusal never bumps updatedAt', async () => {
  const source = stripComments(await readFile(COORDINATOR, 'utf8'))
  assert.equal(
    (source.match(/refreshedSince\(/g) ?? []).length, 3,
    'the three action preflights (remove / remove-unregistered / adopt) must each call refreshedSince',
  )
  assert.match(source, /import \{ NOT_DISPATCHED_CODE \} from '.\/not-dispatched.ts'/,
    'the polling special-case compares the shared literal, not a re-typed string')
  // The stamp must be taken BEFORE the await, otherwise a pull that completes
  // inside the same millisecond could look older than the action.
  assert.equal((source.match(/const refreshStartedAt = Date\.now\(\)\n\s+const fresh = await refreshSource\(sourceId, true\)/g) ?? []).length, 3,
    'all three action preflights stamp the start time before awaiting the pull')
  // Between the refusal branch opening and the next closing brace, the coordinator
  // must not touch updatedAt: a deferred pull has to stay visibly old so the gates
  // above reject it (a "helpful" bump would silently defeat them).
  const branch = source.slice(source.indexOf('error.code === NOT_DISPATCHED_CODE'))
  const block = branch.slice(0, branch.indexOf('\n    }'))
  assert.doesNotMatch(block, /updatedAt/, 'the not-dispatched branch must not stamp updatedAt')
  assert.match(block, /return current/, 'the polling path still resolves with the previous state')
})
