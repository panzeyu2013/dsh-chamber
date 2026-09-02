/**
 * Design 18 registry SRI unit tests: parse/strength rules of registry-integrity.ts.
 *
 * The acceptance harness (runtime-fake-registry-acceptance.mjs) proves the
 * happy-path SRI on a real tarball; these hermetic cases pin the parser's
 * downgrade resistance — a matching weaker digest must never rescue a
 * mismatching stronger one, and malformed encodings must be rejected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createIntegrityVerifier, isSupportedIntegrity } from '../src/registry-integrity.ts'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64')
const sha384 = (bytes: Uint8Array): string => createHash('sha384').update(bytes).digest('base64')
const sha512 = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('base64')

const PAYLOAD = new TextEncoder().encode('dsh runtime tarball fixture bytes')

test('isSupportedIntegrity: accepts a single valid sha256/sha384/sha512 token', () => {
  assert.equal(isSupportedIntegrity(`sha256-${sha256(PAYLOAD)}`), true)
  assert.equal(isSupportedIntegrity(`sha384-${sha384(PAYLOAD)}`), true)
  assert.equal(isSupportedIntegrity(`sha512-${sha512(PAYLOAD)}`), true)
})

test('isSupportedIntegrity: rejects empty, non-string, and malformed encodings', () => {
  assert.equal(isSupportedIntegrity(''), false)
  assert.equal(isSupportedIntegrity('   '), false)
  assert.equal(isSupportedIntegrity(null), false)
  assert.equal(isSupportedIntegrity(undefined), false)
  assert.equal(isSupportedIntegrity(42), false)
  // Wrong digest length for the algorithm.
  assert.equal(isSupportedIntegrity('sha256-AAAA'), false)
  // Truncated base64 that Buffer.from would silently accept must be rejected
  // via the strict re-encode check.
  assert.equal(isSupportedIntegrity(`sha256-${sha256(PAYLOAD).slice(0, -2)}`), false)
  // Unsupported algorithm.
  assert.equal(isSupportedIntegrity(`sha1-${createHash('sha1').update(PAYLOAD).digest('base64')}`), false)
  // Non-base64 charset.
  assert.equal(isSupportedIntegrity('sha256-!!!!'), false)
})

test('parse: strongest algorithm wins; a weaker matching digest cannot rescue a stronger mismatch', () => {
  const weakCorrect = sha256(PAYLOAD)
  const strongWrong = sha512(new TextEncoder().encode('tampered bytes'))
  // Both tokens present, strong digest wrong → must NOT match even though the
  // weak digest is correct (SRI downgrade resistance).
  const verifier = createIntegrityVerifier(`sha256-${weakCorrect} sha512-${strongWrong}`)
  verifier.update(PAYLOAD)
  assert.throws(() => verifier.assertMatch(), /integrity mismatch/, 'weaker correct digest must not rescue a stronger mismatch')
})

test('parse: only the strongest algorithm is verified, and its matching digest passes', () => {
  const strong = sha512(PAYLOAD)
  const weakCorrect = sha256(PAYLOAD)
  const verifier = createIntegrityVerifier(`sha256-${weakCorrect} sha512-${strong}`)
  verifier.update(PAYLOAD)
  assert.doesNotThrow(() => verifier.assertMatch())
})

test('createIntegrityVerifier: streaming verify passes on exact bytes and fails on tamper', () => {
  const good = createIntegrityVerifier(`sha256-${sha256(PAYLOAD)}`)
  good.update(PAYLOAD)
  assert.doesNotThrow(() => good.assertMatch())

  const tampered = createIntegrityVerifier(`sha256-${sha256(PAYLOAD)}`)
  tampered.update(new TextEncoder().encode('tampered bytes'))
  assert.throws(() => tampered.assertMatch(), /integrity mismatch/)

  // Chunked updates produce the same digest as one-shot.
  const chunked = createIntegrityVerifier(`sha256-${sha256(PAYLOAD)}`)
  for (const byte of PAYLOAD) chunked.update(Uint8Array.of(byte))
  assert.doesNotThrow(() => chunked.assertMatch())
})

test('createIntegrityVerifier: rejects double finalization and missing integrity', () => {
  assert.throws(() => createIntegrityVerifier(''), /缺少可用的 sha256\/sha384\/sha512 integrity/)
  const verifier = createIntegrityVerifier(`sha256-${sha256(PAYLOAD)}`)
  verifier.update(PAYLOAD)
  verifier.assertMatch()
  assert.throws(() => verifier.update(Uint8Array.of(1)), /already finalized/)
  assert.throws(() => verifier.assertMatch(), /already finalized/)
})

test('parse: oversized integrity strings are rejected (bounded parse)', () => {
  const huge = `sha256-${'A'.repeat(5000)}`
  assert.equal(isSupportedIntegrity(huge), false)
})
