/**
 * The shared gateway refusal projection (client-core face) — absolute
 * verdicts, not merely self-consistency.
 *
 * The body matrix is the contract the gateway runtime routes ship. Asserting
 * the expected family/code per body — rather than only that two copies agree —
 * means a synchronized regression fails here.
 *
 * Run directly: node packages/dsh-chamber-client-ui-sidebar/test/shared/runtime-refusal.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRuntimeRefusal,
  serverRefusalText,
  type RuntimeRefusalKind,
} from '@dsh-chamber/dsh-chamber-client-core'

type Verdict = { kind: RuntimeRefusalKind; code: string | null } | null

/** [status, body, expected verdict] — the routes' shipped shapes. */
const CASES: ReadonlyArray<[number, unknown, Verdict]> = [
  [409, { error: 'managed dsh is not running (stopped); start the managed dsh first', code: 'runtime_busy' }, { kind: 'not-running', code: 'runtime_busy' }],
  [409, { error: 'a restart is already in flight', code: 'runtime_busy' }, { kind: 'busy', code: 'runtime_busy' }],
  [409, { error: 'another runtime mutation holds the profile write lease', code: 'runtime_busy' }, { kind: 'busy', code: 'runtime_busy' }],
  [409, { error: 'runtime recovery is required', code: 'runtime_recovery_required' }, { kind: 'busy', code: 'runtime_recovery_required' }],
  // Body-less / malformed 409s are still refusals, never verbatim text.
  [409, { code: 'runtime_busy' }, { kind: 'busy', code: 'runtime_busy' }],
  [409, { error: 42 }, { kind: 'busy', code: null }],
  [409, null, { kind: 'busy', code: null }],
  // Non-409s keep the caller's verbatim/status-anchored projection.
  [400, { error: 'bad request' }, null],
  [500, { error: 'gateway exploded' }, null],
  [503, null, null],
]

test('classifyRuntimeRefusal: every shipped body projects to its registered verdict', () => {
  for (const [status, body, expected] of CASES) {
    assert.deepEqual(classifyRuntimeRefusal(body, status), expected, status + ' ' + JSON.stringify(body))
  }
})

test('classifyRuntimeRefusal: a non-empty string code is required, and any other code shape is null', () => {
  assert.equal(classifyRuntimeRefusal({ code: '' }, 409)?.code, null)
  assert.equal(classifyRuntimeRefusal({ code: 7 }, 409)?.code, null)
  assert.equal(classifyRuntimeRefusal({ code: 'runtime_busy' }, 409)?.code, 'runtime_busy')
})

test('classifyRuntimeRefusal: "is not running" is matched case-insensitively at a word boundary', () => {
  assert.equal(classifyRuntimeRefusal({ error: 'Managed DSH is Not Running (starting)' }, 409)?.kind, 'not-running')
  // 'is not running' inside a longer word must not select the family.
  assert.equal(classifyRuntimeRefusal({ error: 'the check is not runningx' }, 409)?.kind, 'busy')
})

test('serverRefusalText: verbatim server error, else the status-anchored fallback', () => {
  assert.equal(serverRefusalText({ error: 'bad request' }, 400), 'bad request')
  assert.equal(serverRefusalText({ error: '' }, 503), 'restart refused (503)')
  assert.equal(serverRefusalText({ error: 42 }, 503), 'restart refused (503)')
  assert.equal(serverRefusalText(null, 503), 'restart refused (503)')
})
