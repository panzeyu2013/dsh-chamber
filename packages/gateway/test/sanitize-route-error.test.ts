/**
 * sanitize-route-error: the 400 REASON must survive redaction.
 *
 * Regression (2026-09 audit): a scoped package name (`@dsh-chamber/dsh-…`) is
 * path-shaped, so the path rule rewrote it and the unknown-package refusal
 * answered `unsyncable package "@dsh-chamber[path] …` — losing the single fact
 * the message exists to carry. The route now hands the sanitizer the thrower's
 * own non-secret vocabulary (`error.keep`), and these cases pin both halves:
 * the kept token survives, everything else is still redacted.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeRouteError } from '../src/sanitize-route-error.ts'

const SEED_PACKAGE = '@dsh-chamber/dsh-chamber-seed-client-graph'

function refusal(): string {
  return `unsyncable package ${JSON.stringify(SEED_PACKAGE)} (this gateway release cannot cache it — it may predate the package; update the gateway to match the connecting desktop)`
}

test('a kept scoped package name survives path redaction verbatim', () => {
  const out = sanitizeRouteError(refusal(), [SEED_PACKAGE])
  assert.match(out, /"@dsh-chamber\/dsh-chamber-seed-client-graph"/)
  assert.doesNotMatch(out, /\[path\]/)
})

test('without the keep token the same message is redacted into [path] (the pre-fix shape)', () => {
  assert.match(sanitizeRouteError(refusal()), /@dsh-chamber\[path\]/)
})

test('keep does not weaken path or credential redaction for the rest of the message', () => {
  const out = sanitizeRouteError(
    `unsyncable package ${JSON.stringify(SEED_PACKAGE)} while reading /Users/alice/private/state.json token=abc123`,
    [SEED_PACKAGE],
  )
  assert.match(out, /@dsh-chamber\/dsh-chamber-seed-client-graph/)
  assert.doesNotMatch(out, /\/Users\/alice/)
  assert.match(out, /\[path\]/)
  assert.match(out, /token=\[redacted\]/)
})

test('an empty or non-string keep entry never widens the output', () => {
  const message = `unsyncable package ${JSON.stringify(SEED_PACKAGE)} at /srv/data/plugins`
  assert.match(sanitizeRouteError(message, ['']), /\[path\]/)
  assert.match(sanitizeRouteError(message, []), /\[path\]/)
})
