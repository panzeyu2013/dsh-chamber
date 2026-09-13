/**
 * Wiring contract for the sidebarRight self-heal (2026-09-10, design 09 §3.2).
 *
 * `App.tsx` cannot be imported by a node test (it renders the whole shell) and
 * the three layers live in three different files, so this is the SAME
 * source-text contract pattern the repo already uses for App-level wiring
 * (`app-purged-memory-wiring.test.ts`, sidebar `producer-purged-wiring.test.ts`):
 * a green run proves the SHAPE, not the behaviour — the behaviour is covered by
 * `host-graph.test.ts` (serving gate + degrade reporting), `shell.test.ts`
 * (degrade settle, probe republish, gate threading) and
 * `degraded-retry.test.ts` (the once-per-ready-epoch decision).
 *
 * Pinned here because each of these links is a silent no-op when it goes
 * missing: the gate never reaches the fetch, the probe's verdict never reaches
 * the App, or the App never re-boots — and the user is back to a mount whose
 * conversation view never registers.
 *
 * 2026-12 (falsification round): the reads now go through the shared
 * `stripComments` + `normalize` helpers. Every lock in this file is a
 * source-text contract, and raw source can be satisfied by a COMMENT that
 * merely describes the invariant (the documented failure mode in
 * `source-text.ts`) — this file holds the only catcher for the shell's
 * fact-identity dedup, so a prose-satisfiable lock there is a real hole.
 * Normalizing also makes the attribute-level locks independent of line breaks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from './source-text.ts'

/** Comment-stripped, whitespace-collapsed source: the semantic text of a file. */
const read = (rel: string): string =>
  normalize(stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')))

test('the App arms the serving gate, and it reaches the instance shell', () => {
  const app = read('../src/App.tsx')
  // the gate is bounded by the SINGLE boot budget, never a hand-written number
  assert.match(app, /const SERVING_WAIT_MS = BOOT_TIMEOUT_MS/, 'the gate must reuse the boot budget')
  assert.match(app, /const waitForServing = useCallback\(\(instanceId: string\): Promise<boolean> => \{/)
  assert.match(app, /const phase = serversPhaseRef\.current\[instanceId\]/, 'the gate reads the phase mirror')
  assert.match(app, /waitForServing=\{waitForServing\}/, 'InstanceView must receive the gate')
  const view = read('../src/components/InstanceView.tsx')
  assert.match(view, /waitForServing\?: \(instanceId: string\) => Promise<boolean>/)
  // 2026-12 BLOCKER fix: the boot seams the App owns now include the post-settle
  // republish sink. Without it the fact only re-rendered the view (its `onState`
  // is the local setter) and the App's mirror — banner, projection, self-heal —
  // never learned about it.
  assert.match(
    view,
    /bootInstanceShell\(instanceId, basePath, el, setShell, sourceFingerprint, transport, \{\s*waitForServing,\s*onRepublish: onStateChange === undefined \? undefined : \(id, next\) => onStateChange\(id, next\),\s*\}\)/,
    'InstanceView must hand the shell an App-facing republish sink',
  )
})

test('the phase mirror is written in an effect and feeds the bounded gate', () => {
  const app = read('../src/App.tsx')
  const mirror = /useEffect\(\(\) => \{\s*serversPhaseRef\.current = Object\.fromEntries\(servers\.map\(server => \[server\.id, server\.phase\]\)\)\s*\}, \[servers\]\)/
  assert.match(app, mirror, 'the mirror is effect-written (never during render) and tracks servers')
  assert.match(app, /const deadline = Date\.now\(\) \+ SERVING_WAIT_MS/)
  assert.match(app, /if \(Date\.now\(\) >= deadline\) \{ resolve\(false\); return \}/, 'the gate must time out, not hang')
})

test('a degraded mount is re-booted once per ready epoch by the App', () => {
  const app = read('../src/App.tsx')
  assert.match(app, /const plan = planDegradedRetries\(\{/)
  // 2026-12: the plan carries the fact's KIND — retryability is the kind's own
  // verdict (boot-gap.ts), so a kind a cold re-mount cannot fix never reaches
  // the planner as a bare id.
  assert.match(
    app,
    /degraded: Object\.entries\(shellStates\)\.flatMap\(\(\[instanceId, state\]\) =>\s*state\.degraded === null \? \[\] : \[\{ instanceId, kind: state\.degraded\.kind \}\]\)/,
    'only settled gaps are planned, and each one carries its kind',
  )
  assert.match(app, /phaseOf: \(instanceId\) => phases\[instanceId\]/)
  assert.match(app, /retried: degradedRetriedRef\.current/)
  assert.match(app, /degradedRetriedRef\.current = plan\.retried/, 'the marks must be carried into the next pass')
  assert.match(app, /for \(const instanceId of plan\.retry\) next\[instanceId\] = \(next\[instanceId\] \?\? 0\) \+ 1/, 'the self-heal drives the same retry token the user retry uses')
})

test('the entry producers report STRUCTURED gaps through the shell seam', () => {
  const entry = read('../src/chamber-entry.ts')
  assert.match(
    entry,
    /const reportBootDegraded = \(ctx as \{ chamberReportBootDegraded\?: \(fact: ShellDegradedFact\) => void \}\)/,
    'the seam carries a fact, not a sentence',
  )
  assert.match(
    entry,
    /degradedSeam\(\{ kind: 'required-services-missing', message, \.\.\.missingServiceFact\(missing\) \}\)/,
    'the 5s verdict must reach the seam as kind + services',
  )
  assert.match(
    entry,
    /degradedSeam\(\{\s*kind: 'deferred-registration-failed',\s*message,\s*failedIds: \[\.\.\.failed\],\s*\}\)/,
    'the deferred-cluster verdict is its OWN kind (sharing the probe kind dropped it)',
  )
  const shell = read('../src/shell.ts')
  assert.match(shell, /ctx\.provide\('chamberReportBootDegraded', reportBootDegraded\)/)
  assert.match(shell, /reportSettledDegrade\(instanceId, fact, serial\)/, 'the shell carries the fact whole, under its boot serial')
  assert.match(shell, /const next: ShellState = \{ \.\.\.holder\.lastState, degraded: fact \}/, 'a post-settle verdict republishes through onState')
  assert.match(
    shell,
    /holder\.onRepublish\?\.\(instanceId, next\)/,
    'the post-settle verdict must ALSO reach the App-owned sink (the view setter cannot)',
  )
  assert.match(
    shell,
    /if \(holder !== undefined && holder\.serial !== serial\) return/,
    'another boot\'s holder must never be overwritten by a stale incarnation',
  )
  assert.match(
    shell,
    /const pending = pendingDegrades\.get\(instanceId\)\s*if \(pending === undefined \|\| pending\.serial !== serial\) pendingDegrades\.set\(instanceId, \{ serial, fact \}\)/,
    'a verdict that arrives before settle must be held for that boot (F2/F3), not dropped',
  )
  assert.match(
    shell,
    /if \(pending\.serial === serial\) reportSettledDegrade\(instanceId, pending\.fact, serial\)/,
    'the held verdict must be replayed at settle (only for the boot that was loading)',
  )
  // All THREE reclamation sites: holder creation (consume), lifecycle-owner cleanup
  // (id freed) and boot failure (the overlay owns the surface). A single-presence
  // check would let two of them be deleted unnoticed.
  assert.equal(
    (shell.match(/pendingDegrades\.delete\(instanceId\)/g) ?? []).length,
    3,
    'every exit from a boot that never claimed the stash must drop it',
  )
  // Identity = kind + payload: a kind-only comparison silently dropped the
  // richer verdict of a same-kind second producer.
  assert.match(
    shell,
    /bootGapSignature\(current\) === bootGapSignature\(fact\)/,
    'the same-fact check must include the payload, not just the kind',
  )
})

test('the settled gap reaches the active view as copy, with one retry entry', () => {
  const app = read('../src/App.tsx')
  // Render decision is the pure module's (copy key, structured facts, retry
  // verdict, "will the self-heal re-mount this?"); the frame only maps keys.
  // The `error === null` half is the mutual exclusion with the failure overlay:
  // a failed boot renders THAT surface, never both.
  assert.match(
    app,
    /const activeShellGap = activeShellState !== undefined && activeShellState\.error === null\s*\?\s*activeShellState\.degraded\s*:\s*null/,
  )
  assert.match(app, /const activeBootGap = activeShellGap === null\s*\?\s*null\s*:\s*bootGapNotice\(activeShellGap, \{/)
  assert.match(app, /phase: servers\.find\(server => server\.id === activeView\)\?\.phase/)
  assert.match(app, /retried: degradedRetriedRef\.current\[activeView\] === true/)
  assert.match(app, /t\(activeBootGap\.autoRetryArmed \? 'bootGap\.action\.autoRetry' : 'bootGap\.action\.manual'\)/,
    'the next-step copy follows the self-heal state, not the kind')
  assert.match(app, /className="boot-gap" role="status"/, 'the notice is non-interruptive (never role="alert")')
  assert.match(app, /activeBootGap\.services\.join\(', '\)/, 'the copy NAMES the missing service (structured fact, no log parsing)')
  assert.match(app, /activeBootGap\.detail\}/, 'the producer diagnostic stays a detail line')
  // Retry = the SAME three-part entry the failure overlay uses: one writer, so
  // the probe + tunnel + token arms cannot diverge.
  assert.match(app, /const retryView = useCallback\(\(viewId: string\) => \{/)
  assert.match(app, /probeRemoteReady\(viewId\)\s*ensureRemoteConnected\(viewId\)\s*setRetryTokens\(prev => \(\{ \.\.\.prev, \[viewId\]: \(prev\[viewId\] \?\? 0\) \+ 1 \}\)\)/)
  assert.match(app, /onClick=\{\(\) => retryView\(activeView\)\}/, 'the notice retry reuses that entry')
  assert.doesNotMatch(app, /onClick=\{\(\) => \{\s*probeRemoteReady/,
    'no surface may hand-roll the retry sequence again')
  // 2026-12 falsification round: the banner is ACTIVE-VIEW scoped and it must
  // actually consume the decided key/fields. Each of these was proven
  // mutation-green before these locks: browsing to another source's gap
  // (`Object.values(shellStates).find(...)`), hardcoding one body sentence (the
  // banner then names the wrong cause for every kind), and deleting the
  // structured lines (the copy can no longer name the missing service).
  assert.match(
    app,
    /const activeShellState = shellStates\[activeView\]/,
    'the banner must read the ACTIVE view\'s shell state, never any degraded one',
  )
  assert.match(app, /\{t\(activeBootGap\.bodyKey\)\}/, 'the kind→sentence decision must be consumed, not re-decided')
  // The control-unreachable overlay is independent of shell state, so the banner
  // needs its own gate — otherwise it stays tabbable/announced UNDER that opaque
  // overlay (2026-12 review MINOR).
  assert.match(
    app,
    /\{activeBootGap !== null && !controlUnreachable && \(/,
    'the banner must yield to the control-unreachable overlay',
  )
  assert.match(app, /\{activeBootGap\.services\.join\(', '\)\}/, 'the missing services must be rendered from the fact')
  assert.match(app, /\{activeBootGap\.injectedBy\.length > 0/, 'the injector line must render when present')
  assert.match(app, /\{activeBootGap\.failedIds\.length > 0/, 'the failed-plugin line must render when present')
  assert.equal(
    (app.match(/className="boot-gap-layer"/g) ?? []).length,
    1,
    'exactly ONE banner layer — a second one could show two sources\' gaps at once',
  )
})

test('the banner chrome is actually styled (an unstyled layer floats or blocks clicks)', () => {
  const css = read('../src/styles.css')
  for (const cls of ['boot-gap-layer', 'boot-gap', 'boot-gap-title', 'boot-gap-body', 'boot-gap-facts', 'boot-gap-action', 'boot-gap-detail']) {
    // Selector-list aware (`.boot-gap-body, .boot-gap-action { … }` groups two of
    // them), and anchored so `.boot-gap-title` can never satisfy `.boot-gap`.
    assert.match(
      css,
      new RegExp(`(?:^|[,\\s])\\.${cls}(?=[,\\s{])`),
      `.${cls} must appear as a selector (deleting the rule leaves the banner unstyled)`,
    )
  }
  // The code-font fallback is DECLARED once (2026-12: the referenced
  // `--ds-font-family-code` has zero declarations in this repo — it is the upstream
  // theme token, and S1 only scans --dsw-/--dsh-, so nothing noticed). Upstream
  // keeps precedence; the local token only supplies the second position.
  assert.match(css, /--chamber-font-family-code: 'SF Mono'/, 'the local code-font fallback must be declared')
  assert.equal(
    (css.match(/var\(--ds-font-family-code, var\(--chamber-font-family-code\)\)/g) ?? []).length,
    2,
    'both frame rules must share the single-sourced fallback',
  )
  assert.doesNotMatch(css, /--ds-font-family-code:\s/, 'never shadow the upstream token name')
  // The two properties that make the banner NON-BLOCKING and subordinate to the
  // failure overlay are the whole design claim; pin them.
  assert.match(css, /\.boot-gap-layer \{[^}]*pointer-events: none/, 'the layer must not swallow clicks')
  assert.match(css, /\.boot-gap-layer \{[^}]*z-index: 900/, 'the banner must stay under .fatal-overlay (z-index 1000)')
})

test('the settled gap is projected to the sidebar and the connections card', () => {
  const app = read('../src/App.tsx')
  // The projection is the SECOND batch's whole premise: the sidebar row and the
  // connections card live in other packages' render trees and can only read
  // chamberBridge, so the fact must ride `ChamberServerAggregate.bootGap`.
  assert.match(app, /shellStates: Record<string, ShellState \| undefined>,/,
    'deriveServers must receive the shell states (the gap lives there)')
  assert.match(
    app,
    /const bootGap = shellStates\[id\]\?\.degraded\s*if \(bootGap !== undefined && bootGap !== null\) entry\.bootGap = toServerBootGap\(bootGap\)/,
    'the settled gap must be projected onto the row (structured, no producer sentence)',
  )
})

test('the degrade fact travels with every settled ShellState', () => {
  const shell = read('../src/shell.ts')
  assert.match(shell, /degraded: ShellDegradedFact \| null/)
  assert.match(shell, /graphUnavailable === null\s*\?\s*null\s*:\s*\{ kind: 'graph-unavailable', message: graphUnavailable \}/)
  assert.match(shell, /onGraphUnavailable: \(message\) => \{ if \(mayPublish\(\)\) graphUnavailable = message \}/)
  assert.match(shell, /\.\.\.\(options\.waitForServing === undefined \? \{\} : \{ waitForServing: options\.waitForServing \}\)/)
})
