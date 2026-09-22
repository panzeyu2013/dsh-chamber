/**
 * The shared error-text projections (sidebar shared face).
 *
 * These two primitives are intentionally different, and this file pins the
 * difference: errorMessage is the cheap verbatim projection (may be '' and may
 * throw on a hostile value), describeThrown is the catch-boundary projection
 * (never throws, never '').
 *
 * Run directly: node packages/dsh-chamber-client-ui-sidebar/test/shared/error-text.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeThrown, errorMessage } from '../../src/shared/error-text.ts'

/** An object whose message getter and both string coercions throw. */
function hostileThrowingBoth(): unknown {
  return {
    get message(): string { throw new Error('hostile getter') },
    get name(): string { throw new Error('hostile getter') },
    toString(): string { throw new Error('hostile toString') },
    [Symbol.toPrimitive](): string { throw new Error('hostile toPrimitive') },
  }
}

/** A proxy whose own prototype lookup throws (instanceof itself throws). */
function hostilePrototype(): unknown {
  return new Proxy({}, {
    getPrototypeOf(): object { throw new Error('hostile getPrototypeOf') },
  })
}

test('errorMessage: Error.message verbatim, everything else stringified', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage(new TypeError('typed')), 'typed')
  assert.equal(errorMessage('plain'), 'plain')
  assert.equal(errorMessage(undefined), 'undefined')
  assert.equal(errorMessage(null), 'null')
  assert.equal(errorMessage(42), '42')
  assert.equal(errorMessage({ message: 'not an Error' }), '[object Object]')
  // Documented difference from describeThrown: the cheap projection is allowed
  // to be empty, and it is allowed to throw on a hostile value.
  assert.equal(errorMessage(new Error('')), '')
  assert.throws(() => errorMessage(hostileThrowingBoth()))
})

test('describeThrown: message, then name, then String(), and never an empty string', () => {
  assert.equal(describeThrown(new Error('boom')), 'boom')
  const unnamed = new Error('')
  Object.defineProperty(unnamed, 'name', { value: 'CodeError' })
  assert.equal(describeThrown(unnamed), 'CodeError')
  assert.equal(describeThrown('plain'), 'plain')
  assert.equal(describeThrown(42), '42')
  assert.equal(describeThrown(null), 'null')
  assert.equal(describeThrown({ message: 'not an Error' }), '[object Object]')
  // Nothing readable -> the caller's fallback, or the default.
  assert.equal(describeThrown(''), 'unknown error')
  assert.equal(describeThrown('', 'unknown Git error'), 'unknown Git error')
})

test('describeThrown: hostile values settle on text instead of throwing', () => {
  // instanceof itself throws (hostile getPrototypeOf): the guarded Error branch
  // is skipped and String() still yields the object tag — text, never a throw.
  const proxyValue = hostilePrototype()
  assert.doesNotThrow(() => describeThrown(proxyValue))
  assert.equal(describeThrown(proxyValue), '[object Object]')
  // Hostile getters AND a throwing coercion: the caller gets the fallback.
  const hostile = hostileThrowingBoth()
  assert.equal(describeThrown(hostile), 'unknown error')
  assert.equal(describeThrown(hostile, 'unknown Git error'), 'unknown Git error')
  assert.equal(describeThrown({ toString: () => '' }), 'unknown error')
})

test('describeThrown: an Error whose message is not a string falls through to String()', () => {
  const weird = new Error('x')
  Object.defineProperty(weird, 'message', { value: 42 })
  assert.equal(describeThrown(weird), 'Error')
})
