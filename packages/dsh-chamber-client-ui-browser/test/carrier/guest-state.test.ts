/** FW2 guest state machine: lease races, state adoption, forwarded transition, history. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptsForwardNegotiation, acceptsStatePush, canonicalOrigin, historyAdoptAction,
  isLoopbackNegotiationTarget, planLeaseSettle, projectAckFailure, transitionForwarded,
} from '../../src/client/browser/guest-state.ts'

test('an acquire that settles after dispose releases the minted lease', () => {
  assert.deepEqual(planLeaseSettle(false, { ok: true, lease: 'l1' }), { adopt: 'l1' })
  assert.deepEqual(planLeaseSettle(true, { ok: true, lease: 'l1' }), { release: 'l1' })
  assert.deepEqual(planLeaseSettle(true, { ok: false, code: 'limit' }), {})
  assert.deepEqual(planLeaseSettle(false, { ok: false, code: 'limit' }), { failure: 'limit' })
})

test('a state push is accepted only for the current lease', () => {
  assert.equal(acceptsStatePush(false, 'tab-1', { tabId: 'tab-1', lease: 'l1' }, 'l1'), true)
  assert.equal(acceptsStatePush(false, 'tab-1', { tabId: 'tab-2', lease: 'l1' }, 'l1'), false)
  assert.equal(acceptsStatePush(false, 'tab-1', { tabId: 'tab-1', lease: 'l0' }, 'l1'), false)
  assert.equal(acceptsStatePush(false, 'tab-1', { tabId: 'tab-1', lease: 'l1' }, undefined), false)
  assert.equal(acceptsStatePush(true, 'tab-1', { tabId: 'tab-1', lease: 'l1' }, 'l1'), false)
})

test('a refused ack is projected into the failure bar', () => {
  assert.equal(projectAckFailure({ ok: true }), undefined)
  assert.deepEqual(projectAckFailure({ ok: false, code: 'limit' }), { code: undefined, description: 'limit' })
  assert.deepEqual(projectAckFailure({ ok: false }), { code: undefined, description: 'unknown' })
})

test('leaving the alias origin drops the forwarded projection', () => {
  const alias = 'http://127.0.0.7:41000'
  assert.deepEqual(transitionForwarded(true, alias, alias + '/app'), { forwarded: true, origin: alias, adopt: false })
  assert.deepEqual(transitionForwarded(true, alias, 'https://example.com/x'), { forwarded: false, adopt: true })
  assert.deepEqual(transitionForwarded(false, undefined, alias + '/app'), { forwarded: false, adopt: true })
  assert.equal(canonicalOrigin('javascript:alert(1)'), undefined)
})

test('a late forward negotiation is dropped unless generation/lease still hold (R4-01)', () => {
  const ok = { disposed: false, generationMatches: true, leaseMatches: true }
  assert.equal(acceptsForwardNegotiation(ok), true)
  assert.equal(acceptsForwardNegotiation({ ...ok, disposed: true }), false, 'disposed')
  for (const broken of ['generationMatches', 'leaseMatches'] as const) {
    assert.equal(acceptsForwardNegotiation({ ...ok, [broken]: false }), false, broken)
  }
})

test('a forward negotiation target must be a loopback target (R4-01)', () => {
  // Main pushes the SUSPENDED target; the address on screen is a different page.
  assert.equal(isLoopbackNegotiationTarget('http://127.0.0.1:5173/'), true)
  assert.equal(isLoopbackNegotiationTarget('http://localhost:3000/app'), true)
  assert.equal(isLoopbackNegotiationTarget('http://[::1]:8080/'), true)
  // m1: Swift canonicalHost normalizes the mapped IPv6 spellings to 127.0.0.1
  // before it pushes forward-needed, so this class gate must accept them; the
  // resolver then answers the failure bar (the forward target set is only
  // 127.0.0.1/localhost) instead of the push being silently dropped.
  assert.equal(isLoopbackNegotiationTarget('http://[::ffff:7f00:1]:8080/'), true)
  assert.equal(isLoopbackNegotiationTarget('http://[::ffff:127.0.0.1]:8080/'), true,
    'the URL parser normalizes the dotted mapped form to [::ffff:7f00:1]')
  // D6 tail-dot: the FQDN root spelling compares equal to the plain loopback host
  // (mirrors Swift canonicalHost's trailing-dot strip).
  assert.equal(isLoopbackNegotiationTarget('http://localhost.:3000/'), true)
  assert.equal(isLoopbackNegotiationTarget('http://127.0.0.1.:3000/'), true)
  // Anything else is not a negotiation target, whatever main claims.
  assert.equal(isLoopbackNegotiationTarget('https://example.com/'), false)
  assert.equal(isLoopbackNegotiationTarget('http://127.0.0.2:5173/'), false)
  assert.equal(isLoopbackNegotiationTarget('file:///etc/passwd'), false)
  assert.equal(isLoopbackNegotiationTarget('not a url'), false)
})

test('an existing history entry moves the cursor instead of appending', () => {
  const urls = ['http://a/', 'http://b/', 'http://c/']
  assert.deepEqual(historyAdoptAction(urls, 2, 'http://b/'), { kind: 'reuse', index: 1 })
  assert.deepEqual(historyAdoptAction(urls, 1, 'http://d/'), { kind: 'append', entries: ['http://a/', 'http://b/'], index: 2 })
  assert.deepEqual(historyAdoptAction([], -1, 'http://a/'), { kind: 'append', entries: [], index: 0 })
})

