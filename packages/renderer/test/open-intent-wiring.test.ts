/**
 * Wiring contract for the open-session intent gates (design 05 §2.2 revision
 * 2026-12; 2026-12 field report problem 1).
 *
 * Source-text contract (same pattern as `sidebar-right-heal-wiring.test.ts`):
 * `App.tsx` renders the whole shell and cannot be imported by a node test, and
 * `InstanceView` needs a DOM. The RULES are unit-tested in the sidebar package
 * (`test/open-intent.test.ts`); this file pins the four links whose silent
 * disappearance would bring the field bug back:
 *
 * 1. the App ARMS the intent before switching the view and RELEASES it on
 *    settle (without both, the gates never lift or never exist) — and the arm
 *    sits INSIDE the `try` whose `finally` releases it (2026-09-11 review F1:
 *    an arm before the `try` latches the intent for the whole generation when
 *    the view switch throws);
 * 2. the derive projects `current` through `projectableCurrent` (the blank
 *    "新会话" row is what the sidebar renders from `current`);
 * 3. the view mount receives the raw intent plus the "nothing legitimate on
 *    screen" input (`blankCurrent`, 2026-09-11 review S1), and the view applies
 *    the shared `shouldHoldViewVeil` rule (a failed shell must never hold the
 *    veil);
 * 4. a retired source's intent is cleared (otherwise the projection/veil gates
 *    stay latched forever for a same-id re-add).
 *
 * The locks match the source with comments STRIPPED (`source-text.ts`): the
 * comments next to this code describe the very invariants pinned here, so a
 * raw-text match could be satisfied by prose (panel-wiring.test.ts precedent).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from './source-text.ts'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('App.openSession arms the intent before the view switch and releases it, session-guarded, on settle', () => {
  const app = read('../src/App.tsx')
  const arm = app.indexOf('armOpenIntent(instanceId, sessionId)')
  const select = app.indexOf('selectView(instanceId)', arm)
  const release = app.indexOf('releaseOpenIntent(instanceId, sessionId)', select)
  assert.notEqual(arm, -1, 'the intent must be armed')
  assert.notEqual(select, -1, 'the view switch must follow the arm')
  assert.notEqual(release, -1, 'the intent must be released')
  assert.match(
    app,
    /} finally \{\s*releaseOpenIntent\(instanceId, sessionId\)\s*\}/,
    'release belongs in finally — a FAILED open must lift both gates too',
  )
  assert.match(
    app,
    /const openIntents = useSyncExternalStore\(subscribeOpenIntent, getOpenIntentsSnapshot\)/,
    'the App binds the shared slot as an external store (stable snapshot identity)',
  )
  // 2026-09-11 review F1 (latent latch): arm and release are ONE pair, so the
  // arm must be the FIRST statement inside the try the finally belongs to.
  // Placed before the try — the shape this locks against — a synchronous throw
  // from `selectView` (view-transition plumbing) skips the only release and
  // latches the intent for that source's whole generation: its projected
  // `current` stays suppressed and the loading veil is pinned once the shell
  // settles elsewhere. Matching is done on comment-stripped, whitespace-
  // normalized source so neither prose nor formatting can satisfy the lock.
  const compact = normalize(stripComments(app))
  assert.ok(
    compact.includes('try { armOpenIntent(instanceId, sessionId) selectView(instanceId)'),
    'F1: the arm must open the try (nothing between `try {` and the arm) and stay BEFORE the view switch',
  )
  assert.ok(
    compact.includes('} finally { releaseOpenIntent(instanceId, sessionId) }'),
    'F1: the release must stay the finally body — it is the arm\'s only counterpart',
  )
})

test('the sidebar projection gates the current session on the pending intent', () => {
  const app = read('../src/App.tsx')
  assert.match(
    app,
    /const current = projectableCurrent\(\s*activeViewId,\s*id,\s*runtimeFacts\[id\]\?\.current,\s*openIntents\[id\],\s*\)/,
    'the gate must receive the REQUESTED SESSION (not a boolean): an idempotent re-open must keep its highlight',
  )
  // 2026-09-11 review-fix (finding 4f): `locale` is a REQUIRED part of both the
  // call and the memo deps — it was matched as optional here, so a mutation that
  // dropped it from either place kept this lock green while the frame copy in the
  // derive (the local source's fallback label, T16) would freeze in the locale of
  // the first render.
  // 2026-12: `shellStates` joins BOTH lists for the same reason — the sidebar row
  // and the connections card read the settled-boot gap off this projection, so a
  // dropped input (or dep) freezes that warning at its first value.
  assert.match(
    app,
    /managedRuntime, workspaceEcho, openIntents, locale\),\n    \[health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, completedBySource, activeView, pluginDiagnostics, shellStates, managedRuntime, workspaceEcho, openIntents, locale\],/,
    'the intent, the frame locale AND the shell gap facts must be derive inputs and memo dependencies',
  )
})

test('the App decides the reveal gate from the shell state and the RAW runtime current', () => {
  const app = read('../src/App.tsx')
  // The decision rides the shared rule with four inputs, in this order: the
  // shell's failure mirror, the pending intent, the "nothing legitimate on
  // screen" fact (blankCurrent, 2026-09-11 review S1) and whether the shell
  // already shows the requested session. Comment-stripped + normalized so the
  // prose around these fields cannot satisfy the lock.
  const compact = normalize(stripComments(app))
  assert.ok(
    compact.includes('holdVeil={shouldHoldViewVeil({ failed: (shellStates[viewId]?.error ?? null) !== null, pendingIntent: openIntents[viewId] !== undefined, blankCurrent, showsRequestedSession: openIntents[viewId] !== undefined && shellStates[viewId]?.booted === true && runtimeFacts[viewId]?.current === openIntents[viewId], })}'),
    'the decision needs settled/failed (shell mirror) + the pending intent + blankCurrent + whether the shell already shows the requested session',
  )
  // S1 (2026-09-11 review): blankCurrent must be derived from data the App
  // ALREADY holds for that view — the RAW runtime current and the source's own
  // aggregate session rows (whose `blank` flag is the runtime's provisional
  // "新会话" marker). UNKNOWN ⇒ true: a session the aggregate does not list yet
  // (cold boot, push not landed) keeps the veil, so only a KNOWN non-blank
  // current session lifts the post-settle hold — without that input a WARM shell
  // showing a legitimate session stayed covered by the opaque veil for up to the
  // whole 8s open budget.
  assert.ok(
    compact.includes('const blankCurrent = currentSessionId === undefined || (aggregates[viewId]?.sessions.find(session => session.sessionId === currentSessionId)?.blank ?? true)'),
    'blankCurrent: true when the view has no current session, or the aggregate flags it blank; unknown ⇒ true',
  )
  // The gate must read the RAW current: the projection gate exists to hide that
  // very value, so deriving "shows the requested session" from the projection
  // would make the veil self-fulfilling and never lift during an open.
  assert.doesNotMatch(app, /showsRequestedSession:[^\n]*servers\./, 'never derive it from the published projection')
  assert.doesNotMatch(app, /blankCurrent:[^\n]*servers\./, 'never derive it from the published projection either')
  assert.match(app, /clearOpenIntents\(retired\)/, 'a retired source must not keep a latched gate')
})

test('the view mount carries the decided boolean and the view only composes it with its own boot state', () => {
  const app = read('../src/App.tsx')
  assert.match(app, /holdVeil=\{shouldHoldViewVeil\(\{/, 'the App owns the rule')
  const view = read('../src/components/InstanceView.tsx')
  assert.match(view, /holdVeil\?: boolean/)
  assert.match(
    view,
    /const veilVisible = !settled \|\| holdVeil === true/,
    'the view owns only the boot window; the post-settle hold arrives decided',
  )
  assert.match(view, /\{veilVisible && \(/, 'the rendered veil must be driven by the combined condition')
  assert.doesNotMatch(
    view,
    /shouldHoldViewVeil\(/,
    'the rule must not be CALLED in the view (it needs App-only inputs: the raw runtime current)',
  )
  assert.doesNotMatch(
    view,
    /import \{[^}]*shouldHoldViewVeil/,
    'the view must not import the rule either — the App decides and passes a boolean',
  )
})
