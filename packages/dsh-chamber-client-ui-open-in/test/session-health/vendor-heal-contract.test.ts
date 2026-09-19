/**
 * VENDOR HEAL-CONTRACT LOCKSTEP (design 14 §D4, 2026-12).
 *
 * The chamber's only recovery lever for a latched conversation stream is the
 * stage move — `sessions.open(neighbor)` then `sessions.open(target)` in one
 * synchronous tick (see `../src/client/session-stream-health-probe.ts`). It works
 * because of exactly three facts in the PINNED vendor code, pinned here by
 * source text. Formatting is absorbed (`stripComments` + `normalize` from the
 * shared test-support layer) while a SEMANTIC change fails HERE — the recovery
 * arm must be re-derived, never silently disabled, on the next dsh pin upgrade.
 *
 *  1. `service.followCurrent()` opens a session only when `list.current` moved:
 *     that is why a stage move is the lever, and why `clear()` (which blanks
 *     `current`, so the same guard holds the stage) and a connection-generation
 *     reconnect (which keeps every ctx object mounted) are not;
 *  2. `Session.open()` short-circuits on `openState === 'open'` and otherwise
 *     returns the in-flight promise: only `'error'` / `'cold'` are healable, a
 *     parked `'loading'` open is not — the boundary the ladder's two arms rest on;
 *  3. `Session.failEventStream()` lattices `openState = 'error'` and clears the
 *     in-flight promise: the state the ladder keys on, and why a heal can be
 *     re-entered at all (a surviving promise would return the dead open forever).
 *
 * The tree is resolved through the repo's vendor symlink layout
 * (`vendor/harness-packages/@deepseek-ai/…`), as every other vendor-reading test
 * does: a missing tree means `pnpm install` was never run, and the ENOENT below
 * is that failure, not a lock failure.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments, normalize } from '../../../../scripts/dev/test-support/source-text.ts'

/** The pinned session-controller client sources (read-only vendor symlink tree). */
const VENDOR = '../../../../vendor/harness-packages/@deepseek-ai/dsh-api-session-controller/src/client/sessions'

function vendorSource(file: string): string {
  const url = new URL(`${VENDOR}/${file}`, import.meta.url)
  return normalize(stripComments(readFileSync(fileURLToPath(url), 'utf8')))
}

const service = vendorSource('service.ts')
const session = vendorSource('session.ts')

test('vendor heal contract: followCurrent re-opens a session only when the stage moved', () => {
  assert.match(
    service,
    /if \(current === undefined \|\| snapshot\.byId\[current\] === undefined \|\| current === this\.watched\) return/,
    'followCurrent no longer holds the stage for an unchanged current — a stage move may no longer be a lever',
  )
  assert.match(
    service,
    /this\.watched = current this\.sweepDeferred\(\) const record = this\.resolve\(current\) .*?void record\.session\.open\(\)/,
    'followCurrent no longer calls session.open() after the stage moved — the heal would move the stage without re-opening',
  )
})

test('vendor heal contract: Session.open() short-circuits on open and on a pending promise', () => {
  assert.match(
    session,
    /open\(\): Promise<void> \{ if \(this\.openState === 'open'\) return Promise\.resolve\(\) if \(this\.openPromise !== null\) return this\.openPromise/,
    'Session.open() no longer short-circuits as the heal ladder assumes (a parked loading/open session would become healable, or a heal could start a second open)',
  )
})

test('vendor heal contract: failEventStream latches the error state the ladder keys on', () => {
  assert.match(
    session,
    /private failEventStream\(events: SessionEventStream, generation: number, error: unknown\): void \{ if \(generation !== this\.openGeneration \|\| this\.events !== events\) return if \(!isRemoteFailure\(error\)\) throw error this\.openGeneration\+\+ this\.events = undefined this\.openPromise = null this\.openState = 'error' this\.openError = error/,
    "the terminal journal failure no longer latches openState = 'error' with a cleared open promise — the ladder keys on that state, so the recovery arm must be re-derived",
  )
})
