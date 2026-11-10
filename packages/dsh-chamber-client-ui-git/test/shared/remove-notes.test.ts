/**
 * Removal-failure code resolution. Pure node:test, no React: the code→copy table
 * is the single localization boundary for host refusals and local preflight
 * guards, and every mapped key must exist in both dictionaries.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { removeFailureCode, removeFailureCopyKey } from '../../src/shared/remove-notes.ts'
import { en, zh } from '../../src/locales.ts'

test('removeFailureCode: follows the saga original chain and only reports real codes', () => {
  assert.equal(removeFailureCode({ code: 'running-agent', original: {} }), 'running-agent')
  assert.equal(removeFailureCode({ original: { code: 'running-agent' } }), 'running-agent')
  assert.equal(removeFailureCode(new Error('plain failure')), undefined)
  assert.equal(removeFailureCode(null), undefined)
  assert.equal(removeFailureCode({ code: '' }), undefined)
})

test('removeFailureCopyKey: host and local refusals map to localized copy', () => {
  assert.equal(removeFailureCopyKey('running-agent'), 'runningAgentBlocked')
  assert.equal(removeFailureCopyKey('main-worktree'), 'mainWorktreeBlocked')
  assert.equal(removeFailureCopyKey('worktree-locked'), 'lockedBlocked')
  assert.equal(removeFailureCopyKey('worktree-dirty'), 'dirtyDiscardWarning')
  assert.equal(removeFailureCopyKey('worktree-submodules'), 'submoduleDiscardWarning')
  assert.equal(removeFailureCopyKey('worktree-invalid'), 'unhealthyInvalidBlocked')
  assert.equal(removeFailureCopyKey('fresh-facts-unavailable'), 'freshFactsUnavailable')
  assert.equal(removeFailureCopyKey('source-workspace-missing'), 'sourceWorkspaceMissing')
  // Create-dialog refusals (previewCreate): localized, actionable copy for the picker/self-heal.
  assert.equal(removeFailureCopyKey('branch-not-found'), 'branchNotFound')
  assert.equal(removeFailureCopyKey('branch-checked-out'), 'branchCheckedOutBlocked')
  assert.equal(removeFailureCopyKey('branch-exists'), 'branchExists')
  // The retired registered-removal vocabulary has no copy key any more.
  assert.equal(removeFailureCopyKey('worktree-unregistered'), undefined)
  assert.equal(removeFailureCopyKey('worktree-current'), undefined)
  assert.equal(removeFailureCopyKey('worktree-runtime-unknown'), undefined)
  assert.equal(removeFailureCopyKey('worktree-unhealthy'), undefined)
  // The optional archive-before-remove step has its own localized failure.
  assert.equal(removeFailureCopyKey('archive-failed'), 'archiveFailed')
  // Unmapped codes keep the host message (honest, if English).
  assert.equal(removeFailureCopyKey('operation-conflict'), undefined)
  assert.equal(removeFailureCopyKey(undefined), undefined)
  // Every mapped key exists in BOTH locales (zh/en parity).
  for (const code of ['running-agent', 'main-worktree', 'worktree-locked', 'worktree-dirty', 'worktree-submodules', 'worktree-invalid', 'archive-failed']) {
    const key = removeFailureCopyKey(code)!
    assert.equal(typeof zh[key], 'string', `${code} → zh.${key}`)
    assert.equal(typeof en[key], 'string', `${code} → en.${key}`)
  }
})
