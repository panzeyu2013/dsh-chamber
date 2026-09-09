/**
 * Remove-dialog note/count derivation (review G1-2/3/4/6). Pure node:test, no
 * React: the derivation used to live inline in RemoveWorktreeDialog.tsx and
 * was untested — the old-host case wrongly claimed archivedness and the count
 * was length subtraction.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { removeFailureCode, removeFailureCopyKey, removeRunningNotes } from '../src/shared/remove-notes.ts'
import { en, zh } from '../src/locales.ts'

test('removeRunningNotes: an old host (no archived-aware field) never claims archivedness', () => {
  // ABSENT blockingRunningSessionIds = the host cannot tell us which running
  // sessions are inert. The note must be NEUTRAL and count EVERY running
  // session (the conservative fallback), and the archived note must stay off.
  const notes = removeRunningNotes({ runningSessionIds: ['a', 'b'] })
  assert.equal(notes.kind, 'legacy')
  assert.equal(notes.blockingCount, 2)
  assert.equal(notes.inertCount, 0, 'archivedness is UNKNOWN on an old host — never claimed')
  assert.equal(notes.runningCount, 2)
  assert.equal(removeRunningNotes({ runningSessionIds: [] }).kind, 'none')
})

test('removeRunningNotes: the inert count is a SET DIFFERENCE, never length subtraction', () => {
  const notes = removeRunningNotes({ runningSessionIds: ['a', 'b', 'c'], blockingRunningSessionIds: ['b'] })
  assert.equal(notes.kind, 'blocking')
  assert.equal(notes.blockingCount, 1)
  assert.equal(notes.inertCount, 2, 'a and c are the inert running sessions')

  // A non-subset host fact (an id reported blocking but not running) must not
  // make the count negative or over-count: the row decoder rejects it, and the
  // derivation stays monotone even if it somehow reaches the dialog.
  const nonSubset = removeRunningNotes({ runningSessionIds: ['a'], blockingRunningSessionIds: ['b', 'c'] })
  assert.equal(nonSubset.inertCount, 1, 'a is still counted inert — the extra blocking id never subtracts')
  assert.equal(nonSubset.blockingCount, 2)

  // ALL running sessions inert: no blocking note, only the archived note.
  const allInert = removeRunningNotes({ runningSessionIds: ['a'], blockingRunningSessionIds: [] })
  assert.equal(allInert.kind, 'none')
  assert.equal(allInert.inertCount, 1)
})

test('removeFailureCode: follows the saga original chain and only reports real codes', () => {
  assert.equal(removeFailureCode({ code: 'running-agent', original: {} }), 'running-agent')
  assert.equal(removeFailureCode({ original: { code: 'running-agent' } }), 'running-agent')
  assert.equal(removeFailureCode(new Error('plain failure')), undefined)
  assert.equal(removeFailureCode(null), undefined)
  assert.equal(removeFailureCode({ code: '' }), undefined)
})

test('removeFailureCopyKey: the host running-agent refusal maps to localized copy', () => {
  assert.equal(removeFailureCopyKey('running-agent'), 'runningAgentBlocked')
  assert.equal(removeFailureCopyKey('main-worktree'), 'mainWorktreeBlocked')
  assert.equal(removeFailureCopyKey('worktree-locked'), 'lockedBlocked')
  assert.equal(removeFailureCopyKey('worktree-dirty'), 'dirtyDiscardWarning')
  assert.equal(removeFailureCopyKey('worktree-invalid'), 'unhealthyInvalidBlocked')
  // Unmapped codes keep the host message (honest, if English).
  assert.equal(removeFailureCopyKey('operation-conflict'), undefined)
  assert.equal(removeFailureCopyKey(undefined), undefined)
  // Every mapped key exists in BOTH locales (zh/en parity).
  for (const code of ['running-agent', 'main-worktree', 'worktree-locked', 'worktree-dirty', 'worktree-invalid']) {
    const key = removeFailureCopyKey(code)!
    assert.equal(typeof zh[key], 'string', `${code} → zh.${key}`)
    assert.equal(typeof en[key], 'string', `${code} → en.${key}`)
  }
})

test('the archived note names archived OR subagent-under-archived sessions in both locales', () => {
  // A running SUBAGENT under an archived root is not itself archived, and a
  // FORK descendant is NOT inert at all (fork edges terminate the lineage) —
  // the copy must carry the SUBAGENT qualifier, never a bare "under an
  // archived session" (design 08 §6; 2026-12 lens-D nit).
  assert.match(zh.runningRemoveArchivedNote, /已归档、或位于已归档会话的子代理之下/)
  assert.match(en.runningRemoveArchivedNote, /ARCHIVED, or under a SUBAGENT of an archived session/)
  // The old-host copy must not claim archivedness at all.
  assert.doesNotMatch(zh.runningRemoveLegacyNote, /已归档/u)
  assert.doesNotMatch(en.runningRemoveLegacyNote, /ARCHIVED/u)
  assert.match(zh.runningRemoveLegacyNote, /未报告归档状态/)
  assert.match(en.runningRemoveLegacyNote, /does not report archivedness/)
  // The ROW title has the same old-host honesty requirement.
  assert.doesNotMatch(zh.runningRemoveLegacyTitle, /未归档/u)
  assert.doesNotMatch(en.runningRemoveLegacyTitle, /NON-ARCHIVED/u)
})

test('the workspace row picks the neutral running title when the host has no archived-aware field', () => {
  const row = readFileSync(new URL('../src/client/SidebarWorkspaceGitLine.tsx', import.meta.url), 'utf8')
  // Cohesion (2026-12 nit): the row reuses the dialog's derivation instead of
  // re-checking `blockingRunningSessionIds === undefined` inline, so the two
  // can never drift apart.
  assert.match(row, /removeRunningNotes\(\{/, 'the row must reuse the pure derivation')
  assert.match(row, /runningNotes\.kind === 'legacy'[\s\S]{0,80}runningRemoveLegacyTitle/,
    'an old host must get the neutral running title')
  assert.match(row, /runtimeKnown=\{runtimeKnown\}/, 'the dialog must receive the runtime-channel presence flag')
})

test('the remove dialog derives its notes from the helper and never does inline length arithmetic', () => {
  // Source pin (the regression lived in the component's inline logic, so a
  // pure-helper test alone cannot catch it being re-added).
  const dialog = readFileSync(new URL('../src/client/RemoveWorktreeDialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /removeRunningNotes\(\{/, 'the dialog must use the pure derivation')
  assert.match(dialog, /runningNotes\.inertCount/, 'the inert count comes from the set difference')
  assert.doesNotMatch(dialog, /runningSessionIds\.length\s*-/, 'no length subtraction for the archived count')
  assert.match(dialog, /removeFailureCopyKey\(/, 'host refusals must map to localized copy')
  assert.match(dialog, /runtimeUnknownBlock/, 'the runtime-absent pre-hint must gate the confirm')
})
