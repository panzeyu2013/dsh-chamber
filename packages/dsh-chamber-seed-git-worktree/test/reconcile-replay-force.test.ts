/**
 * Git worktree core — replay/reconciliation legs and the dirty/locked/force removal decisions.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GitWorktreeError } from '../src/core.ts'
import {
  LINKED,
  MAIN_HEAD,
  FEATURE_HEAD,
  setup,
  mutationCalls,
} from './support/fake-repository.ts'

// ---------------------------------------------------------------------------
// REPLAY legs re-read the archived set. An unarchive between the first
// attempt and its replay must flip inert → blocking (the archived fact is
// authoritative state, never a cached decision).
// ---------------------------------------------------------------------------

test('terminal replay re-reads the archived set: unarchiving between attempts refuses the replay', async () => {
  const { core, repo, agents, archived, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const input = {
    operationId: 'terminal-unarchive',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: linked.branch,
      head: linked.head,
    },
  }
  // The first attempt runs with the member archived: inert, removal proceeds.
  workspaces[1] = { ...workspaces[1]!, sessionIds: ['s-feature'] }
  agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  archived.push('s-feature')
  const removed = await core.remove(input)
  assert.equal(removed.removed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  // Unarchive, then replay the SAME operationId: the terminal receipt leg
  // re-reads the authoritative archived set and must now refuse.
  archived.length = 0
  await assert.rejects(
    core.remove(input),
    error => error instanceof GitWorktreeError
      && error.code === 'running-agent'
      && /s-feature/.test(error.message),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1, 'a refused replay never deletes again')
})

test('uncertain-outcome reconciliation re-reads the archived set: unarchiving between attempts refuses the replay', async () => {
  const { core, repo, agents, archived, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const input = {
    operationId: 'reconcile-unarchive',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: linked.branch,
      head: linked.head,
    },
  }
  workspaces[1] = { ...workspaces[1]!, sessionIds: ['s-feature'] }
  agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  archived.push('s-feature')
  // The Git subprocess commits but the postcondition read fails: the outcome
  // is uncertain and the client replays the same operationId.
  repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated committed timeout')
  await assert.rejects(core.remove(input))
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  // Unarchive before the replay: reconcileBoundRemove's receipt leg re-reads
  // the archived set, so the same replay must now be refused.
  archived.length = 0
  await assert.rejects(
    core.remove(input),
    error => error instanceof GitWorktreeError
      && error.code === 'running-agent'
      && /s-feature/.test(error.message),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1, 'the refused replay deleted nothing again')
})

test('uncertain-outcome reconciliation re-reads the archived set for the UNREGISTERED path leg', async () => {
  const { core, repo, agents, archived } = setup()
  const extra = repo.addLinked({ path: '/repos/unregistered', branch: 'unreg', head: FEATURE_HEAD })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const row = repository.worktrees.find(worktree => worktree.path === extra.path)!
  const input = {
    operationId: 'reconcile-unregistered-unarchive',
    expected: { repoId: repository.repoId, worktreeId: row.worktreeId, branch: row.branch!, head: row.head },
    path: extra.path,
  }
  agents.push({ sessionId: 's-live', status: 'running', cwd: `${extra.path}/sub` })
  archived.push('s-live')
  // The attempt reaches Git but the subprocess times out BEFORE mutating: the
  // operation keeps its intent and the client replays the same operationId
  // through reconcileBoundRemove's unregistered branch (directory still there).
  repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(core.remove(input))
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  archived.length = 0
  await assert.rejects(
    core.remove(input),
    error => error instanceof GitWorktreeError
      && error.code === 'running-agent'
      && /cwd/.test(error.message),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

// ---------------------------------------------------------------------------
// REGISTERED reconcile replay (reconcileBoundRemove registered leg): the only
// running guard on that path. BLOCK direction (a running non-archived member
// refuses the replay) AND ALLOW direction (an archived member must not) are
// both pinned — the allow direction would otherwise wedge the normal flow.
// ---------------------------------------------------------------------------

test('registered reconcile replay refuses a running member (the leg\'s ONLY running guard)', async () => {
  const { core, repo, agents, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const input = {
    operationId: 'registered-reconcile-running',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: linked.branch,
      head: linked.head,
    },
  }
  // First attempt: the Git subprocess times out BEFORE mutating, so the bound
  // intent survives and the target is still present on the replay.
  repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(core.remove(input))
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  // A running (non-archived) workspace member appears before the replay. The
  // registered branch of reconcileBoundRemove runs ONLY its own guard pair —
  // no full preflight — so this refusal is the sole protection.
  workspaces[1] = { ...workspaces[1]!, sessionIds: ['s-feature'] }
  agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  await assert.rejects(
    core.remove(input),
    error => error instanceof GitWorktreeError
      && error.code === 'running-agent'
      && /s-feature/.test(error.message),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1, 'a refused replay never mutates again')
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), true)
})

test('registered reconcile replay ALLOWS an ARCHIVED running member (the allow direction must not wedge)', async () => {
  const { core, repo, agents, archived, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const input = {
    operationId: 'registered-reconcile-archived',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: linked.branch,
      head: linked.head,
    },
  }
  // The only running member is ARCHIVED: inert, so the first attempt passes the
  // preflight and binds the intent; the Git subprocess then times out
  // pre-mutation.
  workspaces[1] = { ...workspaces[1]!, sessionIds: ['s-feature'] }
  agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  archived.push('s-feature')
  repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(core.remove(input))
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  // Replay: reconcileBoundRemove's registered leg must re-read the archived set
  // and ALLOW the removal (a raw running-set guard here would wedge every
  // removal whose only running sessions are archived).
  const replayed = await core.remove(input)
  assert.equal(replayed.removed, true)
  assert.equal(replayed.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 2)
  assert.deepEqual(replayed.sessionIds, ['s-feature'])
})

test('terminal receipt replay ALLOWS an ARCHIVED running member (the allow direction must not wedge)', async () => {
  const { core, repo, agents, archived, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const input = {
    operationId: 'terminal-receipt-archived',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: linked.branch,
      head: linked.head,
    },
  }
  // The worktree's ONLY running session is archived ⇒ inert ⇒ the removal
  // succeeds. The workspace stays registered, so the replay re-enters
  // assertRemovedWorkspaceReceipt (the pre-`workspace.delete` receipt leg).
  workspaces[1] = { ...workspaces[1]!, sessionIds: ['s-feature'] }
  agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  archived.push('s-feature')
  const removed = await core.remove(input)
  assert.equal(removed.removed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  const replayed = await core.remove(input)
  assert.equal(replayed.replayed, true,
    'a raw running-set guard on the receipt leg would refuse this replay and wedge the client')
  assert.equal(mutationCalls(repo, 'remove').length, 1, 'the receipt replay deletes nothing again')
})

test('removed terminal replay rejects a reappeared worktree without deleting it again', async () => {
  const { core, repo } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const input = {
    operationId: 'terminal-remove-reappeared',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: linked.branch,
      head: linked.head,
    },
  }
  await core.remove(input)
  repo.addLinked()
  await assert.rejects(
    core.remove(input),
    error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), true)
})

test('removed terminal replay requires the same workspace membership and no running agent', async () => {
  for (const change of ['membership', 'running'] as const) {
    const { core, repo, workspaces, agents } = setup({ linked: true })
    const snapshot = await core.snapshot()
    const repository = snapshot.repos[0]!
    const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
    const input = {
      operationId: `terminal-remove-${change}`,
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }
    await core.remove(input)
    if (change === 'membership') {
      const workspaceIndex = workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature')
      workspaces[workspaceIndex] = {
        ...workspaces[workspaceIndex]!,
        sessionIds: [...workspaces[workspaceIndex]!.sessionIds, 'new-session'],
      }
    } else {
      agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
    }
    await assert.rejects(
      core.remove(input),
      error => error instanceof GitWorktreeError
        && error.code === (change === 'membership' ? 'operation-conflict' : 'running-agent'),
    )
    assert.equal(mutationCalls(repo, 'remove').length, 1)
  }
})

test('remove retries reconcile committed timeout and postcondition-read failures without a second delete', async () => {
  for (const failure of ['timeout', 'post-read'] as const) {
    const { core, repo } = setup({ linked: true })
    const snapshot = await core.snapshot()
    const repository = snapshot.repos[0]!
    const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
    const input = {
      operationId: `remove-${failure}`,
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }
    if (failure === 'timeout') {
      repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated timeout')
    } else {
      repo.failListAfterRemove = true
    }
    await assert.rejects(core.remove(input))
    assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
    const reconciled = await core.remove(input)
    assert.equal(reconciled.removed, true)
    assert.equal(reconciled.replayed, true)
    assert.deepEqual(reconciled.sessionIds, ['s-feature'])
    assert.equal(mutationCalls(repo, 'remove').length, 1)
  }
})

test('uncertain remove reconciliation fails closed when membership or liveness changed', async () => {
  for (const change of ['membership', 'running'] as const) {
    const { core, repo, workspaces, agents } = setup({ linked: true })
    const snapshot = await core.snapshot()
    const repository = snapshot.repos[0]!
    const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
    const input = {
      operationId: `uncertain-receipt-${change}`,
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }
    repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated committed timeout')
    await assert.rejects(core.remove(input))
    if (change === 'membership') {
      const workspaceIndex = workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature')
      workspaces[workspaceIndex] = {
        ...workspaces[workspaceIndex]!,
        sessionIds: [...workspaces[workspaceIndex]!.sessionIds, 'late-session'],
      }
    } else {
      agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
    }
    await assert.rejects(
      core.remove(input),
      error => error instanceof GitWorktreeError
        && error.code === (change === 'membership' ? 'operation-conflict' : 'running-agent'),
    )
    assert.equal(mutationCalls(repo, 'remove').length, 1)
    assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
  }
})

test('remove repeats Git identity checks after the final registry and agent scan', async () => {
  const { core, repo, setSourceReadHook } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  let reads = 0
  setSourceReadHook(() => {
    reads += 1
    if (reads === 3) repo.worktrees[1]!.branch = 'changed-after-state-scan'
  })
  await assert.rejects(
    core.remove({
      operationId: 'remove-final-check',
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('remove final absent convergence rechecks membership and liveness receipts', async () => {
  for (const change of ['membership', 'running'] as const) {
    const { core, repo, workspaces, agents } = setup({ linked: true })
    const snapshot = await core.snapshot()
    const repository = snapshot.repos[0]!
    const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
    let actionLists = 0
    repo.onWorktreeList = () => {
      actionLists += 1
      if (actionLists !== 2) return
      const targetIndex = repo.worktrees.findIndex(worktree => worktree.path === LINKED)
      assert.notEqual(targetIndex, -1)
      repo.worktrees.splice(targetIndex, 1)
      repo.existing.delete(LINKED)
      if (change === 'membership') {
        const workspaceIndex = workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature')
        workspaces[workspaceIndex] = {
          ...workspaces[workspaceIndex]!,
          sessionIds: [...workspaces[workspaceIndex]!.sessionIds, 'late-session'],
        }
      } else {
        agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
      }
    }

    await assert.rejects(
      core.remove({
        operationId: `remove-final-absent-${change}`,
        workspaceId: 'ws-feature',
        expected: {
          repoId: repository.repoId,
          worktreeId: linked.worktreeId,
          branch: linked.branch,
          head: linked.head,
        },
      }),
      error => error instanceof GitWorktreeError
        && error.code === (change === 'membership' ? 'operation-conflict' : 'running-agent'),
    )
    assert.equal(actionLists, 2)
    assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
    assert.equal(mutationCalls(repo, 'remove').length, 0)
  }
})

test('remove refuses main, dirty and locked worktrees without exposing force', async () => {
  const { core, repo } = setup({ linked: true })
  let snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const main = repository.worktrees[0]!
  await assert.rejects(
    core.remove({
      operationId: 'remove-main',
      workspaceId: 'ws-main',
      expected: { repoId: repository.repoId, worktreeId: main.worktreeId, branch: 'main', head: MAIN_HEAD },
    }),
    error => error instanceof GitWorktreeError && error.code === 'main-worktree',
  )

  repo.worktrees[1]!.dirty = true
  snapshot = await core.snapshot()
  let linked = snapshot.repos[0]!.worktrees[1]!
  await assert.rejects(
    core.remove({
      operationId: 'remove-dirty',
      workspaceId: 'ws-feature',
      expected: {
        repoId: snapshot.repos[0]!.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch!,
        head: linked.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-dirty',
  )
  repo.worktrees[1]!.dirty = false
  repo.worktrees[1]!.locked = true
  snapshot = await core.snapshot()
  linked = snapshot.repos[0]!.worktrees[1]!
  await assert.rejects(
    core.remove({
      operationId: 'remove-locked',
      workspaceId: 'ws-feature',
      expected: {
        repoId: snapshot.repos[0]!.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch!,
        head: linked.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-locked',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('remove with discardChanges force-removes a dirty worktree and preserves the branch', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  repo.worktrees[1]!.dirty = true
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees[1]!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }

  // Without discardChanges the dirty worktree is still rejected.
  await assert.rejects(
    core.remove({ operationId: 'force-op-no-flag', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-dirty',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)

  // With discardChanges the removal goes through with --force; the branch
  // and the registered workspace row survive (Git-first protocol).
  const removed = await core.remove({
    operationId: 'force-op',
    workspaceId: 'ws-feature',
    expected,
    discardChanges: true,
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'delete-workspace')
  assert.equal(removed.branchPreserved, true)
  assert.deepEqual(removed.sessionIds, ['s-feature'])
  assert.equal(repo.branches.has('feature'), true)
  assert.equal(workspaces.some(workspace => workspace.workspaceId === 'ws-feature'), true)
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--force', '--', LINKED])
  assert.equal(repo.calls.some(call => call.args[0] === 'branch'), false)

  // Same-id replay with the identical input is byte-identical (fingerprint)
  // and does not re-run the mutation.
  const replay = await core.remove({
    operationId: 'force-op',
    workspaceId: 'ws-feature',
    expected,
    discardChanges: true,
  })
  assert.equal(replay.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)

  // A replay WITHOUT discardChanges changes the fingerprint -> conflict.
  await assert.rejects(
    core.remove({ operationId: 'force-op', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
  )
})

test('unregistered removal honors discardChanges with --force on a dirty path', async () => {
  const { core, repo } = setup({ linked: true })
  repo.addLinked({ path: '/repos/external', branch: 'ext', head: FEATURE_HEAD })
  repo.worktrees.find(worktree => worktree.path === '/repos/external')!.dirty = true
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const external = repository.worktrees.find(worktree => worktree.path === '/repos/external')!
  const expected = {
    repoId: repository.repoId,
    worktreeId: external.worktreeId,
    branch: 'ext' as string | null,
    head: FEATURE_HEAD,
  }
  await assert.rejects(
    core.remove({ operationId: 'unreg-dirty', expected, path: '/repos/external' }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-dirty',
  )
  const removed = await core.remove({
    operationId: 'unreg-dirty-force',
    expected,
    path: '/repos/external',
    discardChanges: true,
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'none')
  assert.equal(removed.workspaceId, undefined)
  assert.equal(repo.branches.has('ext'), true)
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--force', '--', '/repos/external'])
})

test('force remove reconciles a committed timeout with a single --force call', async () => {
  // First attempt commits `git worktree remove --force` (dirty worktree,
  // discardChanges authorized) but the response is lost (simulated timeout
  // thrown AFTER the fake mutation applied). The same-id retry must converge
  // on the receipt WITHOUT re-running the mutation, and the reconcile/
  // commit dirty guards (core.ts reconcile/commit intent.discardChanges)
  // must be exercised by that path.
  const { core, repo } = setup({ linked: true })
  repo.worktrees[1]!.dirty = true
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees[1]!
  const input = {
    operationId: 'force-uncertain',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: linked.branch!,
      head: linked.head,
    },
    discardChanges: true,
  }
  repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated timeout after --force commit')
  await assert.rejects(core.remove(input))
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
  const reconciled = await core.remove(input)
  assert.equal(reconciled.removed, true)
  assert.equal(reconciled.replayed, true)
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--force', '--', LINKED])
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('discardChanges never overrides the locked guard, even on a clean worktree', async () => {
  const { core, repo } = setup({ linked: true })
  // Clean (no dirty flag) but LOCKED: discardChanges must still be rejected
  // with worktree-locked and zero git mutations — --force is only allowed to
  // relax the DIRTY check, never the host's locked guard (review 2026-08).
  repo.worktrees[1]!.locked = true
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees[1]!
  await assert.rejects(
    core.remove({
      operationId: 'force-locked',
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch!,
        head: linked.head,
      },
      discardChanges: true,
    }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-locked',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})
