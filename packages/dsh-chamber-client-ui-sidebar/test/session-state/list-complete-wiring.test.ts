/**
 * listComplete / facts-injection wiring lock (plan §3.3-1, §6; R13/R14).
 *
 * The behaviour of the pure pieces is pinned in test/session-rows/
 * merge-runtime-facts.test.ts and derive-unread.test.ts. This file locks the
 * PRODUCER seams that no pure module can see:
 *  1. the sidebar runtime-facts producer projects `listComplete` from the
 *     official list store's arrival phase (`phase === 'ready'`,
 *     vendor dsh-api-session-controller/lib/client manager.js:41,387) — the
 *     authoritative "absent = deleted" gate of R13;
 *  2. `InstanceRuntimeReport` carries `listComplete`/`stale` as OPTIONAL
 *     judgment facts (absent = not proven / live, today's semantics);
 *  3. `listComplete` enters the runtime report's IDENTITY signature (or a
 *     "facts unchanged, list became authoritative" report would be deduplicated
 *     away) and NOT the projection signature (the sidebar renders nothing from
 *     it, and a flip must not re-publish every shell's list);
 *  4. mergeRuntimeFacts exposes the overlay + stale parameters of the facts
 *     injection (two-argument compatibility is behaviourally locked in the
 *     session-rows suite).
 * Text matching strips comments first (scripts/dev/test-support/source-text.ts)
 * so a doc string cannot satisfy an assertion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const producer = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/client/index.ts', import.meta.url)), 'utf8'))
const store = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/shared/aggregate-store.ts', import.meta.url)), 'utf8'))
const derive = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/shared/derive.ts', import.meta.url)), 'utf8'))

test('producer projects listComplete from the official list store phase', () => {
  assert.match(producer, /baseReport.listComplete = snapshot.phase === 'ready'/,
    'listComplete must come from the official list phase (pending → ready), not from a row count')
  assert.match(producer, /const snapshot = sessionsList.getSnapshot()/,
    'the projection must read the same store snapshot the facts project')
})

test('InstanceRuntimeReport carries optional listComplete and stale judgment facts', () => {
  assert.match(store, /listComplete\?: boolean/, 'listComplete is an optional additive field (plan §6)')
  assert.match(store, /stale\?: boolean/, 'R14 needs the stale marker on the report (facts outlive connected)')
})

test('listComplete moves the identity signature only, never the projection signature', () => {
  assert.match(derive, /const listComplete = !includeRunning || report.listComplete === undefined/,
    'listComplete joins the identity-only branch (same discipline as the reconcile receipt)')
  assert.ok(derive.includes('${receipt}${listComplete}'),
    'the identity signature must actually embed the listComplete component')
  assert.ok(derive.includes("if (rows.length === 0 && current === '' && receipt === '' && listComplete === '') return ''"),
    'a report whose only content is the authoritative list gate must not normalize to "no runtime"')
})

test('mergeRuntimeFacts exposes the overlay/stale parameters, deriveUnread the pure predicate', () => {
  assert.match(derive, /overlay\?: RuntimeFactsOverlay,/)
  assert.match(derive, /stale\?: boolean,/)
  assert.match(derive, /export function deriveUnread\(/,
    'the App-side derivation must consume the shared predicate, not re-implement the formula')
})
