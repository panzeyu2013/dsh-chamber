/**
 * core-ops-create.ts — the GitWorktreeCore create/rollback family.
 *
 * Deps injection instead of class surgery: the factory receives exactly the
 * fields and cross-family callbacks this path uses (git runner, fs, clock,
 * token, operation cap, preview/create-operation tables, common-dir mutex and
 * the read/validate/topology/path callbacks), so no private member of
 * GitWorktreeCore is widened. GitWorktreeCore keeps same-named facade methods
 * and the package/error surface stays stable.
 */

import { resolve, sep } from 'node:path'

import { MAX_PREVIEWS, PREVIEW_TTL_MS } from './core-constants.ts'
import { GitWorktreeError } from './core-errors.ts'
import type { CreateOperationRecord, CreatedFacts, PreviewRecord, SourceSnapshot, WorktreeTopology } from './core-internals.ts'
import type { CreateInput, CreateResult, GitCommandResult, PreviewCreateInput, PreviewCreateResult, RollbackCreateInput, RollbackCreateResult, WorkspaceFact } from './core-types.ts'
import { fail, opaqueId, parseCreateInput, parsePreviewInput, parseRollbackInput, previewToken } from './core-validation.ts'

/** Narrow host surface the create path needs; GitWorktreeCore satisfies it. */
export interface CreateOpsDeps {
  readonly createOperations: Map<string, CreateOperationRecord>
  readonly mutex: { run<T>(key: string, operation: () => Promise<T>): Promise<T> }
  readonly nextToken: () => string
  readonly now: () => number
  readonly operationCapacity: number
  readonly previews: Map<string, PreviewRecord>
  readonly worktreesRoot: string
  readonly anyWorkspaceOwnsPath: (state: SourceSnapshot, target: string) => Promise<boolean>
  readonly assertBranchFormat: (cwd: string, branch: string) => Promise<void>
  readonly assertNoRunningAtPath: (target: string, state: SourceSnapshot) => Promise<void>
  readonly assertPathAbsent: (path: string) => Promise<void>
  readonly clearDiscoveryCaches: () => void
  readonly discover: (cwd: string) => Promise<{ commonDir: string; topLevel: string }>
  readonly ensureWorktreeRoot: (root: string) => Promise<void>
  readonly existingPath: (path: string) => Promise<string>
  readonly gitChecked: (cwd: string, args: readonly string[], mutation?: boolean) => Promise<GitCommandResult>
  readonly isDirty: (path: string) => Promise<boolean>
  readonly localBranchHead: (cwd: string, branch: string) => Promise<string | null>
  readonly pruneCaches: () => void
  readonly readSource: () => Promise<SourceSnapshot>
  readonly topology: (cwd: string) => Promise<WorktreeTopology>
  readonly workspace: (state: SourceSnapshot, id: string) => WorkspaceFact
  readonly worktreeRootFor: (mainPath: string, commonDir: string) => string
}

/** The create family as returned by the factory (also used by the facade). */
export interface CreateOps {
  previewCreate(untrusted: PreviewCreateInput): Promise<PreviewCreateResult>
  create(untrusted: CreateInput): Promise<CreateResult>
  rollbackCreate(untrusted: RollbackCreateInput): Promise<RollbackCreateResult>
  verifyCreatedReplay(record: CreateOperationRecord): Promise<CreateResult>
  performCreate(id: string, preview: PreviewRecord, operation: CreateOperationRecord, replayed: boolean,): Promise<CreateResult>
  performRollback(id: string, facts: CreatedFacts, operation: CreateOperationRecord, replayed: boolean,): Promise<RollbackCreateResult>
  uniquePreviewToken(): string
  publicPreview(preview: PreviewRecord): PreviewCreateResult
  evictOldestCreateOperationIfFull(): void
}

