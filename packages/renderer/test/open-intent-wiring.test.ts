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
 *    settle (without both, the gates never lift or never exist);
 * 2. the derive projects `current` through `projectableCurrent` (the blank
 *    "新会话" row is what the sidebar renders from `current`);
 * 3. the view mount receives the raw intent, and the view applies the shared
 *    `shouldHoldViewVeil` rule (a failed shell must never hold the veil);
 * 4. a retired source's intent is cleared (otherwise the projection/veil gates
 *    stay latched forever for a same-id re-add).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
})

test('the sidebar projection gates the current session on the pending intent', () => {
  const app = read('../src/App.tsx')
  assert.match(
    app,
    /const current = projectableCurrent\(\s*activeViewId,\s*id,\s*runtimeFacts\[id\]\?\.current,\s*openIntents\[id\],\s*\)/,
    'the gate must receive the REQUESTED SESSION (not a boolean): an idempotent re-open must keep its highlight',
  )
  assert.match(
    app,
    /managedRuntime, openIntents\),\n    \[health, connections, remoteInstances, remoteStatus, aggregates, hostFacts, runtimeFacts, completedBySource, activeView, pluginDiagnostics, managedRuntime, openIntents\],/,
    'the intent must be a derive input, otherwise the gate never re-evaluates',
  )
})

test('the App decides the reveal gate from the shell state and the RAW runtime current', () => {
  const app = read('../src/App.tsx')
  assert.match(
    app,
    /holdVeil=\{shouldHoldViewVeil\(\{[\s\S]{0,800}?failed: \(shellStates\[viewId\]\?\.error \?\? null\) !== null,[\s\S]{0,400}?pendingIntent: openIntents\[viewId\] !== undefined,[\s\S]{0,800}?showsRequestedSession: openIntents\[viewId\] !== undefined\s*&& shellStates\[viewId\]\?\.booted === true\s*&& runtimeFacts\[viewId\]\?\.current === openIntents\[viewId\],\s*\}\)\}/,
    'the decision needs settled/failed (shell mirror) + whether the shell already shows the requested session',
  )
  // The gate must read the RAW current: the projection gate exists to hide that
  // very value, so deriving "shows the requested session" from the projection
  // would make the veil self-fulfilling and never lift during an open.
  assert.doesNotMatch(app, /showsRequestedSession:[^\n]*servers\./, 'never derive it from the published projection')
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
