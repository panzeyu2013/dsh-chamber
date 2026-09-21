/**
 * Git worktree core — removal semantics: the archived-aware running guard, the
 * registered/unregistered/missing-record legs, replay/reconcile receipts and the
 * dirty/locked/force decisions. Round-2 consolidation of remove-running-guard,
 * reconcile-replay-force and unregistered-leftover-vanish; shared fixtures live
 * in support/fake-repository.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GitWorktreeCore, GitWorktreeError, type GitCommandRequest } from '../src/core.ts'
import {
  MAIN,
  LINKED,
  FEATURE_HEAD,
  FakeRepository,
  setup,
  targetOf,
  refuses,
  mutationCalls,
  previewNew,
  STALE,
  addStaleRecord,
} from './support/fake-repository.ts'

test('remove rejects a running agent and stale expected state, then returns Git-first recovery data', async () => {
  const { core, repo, agents, workspaces } = setup({ linked: true })
  const { expected } = await targetOf(core)
  repo.existing.add(`${LINKED}/subagent`)
  agents.push({ sessionId: 's-unaccounted', status: 'running', cwd: `${LINKED}/subagent` })
  await assert.rejects(core.remove({ operationId: 'remove-running', workspaceId: 'ws-feature', expected }), refuses('running-agent'))
  agents.length = 0
  await assert.rejects(
    core.remove({ operationId: 'remove-stale', workspaceId: 'ws-feature', expected: { ...expected, head: 'a'.repeat(40) } }),
    refuses('expected-mismatch'),
  )

  const removed = await core.remove({ operationId: 'remove-ok', workspaceId: 'ws-feature', expected })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'delete-workspace')
  assert.deepEqual(removed.sessionIds, ['s-feature'])
  assert.equal(removed.branchPreserved, true)
  assert.equal(workspaces.some(workspace => workspace.workspaceId === 'ws-feature'), true)
  assert.equal(repo.branches.has('feature'), true)
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--', LINKED])
  assert.equal(repo.calls.some(call => call.args.includes('--force')), false)
  assert.equal(repo.calls.some(call => call.args[0] === 'branch'), false)

  const replay = await core.remove({ operationId: 'remove-ok', workspaceId: 'ws-feature', expected })
  assert.equal(replay.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  workspaces.splice(workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature'), 1)
  const receipt = await core.remove({ operationId: 'remove-ok', workspaceId: 'ws-feature', expected })
  assert.equal(receipt.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)

  // The same operation id with a drifted expected identity conflicts on the
  // intent fingerprint and never mutates again.
  await assert.rejects(
    core.remove({ operationId: 'remove-ok', workspaceId: 'ws-feature', expected: { ...expected, head: 'f'.repeat(40) } }),
    refuses('operation-conflict'),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('the running guard is archived-aware on the membership, path and snapshot legs', async () => {
  // MEMBERSHIP: a running workspace member blocks, then is inert once archived.
  const membership = setup({ linked: true })
  const membershipExpected = (await targetOf(membership.core)).expected
  membership.agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  await assert.rejects(membership.core.remove({ operationId: 'g-membership-blocked', workspaceId: 'ws-feature', expected: membershipExpected }), refuses('running-agent', /s-feature/))
  assert.equal(mutationCalls(membership.repo, 'remove').length, 0, 'a refusal never mutates')
  membership.archived.push('s-feature')
  const removed = await membership.core.remove({ operationId: 'g-membership-inert', workspaceId: 'ws-feature', expected: membershipExpected })
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.sessionIds, ['s-feature'], 'membership is still reported for the client workspace.delete')
  assert.equal(membership.agents.length, 1, 'the running agent fact is never mutated by the removal')
  assert.equal(membership.workspaces.some(workspace => workspace.workspaceId === 'ws-feature'), true,
    'the workspace registration is the CLIENT next step, never deleted here')

  // PATH: an ungrouped running cwd inside the worktree blocks; archived is inert.
  const path = setup({ linked: true })
  path.repo.existing.add(`${LINKED}/sub`)
  const pathExpected = (await targetOf(path.core)).expected
  path.agents.push({ sessionId: 's-ungrouped', status: 'running', cwd: `${LINKED}/sub` })
  await assert.rejects(path.core.remove({ operationId: 'g-path-blocked', workspaceId: 'ws-feature', expected: pathExpected }), refuses('running-agent', /cwd/))
  path.archived.push('s-ungrouped')
  assert.equal((await path.core.remove({ operationId: 'g-path-inert', workspaceId: 'ws-feature', expected: pathExpected })).removed, true)

  // SNAPSHOT: display lists every runner; blocking excludes inert ones; a running
  // FORK of an archived session is an independent run and stays blocking.
  const snap = setup({ linked: true })
  snap.repo.existing.add(`${LINKED}/sub`)
  snap.agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  snap.agents.push({ sessionId: 's-block', status: 'running', cwd: `${LINKED}/sub` })
  snap.agents.push({ sessionId: 'forked', status: 'running', cwd: `${LINKED}/sub`, parentSessionId: 's-feature' })
  snap.archived.push('s-feature')
  const linked = (await snap.core.snapshot()).repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.deepEqual([...linked.runningSessionIds].sort(), ['forked', 's-block', 's-feature'])
  assert.deepEqual(linked.blockingRunningSessionIds, ['s-block', 'forked'],
    'only subagent lineage inherits inertness: the fork edge terminates the walk')
})

test('subagent lineage governs inertness: archived ancestors, fork edges, cycles and unresolvable chains', async () => {
  // An archived ANCESTOR makes a running subagent descendant inert — loaded or not.
  const chain = setup({ linked: true })
  chain.repo.existing.add(`${LINKED}/sub`)
  const chainExpected = (await targetOf(chain.core)).expected
  chain.agents.push({ sessionId: 'parent', status: 'idle' })
  chain.agents.push({ sessionId: 'child', status: 'running', cwd: `${LINKED}/sub`, parentSessionId: 'parent', origin: 'subagent' })
  await assert.rejects(chain.core.remove({ operationId: 'chain-non-archived', workspaceId: 'ws-feature', expected: chainExpected }), refuses('running-agent'))
  chain.archived.push('parent')
  assert.equal((await chain.core.remove({ operationId: 'chain-archived', workspaceId: 'ws-feature', expected: chainExpected })).removed, true)
  assert.deepEqual(mutationCalls(chain.repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--', LINKED],
    'inertness never implies --force: dirty semantics are untouched')
  chain.repo.addLinked()
  chain.agents.length = 0
  chain.agents.push({ sessionId: 'child', status: 'running', cwd: `${LINKED}/sub`, parentSessionId: 'parent', origin: 'subagent' })
  assert.equal((await chain.core.remove({ operationId: 'chain-archived-unloaded', workspaceId: 'ws-feature', expected: chainExpected })).removed, true,
    'an archived-but-unloaded ancestor still wins')

  // A running FORK of an archived session is not inert: fork lineage is not subagent lineage.
  const fork = setup({ linked: true })
  fork.archived.push('source-session')
  fork.agents.push({ sessionId: 'source-session', status: 'idle' })
  fork.workspaces[1] = { ...fork.workspaces[1]!, sessionIds: ['forked'] }
  fork.agents.push({ sessionId: 'forked', status: 'running', cwd: `${MAIN}/elsewhere`, parentSessionId: 'source-session' })
  const forkExpected = (await targetOf(fork.core)).expected
  await assert.rejects(fork.core.remove({ operationId: 'fork-member', workspaceId: 'ws-feature', expected: forkExpected }), refuses('running-agent', /forked/))
  fork.workspaces[1] = { ...fork.workspaces[1]!, sessionIds: [] }
  fork.agents.length = 0
  fork.agents.push({ sessionId: 'source-session', status: 'idle' })
  fork.agents.push({ sessionId: 'forked', status: 'running', cwd: LINKED, parentSessionId: 'source-session' })
  await assert.rejects(fork.core.remove({ operationId: 'fork-path', workspaceId: 'ws-feature', expected: forkExpected }), refuses('running-agent', /cwd/))

  // Cycles: archived-free fails closed; a cycle WITH an archived member is inert.
  const cycle = setup({ linked: true })
  cycle.repo.existing.add(`${LINKED}/sub`)
  const cycleExpected = (await targetOf(cycle.core)).expected
  cycle.agents.push({ sessionId: 'a', status: 'running', cwd: `${LINKED}/sub`, parentSessionId: 'b', origin: 'subagent' })
  cycle.agents.push({ sessionId: 'b', status: 'idle', parentSessionId: 'a', origin: 'subagent' })
  await assert.rejects(cycle.core.remove({ operationId: 'cycle-archived-free', workspaceId: 'ws-feature', expected: cycleExpected }), refuses('running-agent'))
  cycle.archived.push('b')
  assert.equal((await cycle.core.remove({ operationId: 'cycle-archived-member', workspaceId: 'ws-feature', expected: cycleExpected })).removed, true)

  // Unresolvable chains (ghost ancestor, parentless subagent) fail closed.
  const ghost = setup({ linked: true })
  ghost.repo.existing.add(`${LINKED}/sub`)
  const ghostExpected = (await targetOf(ghost.core)).expected
  ghost.agents.push({ sessionId: 'child', status: 'running', cwd: `${LINKED}/sub`, parentSessionId: 'ghost', origin: 'subagent' })
  await assert.rejects(ghost.core.remove({ operationId: 'chain-unresolvable', workspaceId: 'ws-feature', expected: ghostExpected }), refuses('running-agent'))
  ghost.agents.length = 0
  ghost.agents.push({ sessionId: 'orphan-subagent', status: 'running', cwd: `${LINKED}/sub`, origin: 'subagent' })
  await assert.rejects(ghost.core.remove({ operationId: 'chain-parentless-subagent', workspaceId: 'ws-feature', expected: ghostExpected }), refuses('running-agent'))
  assert.equal(ghost.archived.length, 0)
  assert.equal(mutationCalls(ghost.repo, 'remove').length, 0)
})

test('a drifted agent origin is handled per row and reported loudly (never darkens the domain)', async () => {
  const { core, repo, agents, archived } = setup({ linked: true })
  archived.push('parent')
  agents.push({ sessionId: 'parent', status: 'idle' })
  agents.push({
    sessionId: 'drifted', status: 'running', cwd: LINKED, parentSessionId: 'parent', origin: 'fork' as unknown as 'subagent',
  })
  const snapshot = await core.snapshot()
  assert.equal(snapshot.sourceError, undefined,
    'one drifted row must NOT erase the whole domain (AGENTS: one failed entity must not block unrelated complete entities)')
  assert.equal(snapshot.repos.length, 1)
  const linked = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.deepEqual(linked.blockingRunningSessionIds, ['drifted'],
    'fail-closed: an unrecognized origin is not subagent-origin, so the session blocks')
  const diagnostic = snapshot.errors.find(error => error.code === 'agent-origin-unknown')
  assert.notEqual(diagnostic, undefined, 'the drift is never silent')
  assert.match(diagnostic!.message, /drifted/)
  assert.match(diagnostic!.message, /fork/)
  await assert.rejects(
    core.remove({
      operationId: 'drifted-origin',
      workspaceId: 'ws-feature',
      expected: { repoId: snapshot.repos[0]!.repoId, worktreeId: linked.worktreeId, branch: linked.branch!, head: linked.head },
    }),
    refuses('running-agent'),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('unrecognized agent status and a non-absolute running cwd are per-row, loud and fail closed', async () => {
  const status = setup({ linked: true })
  status.workspaces[1] = { ...status.workspaces[1]!, sessionIds: [...status.workspaces[1]!.sessionIds, 's-status'] }
  status.agents.push({ sessionId: 's-status', status: 'paused' as unknown as 'running', cwd: LINKED })
  const statusSnapshot = await status.core.snapshot()
  assert.equal(statusSnapshot.sourceError, undefined, 'one drifted status must NOT erase the whole domain')
  const statusLinked = statusSnapshot.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.deepEqual(statusLinked.runningSessionIds, ['s-status'], 'an unknown status is not idle')
  assert.deepEqual(statusLinked.blockingRunningSessionIds, ['s-status'], 'fail-closed: an unreadable liveness fact keeps blocking')
  const statusDiagnostic = statusSnapshot.errors.find(error => error.code === 'agent-status-unknown')
  assert.notEqual(statusDiagnostic, undefined, 'the drift is never silent')
  assert.match(statusDiagnostic!.message, /s-status/)
  assert.match(statusDiagnostic!.message, /paused/)
  await assert.rejects(
    status.core.remove({
      operationId: 'drifted-status',
      workspaceId: 'ws-feature',
      expected: { repoId: statusSnapshot.repos[0]!.repoId, worktreeId: statusLinked.worktreeId, branch: statusLinked.branch!, head: statusLinked.head },
    }),
    refuses('running-agent'),
  )
  assert.equal(mutationCalls(status.repo, 'remove').length, 0)

  const cwd = setup({ linked: true })
  const extra = cwd.repo.addLinked({ path: '/repos/unregistered', branch: 'unreg', head: FEATURE_HEAD })
  cwd.agents.push({ sessionId: 's-cwd', status: 'running', cwd: 'relative/worktree' })
  const cwdSnapshot = await cwd.core.snapshot()
  assert.equal(cwdSnapshot.sourceError, undefined, 'one drifted cwd must NOT erase the whole domain')
  const cwdDiagnostic = cwdSnapshot.errors.find(error => error.code === 'agent-cwd-unknown')
  assert.notEqual(cwdDiagnostic, undefined, 'the drift is never silent')
  assert.match(cwdDiagnostic!.message, /s-cwd/)
  assert.match(cwdDiagnostic!.message, /relative\/worktree/)
  const cwdRepository = cwdSnapshot.repos[0]!
  const cwdRow = cwdRepository.worktrees.find(worktree => worktree.path === extra.path)!
  await assert.rejects(
    cwd.core.remove({ operationId: 'drifted-cwd', expected: { repoId: cwdRepository.repoId, worktreeId: cwdRow.worktreeId, branch: cwdRow.branch!, head: cwdRow.head }, path: extra.path }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent-cwd-unavailable',
  )
  const registered = cwdRepository.worktrees.find(worktree => worktree.path === LINKED)!
  await assert.rejects(
    cwd.core.remove({
      operationId: 'drifted-cwd-registered',
      workspaceId: 'ws-feature',
      expected: { repoId: cwdRepository.repoId, worktreeId: registered.worktreeId, branch: registered.branch!, head: registered.head },
    }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent-cwd-unavailable',
  )
  assert.equal(mutationCalls(cwd.repo, 'remove').length, 0)
})

test('a throwing or malformed archivedSessionIds source fails snapshot AND remove loudly, mutating nothing', async () => {
  const cases = [
    { name: 'throw', mode: 'throw', code: 'state-source-unavailable' },
    { name: 'non-array', mode: 'non-array', code: 'state-source-invalid' },
    { name: 'non-string element', mode: 'non-string', code: 'state-source-invalid' },
    { name: 'empty element', mode: 'empty', code: 'state-source-invalid' },
  ] as const
  for (const testCase of cases) {
    const repo = new FakeRepository()
    repo.addLinked()
    let mode: string = 'ok'
    const core = new GitWorktreeCore({
      source: {
        listWorkspaces: () => [{ workspaceId: 'ws-feature', path: LINKED, sessionIds: ['s-feature'] }],
        listAgents: () => [{ sessionId: 's-feature', status: 'running', cwd: LINKED }],
        listArchivedSessionIds: () => {
          if (mode === 'throw') throw new Error('archived set offline')
          if (mode === 'non-array') return 's-feature' as unknown as readonly string[]
          if (mode === 'non-string') return ['s-feature', 42] as unknown as readonly string[]
          if (mode === 'empty') return ['']
          return []
        },
      },
      git: repo.runner,
      fs: repo.fs,
      worktreesRoot: '/worktrees',
    })
    const healthy = await core.snapshot()
    const linked = healthy.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
    mode = testCase.mode
    const failed = await core.snapshot()
    assert.notEqual(failed.sourceError, undefined, `${testCase.name}: snapshot must fail loudly`)
    assert.equal(failed.sourceError!.code, 'state-source-unavailable', testCase.name)
    assert.deepEqual(failed.repos, [], `${testCase.name}: never an empty success`)
    await assert.rejects(
      core.remove({
        operationId: `archived-drift-${testCase.mode}`,
        workspaceId: 'ws-feature',
        expected: { repoId: healthy.repos[0]!.repoId, worktreeId: linked.worktreeId, branch: linked.branch!, head: linked.head },
      }),
      error => error instanceof GitWorktreeError && error.code === testCase.code,
      `${testCase.name}: the removal legs re-read the same source and must fail identically`,
    )
    assert.equal(mutationCalls(repo, 'remove').length, 0, `${testCase.name}: nothing was mutated`)
  }
})

test('discardChanges relaxes only the dirty guard: main, locked and stale targets stay protected', async () => {
  const { core, repo } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const main = repository.worktrees[0]!
  await assert.rejects(
    core.remove({ operationId: 'remove-main', workspaceId: 'ws-main', expected: { repoId: repository.repoId, worktreeId: main.worktreeId, branch: 'main', head: main.head } }),
    refuses('main-worktree'),
  )
  repo.worktrees[1]!.dirty = true
  await assert.rejects(core.remove({ operationId: 'remove-dirty', workspaceId: 'ws-feature', expected: (await targetOf(core)).expected }), refuses('worktree-dirty'))
  repo.worktrees[1]!.dirty = false
  repo.worktrees[1]!.locked = true
  await assert.rejects(core.remove({ operationId: 'remove-locked', workspaceId: 'ws-feature', expected: (await targetOf(core)).expected }), refuses('worktree-locked'))
  // --force is only allowed to relax the DIRTY check, never the host's locked guard.
  await assert.rejects(
    core.remove({ operationId: 'remove-locked-force', workspaceId: 'ws-feature', expected: (await targetOf(core)).expected, discardChanges: true }),
    refuses('worktree-locked'),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('discardChanges force-removes dirty targets and reconciles a committed timeout with one --force call', async () => {
  const registered = setup({ linked: true })
  registered.repo.worktrees[1]!.dirty = true
  const { expected } = await targetOf(registered.core)
  await assert.rejects(registered.core.remove({ operationId: 'force-no-flag', workspaceId: 'ws-feature', expected }), refuses('worktree-dirty'))
  assert.equal(mutationCalls(registered.repo, 'remove').length, 0)
  const removed = await registered.core.remove({ operationId: 'force-op', workspaceId: 'ws-feature', expected, discardChanges: true })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'delete-workspace')
  assert.equal(removed.branchPreserved, true)
  assert.deepEqual(removed.sessionIds, ['s-feature'])
  assert.equal(registered.repo.branches.has('feature'), true)
  assert.equal(registered.workspaces.some(workspace => workspace.workspaceId === 'ws-feature'), true)
  assert.deepEqual(mutationCalls(registered.repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--force', '--', LINKED])
  assert.equal(registered.repo.calls.some(call => call.args[0] === 'branch'), false)
  const replay = await registered.core.remove({ operationId: 'force-op', workspaceId: 'ws-feature', expected, discardChanges: true })
  assert.equal(replay.replayed, true)
  assert.equal(mutationCalls(registered.repo, 'remove').length, 1)
  await assert.rejects(registered.core.remove({ operationId: 'force-op', workspaceId: 'ws-feature', expected }), refuses('operation-conflict'))

  const external = setup({ linked: true })
  external.repo.addLinked({ path: '/repos/external', branch: 'ext', head: FEATURE_HEAD }).dirty = true
  const externalExpected = (await targetOf(external.core, '/repos/external')).expected
  await assert.rejects(external.core.remove({ operationId: 'unreg-dirty', expected: externalExpected, path: '/repos/external' }), refuses('worktree-dirty'))
  const externalRemoved = await external.core.remove({ operationId: 'unreg-dirty-force', expected: externalExpected, path: '/repos/external', discardChanges: true })
  assert.equal(externalRemoved.removed, true)
  assert.equal(externalRemoved.next, 'none')
  assert.equal(externalRemoved.workspaceId, undefined)
  assert.equal(external.repo.branches.has('ext'), true)
  assert.deepEqual(mutationCalls(external.repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--force', '--', '/repos/external'])

  const timeout = setup({ linked: true })
  timeout.repo.worktrees[1]!.dirty = true
  const timeoutExpected = (await targetOf(timeout.core)).expected
  const input = { operationId: 'force-uncertain', workspaceId: 'ws-feature', expected: timeoutExpected, discardChanges: true }
  timeout.repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated timeout after --force commit')
  await assert.rejects(timeout.core.remove(input))
  assert.equal(timeout.repo.worktrees.some(worktree => worktree.path === LINKED), false)
  const reconciled = await timeout.core.remove(input)
  assert.equal(reconciled.removed, true)
  assert.equal(reconciled.replayed, true)
  assert.deepEqual(mutationCalls(timeout.repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--force', '--', LINKED])
  assert.equal(mutationCalls(timeout.repo, 'remove').length, 1)
})

test('every removal leg re-reads the archived set: unarchiving refuses the replay without a second delete', async () => {
  // Terminal receipt replay.
  const terminal = setup({ linked: true })
  const terminalTarget = await targetOf(terminal.core)
  const terminalInput = { operationId: 'terminal-unarchive', workspaceId: 'ws-feature', expected: terminalTarget.expected }
  terminal.workspaces[1] = { ...terminal.workspaces[1]!, sessionIds: ['s-feature'] }
  terminal.agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  terminal.archived.push('s-feature')
  assert.equal((await terminal.core.remove(terminalInput)).removed, true)
  terminal.archived.length = 0
  await assert.rejects(terminal.core.remove(terminalInput), refuses('running-agent', /s-feature/))
  assert.equal(mutationCalls(terminal.repo, 'remove').length, 1, 'a refused replay never deletes again')

  // Uncertain-outcome reconcile, registered leg.
  const uncertain = setup({ linked: true })
  const uncertainTarget = await targetOf(uncertain.core)
  const uncertainInput = { operationId: 'reconcile-unarchive', workspaceId: 'ws-feature', expected: uncertainTarget.expected }
  uncertain.workspaces[1] = { ...uncertain.workspaces[1]!, sessionIds: ['s-feature'] }
  uncertain.agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  uncertain.archived.push('s-feature')
  uncertain.repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated committed timeout')
  await assert.rejects(uncertain.core.remove(uncertainInput))
  uncertain.archived.length = 0
  await assert.rejects(uncertain.core.remove(uncertainInput), refuses('running-agent', /s-feature/))
  assert.equal(mutationCalls(uncertain.repo, 'remove').length, 1)

  // Uncertain-outcome reconcile, UNREGISTERED path leg.
  const unreg = setup()
  const extra = unreg.repo.addLinked({ path: '/repos/unregistered', branch: 'unreg', head: FEATURE_HEAD })
  const unregTarget = await targetOf(unreg.core, extra.path)
  const unregInput = { operationId: 'reconcile-unregistered-unarchive', expected: unregTarget.expected, path: extra.path }
  unreg.agents.push({ sessionId: 's-live', status: 'running', cwd: `${extra.path}/sub` })
  unreg.archived.push('s-live')
  unreg.repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(unreg.core.remove(unregInput))
  unreg.archived.length = 0
  await assert.rejects(unreg.core.remove(unregInput), refuses('running-agent', /cwd/))
  assert.equal(mutationCalls(unreg.repo, 'remove').length, 1)
})

test('reconcile and terminal-receipt replays enforce running/membership facts without a second delete', async () => {
  // The registered reconcile replay runs ONLY its own guard pair: a running
  // member must refuse (BLOCK direction).
  const refuse = setup({ linked: true })
  const refuseTarget = await targetOf(refuse.core)
  const refuseInput = { operationId: 'registered-reconcile-running', workspaceId: 'ws-feature', expected: refuseTarget.expected }
  refuse.repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(refuse.core.remove(refuseInput))
  refuse.workspaces[1] = { ...refuse.workspaces[1]!, sessionIds: ['s-feature'] }
  refuse.agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  await assert.rejects(refuse.core.remove(refuseInput), refuses('running-agent', /s-feature/))
  assert.equal(mutationCalls(refuse.repo, 'remove').length, 1, 'a refused replay never mutates again')
  assert.equal(refuse.repo.worktrees.some(worktree => worktree.path === LINKED), true)

  // ... and re-reads the archived set so an archived running member is ALLOWED
  // (the allow direction must not wedge every archived-only removal).
  const allow = setup({ linked: true })
  const allowTarget = await targetOf(allow.core)
  const allowInput = { operationId: 'registered-reconcile-archived', workspaceId: 'ws-feature', expected: allowTarget.expected }
  allow.workspaces[1] = { ...allow.workspaces[1]!, sessionIds: ['s-feature'] }
  allow.agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  allow.archived.push('s-feature')
  allow.repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(allow.core.remove(allowInput))
  const replayed = await allow.core.remove(allowInput)
  assert.equal(replayed.removed, true)
  assert.equal(replayed.replayed, true)
  assert.deepEqual(replayed.sessionIds, ['s-feature'])
  assert.equal(mutationCalls(allow.repo, 'remove').length, 2)

  // Terminal receipt replay allows an archived member and deletes nothing again.
  const receipt = setup({ linked: true })
  const receiptTarget = await targetOf(receipt.core)
  const receiptInput = { operationId: 'terminal-receipt-archived', workspaceId: 'ws-feature', expected: receiptTarget.expected }
  receipt.workspaces[1] = { ...receipt.workspaces[1]!, sessionIds: ['s-feature'] }
  receipt.agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  receipt.archived.push('s-feature')
  assert.equal((await receipt.core.remove(receiptInput)).removed, true)
  assert.equal((await receipt.core.remove(receiptInput)).replayed, true)
  assert.equal(mutationCalls(receipt.repo, 'remove').length, 1)

  // A reappeared target refuses the replay and is not deleted again.
  const gone = setup({ linked: true })
  const goneTarget = await targetOf(gone.core)
  const goneInput = { operationId: 'terminal-remove-reappeared', workspaceId: 'ws-feature', expected: goneTarget.expected }
  await gone.core.remove(goneInput)
  gone.repo.addLinked()
  await assert.rejects(gone.core.remove(goneInput), refuses('operation-conflict'))
  assert.equal(mutationCalls(gone.repo, 'remove').length, 1)
  assert.equal(gone.repo.worktrees.some(worktree => worktree.path === LINKED), true)

  // The same replay with changed membership or a late running agent fails closed.
  for (const change of ['membership', 'running'] as const) {
    const scope = setup({ linked: true })
    const target = await targetOf(scope.core)
    const input = { operationId: `terminal-remove-${change}`, workspaceId: 'ws-feature', expected: target.expected }
    await scope.core.remove(input)
    if (change === 'membership') {
      const index = scope.workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature')
      scope.workspaces[index] = { ...scope.workspaces[index]!, sessionIds: [...scope.workspaces[index]!.sessionIds, 'new-session'] }
    } else {
      scope.agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
    }
    await assert.rejects(scope.core.remove(input), refuses(change === 'membership' ? 'operation-conflict' : 'running-agent'))
    assert.equal(mutationCalls(scope.repo, 'remove').length, 1)
  }
})

test('remove retries reconcile committed failures and fails closed when receipts changed', async () => {
  for (const failure of ['timeout', 'post-read'] as const) {
    const { core, repo } = setup({ linked: true })
    const { expected } = await targetOf(core)
    const input = { operationId: `remove-${failure}`, workspaceId: 'ws-feature', expected }
    if (failure === 'timeout') repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated timeout')
    else repo.failListAfterRemove = true
    await assert.rejects(core.remove(input))
    assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
    const reconciled = await core.remove(input)
    assert.equal(reconciled.removed, true)
    assert.equal(reconciled.replayed, true)
    assert.deepEqual(reconciled.sessionIds, ['s-feature'])
    assert.equal(mutationCalls(repo, 'remove').length, 1)
  }
  for (const change of ['membership', 'running'] as const) {
    const { core, repo, workspaces, agents } = setup({ linked: true })
    const { expected } = await targetOf(core)
    const input = { operationId: `uncertain-receipt-${change}`, workspaceId: 'ws-feature', expected }
    repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated committed timeout')
    await assert.rejects(core.remove(input))
    if (change === 'membership') {
      const index = workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature')
      workspaces[index] = { ...workspaces[index]!, sessionIds: [...workspaces[index]!.sessionIds, 'late-session'] }
    } else {
      agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
    }
    await assert.rejects(core.remove(input), refuses(change === 'membership' ? 'operation-conflict' : 'running-agent'))
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
      expected: { repoId: repository.repoId, worktreeId: linked.worktreeId, branch: linked.branch, head: linked.head },
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
        workspaces[workspaceIndex] = { ...workspaces[workspaceIndex]!, sessionIds: [...workspaces[workspaceIndex]!.sessionIds, 'late-session'] }
      } else {
        agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
      }
    }

    await assert.rejects(
      core.remove({
        operationId: `remove-final-absent-${change}`,
        workspaceId: 'ws-feature',
        expected: { repoId: repository.repoId, worktreeId: linked.worktreeId, branch: linked.branch, head: linked.head },
      }),
      error => error instanceof GitWorktreeError && error.code === (change === 'membership' ? 'operation-conflict' : 'running-agent'),
    )
    assert.equal(actionLists, 2)
    assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
    assert.equal(mutationCalls(repo, 'remove').length, 0)
  }
})

test('unregistered removal is git-first with the dirty/path guards and idempotent replay', async () => {
  const { core, repo, agents, archived } = setup({ linked: true })
  const ext = repo.addLinked({ path: '/repos/external', branch: 'ext', head: FEATURE_HEAD })
  const { expected } = await targetOf(core, ext.path)
  ext.dirty = true
  await assert.rejects(core.remove({ operationId: 'op-unreg-dirty', expected, path: ext.path }), refuses('worktree-dirty'))
  ext.dirty = false
  await assert.rejects(core.remove({ operationId: 'op-unreg-nopath', expected }), refuses('invalid-input'))
  // The PATH-level running guard is archived-aware on this leg too.
  agents.push({ sessionId: 's-live', status: 'running', cwd: `${ext.path}/sub` })
  await assert.rejects(core.remove({ operationId: 'op-unreg-running', expected, path: ext.path }), refuses('running-agent', /cwd/))
  archived.push('s-live')
  const removed = await core.remove({ operationId: 'op-unreg', expected, path: ext.path })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'none')
  assert.equal(removed.workspaceId, undefined)
  assert.equal((await core.snapshot()).repos[0]!.worktrees.some(row => row.path === ext.path), false)
  const replay = await core.remove({ operationId: 'op-unreg', expected, path: ext.path })
  assert.equal(replay.removed, true)
  assert.equal(replay.replayed, true)
  assert.equal(replay.next, 'none')
})

test('missing-dir leftover records stay associated, never block other work and clean up in one plain remove', async () => {
  // A vanished directory with surviving git metadata keeps its raw-path workspace
  // association instead of leaking into the unregistered block.
  const associated = setup({ linked: true })
  associated.repo.existing.delete(LINKED)
  const vanishedRow = (await associated.core.snapshot()).repos[0]!.worktrees.find(worktree => worktree.path === LINKED)
  assert.ok(vanishedRow !== undefined, 'the vanished worktree row still exists (metadata alive)')
  assert.equal(vanishedRow.status, 'missing')
  assert.equal(vanishedRow.workspaceId, 'ws-feature')

  // A VANISHED (orphaned) workspace registration no longer blocks another removal.
  const orphan = setup({ linked: true })
  orphan.workspaces.push({ workspaceId: 'orphan-1', path: '/repos/orphaned-path', sessionIds: [] })
  const orphanTarget = await targetOf(orphan.core)
  assert.equal((await orphan.core.remove({ operationId: 'op-with-orphan', workspaceId: 'ws-feature', expected: orphanTarget.expected })).removed, true)

  // A stale record neither blocks preview/create nor another removal.
  const stale = setup({ linked: true })
  addStaleRecord(stale.repo)
  const staleTarget = await targetOf(stale.core, STALE)
  assert.equal(staleTarget.row.status, 'missing')
  assert.equal(staleTarget.row.workspaceId, null)
  assert.match((await previewNew(stale.core, 'new-worktree', 'topic')).repoId, /^repo_[0-9a-f]{64}$/)
  const linkedRow = staleTarget.repository.worktrees.find(row => row.path === LINKED)!
  assert.equal((await stale.core.remove({
    operationId: 'op-other-with-stale',
    workspaceId: 'ws-feature',
    expected: { repoId: staleTarget.repository.repoId, worktreeId: linkedRow.worktreeId, branch: linkedRow.branch!, head: linkedRow.head },
  })).removed, true)

  // Record-only cleanup: one plain remove (no --force), idempotent replay.
  const cleanup = setup({ linked: true })
  addStaleRecord(cleanup.repo)
  const cleanupTarget = await targetOf(cleanup.core, STALE)
  const removed = await cleanup.core.remove({ operationId: 'op-stale-clean', expected: cleanupTarget.expected, path: STALE })
  assert.equal(removed.removed, true)
  assert.equal(removed.replayed, false)
  assert.equal(removed.next, 'none')
  assert.equal(removed.path, STALE)
  const removeCalls = mutationCalls(cleanup.repo, 'remove')
  assert.equal(removeCalls.length, 1)
  assert.deepEqual(removeCalls[0]!.args, ['worktree', 'remove', '--', STALE])
  assert.equal((await cleanup.core.snapshot()).repos[0]!.worktrees.some(row => row.path === STALE), false)
  const replay = await cleanup.core.remove({ operationId: 'op-stale-clean', expected: cleanupTarget.expected, path: STALE })
  assert.equal(replay.removed, true)
  assert.equal(replay.replayed, true)
  assert.equal(replay.next, 'none')

  // A running session (archived) at the VANISHED path cannot be probed; the
  // record-only cleanup still converges with a plain remove.
  const recordOnly = setup({ linked: true })
  addStaleRecord(recordOnly.repo)
  const recordOnlyTarget = await targetOf(recordOnly.core, STALE)
  recordOnly.agents.push({ sessionId: 's-archived', status: 'running', cwd: `${STALE}/sub` })
  recordOnly.archived.push('s-archived')
  const recordOnlyRemoved = await recordOnly.core.remove({ operationId: 'record-only-archived', expected: recordOnlyTarget.expected, path: STALE })
  assert.equal(recordOnlyRemoved.removed, true)
  assert.deepEqual(mutationCalls(recordOnly.repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--', STALE])
})

test('missing leftover removal keeps locked/ghost/identity guards, matches detached rows and refuses reappearance', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  addStaleRecord(repo)
  const { expected } = await targetOf(core, STALE)
  repo.worktrees.find(row => row.path === STALE)!.locked = true
  await assert.rejects(core.remove({ operationId: 'op-stale-locked', expected, path: STALE }), refuses('worktree-locked'))
  repo.worktrees.find(row => row.path === STALE)!.locked = false
  workspaces.push({ workspaceId: 'ghost-stale', path: STALE, sessionIds: [] })
  await assert.rejects(core.remove({ operationId: 'op-stale-ghost', expected, path: STALE }), refuses('workspace-registered'))
  workspaces.pop()
  await assert.rejects(core.remove({ operationId: 'op-stale-repo', expected: { ...expected, repoId: `repo_${'0'.repeat(64)}` }, path: STALE }), refuses('expected-mismatch'))
  await assert.rejects(core.remove({ operationId: 'op-stale-wtid', expected: { ...expected, worktreeId: `worktree_${'0'.repeat(64)}` }, path: STALE }), refuses('expected-mismatch'))
  assert.equal(mutationCalls(repo, 'remove').length, 0)

  // A directory that reappears before the commit is a live worktree again.
  const race = setup({ linked: true })
  addStaleRecord(race.repo)
  const raceTarget = await targetOf(race.core, STALE)
  let lists = 0
  race.repo.onWorktreeList = () => { lists += 1; if (lists === 2) race.repo.existing.add(STALE) }
  await assert.rejects(race.core.remove({ operationId: 'op-stale-race', expected: raceTarget.expected, path: STALE }), refuses('worktree-invalid'))
  assert.equal(mutationCalls(race.repo, 'remove').length, 0)

  // The 2026-09 live record was DETACHED: the null branch identity must match.
  const detached = setup({ linked: true })
  detached.repo.existing.add(STALE)
  detached.repo.worktrees.push({ path: STALE, branch: null, head: FEATURE_HEAD })
  detached.repo.existing.delete(STALE)
  const detachedTarget = await targetOf(detached.core, STALE)
  assert.equal(detachedTarget.row.status, 'missing')
  assert.equal(detachedTarget.row.branch, null)
  const detachedRemoved = await detached.core.remove({ operationId: 'op-stale-detached', expected: detachedTarget.expected, path: STALE })
  assert.equal(detachedRemoved.removed, true)
  assert.equal(detachedRemoved.next, 'none')
  assert.equal(detachedRemoved.branch, null)
  assert.equal((await detached.core.snapshot()).repos[0]!.worktrees.some(row => row.path === STALE), false)
})

const VANISH = '/repos/vanish-target'

function statusProbes(repo: FakeRepository, cwd: string): GitCommandRequest[] {
  // Only the removal dirty probes (isDirty, no --branch); snapshot status reads are not removal probes.
  return repo.calls.filter(call => call.args[0] === 'status' && !call.args.includes('--branch') && call.cwd === cwd)
}

test('mid-flight directory vanish converges through record cleanup without a dirty probe', async () => {
  // The target vanishes before the in-lock preflight: the first attempt degrades
  // to record cleanup (no same-id retry) and never probes the gone cwd.
  const first = setup({ linked: true })
  const firstTarget = await targetOf(first.core, first.repo.addLinked({ path: VANISH, branch: 'vanish', head: FEATURE_HEAD }).path)
  let lists = 0
  first.repo.onWorktreeList = () => { lists += 1; if (lists === 1) first.repo.existing.delete(VANISH) }
  const firstRemoved = await first.core.remove({ operationId: 'op-vanish-midflight', expected: firstTarget.expected, path: VANISH })
  assert.equal(firstRemoved.removed, true)
  assert.equal(firstRemoved.replayed, false)
  assert.equal(firstRemoved.next, 'none')
  assert.deepEqual(mutationCalls(first.repo, 'remove')[0]!.args, ['worktree', 'remove', '--', VANISH])
  assert.equal(statusProbes(first.repo, VANISH).length, 0)
  assert.equal((await first.core.snapshot()).repos[0]!.worktrees.some(row => row.path === VANISH), false)

  // The target survives the first topology read but vanishes before the commit's
  // in-lock re-read: no probe follows the resolved-missing row.
  const commit = setup({ linked: true })
  const commitTarget = await targetOf(commit.core, commit.repo.addLinked({ path: VANISH, branch: 'vanish', head: FEATURE_HEAD }).path)
  const listCount = (): number => commit.repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list').length
  const listsBefore = listCount()
  lists = 0
  commit.repo.onWorktreeList = () => { lists += 1; if (lists === 2) commit.repo.existing.delete(VANISH) }
  const commitRemoved = await commit.core.remove({ operationId: 'op-vanish-commit', expected: commitTarget.expected, path: VANISH })
  assert.equal(commitRemoved.removed, true)
  assert.equal(commitRemoved.replayed, false)
  assert.deepEqual(mutationCalls(commit.repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--', VANISH])
  const probes = statusProbes(commit.repo, VANISH)
  assert.equal(probes.length, 1)
  const manageLists = commit.repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list')
  assert.ok(commit.repo.calls.indexOf(probes[0]!) < commit.repo.calls.indexOf(manageLists[listsBefore + 1]!),
    'the only dirty probe ran before the row was resolved missing')

  // A registered replay with a vanished target fails path-unavailable and never
  // re-attempts the mutation.
  const replay = setup({ linked: true })
  const replayTarget = await targetOf(replay.core)
  replay.repo.throwBeforeRemove = new GitWorktreeError('git-spawn-failed', 'simulated ENOENT')
  await assert.rejects(replay.core.remove({ operationId: 'op-reg-vanish', workspaceId: 'ws-feature', expected: replayTarget.expected }), refuses('git-spawn-failed'))
  const probesBefore = statusProbes(replay.repo, LINKED).length
  replay.repo.existing.delete(LINKED)
  await assert.rejects(replay.core.remove({ operationId: 'op-reg-vanish', workspaceId: 'ws-feature', expected: replayTarget.expected }), refuses('path-unavailable'))
  assert.equal(statusProbes(replay.repo, LINKED).length, probesBefore)
  assert.equal(mutationCalls(replay.repo, 'remove').length, 1)
})

test('remove with deleteBranch deletes at most once and reports a failed delete honestly', async () => {
  const success = setup({ linked: true })
  const successTarget = await targetOf(success.core)
  assert.equal(success.repo.branches.has('feature'), true)
  const removed = await success.core.remove({ operationId: 'remove-del', workspaceId: 'ws-feature', expected: successTarget.expected, deleteBranch: 'feature' })
  assert.equal(removed.removed, true)
  assert.equal(removed.branchDeleted, true)
  assert.equal(removed.branchDeleteFailed, undefined)
  assert.equal(removed.branchDeleteError, undefined, 'a successful branch delete carries no failure reason')
  assert.equal(success.repo.branches.has('feature'), false)
  assert.deepEqual(success.repo.calls.filter(call => call.args[0] === 'branch').at(-1)!.args, ['branch', '-D', 'feature'])
  const branchCallsBefore = success.repo.calls.filter(call => call.args[0] === 'branch').length
  const replay = await success.core.remove({ operationId: 'remove-del', workspaceId: 'ws-feature', expected: successTarget.expected, deleteBranch: 'feature' })
  assert.equal(replay.replayed, true)
  assert.equal(success.repo.calls.filter(call => call.args[0] === 'branch').length, branchCallsBefore, 'branch delete must run at most once')

  const failure = setup({ linked: true })
  const failureTarget = await targetOf(failure.core)
  failure.repo.branches.delete('feature')
  const failed = await failure.core.remove({ operationId: 'remove-fail-branch', workspaceId: 'ws-feature', expected: failureTarget.expected, deleteBranch: 'feature' })
  assert.equal(failed.removed, true)
  assert.equal(failed.branchDeleted, undefined)
  assert.equal(failed.branchDeleteFailed, true)
  // The failure carries the bounded reason so the client can show WHY it failed.
  assert.equal(typeof failed.branchDeleteError, 'string')
  assert.ok((failed.branchDeleteError ?? '').length > 0)
})
