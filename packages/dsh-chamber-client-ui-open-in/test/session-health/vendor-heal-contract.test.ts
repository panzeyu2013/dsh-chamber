/**
 * VENDOR HEAL-CONTRACT LOCKSTEP (design 14 §D4).
 *
 * The chamber's recovery lever for a latched conversation stream is the concrete
 * per-session `Session.resync()` (see
 * `../src/client/session-stream-health-probe.ts`); presentation itself rides the
 * official view-owner path `ISessions.retain` (ui-workspace's
 * `openSession` → `replaceMain`). Both work because of exactly three facts in
 * the PINNED vendor code, pinned here by source text. Formatting is absorbed
 * (`stripComments` + `normalize` from the shared test-support layer) while a
 * SEMANTIC change fails HERE — the recovery arm must be re-derived, never
 * silently disabled, on the next dsh pin upgrade.
 *
 *  1. `service.retain()` presents a session by opening it
 *     (`reference.attachOpening(this.manager.get(id).open(), signal)`): that is
 *     why the official view owner's `openSession` is the presentation entry
 *     point — retaining the target (again) re-enters `Session.open()` — while a
 *     connection-generation reconnect (which keeps every ctx object mounted, so
 *     nothing is re-presented) is not;
 *  2. `Session.open()` short-circuits on `openState === 'open'` and otherwise
 *     returns the in-flight promise: only `'error'` / `'cold'` are healable, a
 *     parked `'loading'` open is not — the boundary the ladder's two arms rest on;
 *  3. `Session.failEventStream()` lattices `openState = 'error'` and clears the
 *     in-flight promise: the state the ladder keys on, and why a heal can be
 *     re-entered at all (a surviving promise would return the dead open forever).
 *
 * The concrete-Session ACCESS path is pinned too: rc.2's `ISessions` contract
 * exposes `binding(id)` and no `resolve`, and the service method returns the
 * `SessionBinding` carrier whose `.session` is the concrete face.
 *
 * The tree is resolved through the repo's vendor symlink layout
 * (`vendor/harness-packages/@deepseek-ai/…`), as every other vendor-reading test
 * does: a missing tree means `pnpm install` was never run, and the ENOENT below
 * is that failure, not a lock failure.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments, normalize } from '../../../../scripts/dev/test-support/source-text.ts'

/** The pinned session-controller client sources (read-only vendor symlink tree). */
const VENDOR = '../../../../vendor/harness-packages/@deepseek-ai/dsh-api-session-controller/src/client'

function vendorSource(file: string): string {
  const url = new URL(`${VENDOR}/${file}`, import.meta.url)
  return normalize(stripComments(readFileSync(fileURLToPath(url), 'utf8')))
}

const service = vendorSource('sessions/service.ts')
const session = vendorSource('sessions/session.ts')
const sessionsContract = vendorSource('contract/sessions.ts')

test('vendor heal contract: retaining a session carries its open() (the view-owner lever)', () => {
  assert.match(
    service,
    /reference\.attachOpening\(this\.manager\.get\(id\)\.open\(\), signal\)/,
    'retain() no longer opens the presented session — the official openSession path may no longer re-open it',
  )
})

test('vendor heal contract: Session.resync() rebuilds a non-cold stream through open()', () => {
  assert.match(
    session,
    /async resync\(\): Promise<void> \{ if \(this\.openState === 'cold'\) return .*?await this\.open\(\)/,
    'resync() no longer rebuilds a non-cold stream through open() — the ladder\'s direct lever must be re-derived',
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

test('vendor access contract: binding(id) is the rc.2 session entry, and resolve is gone', () => {
  assert.match(
    service,
    /binding\(id: SessionId\): SessionBinding \| undefined \{ return this\.scopes\.get\(id\)\?\.binding \}/,
    'ClientSessions.binding(id) changed — the concrete-Session access path must be re-derived',
  )
  assert.match(
    sessionsContract,
    /binding\(id: SessionId\): SessionBinding \| undefined/,
    'the ISessions contract no longer declares binding(id) — the concrete-Session access path must be re-derived',
  )
  // The carrier shape the probe reads (`.session`) is pinned with the accessor.
  assert.match(
    service,
    /export interface SessionBinding \{ readonly sessionId: SessionId readonly session: SessionFace/,
    'SessionBinding.session is no longer the carrier property the concrete-session helper reads',
  )
  // The pre-rc.2 runtime-only `resolve(id)` must NOT return to the public face:
  // consumers keep it as an old-anchor fallback, never as the primary path.
  assert.doesNotMatch(service, /\bresolve\(id: SessionId\)/, 'a resolve(id) accessor reappeared on ClientSessions')
  assert.doesNotMatch(sessionsContract, /\bresolve\(id: SessionId\)/, 'a resolve(id) accessor reappeared on ISessions')
})

/**
 * The desktop page loads the BUILT session-controller bundle, so the same fact
 * is pinned against the shipped bytes when that bundle is present. A bare
 * checkout has not run `bundle:dsh` yet; absence is not a lock failure.
 */
const BUILT_SESSION_CONTROLLER = fileURLToPath(new URL(
  '../../../../packages/desktop/vendor/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js',
  import.meta.url,
))

test('vendor access contract: the built bundle ships binding, not resolve', {
  skip: existsSync(BUILT_SESSION_CONTROLLER) ? false : 'packages/desktop/vendor/dsh is not installed (pnpm run bundle:dsh)',
}, () => {
  const built = normalize(readFileSync(BUILT_SESSION_CONTROLLER, 'utf8'))
  assert.match(
    built,
    /binding\(id\) \{ return this\.scopes\.get\(id\)\?\.binding; \}/,
    'the shipped session-controller bundle no longer carries binding(id) — the access path must be re-derived',
  )
  assert.doesNotMatch(built, /\bresolve\(id\) \{/, 'a resolve(id) accessor reappeared in the shipped bundle')
})
