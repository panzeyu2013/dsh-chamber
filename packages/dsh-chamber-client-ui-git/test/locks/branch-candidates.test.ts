/**
 * Source locks for the create dialog's on-demand branch candidates (design 08 §2.1/§4.1).
 *
 * The picker's freshness must never be "fixed" by kicking the polled snapshot again: the
 * dialog reads `gitWorktree/branches` through the ONE planned effect, degrades to the snapshot
 * list only for the snapshot-proven old-host signal, and the query module stays pure so every
 * rule is unit tested. Comments are stripped so the pins are satisfied by CODE, never prose.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const DIALOG = stripComments(readFileSync(new URL('../../src/client/CreateWorktreeDialog.tsx', import.meta.url), 'utf8'))
const QUERY = stripComments(readFileSync(new URL('../../src/shared/branch-query.ts', import.meta.url), 'utf8'))

test('the dialog reads candidates through ONE planned on-demand effect', () => {
  assert.match(DIALOG, /gitWorktreeApi\.listBranches\(/u)
  assert.match(DIALOG, /planBranchQuery\(/u)
  assert.equal((DIALOG.match(/planBranchQuery\(/gu) ?? []).length, 1,
    'exactly one effect may drive the read plan (a second dispatcher is the reopen/repo-switch race)')
  assert.match(DIALOG, /if \(plan === 'start'\) startBranchQuery\(sourceWorkspaceId, sourceRepo\?\.repoId\)/u)
  assert.match(DIALOG, /\}, \[open, mode, branchQueryKeyForRepo, currentBranchQuery\]\)/u,
    'the plan effect dependency set is the read identity')
  assert.match(DIALOG, /branchQueryFlight\.current\?\.abort\(\)/u)
  assert.doesNotMatch(DIALOG, /refreshSource/u)
})

test('the old-host fallback is the mounted-domain inference, not a blanket 404 message', () => {
  assert.match(DIALOG, /isOldHostFallback\(error, /u)
  assert.match(DIALOG, /snapshot !== undefined/u)
  assert.match(DIALOG, /'unsupported'/u)
})

test('only the Existing tab consumes the checked-out advisory', () => {
  assert.match(DIALOG, /branchOptionCheckedOut\(name, currentBranchQuery, mode\)/u)
})

test('the retry affordance is classified once at failure time, not by error code in the render', () => {
  assert.match(DIALOG, /gitActionErrorCode\(error\) === NOT_DISPATCHED_CODE \|\| !isDeterministicGitRejection\(error\)/u)
  assert.match(DIALOG, /error\?\.retryable === true/u)
  assert.match(DIALOG, /\{branchRetryable && \(/u)
})

test('the query module is pure: no React/DOM/timer/clock', () => {
  assert.doesNotMatch(QUERY, /from 'react'/u)
  assert.doesNotMatch(QUERY, /document\.|window\./u)
  assert.doesNotMatch(QUERY, /setTimeout|setInterval|Date\.now/u)
})
