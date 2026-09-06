/**
 * S0 injection-budget pin (B-6e): MAX_HTML_INJECTION_BYTES is the single
 * source of truth for the 64 KiB HTML-trust-injection budget. The gateway's
 * html-inject.ts no longer carries a twin constant — it consumes this export
 * through its @dsh-chamber/control-plane dependency and re-exports it as
 * HTML_INJECT_MAX_BYTES for gateway tests. With the twin gone there is no
 * cross-package equality to lockstep; the test's remaining value is pinning
 * the shared budget constant itself.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_HTML_INJECTION_BYTES } from '../src/proxy-forward.ts'

test('MAX_HTML_INJECTION_BYTES is the shared 64 KiB HTML-injection budget (S0)', () => {
  assert.equal(
    MAX_HTML_INJECTION_BYTES,
    64 * 1024,
    'the S0 HTML trust-injection budget must stay 64 KiB: proxy-forward.ts '
      + 'MAX_HTML_INJECTION_BYTES is the single source of truth, imported by '
      + 'the gateway html-inject.ts (no twin constant anymore)',
  )
})
