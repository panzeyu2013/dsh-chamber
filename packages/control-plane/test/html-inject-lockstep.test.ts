/**
 * S0 twin-cap lockstep (B-6e): proxy-forward.ts MAX_HTML_INJECTION_BYTES and
 * the gateway's html-inject.ts HTML_INJECT_MAX_BYTES are one 64KiB budget
 * from opposite sides of an ownership boundary — control-plane production
 * code cannot import the gateway package (and the gateway cannot import the
 * control-plane test tree), so both sides currently carry only a soft
 * "must stay equal" comment (proxy-forward.ts ~L53-55, html-inject.ts ~L31).
 *
 * This test turns that soft pin into a loud one: it imports the gateway
 * source directly — a test-level cross-package source import, the same
 * pattern packages/desktop/plugin-tarball.test.ts uses to pin the gateway
 * route's upload literals — and fails the day either cap drifts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HTML_INJECT_MAX_BYTES } from '../../gateway/src/html-inject.ts'
import { MAX_HTML_INJECTION_BYTES } from '../src/proxy-forward.ts'

test('gateway HTML_INJECT_MAX_BYTES stays equal to MAX_HTML_INJECTION_BYTES (S0 injection budget)', () => {
  assert.equal(
    HTML_INJECT_MAX_BYTES,
    MAX_HTML_INJECTION_BYTES,
    'twin HTML-injection caps drifted: control-plane proxy-forward.ts '
      + 'MAX_HTML_INJECTION_BYTES vs gateway html-inject.ts HTML_INJECT_MAX_BYTES '
      + '(production code cannot import across the boundary; keep the values equal)',
  )
})
