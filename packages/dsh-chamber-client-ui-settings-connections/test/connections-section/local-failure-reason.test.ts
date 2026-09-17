/**
 * F1 renderer-side lock: the local card must SHOW why the instance could not
 * start.
 *
 * The control plane now reports an exhausted start as a visible /health
 * terminal (`status:'error'` + the concrete reason), and the desktop runtime
 * evidence carries the same reason (`runtimeBlockedReason`, gated separately).
 * This lock pins the RENDERER half of that contract so the reason can never be
 * silently dropped:
 *   1. the health-events push handler stores every valid frame's `dsh` block —
 *      a failure that happened while the page was already open must reach the
 *      card without waiting for the 30s poll;
 *   2. the local card renders `dsh.error` as a visible error paragraph;
 *   3. the 'error' status maps to a distinct localized badge (not 'unknown').
 *
 * LIMITS, stated honestly: this is a SOURCE-TEXT lock (the package's existing
 * technique — there is no DOM runner). The producer side is pinned by
 * `packages/control-plane/test/api/manager-api.test.ts`
 * ('an exhausted start … is a visible /health failure with the concrete
 * reason'); together they cover the cross-package chain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { en, zh } from '../../src/locales.ts'

const section = stripComments(readFileSync(new URL('../../src/client/ConnectionsSection.tsx', import.meta.url), 'utf8'))
  .replace(/\s+/g, ' ')

test('the health-events push stores the frame (a failure during the open page needs no poll)', () => {
  assert.ok(
    section.includes('events.onmessage = (event) => {'),
    'the local card must subscribe to the health-events push channel',
  )
  assert.ok(
    section.includes('setHealth(payload as HealthResponse)'),
    'every valid pushed dsh frame must land in the health state the card reads',
  )
})

test('the local card renders dsh.error (the concrete start-failure reason)', () => {
  assert.ok(
    section.includes("{dsh?.error != null && dsh.error !== '' ? <p className={css.error}>{dsh.error}</p> : null}"),
    'the local card must render the health error reason as visible error copy',
  )
})

test("the 'error' status has its own localized badge, not the unknown fallback", () => {
  assert.ok(section.includes("case 'error': return 'statusError'"), "dsh status 'error' must map to the statusError badge key")
  assert.notEqual(zh.statusError, undefined, 'zh must carry statusError copy')
  assert.notEqual(en.statusError, undefined, 'en must carry statusError copy')
  assert.notEqual(zh.statusError, zh.statusUnknown, 'zh statusError must not be the unknown fallback')
  assert.notEqual(en.statusError, en.statusUnknown, 'en statusError must not be the unknown fallback')
})
