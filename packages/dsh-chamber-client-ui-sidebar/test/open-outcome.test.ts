/**
 * open-outcome row-error contract (design 05 §3): the SidebarRoot writer and
 * the ServerSection reader must share one key template, and the delete
 * reducer must not churn state when the key is absent (rowErrors functional
 * updates compare references to skip re-renders).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openErrorKey, withoutOpenError } from '../src/shared/open-outcome.ts'

test('openErrorKey produces the reader/writer-shared rowErrors key shape', () => {
  assert.equal(openErrorKey('local', 'session-1'), 'local/session/session-1/open')
  assert.equal(openErrorKey('gateway-pve-ct-harness', 'session-1'), 'gateway-pve-ct-harness/session/session-1/open')
  // Key parts must stay distinct — a source or session id containing '/'
  // would collide only if the template also conflated them.
  assert.equal(openErrorKey('a/b', 'c'), 'a/b/session/c/open')
})

test('withoutOpenError deletes without churn when absent and preserves siblings when present', () => {
  const base = { 'a/session/x/rename': 'r', 'local/session/s-1/open': 'boom' }
  // Absent key: same reference (no churn — React skips the state update).
  assert.equal(withoutOpenError(base, 'local/session/missing/open'), base)
  // Present key: a new object without the key, siblings untouched.
  const next = withoutOpenError(base, 'local/session/s-1/open')
  assert.notEqual(next, base)
  assert.deepEqual(next, { 'a/session/x/rename': 'r' })
  assert.equal(next['a/session/x/rename'], 'r')
})