export function createWorktreeCreateOps(deps: CreateOpsDeps): CreateOps {
  async function previewCreate(untrusted: PreviewCreateInput): Promise<PreviewCreateResult> {
    const input = parsePreviewInput(untrusted)
    const initial = await deps.readSource()
    const initialWorkspace = deps.workspace(initial, input.sourceWorkspaceId)
    const discovered = await deps.discover(initialWorkspace.path)

    return await deps.mutex.run(discovered.commonDir, async () => {
      const state = await deps.readSource()
      const workspace = deps.workspace(state, input.sourceWorkspaceId)
      const topology = await deps.topology(workspace.path)
      if (topology.commonDir !== discovered.commonDir) {
        fail('repository-changed', 'the source workspace changed repositories during preview')
      }
      const main = topology.worktrees[0]!
      if (main.bare) fail('bare-repository', 'bare repositories cannot own linked worktrees')

      const targetRoot = deps.worktreeRootFor(topology.mainPath, topology.commonDir)
      const targetPath = resolve(targetRoot, input.basename)
      if (!targetPath.startsWith(`${targetRoot}${sep}`)) fail('unsafe-path', 'target escaped the unified worktree root')
      await deps.assertPathAbsent(targetPath)
      await deps.assertBranchFormat(topology.mainPath, input.branch.name)

      const branchHead = await deps.localBranchHead(topology.mainPath, input.branch.name)
      let startHead: string
      if (input.branch.kind === 'existing') {
        if (branchHead === null) fail('branch-not-found', `local branch '${input.branch.name}' does not exist`)
        if (topology.worktrees.some(worktree => worktree.branch === input.branch.name)) {
          fail('branch-checked-out', `local branch '${input.branch.name}' is already checked out`)
        }
        startHead = branchHead
      } else {
        if (branchHead !== null) fail('branch-exists', `local branch '${input.branch.name}' already exists`)
        // OpenChamber sourceBranch: the new branch starts from the chosen
        // local branch's head (pinned as an exact commit), defaulting to the
        // main checkout HEAD.
        if (input.startRef !== undefined) {
          const startHeadOf = await deps.localBranchHead(topology.mainPath, input.startRef)
          if (startHeadOf === null) fail('branch-not-found', `source branch '${input.startRef}' does not exist`)
          startHead = startHeadOf
        } else {
          startHead = main.head
        }
      }

      deps.pruneCaches()
      if (deps.previews.size >= MAX_PREVIEWS) fail('preview-capacity', 'too many live worktree previews')
      const token = ops.uniquePreviewToken()
      const createdAt = deps.now()
      const preview: PreviewRecord = {
        previewToken: token,
        expiresAt: createdAt + PREVIEW_TTL_MS,
        repoId: opaqueId('repo', topology.commonDir),
        commonDir: topology.commonDir,
        mainPath: topology.mainPath,
        targetPath,
        branch: input.branch.name,
        branchMode: input.branch.kind,
        baseHead: startHead,
        startRef: input.branch.kind === 'new' ? input.startRef : undefined,
        sourceWorkspaceId: input.sourceWorkspaceId,
        basename: input.basename,
        createdAt,
      }
      deps.previews.set(token, preview)
      return ops.publicPreview(preview)
    })
  }

  /** Create exactly the previewed worktree, with bounded same-process TTL idempotency. */

  async function create(untrusted: CreateInput): Promise<CreateResult> {
    const input = parseCreateInput(untrusted)
    deps.clearDiscoveryCaches()
    deps.pruneCaches()
    const existing = deps.createOperations.get(input.operationId)
    let preview: PreviewRecord
    if (existing !== undefined) {
      if (existing.previewToken !== input.previewToken) {
        fail('operation-conflict', 'operationId is already bound to another preview')
      }
      preview = existing.preview
      if (existing.state === 'creating') {
        const result = await existing.createPromise!
        return { ...result, replayed: true }
      }
      if (existing.state === 'created') return await ops.verifyCreatedReplay(existing)
      if (existing.state === 'rolling-back'
        || existing.state === 'rollback-uncertain'
        || existing.state === 'rolled-back') {
        fail('operation-rolled-back', 'the create operation has already been rolled back')
      }
    } else {
      const candidate = deps.previews.get(input.previewToken)
      if (candidate === undefined) fail('preview-not-found', 'preview token is unknown or expired')
      if (candidate.expiresAt <= deps.now()) {
        deps.previews.delete(input.previewToken)
        fail('preview-expired', 'preview token has expired')
      }
      ops.evictOldestCreateOperationIfFull()
      if (deps.createOperations.size >= deps.operationCapacity) {
        fail('operation-capacity', 'too many retained worktree operations')
      }
      preview = candidate
    }
    const record: CreateOperationRecord = existing ?? {
      previewToken: input.previewToken,
      preview,
      state: 'ready',
      updatedAt: deps.now(),
      attemptedCreate: false,
      gitAccepted: false,
      attemptedRollback: false,
    }
    deps.createOperations.set(input.operationId, record)
    record.state = 'creating'
    record.updatedAt = deps.now()
    const promise = ops.performCreate(input.operationId, preview, record, existing !== undefined)
    record.createPromise = promise
    try {
      const result = await promise
      record.state = 'created'
      record.updatedAt = deps.now()
      record.createResult = result
      if (result.rollbackAuthorized) {
        record.facts = {
          repoId: result.repoId,
          worktreeId: result.worktreeId,
          commonDir: result.commonDir,
          mainPath: preview.mainPath,
          path: result.path,
          branch: result.branch,
          head: result.head,
          branchCreated: result.branchCreated,
        }
      }
      return result
    } catch (error) {
      // Once a mutation was admitted, timeout/output overflow/non-zero exit
      // and postcondition read failures all have uncertain commit outcome.
      // The same operation id must reconcile topology before another add.
      record.state = record.attemptedCreate ? 'uncertain' : 'ready'
      record.updatedAt = deps.now()
      record.createPromise = undefined
      throw error
    }
  }

  /**
   * Compensate only a worktree proven to have been created by this operation.
   * No force and no branch deletion are ever available.
   */

  async function rollbackCreate(untrusted: RollbackCreateInput): Promise<RollbackCreateResult> {
    const input = parseRollbackInput(untrusted)
    deps.clearDiscoveryCaches()
    deps.pruneCaches()
    const record = deps.createOperations.get(input.operationId)
    if (record === undefined) fail('operation-not-found', 'no create operation can authorize this rollback')
    if (record.state === 'creating') fail('operation-busy', 'create operation is still running')
    if (record.state === 'ready') fail('operation-not-created', 'create operation did not create a worktree')
    if (record.state === 'rolling-back') {
      const result = await record.rollbackPromise!
      return { ...result, replayed: true }
    }
    if (record.state === 'rolled-back') return { ...record.rollbackResult!, replayed: true }
    if (!record.gitAccepted || record.facts === undefined) {
      fail('rollback-not-authorized', 'Git add success was not observed; automatic rollback has no provenance')
    }

    const stateBeforeRollback = record.state
    record.state = 'rolling-back'
    record.updatedAt = deps.now()
    const promise = ops.performRollback(
      input.operationId,
      record.facts,
      record,
      stateBeforeRollback === 'rollback-uncertain',
    )
    record.rollbackPromise = promise
    try {
      const result = await promise
      record.state = 'rolled-back'
      record.updatedAt = deps.now()
      record.rollbackResult = result
      return result
    } catch (error) {
      record.state = record.attemptedRollback ? 'rollback-uncertain' : stateBeforeRollback
      record.updatedAt = deps.now()
      record.rollbackPromise = undefined
      throw error
    }
  }

  /** Git-first removal; the durable workspace registration remains for the caller's next step. */

  async function verifyCreatedReplay(record: CreateOperationRecord): Promise<CreateResult> {
    const result = record.createResult
    if (result === undefined) throw new Error('created operation is missing its terminal result')
    return await deps.mutex.run(result.commonDir, async () => {
      const topology = await deps.topology(record.preview.mainPath)
      if (topology.commonDir !== result.commonDir
        || topology.commonDir !== record.preview.commonDir
        || topology.mainPath !== record.preview.mainPath
        || opaqueId('repo', topology.commonDir) !== result.repoId) {
        fail('operation-conflict', 'created operation repository changed before terminal replay')
      }
      const target = topology.worktrees.find(worktree => worktree.path === result.path)
      if (target === undefined
        || target === topology.worktrees[0]
        || target.bare
        || result.path !== record.preview.targetPath
        || target.branch !== result.branch
        || target.branch !== record.preview.branch
        || target.head !== result.head
        || target.head !== record.preview.baseHead
        || opaqueId('worktree', topology.commonDir, target.path) !== result.worktreeId) {
        fail('operation-conflict', 'created worktree no longer has the terminal operation identity')
      }
      return { ...result, replayed: true }
    })
  }

  /** Verify the Git-first receipt again before a client retries workspace.delete. */

  async function performCreate(
    id: string,
    preview: PreviewRecord,
    operation: CreateOperationRecord,
    replayed: boolean,
  ): Promise<CreateResult> {
    return await deps.mutex.run(preview.commonDir, async () => {
      const state = await deps.readSource()
      const workspace = deps.workspace(state, preview.sourceWorkspaceId)
      const topology = await deps.topology(workspace.path)
      if (topology.commonDir !== preview.commonDir || topology.mainPath !== preview.mainPath) {
        fail('preview-stale', 'repository identity changed after preview')
      }
      const targetRoot = deps.worktreeRootFor(topology.mainPath, topology.commonDir)
      const targetPath = resolve(targetRoot, preview.basename)
      if (targetPath !== preview.targetPath || !targetPath.startsWith(`${deps.worktreesRoot}${sep}`)) {
        fail('preview-stale', 'target identity changed after preview')
      }

      const reconciled = topology.worktrees.find(worktree => worktree.path === targetPath)
      if (reconciled !== undefined) {
        if (!operation.attemptedCreate) {
          fail('target-exists', `target path '${targetPath}' was not created by this operation`)
        }
        if (reconciled.bare
          || reconciled.branch !== preview.branch
          || reconciled.head !== preview.baseHead) {
          fail('operation-conflict', 'operation target exists with a different branch or HEAD')
        }
        const facts: CreatedFacts = {
          repoId: opaqueId('repo', topology.commonDir),
          worktreeId: opaqueId('worktree', topology.commonDir, reconciled.path),
          commonDir: topology.commonDir,
          mainPath: topology.mainPath,
          path: reconciled.path,
          branch: preview.branch,
          head: reconciled.head,
          branchCreated: preview.branchMode === 'new' && operation.gitAccepted,
        }
        if (operation.gitAccepted) operation.facts = facts
        return {
          operationId: id,
          created: true,
          replayed: true,
          repoId: facts.repoId,
          worktreeId: facts.worktreeId,
          commonDir: facts.commonDir,
          path: facts.path,
          branch: facts.branch,
          head: facts.head,
          rollbackAuthorized: operation.gitAccepted,
          branchCreated: facts.branchCreated,
        }
      }

      await deps.assertPathAbsent(targetPath)
      await deps.assertBranchFormat(topology.mainPath, preview.branch)
      const branchHead = await deps.localBranchHead(topology.mainPath, preview.branch)

      if (preview.branchMode === 'existing') {
        if (branchHead !== preview.baseHead) fail('preview-stale', 'existing branch moved after preview')
        if (topology.worktrees.some(worktree => worktree.branch === preview.branch)) {
          fail('branch-checked-out', `local branch '${preview.branch}' is already checked out`)
        }
      } else {
        if (branchHead !== null) {
          fail(
            'operation-conflict',
            operation.gitAccepted && branchHead === preview.baseHead
              ? 'the confirmed worktree disappeared while its preserved branch remains'
              : 'new branch now exists without confirmed operation provenance',
          )
        } else if (preview.startRef !== undefined) {
          const startHead = await deps.localBranchHead(topology.mainPath, preview.startRef)
          if (startHead !== preview.baseHead) fail('preview-stale', 'source branch moved after preview')
        } else if (topology.worktrees[0]!.head !== preview.baseHead) {
          fail('preview-stale', 'main checkout moved after preview')
        }
      }

      // Re-read the registry immediately before mutation. This cannot make Git
      // and dsh storage transactional, but it closes ordinary UI races.
      const latest = await deps.readSource()
      const latestWorkspace = deps.workspace(latest, preview.sourceWorkspaceId)
      if (await deps.existingPath(latestWorkspace.path) !== await deps.existingPath(workspace.path)) {
        fail('preview-stale', 'source workspace path changed after preview')
      }

      const expectedFacts: CreatedFacts = {
        repoId: opaqueId('repo', topology.commonDir),
        worktreeId: opaqueId('worktree', topology.commonDir, targetPath),
        commonDir: topology.commonDir,
        mainPath: topology.mainPath,
        path: targetPath,
        branch: preview.branch,
        head: preview.baseHead,
        branchCreated: preview.branchMode === 'new',
      }
      operation.attemptedCreate = true

      await deps.ensureWorktreeRoot(targetRoot)
      const args = preview.branchMode === 'existing'
        ? ['worktree', 'add', '--', targetPath, preview.branch]
        : ['worktree', 'add', '-b', preview.branch, '--', targetPath, preview.baseHead]
      try {
        await deps.gitChecked(topology.mainPath, args, true)
      } catch (error) {
        // A spawn failure proves Git never accepted the operation. Timeout,
        // output overflow and non-zero exit remain ambiguous and are reconciled
        // by identity, but can never grant rollback provenance.
        if (error instanceof GitWorktreeError && error.code === 'git-spawn-failed') {
          operation.attemptedCreate = false
        }
        throw error
      }
      operation.gitAccepted = true
      operation.facts = expectedFacts

      const after = await deps.topology(topology.mainPath)
      const created = after.worktrees.find(worktree => worktree.path === targetPath)
      if (after.commonDir !== topology.commonDir
        || created === undefined
        || created.branch !== preview.branch
        || created.head !== preview.baseHead
        || created.bare) {
        fail('postcondition-failed', 'Git did not publish the expected worktree identity')
      }
      return {
        operationId: id,
        created: true,
        replayed,
        repoId: opaqueId('repo', after.commonDir),
        worktreeId: opaqueId('worktree', after.commonDir, created.path),
        commonDir: after.commonDir,
        path: created.path,
        branch: preview.branch,
        head: created.head,
        rollbackAuthorized: true,
        branchCreated: preview.branchMode === 'new',
      }
    })
  }

  async function performRollback(
    id: string,
    facts: CreatedFacts,
    operation: CreateOperationRecord,
    replayed: boolean,
  ): Promise<RollbackCreateResult> {
    return await deps.mutex.run(facts.commonDir, async () => {
      const state = await deps.readSource()
      if (await deps.anyWorkspaceOwnsPath(state, facts.path)) {
        fail('rollback-has-workspace', 'rollback is forbidden after a workspace registration exists')
      }
      await deps.assertNoRunningAtPath(facts.path, state)
      const topology = await deps.topology(facts.mainPath)
      if (topology.commonDir !== facts.commonDir) fail('repository-changed', 'created repository identity changed')
      const target = topology.worktrees.find(worktree => worktree.path === facts.path)
      if (target === undefined) {
        // A prior rollback may have committed before its response/post-read
        // failed. Proven create ownership plus authoritative absence is the
        // idempotent success condition; the preserved branch is untouched.
        return {
          operationId: id,
          removed: true,
          replayed: true,
          repoId: facts.repoId,
          worktreeId: facts.worktreeId,
          commonDir: facts.commonDir,
          path: facts.path,
          branch: facts.branch,
          head: facts.head,
          branchPreserved: true,
        }
      }
      if (target === topology.worktrees[0]) fail('main-worktree', 'the main checkout can never be rolled back')
      if (target.locked) fail('worktree-locked', 'locked worktrees cannot be rolled back')
      if (target.branch !== facts.branch) fail('worktree-changed', 'the operation-created worktree changed branch')
      if (target.head !== facts.head) fail('worktree-changed', 'the operation-created worktree changed HEAD')
      // A MISSING target (external actor deleted the directory, the admin
      // record survives) has no working-tree content to protect or probe —
      // the rollback then converges by clearing the leftover record (a plain
      // `git worktree remove` succeeds on the absent directory).
      if (target.missing !== true && await deps.isDirty(target.path)) fail('worktree-dirty', 'dirty worktrees cannot be rolled back')

      // Fresh workspace check immediately before Git removal. Never force.
      const latest = await deps.readSource()
      if (await deps.anyWorkspaceOwnsPath(latest, facts.path)) {
        fail('rollback-has-workspace', 'workspace registration appeared during rollback')
      }
      await deps.assertNoRunningAtPath(facts.path, latest)
      const finalTopology = await deps.topology(facts.mainPath)
      if (finalTopology.commonDir !== facts.commonDir || finalTopology.mainPath !== facts.mainPath) {
        fail('repository-changed', 'created repository identity changed immediately before rollback')
      }
      const finalTarget = finalTopology.worktrees.find(worktree => worktree.path === facts.path)
      if (finalTarget === undefined) {
        return {
          operationId: id,
          removed: true,
          replayed: true,
          repoId: facts.repoId,
          worktreeId: facts.worktreeId,
          commonDir: facts.commonDir,
          path: facts.path,
          branch: facts.branch,
          head: facts.head,
          branchPreserved: true,
        }
      }
      if (finalTarget === finalTopology.worktrees[0]
        || finalTarget.locked
        || finalTarget.branch !== facts.branch
        || finalTarget.head !== facts.head) {
        fail('worktree-changed', 'operation-created worktree identity changed immediately before rollback')
      }
      if (finalTarget.missing !== true && await deps.isDirty(finalTarget.path)) {
        fail('worktree-dirty', 'worktree became dirty immediately before rollback')
      }
      operation.attemptedRollback = true
      await deps.gitChecked(finalTopology.mainPath, ['worktree', 'remove', '--', facts.path], true)
      const after = await deps.topology(finalTopology.mainPath)
      if (after.worktrees.some(worktree => worktree.path === facts.path)) {
        fail('postcondition-failed', 'Git still reports the rolled-back worktree')
      }
      return {
        operationId: id,
        removed: true,
        replayed,
        repoId: facts.repoId,
        worktreeId: facts.worktreeId,
        commonDir: facts.commonDir,
        path: facts.path,
        branch: facts.branch,
        head: target.head,
        branchPreserved: true,
      }
    })
  }

  function uniquePreviewToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = previewToken(deps.nextToken())
      if (!deps.previews.has(token)) return token
    }
    fail('token-collision', 'could not allocate a unique preview token')
  }

  function publicPreview(preview: PreviewRecord): PreviewCreateResult {
    return {
      previewToken: preview.previewToken,
      expiresAt: preview.expiresAt,
      repoId: preview.repoId,
      commonDir: preview.commonDir,
      mainPath: preview.mainPath,
      targetPath: preview.targetPath,
      branch: preview.branch,
      baseHead: preview.baseHead,
    }
  }

  function evictOldestCreateOperationIfFull(): void {
    if (deps.createOperations.size < deps.operationCapacity) return
    let oldest: { id: string; updatedAt: number } | undefined
    for (const [id, record] of deps.createOperations) {
      // Capacity pressure may discard only a proven no-admission failure. An
      // uncertain/created/rolled-back record is an idempotency tombstone and/or
      // rollback provenance; evicting it early would permit ABA mutation.
      if (record.state !== 'ready'
        || record.attemptedCreate
        || record.attemptedRollback
        || record.facts !== undefined
        || record.createResult !== undefined
        || record.rollbackResult !== undefined) continue
      if (oldest === undefined || record.updatedAt < oldest.updatedAt) {
        oldest = { id, updatedAt: record.updatedAt }
      }
    }
    if (oldest !== undefined) deps.createOperations.delete(oldest.id)
  }

  const ops: CreateOps = {
    previewCreate,
    create,
    rollbackCreate,
    verifyCreatedReplay,
    performCreate,
    performRollback,
    uniquePreviewToken,
    publicPreview,
    evictOldestCreateOperationIfFull,
  }
  return ops
}
