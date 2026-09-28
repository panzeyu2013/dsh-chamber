/**
 * I-10: the status write-face probe's three branches.
 *
 * The executor (src/client/index.ts) must depend on THIS probe, not on the
 * concrete member name; the contract-growth watch lives in
 * vendor-session-fact-contract.test.ts against the pinned ISessions source.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTRACT_STATUS_WRITE_METHODS, detectStatusWriteFace } from '../../src/client/status-write-face.ts'

test('contract face wins over the concrete member and the write is bound to its owner', () => {
  const calls: [string, boolean][] = []
  const sessions = {
    setSessionStatus(sessionId: string, running: boolean) {
      calls.push([sessionId, running])
      assert.equal(this, sessions, 'the writer must be bound to the sessions owner')
    },
    handleSessionStatus() {
      throw new Error('the concrete member must not be used when the contract face exists')
    },
  }
  const face = detectStatusWriteFace(sessions, ['setSessionStatus'])
  assert.equal(face.kind, 'contract')
  assert.equal(face.member, 'setSessionStatus')
  assert.equal(face.nonContract, false)
  face.write?.('s1', false)
  assert.deepEqual(calls, [['s1', false]])
})

test('the upstream-public concrete member is the fallback, flagged non-contract', () => {
  const calls: [string, boolean][] = []
  const sessions = {
    handleSessionStatus(sessionId: string, running: boolean) { calls.push([sessionId, running]) },
  }
  const face = detectStatusWriteFace(sessions)
  assert.equal(face.kind, 'concrete')
  assert.equal(face.member, 'handleSessionStatus')
  assert.equal(face.nonContract, true)
  face.write?.('s2', false)
  assert.deepEqual(calls, [['s2', false]])
})

test('no write face degrades to the read-only ladder', () => {
  assert.equal(detectStatusWriteFace({ refresh: () => {} }).kind, 'none')
  assert.equal(detectStatusWriteFace({ handleSessionStatus: 'not a function' }).kind, 'none')
  assert.equal(detectStatusWriteFace(null).kind, 'none')
  assert.equal(detectStatusWriteFace(undefined).kind, 'none')
})

test('a throwing service proxy degrades to none instead of crashing the ladder', () => {
  const throwing = new Proxy({}, { get() { throw new Error('service unavailable') } })
  const face = detectStatusWriteFace(throwing)
  assert.equal(face.kind, 'none')
  assert.equal(face.write, undefined)
})

test('the contract table is empty at the current pin — the vendor lockstep owns the growth watch', () => {
  assert.deepEqual(CONTRACT_STATUS_WRITE_METHODS, [])
})
