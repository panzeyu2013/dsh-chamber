/**
 * Source-level wiring pins for the 2026-09 protection amendment: the session
 * this page is displaying must reach the archive manager as a PROTECTION input,
 * and the client must never refuse the run for an unknown one.
 *
 * WHY LIVE-ONLY (the review that produced this file): the vendor's public list
 * snapshot cannot distinguish a MASKED current (the selection is transiently
 * absent from the list; the stage keeps it) from a CLEARED one —
 * `sessions.clear()` is exactly what the vendor does the moment the current
 * session is ARCHIVED (`ui-workspace.clearArchivedCurrent`). A remembered
 * "last current" would therefore keep protecting the session the user just
 * archived, i.e. re-create the very dead end this amendment removes. The
 * protection input is the live fact; the mask window is a registered residual
 * (design 24 §13).
 *
 * These are contract pins on call SHAPE and ORDER (same discipline as
 * app-purged-memory-wiring.test.ts): they do not prove runtime semantics, they
 * fail loudly when a refactor drops a leg of the chain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

test('the archive manager feeds the LIVE current session into the purge flow as its protection input', () => {
  const dialog = read('../../dsh-chamber-client-ui-sidebar/src/client/ArchiveManagerDialog.tsx')
  assert.match(dialog, /runArchivePurge\(client, sessionIds, liveViewedSessionId\(\)\)/,
    'the protection id must be the live runtime current — never a remembered value')
  assert.match(dialog, /chamberBridge\.getServers\(\)\.find\(entry => entry\.id === server\.id\)/,
    'the id must be resolved from the LIVE bridge projection at request time, not from the render snapshot')
  assert.equal(/lastKnown|viewedSessionId/.test(dialog), false,
    'no sticky "last viewed session" may creep back in (it re-creates the archived-session dead end)')
  assert.equal(/purgeRefusalReason/.test(dialog), false, 'the retired pre-flight gate must not come back')
  assert.equal(/purgeBlocked/.test(dialog), false, 'no delete control may be disabled for an unknown current session')
  assert.match(dialog, /const unprotected = server\.runtime\?\.current === undefined/,
    'the degradation must be stated in the dialog instead of greying the controls out')
})

test('the flow protects the viewed id, gates the cancels on a complete chain, and always purges', () => {
  const flow = read('../../dsh-chamber-client-ui-sidebar/src/shared/archive-purge.ts')
  assert.equal(/purgeRefusalReason/.test(flow), false, 'the retired pre-flight gate must not come back')
  assert.match(flow, /const protect = viewedSessionId === undefined \? \[\] : \[viewedSessionId\]/,
    'the protection set is derived from the viewed id')
  assert.match(flow, /requireCompleteExcludeChain: viewedSessionId !== undefined/,
    'the cancel pass is gated on being able to prove the viewed session outside the closure')
  assert.match(flow, /try \{\s*stop = await stopPass\(/,
    'the stop leg must be throw-proof: an advisory failure may never block the deletion')
})

test('the wire sends force + the protected set, and the archive verb stops the subtree', () => {
  const api = read('../../dsh-chamber-client-ui-sidebar/src/shared/instance-api.ts')
  assert.match(api, /client\.archiveCleanup\.purge\(sessionIds, true, protectSessionIds\)/,
    'force is ALWAYS on and the protected set always travels')
  assert.match(api, /export async function stopArchivedSubtree\(/,
    'the archive-time stop must exist as a named, documented seam')
  assert.match(api, /observedRunning\.has\(sessionId\) \|\| snapshot\.listed\.has\(sessionId\)/,
    'cancel failures must be surfaced for listed members too (a maintenance phase reports idle)')
})

test('archiving a session stops it together with its subagent subtree (archive-time termination)', () => {
  const sidebar = read('../../dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx')
  assert.match(sidebar,
    /await archiveSession\(getInstanceClient\(server\.id\), sessionId\)[\s\S]*?await stopArchivedSubtree\(getInstanceClient\(server\.id\), sessionId\)/,
    'the stop must run AFTER the archive succeeded (a failed archive must never kill the turn)')
})
