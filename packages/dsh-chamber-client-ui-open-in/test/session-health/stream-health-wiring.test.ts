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
 *  3. the chip never reloads, re-opens or navigates on its own: the only
 *     `location.reload()` in the whole feature is the injected action, and the
 *     component is inert while the ladder holds nothing;
 *  4. no client source in this package writes to the console — the package's
 *     own ui-lock forbids it, and these files must stay inside that rule;
 *  5. every notice the ladder can return has zh and en copy.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments, normalize } from '../../../../scripts/dev/test-support/source-text.ts'
import { en, zh } from '../../src/locales.ts'
import { SESSION_STREAM_HEALTH_DEFAULTS } from '../../src/client/session-stream-health.ts'

const read = (relative: string): string => stripComments(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'))
const entry = read('../../src/client/index.ts')
const seat = read('../../src/client/session-stream-health-seat.ts')
const chip = read('../../src/client/SessionStreamHealthChip.tsx')

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
  assert.match(seat, /healSessionStream\(readSessions\(ctx\), sessionId, previousOf\(sessionId\)\)/)
  // cordis throws on an absent service read through the ctx proxy.
  assert.match(seat, /reflect\.get\('sessions', false\)/)
  assert.match(seat, /const note = \(sessionId: string\): void => \{ presented = rememberPresented\(presented, sessionId\) \}/)
  assert.match(seat, /previousOf = \(sessionId: string\): string \| undefined => previousPresented\(presented, sessionId\)/)
})

test('stream-health wiring: only the injected action reloads, and an idle ladder renders nothing', () => {
  const reloads = [...chip.matchAll(/location\.reload\(\)/g)]
  assert.equal(reloads.length, 0, 'the chip must not reload on its own')
  const seatReloads = [...seat.matchAll(/location\.reload\(\)/g)]
  assert.equal(seatReloads.length, 1, 'exactly one reload path: the injected user action')
  assert.doesNotMatch(chip, /useRef/, 'the ladder state must not live in a component ref')
  assert.match(normalize(chip), /if \(plan\.notice === null && !recovering\) return null/)
  assert.match(chip, /const recovering = plan\.state\.phase === 'healing' \|\| \(plan\.state\.phase === 'error-hold' && openState === 'error'\)/)
  assert.match(chip, /const next = step\(sessionId, openState, presented, Date\.now\(\)\)/)
  // A hidden page stops the clock and is re-read on the event, not only on the tick.
  assert.match(chip, /visibilitychange/)
  assert.match(chip, /if \(!holding \|\| !visible\) return/)
  // The live region is the label alone: the reload button must never sit inside it.
  assert.match(chip, /<span role="status" aria-live="polite">\{label\}<\/span>/)
  assert.doesNotMatch(chip, /<div[^>]*role="status"/)
})

test('stream-health wiring: no console writer in this package client sources', () => {
  const dir = fileURLToPath(new URL('../../src/client', import.meta.url))
  const offenders = readdirSync(dir)
    .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .filter(name => /console\.(error|warn|log)\(/u.test(stripComments(readFileSync(dir + '/' + name, 'utf8'))))
  assert.deepEqual(offenders, [], 'the package ui-lock forbids console.* in src/client')
})

test('stream-health wiring: every notice key exists in both dictionaries', () => {
  for (const key of ['streamHealth.label', 'streamHealth.healing', 'streamHealth.loadingStall', 'streamHealth.healFailed', 'streamHealth.reload', 'streamHealth.carrierChurn']) {
    assert.equal(typeof (zh as Record<string, string>)[key], 'string', 'zh is missing ' + key)
    assert.equal(typeof (en as Record<string, string>)[key], 'string', 'en is missing ' + key)
  }
  assert.equal(typeof SESSION_STREAM_HEALTH_DEFAULTS.errorGraceMs, 'number')
  assert.equal(typeof SESSION_STREAM_HEALTH_DEFAULTS.carrierChurnMs, 'number')
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

test('stream-health wiring: churn is informational, self-expiring and never offers a reload', () => {
  assert.match(chip, /plan\.notice === null \|\| plan\.notice === 'carrier-churn' \? null/u, 'churn must not offer the reload action')
  assert.match(chip, /\|\| plan\.notice !== null/u, 'a visible notice must keep the ticker alive so it can expire')
})
