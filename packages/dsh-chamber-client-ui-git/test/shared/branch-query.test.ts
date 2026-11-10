/**
 * Create-dialog branch-candidate query state (design 08 §2.1/§4.1): the pure state machine and
 * the ONE read planner the dialog effect drives (including the late-answer fence, the old-host
 * degradation, the snapshot fallback and the reopen/repo-switch de-duplication).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRANCH_QUERY_STALE_MS, beginBranchQuery, branchChoices, branchOptionCheckedOut, branchQueryKey,
  planBranchQuery, settleBranchQuery, shouldRefetchBranches,
} from '../../src/shared/branch-query.ts'
import type { BranchCandidatesResult } from '../../src/shared/types.ts'

const KEY = branchQueryKey('local', 'ws-main')
const RESULT: BranchCandidatesResult = {
  sourceWorkspaceId: 'ws-main',
  repoId: 'repo_' + 'a'.repeat(64),
  branches: ['main', 'feature'],
  checkedOutBranches: ['main'],
  truncated: false,
}

function readyState(at = 1_000) {
  return settleBranchQuery(beginBranchQuery(KEY, 1, at - 100), KEY, 1, { kind: 'ready', result: RESULT }, at)
}

test('a query settles ready with its launch identity and timestamp', () => {
  const loading = beginBranchQuery(KEY, 7, 1_000)
  assert.equal(loading.status, 'loading')
  assert.equal(loading.key, KEY)
  assert.equal(loading.requestId, 7)
  const settled = settleBranchQuery(loading, KEY, 7, { kind: 'ready', result: RESULT }, 1_200)
  assert.equal(settled.status, 'ready')
  assert.deepEqual(settled.result, RESULT)
  assert.equal(settled.settledAt, 1_200)
})

test('a late answer from a superseded query is dropped', () => {
  const loading = beginBranchQuery(KEY, 8, 2_000)
  const older = settleBranchQuery(loading, KEY, 7, { kind: 'ready', result: RESULT }, 2_100)
  assert.equal(older, loading, 'the same state object comes back: nothing was applied')
  const otherKey = settleBranchQuery(loading, branchQueryKey('local', 'ws-other'), 8, { kind: 'ready', result: RESULT }, 2_100)
  assert.equal(otherKey, loading)
})

test('degradation keeps unsupported and failed distinguishable', () => {
  const loading = beginBranchQuery(KEY, 9, 3_000)
  const unsupported = settleBranchQuery(loading, KEY, 9, { kind: 'unsupported' }, 3_100)
  assert.equal(unsupported.status, 'unsupported')
  assert.equal(unsupported.result, undefined)
  const failed = settleBranchQuery(loading, KEY, 9, { kind: 'failed', code: 'git-command-failed', message: 'boom', retryable: true }, 3_100)
  assert.equal(failed.status, 'error')
  assert.equal(failed.error?.code, 'git-command-failed')
  assert.equal(failed.error?.retryable, true, 'the retry affordance is classified ONCE at failure time')
  const refused = settleBranchQuery(loading, KEY, 9, { kind: 'failed', code: 'source-not-main-checkout', message: 'no', retryable: false }, 3_200)
  assert.equal(refused.error?.retryable, false)
})

test('only a settled list older than the TTL is re-read; an old host is not re-probed', () => {
  assert.equal(shouldRefetchBranches(undefined, KEY, 0), true)
  assert.equal(shouldRefetchBranches(beginBranchQuery(KEY, 1, 0), KEY, 60_000), false, 'an in-flight read is never restarted')
  const ready = readyState(1_000)
  assert.equal(shouldRefetchBranches(ready, KEY, 1_000 + BRANCH_QUERY_STALE_MS - 1), false)
  assert.equal(shouldRefetchBranches(ready, KEY, 1_000 + BRANCH_QUERY_STALE_MS), true)
  assert.equal(shouldRefetchBranches(ready, branchQueryKey('local', 'ws-other'), 1_000), true)
  const unsupported = settleBranchQuery(beginBranchQuery(KEY, 2, 0), KEY, 2, { kind: 'unsupported' }, 10)
  assert.equal(shouldRefetchBranches(unsupported, KEY, 10 + BRANCH_QUERY_STALE_MS), false,
    'an old host answers 404 once per dialog, not on every tab activation')
})

test('the read planner: open/workspace/query/TTL decide exactly one action', () => {
  const plan = (overrides: Partial<Parameters<typeof planBranchQuery>[0]> = {}) => planBranchQuery({
    open: true,
    workspaceReady: true,
    mode: 'new',
    key: KEY,
    query: readyState(1_000),
    now: 1_100,
    ...overrides,
  })
  assert.equal(plan({ open: false }), 'reset')
  assert.equal(plan({ workspaceReady: false }), 'keep')
  assert.equal(plan({ query: undefined }), 'start', 'a dialog (re)open or an unresolved repo starts the read once')
  const otherRepo = settleBranchQuery(beginBranchQuery(branchQueryKey('local', 'ws-other'), 6, 0),
    branchQueryKey('local', 'ws-other'), 6, { kind: 'ready', result: RESULT }, 1_000)
  assert.equal(plan({ query: otherRepo }), 'start',
    'an answer for ANOTHER repository identity is never treated as current (the planner owns the guard)')
  assert.equal(plan({ query: beginBranchQuery(KEY, 3, 1_000) }), 'keep')
  assert.equal(plan(), 'keep', 'the NEW tab keeps a ready list')
  assert.equal(plan({ mode: 'existing' }), 'keep', 'a fresh Existing list is not re-read')
  assert.equal(plan({ mode: 'existing', now: 1_000 + BRANCH_QUERY_STALE_MS }), 'start')
  const errored = settleBranchQuery(beginBranchQuery(KEY, 4, 0), KEY, 4, { kind: 'failed', code: 'http-error', message: 'x', retryable: true }, 1_000)
  assert.equal(plan({ mode: 'existing', query: errored }), 'keep', 'a fresh failure is not hammered')
  assert.equal(plan({ mode: 'existing', query: errored, now: 1_000 + BRANCH_QUERY_STALE_MS }), 'start',
    'a settled failure is retried on a later Existing activation')
  const unsupported = settleBranchQuery(beginBranchQuery(KEY, 5, 0), KEY, 5, { kind: 'unsupported' }, 1_000)
  assert.equal(plan({ mode: 'existing', query: unsupported, now: 10_000 }), 'keep',
    'an old host is not re-probed from the tab arm')
})

test('choices prefer the fresh read and fall back to the snapshot exactly like before', () => {
  assert.deepEqual(branchChoices(readyState(), ['stale-main'], []), ['main', 'feature'])
  // Old host / failed read: the snapshot list, then the worktrees' checked-out branches.
  assert.deepEqual(branchChoices(undefined, ['snapshot-main'], ['snapshot-main']), ['snapshot-main'])
  assert.deepEqual(branchChoices(undefined, [], [null, 'main']), ['main'])
  assert.deepEqual(branchChoices(undefined, [], [null]), [])
})

test('the checked-out guard applies to the Existing tab only', () => {
  const ready = readyState()
  assert.equal(branchOptionCheckedOut('main', ready, 'existing'), true)
  assert.equal(branchOptionCheckedOut('feature', ready, 'existing'), false)
  assert.equal(branchOptionCheckedOut('main', ready, 'new'), false, 'the NEW-branch startRef keeps the main branch selectable')
  assert.equal(branchOptionCheckedOut('main', beginBranchQuery(KEY, 2, 20), 'existing'), false)
  assert.equal(branchOptionCheckedOut('main', undefined, 'existing'), false)
})
