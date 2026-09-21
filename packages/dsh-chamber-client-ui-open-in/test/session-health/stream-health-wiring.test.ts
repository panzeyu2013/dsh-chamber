/**
 * STREAM-HEALTH WIRING LOCKS.
 *
 * The React seat and the plugin entry cannot be imported by a plain
 * `node test/…` run (React + the open-in bundle), so their WIRING is pinned as
 * source text with comments stripped first (precedent:
 * `test/ui-lock/instance-view-guard.test.ts` and the shared
 * `scripts/dev/test-support/source-text.ts`). The assertions below are the
 * invariants a refactor would otherwise be free to break silently:
 *
 *  1. the recovery seat is registered BEFORE the open-in source gates — the
 *     freeze arm must survive a source whose open-in id does not parse;
 *  2. the seat targets the session-scoped header actions row, hands the chip a
 *     STABLE injected face, owns the per-session ladder state (a chip remount
 *     must not reset the storm budget) and reads the vendor session face the
 *     non-throwing way (`reflect.get(name, false)` — a bare `ctx.sessions` read
 *     throws in cordis when the service is absent);
 *  3. the chip never reloads, re-opens, rebuilds or navigates on its own: the
 *     only `location.reload()` in the whole feature is the injected action, the
 *     only resync EXECUTIONS are the seat's evidence-gated automatic arm (`plan
 *     .action === 'auto-resync'`, unlocked only by a proven "no open in flight")
 *     and the injected user action, and the component is inert while the ladder
 *     holds nothing;
 *  4. no client source in this package writes to the console — the package's
 *     own ui-lock forbids it, and these files must stay inside that rule;
 *  5. every notice the ladder can return has zh and en copy.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { en, zh } from '../../src/locales.ts'
import { SESSION_STREAM_HEALTH_DEFAULTS } from '../../src/client/session-stream-health.ts'

const read = (relative: string): string => stripComments(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'))
const entry = read('../../src/client/index.ts')
const seat = read('../../src/client/session-stream-health-seat.ts')
const chip = read('../../src/client/SessionStreamHealthChip.tsx')
const chipFace = read('../../src/client/session-stream-health-chip-face.ts')

test('stream-health wiring: the recovery seat is registered before the open-in gates', () => {
  const call = entry.indexOf('registerSessionStreamHealthSeat(ctx, t)')
  const bail = entry.indexOf('if (source === null) return')
  assert.notEqual(call, -1, 'the entry must register the stream-health seat')
  assert.notEqual(bail, -1, 'the open-in source gate must still exist')
  assert.ok(call < bail, 'the recovery seat must not sit behind the open-in source gate')
  assert.match(entry, /import \{ registerSessionStreamHealthSeat \} from '\.\/session-stream-health-seat\.ts'/)
})

test('stream-health wiring: the seat owns the ladder state and reads the session face defensively', () => {
  assert.match(seat, /'conversation\.session\.header\.actions'/)
  assert.match(seat, /id: SLOT_ID/)
  // One face object for the lifetime of the entry (stable effect deps).
  assert.match(seat, /inject: \(\) => face,/)
  assert.match(seat, /const face: SessionStreamHealthInjected = \{/)
  // Per-session ladder state lives HERE, not in a component ref: the header
  // subtree is unmounted on every session switch.
  assert.match(seat, /const ladders = new Map<string, SessionStreamHealthState>\(\)/)
  assert.match(seat, /const step = \(/)
  assert.match(seat, /healSessionStream\(sessions, sessionId, previousOf\(sessionId\)\)/)
  // cordis throws on an absent service read through the ctx proxy.
  assert.match(seat, /reflect\.get\('sessions', false\)/)
  assert.match(seat, /const note = \(sessionId: string\): void => \{ presented = rememberPresented\(presented, sessionId\) \}/)
  assert.match(seat, /previousOf = \(sessionId: string\): string \| undefined => previousPresented\(presented, sessionId\)/)
})

test('stream-health wiring: the seat executes only the evidence-gated auto rebuild, and the click is never ledger-gated', () => {
  // The pure observation carries exactly what the guarded concrete reads found.
  assert.match(seat, /resyncAvailable: hasSessionStreamResync\(sessions, sessionId\)/)
  assert.match(seat, /openInFlight: sessionOpenInFlight\(sessions, sessionId\)/)
  // The plan path branches on 'heal' and 'auto-resync' ONLY; 'resync' merely arms
  // the chip's control (there is no seat branch for it).
  assert.match(seat, /if \(plan\.action === 'heal'\) \{/)
  assert.match(seat, /else if \(plan\.action === 'auto-resync'\) \{/)
  assert.doesNotMatch(seat, /plan\.action === 'resync'/)
  // Exactly two resync execution paths: the automatic arm (accounted against the
  // ledger) and the injected user action.
  assert.equal(
    [...seat.matchAll(/resyncSessionStream\(/gu)].length,
    2,
    'two resync execution paths: the auto arm and the injected user action',
  )
  assert.match(
    seat,
    /resyncSessionStream\(sessions, sessionId\)\n\s*state = markSessionStreamHeal\(state, now\)/,
    'the automatic rebuild must be accounted like an automatic heal',
  )
  // The user's own exit is NOT ledger-gated (2026-09-21): the ledger bounds the
  // automatic arm, while the manual control must survive an exhausted budget. It
  // still stamps the ledger so it paces that arm.
  assert.doesNotMatch(seat, /if \(!sessionStreamLeversAvailable\(current, now\)\) return/)
  assert.match(seat, /resync: \(sessionId\) => \{/)
  assert.match(seat, /const current = ladders\.get\(sessionId\) \?\? createSessionStreamHealthState\(\)/)
  assert.match(seat, /resyncSessionStream\(readSessions\(ctx\), sessionId\)/)
  assert.match(seat, /storeLadder\(sessionId, markSessionStreamHeal\(current, now\)\)/)
  // The ladder state is still stored through one shared helper, so the click and
  // the automatic arms cannot diverge in how they age the ledger.
  assert.match(seat, /const storeLadder = \(sessionId: string, state: SessionStreamHealthState\): void => \{/)
  assert.match(seat, /storeLadder\(sessionId, state\)/)
})

test('stream-health wiring: only the injected action reloads, and an idle ladder renders nothing', () => {
  const reloads = [...chip.matchAll(/location\.reload\(\)/g)]
  assert.equal(reloads.length, 0, 'the chip must not reload on its own')
  const seatReloads = [...seat.matchAll(/location\.reload\(\)/g)]
  assert.equal(seatReloads.length, 1, 'exactly one reload path: the injected user action')
  assert.doesNotMatch(chip, /useRef/, 'the ladder state must not live in a component ref')
  // The visible surface is a pure projection (behaviour-tested in
  // stream-health-chip-face.test.ts): the component renders exactly what it says.
  assert.match(chip, /const face = sessionStreamHealthChipFace\(plan, openState\)/)
  assert.match(chip, /if \(face\.label === null\) return null/)
  assert.match(chip, /face\.label === 'healing' \? t\('streamHealth\.healing'\) : t\(sessionStreamNoticeKey\(face\.label\)\)/)
  assert.match(chip, /data-chamber-stream-health=\{face\.marker\}/)
  assert.match(chipFace, /const recovering = plan\.state\.phase === 'healing'/)
  assert.match(chip, /const next = step\(sessionId, openState, presented, Date\.now\(\)\)/)
  assert.match(chip, /setPlan\(previous => \(sameSessionStreamHealthPlan\(previous, next\) \? previous : next\)\)/)
  // A hidden page stops the clock and is re-read on the event, not only on the tick.
  assert.match(chip, /visibilitychange/)
  assert.match(chip, /if \(!sessionStreamHealthChipHoldsTick\(plan, openState, visible\)\) return/)
  // The live region is the label alone: the reload button must never sit inside it.
  assert.match(chip, /<span role="status" aria-live="polite">\{label\}<\/span>/)
  assert.doesNotMatch(chip, /<div[^>]*role="status"/)
})

test('stream-health wiring: the resync control is rendered where the plan arms OR executes it, beside the reload', () => {
  // Both controls live in the same notice branch; the reload button is byte-for-
  // byte the one that existed before the resync arm (the expression the churn
  // test pins above), and resync is an ADDITIONAL control gated on plan.action —
  // rendered for the armed control AND for the plan's own automatic rebuild, so
  // the user's manual exit never disappears behind the automatic arm.
  assert.match(chip, /face\.reload \? \(/)
  assert.match(chip, /face\.resync \? \(/)
  assert.match(chipFace, /const actionable = plan\.notice !== null && plan\.notice !== 'carrier-churn'/)
  assert.match(chipFace, /plan\.action === 'resync' \|\| plan\.action === 'auto-resync'/)
  assert.match(chip, /<button type="button" className=\{styles\.action\} onClick=\{\(\) => \{ resync\(sessionId\) \}\}>/)
  assert.match(chip, /\{t\('streamHealth\.resync'\)\}/)
  // The chip calls the injected executor exactly once, from that click: no
  // effect, tick or render may rebuild the stream on its own.
  assert.equal([...chip.matchAll(/resync\(sessionId\)/gu)].length, 1, 'the click is the only resync invocation in the chip')
  assert.doesNotMatch(chip, /useEffect\(\(\) => \{ resync/, 'resync must not ride an effect')
})

test('stream-health wiring: no console writer in this package client sources', () => {
  const dir = fileURLToPath(new URL('../../src/client', import.meta.url))
  const offenders = readdirSync(dir)
    .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .filter(name => /console\.(error|warn|log)\(/u.test(stripComments(readFileSync(dir + '/' + name, 'utf8'))))
  assert.deepEqual(offenders, [], 'the package ui-lock forbids console.* in src/client')
})

test('stream-health wiring: every notice key exists in both dictionaries', () => {
  for (const key of ['streamHealth.label', 'streamHealth.healing', 'streamHealth.loadingStall', 'streamHealth.loadingFailed', 'streamHealth.healFailed', 'streamHealth.reload', 'streamHealth.resync', 'streamHealth.carrierChurn']) {
    assert.equal(typeof (zh as Record<string, string>)[key], 'string', 'zh is missing ' + key)
    assert.equal(typeof (en as Record<string, string>)[key], 'string', 'en is missing ' + key)
  }
  assert.equal(typeof SESSION_STREAM_HEALTH_DEFAULTS.errorGraceMs, 'number')
  assert.equal(typeof SESSION_STREAM_HEALTH_DEFAULTS.carrierChurnMs, 'number')
  assert.equal(typeof SESSION_STREAM_HEALTH_DEFAULTS.loadingFailedMs, 'number')
})

test('stream-health wiring: the carrier-churn fact is locked to the api-gateway fork literal', () => {
  const fork = stripComments(readFileSync(
    fileURLToPath(new URL('../../../dsh-api-gateway/src/client/stream-carrier-fact.ts', import.meta.url)),
    'utf8',
  ))
  const forkEvent = /export const STREAM_CARRIER_FAILED_EVENT = '([^']+)'/u.exec(fork)
  assert.ok(forkEvent !== null, 'the fork must export the page event name')
  const seatEvent = /const CARRIER_CHURN_EVENT = '([^']+)'/u.exec(seat)
  assert.equal(seatEvent?.[1], forkEvent[1], 'the seat must listen on the fork event, spelled identically')
  assert.match(seat, /window\.addEventListener\(CARRIER_CHURN_EVENT, onChurn\)/u)
  assert.match(seat, /window\.removeEventListener\(CARRIER_CHURN_EVENT, onChurn\)/u, 'the listener must be torn down with its ctx effect')
  assert.match(
    seat,
    /\.\.\.\(carrierChurn === undefined \? \{\} : \{ carrierChurn \}\)/u,
    'the fact must reach the decision observation',
  )
  assert.match(fork, /createCarrierFailureReporter/u, 'the fork must build the reporter it exports')
})

test('stream-health wiring: a landed churn fact wakes the renderer without becoming a prop', () => {
  // The seat announces the fact (the closure keeps it)…
  assert.match(seat, /const churnListeners = new Set<\(\) => void>\(\)/u)
  assert.match(seat, /subscribe: \(listener\) => \{\n\s*churnListeners\.add\(listener\)/u,
    'subscribe must register the listener — without it every assertion here stays'
    + ' green while the wake-up is dead (2026-09 verification, w4)')
  assert.match(seat, /churnListeners\.delete\(listener\)/u)
  assert.match(seat, /churnListeners\.clear\(\)/u, 'the hub must be torn down with its ctx effect')
  // …and the broadcast must sit INSIDE the landing handler, immediately after the
  // fact is stored: a hub driven from anywhere else (or an early return in the
  // handler) leaves the renderer blind while `openState === 'open'`.
  assert.match(seat, /const onChurn = \(event: Event\): void => \{\n\s*const detail =/u,
    'the handler must start with the fact extraction')
  assert.match(seat, /carrierChurn = \{ at, count \}\n\s*for \(const listener of \[\.\.\.churnListeners\]\) listener\(\)/u,
    'the broadcast must follow the stored fact in the same handler')
  // A line-leading `return` before the broadcast is how a silently dead hub survives
  // every assertion above (2026-09 verification, w3b); the conditional guard on the
  // first line is fine because it is not line-leading.
  assert.match(seat, /const onChurn = \(event: Event\): void => \{(?:(?!\n\s*return\b)[\s\S])*?for \(const listener/u,
    'no unconditional return may precede the broadcast')
  // …and the chip re-plans on that notification instead of waiting for a prop:
  // with openState === 'open' the ticker is off, so nothing else would re-run it.
  // The increment is pinned exactly: a no-op bump would satisfy a loose match and
  // still leave the notice unplannable.
  assert.match(chip, /useEffect\(\(\) => subscribe\(\(\) => setTick\(value => value \+ 1\)\), \[subscribe\]\)/u)
})

test('stream-health wiring: churn is informational, self-expiring and never offers a reload', () => {
  // The projection owns the rule (behaviour-tested in stream-health-chip-face.test.ts).
  assert.match(chipFace, /const actionable = plan\.notice !== null && plan\.notice !== 'carrier-churn'/u, 'churn must not offer the reload action')
  assert.match(chip, /face\.reload \? \(/u, 'the component renders that control from the projection')
  assert.match(chipFace, /\|\| plan\.notice !== null/u, 'a visible notice must keep the ticker alive so it can expire')
})
