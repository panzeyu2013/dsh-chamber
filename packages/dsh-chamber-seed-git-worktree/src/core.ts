/**
 * Conservative Git worktree lifecycle core.
 *
 * TRUST BOUNDARY: callers arrive over the instance's host wire and are
 * untrusted JSON. They never provide a Git command. This module validates the
 * small business vocabulary, derives every argv array itself, invokes Git with
 * `shell: false`, and caps time and output. The allowlist exposes no network Git
 * verb, disables credential prompts/lazy fetch and disables hooks. A checkout
 * may still run clean/smudge/process filters configured by the repository; that
 * repo configuration and any subprocess/I/O it causes are part of the dsh OS
 * user's trusted boundary. This is intentionally a host plugin, never a
 * desktop/SSH command relay.
 */


import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  DISCOVERY_TTL_MS,
  MAX_AGENTS,
  MAX_OPERATIONS,
  MAX_PATH_LENGTH,
  MAX_REPOSITORIES,
  MAX_SESSIONS_PER_WORKSPACE,
  MAX_TOTAL_SESSION_MEMBERSHIPS,
  MAX_TOTAL_WORKTREES,
  MAX_WORKSPACES,
  MAX_WORKTREES_PER_REPOSITORY,
  MUTATION_OUTPUT_CAP,
  MUTATION_TIMEOUT_MS,
  OPERATION_TTL_MS,
  READ_OUTPUT_CAP,
  READ_TIMEOUT_MS,
  SNAPSHOT_DEADLINE_MS,
  SNAPSHOT_STATUS_TIMEOUT_MS,
  SNAPSHOT_WALL_TIMEOUT_MS,
} from './core-constants.ts'
import { GitWorktreeError, SUBMODULE_REFUSAL_MESSAGE } from './core-errors.ts'
import {
  absoluteExpectedPath,
  assertRecord,
  assertSafeGitArgv,
  fail,
  nodeFileSystem,
  objectFingerprint,
  opaqueId,
  parseRemoveInput,
  requiredString,
  safeErrorMessage,
  sameMembership,
} from './core-validation.ts'
import { createLocalGitRunner } from './core-git-runner.ts'
import { createWorktreeCreateOps } from './core-ops-create.ts'
import { KeyedMutex } from './core-internals.ts'
import type {
  AgentRowDrift,
  CreateOperationRecord,
  PreviewRecord,
  RawWorktree,
  RemoveIntent,
  RemoveOperationRecord,
  SnapshotRunningLocation,
  SourceSnapshot,
  WorktreeTopology,
} from './core-internals.ts'
import {
  ZERO_HEAD,
  detectAttention,
  isNotARepositoryError,
  parseBranchLine,
  parseWorktreePorcelain,
  resolveDshHome,
  worktreeGitDir,
} from './core-parse.ts'
import type {
  AgentFact,
  CreateInput,
  CreateResult,
  GitAttentionReason,
  GitCommandResult,
  GitRunner,
  GitWorktreeCoreOptions,
  GitWorktreeState,
  PreviewCreateInput,
  PreviewCreateResult,
  RemoveInput,
  RemoveResult,
  RollbackCreateInput,
  RollbackCreateResult,
  SnapshotError,
  SnapshotRepository,
  SnapshotResult,
  SnapshotWorktree,
  WorkspaceFact,
  WorktreeFileSystem,
  WorktreeStateSource,
} from './core-types.ts'

// Public surface preserved verbatim.
export {
  MAX_OPERATIONS,
  MAX_REPOSITORIES,
  MAX_TOTAL_SESSION_MEMBERSHIPS,
  MAX_TOTAL_WORKTREES,
  MAX_WORKSPACES,
  MAX_WORKTREES_PER_REPOSITORY,
  OPERATION_TTL_MS,
  PREVIEW_TTL_MS,
  SNAPSHOT_DEADLINE_MS,
  SNAPSHOT_WALL_TIMEOUT_MS,
} from './core-constants.ts'
export { GitWorktreeError, RETRYABLE_CODES, domainResult } from './core-errors.ts'
export { assertSafeGitArgv } from './core-validation.ts'
export { createLocalGitRunner } from './core-git-runner.ts'
export { parseBranchLine } from './core-parse.ts'
export type {
  AgentFact,
  CreateBranch,
  CreateInput,
  CreateResult,
  GitAttentionReason,
  GitChildProcess,
  GitCommandRequest,
  GitCommandResult,
  GitRunner,
  GitSpawner,
  GitWorktreeCoreOptions,
  GitWorktreeDomainError,
  GitWorktreeDomainResult,
  GitWorktreeState,
  PreviewCreateInput,
  PreviewCreateResult,
  RemoveInput,
  RemoveResult,
  RollbackCreateInput,
  RollbackCreateResult,
  SnapshotRepository,
  SnapshotResult,
  SnapshotWorktree,
  WorkspaceFact,
  WorktreeFileSystem,
  WorktreeStateSource,
} from './core-types.ts'


/** Host-independent lifecycle implementation; tests inject both Git and state. */
export class GitWorktreeCore {
  private readonly source: WorktreeStateSource
  private readonly git: GitRunner
  private readonly fs: WorktreeFileSystem
  private readonly now: () => number
  private readonly nextToken: () => string
  private readonly operationCapacity: number
  private readonly snapshotWallTimeoutMs: number
  private readonly worktreesRoot: string
  private readonly mutex = new KeyedMutex()
  private readonly previews = new Map<string, PreviewRecord>()
  private readonly createOperations = new Map<string, CreateOperationRecord>()
  private readonly createOps: ReturnType<typeof createWorktreeCreateOps>
  private readonly removeOperations = new Map<string, RemoveOperationRecord>()
  private readonly workspaceDiscoverCache = new Map<string, { commonDir: string; topLevel: string; at: number }>()
  private readonly repoTopologyCache = new Map<string, {
    listedRaw: readonly RawWorktree[]
    branches: readonly string[]
    at: number
  }>()
  private lastWorkspaceSignature = ''
  private snapshotInFlight?: Promise<SnapshotResult>

  constructor(options: GitWorktreeCoreOptions) {
    this.source = options.source
    this.git = options.git ?? createLocalGitRunner()
    this.fs = options.fs ?? nodeFileSystem
    this.now = options.now ?? Date.now
    this.nextToken = options.token ?? randomUUID
    this.operationCapacity = options.operationCapacity ?? MAX_OPERATIONS
    if (!Number.isSafeInteger(this.operationCapacity)
      || this.operationCapacity < 1
      || this.operationCapacity > MAX_OPERATIONS) {
      fail('invalid-core-option', `operationCapacity must be between 1 and ${MAX_OPERATIONS}`)
    }
    this.snapshotWallTimeoutMs = options.snapshotWallTimeoutMs ?? SNAPSHOT_WALL_TIMEOUT_MS
    const worktreesRoot = options.worktreesRoot ?? join(resolveDshHome(), 'worktrees')
    if (!isAbsolute(worktreesRoot)) {
      fail('invalid-config', 'worktreesRoot must be an absolute path')
    }
    this.worktreesRoot = worktreesRoot
    if (!Number.isSafeInteger(this.snapshotWallTimeoutMs)
      || this.snapshotWallTimeoutMs < 1
      || this.snapshotWallTimeoutMs > SNAPSHOT_WALL_TIMEOUT_MS) {
      fail('invalid-core-option', `snapshotWallTimeoutMs must be between 1 and ${SNAPSHOT_WALL_TIMEOUT_MS}`)
    }
    this.createOps = createWorktreeCreateOps({
      createOperations: this.createOperations,
      mutex: this.mutex,
      nextToken: this.nextToken,
      now: this.now,
      operationCapacity: this.operationCapacity,
      previews: this.previews,
      worktreesRoot: this.worktreesRoot,
      anyWorkspaceOwnsPath: this.anyWorkspaceOwnsPath.bind(this),
      assertBranchFormat: this.assertBranchFormat.bind(this),
      assertNoRunningAtPath: this.assertNoRunningAtPath.bind(this),
      assertPathAbsent: this.assertPathAbsent.bind(this),
      clearDiscoveryCaches: this.clearDiscoveryCaches.bind(this),
      discover: this.discover.bind(this),
      ensureWorktreeRoot: this.ensureWorktreeRoot.bind(this),
      existingPath: this.existingPath.bind(this),
      gitChecked: this.gitChecked.bind(this),
      isDirty: this.isDirty.bind(this),
      localBranchHead: this.localBranchHead.bind(this),
      pruneCaches: this.pruneCaches.bind(this),
      readSource: this.readSource.bind(this),
      topology: this.topology.bind(this),
      workspace: this.workspace.bind(this),
      worktreeRootFor: this.worktreeRootFor.bind(this),
    })
  }

  /** Coalesce overlapping polls so a slow old snapshot cannot pile up behind the next tick. */
  snapshot(): Promise<SnapshotResult> {
    if (this.snapshotInFlight !== undefined) return this.snapshotInFlight
    const scan = this.collectSnapshot()
    let timer: NodeJS.Timeout
    const responseDeadline = new Promise<SnapshotResult>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise({
        repos: [],
        errors: [],
        sourceError: {
          code: 'snapshot-deadline',
          message: `snapshot did not settle within ${this.snapshotWallTimeoutMs}ms; the old scan remains single-flight`,
        },
      }), this.snapshotWallTimeoutMs)
      // NOT unref'd on purpose: an uncancellable hung scan is kept observable by
      // this deadline timer, which is the only handle that guarantees the
      // single-flight settles. Unref'ing lets a quiet process drain before the
      // deadline fires, turning a bounded response into a leaked promise.
    })
    const response = Promise.race([scan, responseDeadline])
    this.snapshotInFlight = response
    const clear = (): void => {
      clearTimeout(timer)
      // A timed-out filesystem/state read cannot be cancelled safely. Retain
      // its settled deadline response as the single-flight value until the old
      // scan actually exits, so later polls never start overlapping scans.
      if (this.snapshotInFlight === response) this.snapshotInFlight = undefined
    }
    void scan.then(clear, clear)
    return response
  }

  /** Best-effort per-repository projection. State-source failure is not an empty snapshot. */
  private async collectSnapshot(): Promise<SnapshotResult> {
    const deadline = this.now() + SNAPSHOT_DEADLINE_MS
    let state: SourceSnapshot
    try {
      state = await this.readSource()
    } catch (error) {
      const code = error instanceof GitWorktreeError && error.code === 'state-source-capacity'
        ? 'state-source-capacity'
        : 'state-source-unavailable'
      return {
        repos: [],
        errors: [],
        sourceError: { code, message: safeErrorMessage(error) },
      }
    }

    const errors: SnapshotError[] = []
    let sourceError: SnapshotResult['sourceError']
    // Loud per-row diagnostic for a drifted agent `origin` (2026-09 robustness
    // fix): the row is handled conservatively (not subagent-origin ⇒ it keeps
    // blocking), but the drift must never be silent — the vendor mismatch has
    // to be visible so it can be fixed.
    for (const drift of state.originDrift) {
      errors.push({
        code: 'agent-origin-unknown',
        operation: 'associate',
        message: `session '${drift.sessionId}' has an unrecognized origin '${drift.value}'; treating it as a fork edge (its run keeps blocking)`,
      })
    }
    // Same per-row rule for the other two agent-column drifts (2026-09
    // robustness fix): the conservative reading blocks the removal, and the
    // drift itself is loud — never a whole-source failure.
    for (const drift of state.statusDrift) {
      errors.push({
        code: 'agent-status-unknown',
        operation: 'associate',
        message: `session '${drift.sessionId}' has an unrecognized status '${drift.value}'; treating it as running (its run keeps blocking)`,
      })
    }
    for (const drift of state.cwdDrift) {
      errors.push({
        code: 'agent-cwd-unknown',
        operation: 'associate',
        message: state.blockingRunningIds.has(drift.sessionId)
          ? `running session '${drift.sessionId}' cwd '${drift.value}' is not a normalized absolute path; its location is unknown, so it keeps blocking and refuses every removal`
          : `session '${drift.sessionId}' cwd '${drift.value}' is not a normalized absolute path; its location is unknown`,
      })
    }
    // Registry-change invalidation: any workspace id/path change clears the
    // discovery caches so new/adopted workspaces are always discovered.
    const signature = state.workspaces.map(workspace => `${workspace.workspaceId}:${workspace.path}`).sort().join('|')
    if (signature !== this.lastWorkspaceSignature) {
      this.clearDiscoveryCaches()
      this.lastWorkspaceSignature = signature
    }
    const canonicalWorkspaces: Array<WorkspaceFact & { canonicalPath: string }> = []
    for (const workspace of state.workspaces) {
      if (this.now() >= deadline) {
        sourceError = {
          code: 'snapshot-deadline',
          message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms probe budget during workspace association`,
        }
        break
      }
      try {
        canonicalWorkspaces.push({ ...workspace, canonicalPath: await this.existingPath(workspace.path) })
      } catch (error) {
        errors.push({
          code: error instanceof GitWorktreeError ? error.code : 'workspace-path-failed',
          operation: 'discover',
          message: safeErrorMessage(error),
          path: workspace.path,
          workspaceId: workspace.workspaceId,
        })
      }
    }
    const runningLocationsResult = await this.snapshotRunningLocations(state, deadline, errors)
    const runningLocations = runningLocationsResult.locations
    if (runningLocationsResult.deadlineExceeded) {
      sourceError ??= {
        code: 'snapshot-deadline',
        message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms probe budget during agent association`,
      }
    }

    const groups = new Map<string, { cwd: string; workspaces: Array<WorkspaceFact & { canonicalPath: string }> }>()
    let gitSpawnFailures = 0
    for (const workspace of canonicalWorkspaces) {
      try {
        let discovered: { commonDir: string; topLevel: string }
        const cachedDiscover = this.workspaceDiscoverCache.get(workspace.canonicalPath)
        if (cachedDiscover !== undefined && this.now() - cachedDiscover.at < DISCOVERY_TTL_MS) {
          discovered = { commonDir: cachedDiscover.commonDir, topLevel: cachedDiscover.topLevel }
        } else {
          discovered = await this.snapshotDiscover(workspace.canonicalPath, deadline)
          this.workspaceDiscoverCache.set(workspace.canonicalPath, { ...discovered, at: this.now() })
        }
        const group = groups.get(discovered.commonDir)
        if (group === undefined) {
          if (groups.size >= MAX_REPOSITORIES) {
            errors.push({
              code: 'snapshot-repository-limit',
              operation: 'discover',
              message: `snapshot exceeded the ${MAX_REPOSITORIES} repository limit`,
              path: workspace.path,
              workspaceId: workspace.workspaceId,
            })
            sourceError = {
              code: 'snapshot-capacity',
              message: `snapshot stopped after ${MAX_REPOSITORIES} repositories`,
            }
            break
          }
          groups.set(discovered.commonDir, { cwd: discovered.topLevel, workspaces: [workspace] })
        } else {
          group.workspaces.push(workspace)
        }
      } catch (error) {
        if (error instanceof GitWorktreeError && error.code === 'git-spawn-failed') {
          gitSpawnFailures += 1
        }
        errors.push({
          code: error instanceof GitWorktreeError ? error.code : 'git-discovery-failed',
          operation: 'discover',
          message: safeErrorMessage(error),
          path: workspace.path,
          workspaceId: workspace.workspaceId,
        })
        if (error instanceof GitWorktreeError && error.code === 'snapshot-deadline') {
          sourceError = { code: 'snapshot-deadline', message: error.message }
          break
        }
      }
    }

    // Git executable absence belongs to the whole dsh source, not to every
    // workspace row. Do not probe with a broader `git --version` command: only
    // promote when every real workspace discovery failed at the spawn boundary.
    // A normal non-Git workspace fails later as `git-command-failed` and must
    // remain a local error rather than poisoning the source.
    if (canonicalWorkspaces.length > 0
      && groups.size === 0
      && gitSpawnFailures === canonicalWorkspaces.length) {
      return {
        repos: [],
        errors,
        sourceError: {
          code: 'git-unavailable',
          message: 'Git executable is unavailable for this dsh instance',
        },
      }
    }

    const repos: SnapshotRepository[] = []
    let remainingWorktrees = MAX_TOTAL_WORKTREES
    for (const [commonDir, group] of groups) {
      if (remainingWorktrees === 0) {
        errors.push({
          code: 'snapshot-total-worktree-limit',
          operation: 'list',
          message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} worktrees`,
          path: group.cwd,
        })
        sourceError ??= {
          code: 'snapshot-capacity',
          message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} total worktrees`,
        }
        break
      }
      try {
        let raw: readonly RawWorktree[]
        let branches: readonly string[]
        const cachedTopology = this.repoTopologyCache.get(commonDir)
        if (cachedTopology !== undefined && this.now() - cachedTopology.at < DISCOVERY_TTL_MS) {
          raw = cachedTopology.listedRaw
          branches = cachedTopology.branches
        } else {
          raw = await this.listWorktrees(group.cwd, deadline)
          branches = await this.listBranches(group.cwd, deadline)
          this.repoTopologyCache.set(commonDir, { listedRaw: raw, branches, at: this.now() })
        }
        if (raw.length > MAX_WORKTREES_PER_REPOSITORY) {
          errors.push({
            code: 'snapshot-worktree-limit',
            operation: 'list',
            message: `repository exceeds the ${MAX_WORKTREES_PER_REPOSITORY} worktree snapshot limit`,
            path: group.cwd,
          })
          sourceError ??= {
            code: 'snapshot-capacity',
            message: 'one or more repositories exceeded the worktree snapshot limit',
          }
        }
        const perRepository = Math.min(raw.length, MAX_WORKTREES_PER_REPOSITORY)
        const allowedWorktrees = Math.min(perRepository, remainingWorktrees)
        if (perRepository > remainingWorktrees) {
          errors.push({
            code: 'snapshot-total-worktree-limit',
            operation: 'list',
            message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} total worktrees`,
            path: group.cwd,
          })
          sourceError ??= {
            code: 'snapshot-capacity',
            message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} total worktrees`,
          }
        }
        const worktrees: SnapshotWorktree[] = []
        const associated = new Set<string>()
        let statusDeadlineReported = false

        const boundedRaw = raw.slice(0, allowedWorktrees)
        remainingWorktrees -= boundedRaw.length
        for (let index = 0; index < boundedRaw.length; index += 1) {
          const entry = boundedRaw[index]!
          let path = resolve(entry.path)
          let pathAvailable = false
          if (this.now() < deadline) {
            try {
              path = await this.existingPath(entry.path)
              pathAvailable = true
            } catch (error) {
              errors.push({
                code: error instanceof GitWorktreeError ? error.code : 'worktree-path-failed',
                operation: 'list',
                message: safeErrorMessage(error),
                path: entry.path,
              })
            }
          } else if (!statusDeadlineReported) {
            statusDeadlineReported = true
            sourceError ??= {
              code: 'snapshot-deadline',
              message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms probe budget`,
            }
            errors.push({
              code: 'snapshot-deadline',
              operation: 'associate',
              message: 'remaining filesystem and dirty associations were skipped after the snapshot deadline',
              path,
            })
          }

          const matches = group.workspaces.filter(workspace => workspace.canonicalPath === path)
          if (matches.length > 1) {
            errors.push({
              code: 'duplicate-workspace-path',
              operation: 'associate',
              message: `multiple workspace records own '${path}'`,
              path,
            })
          }
          let workspace: WorkspaceFact | undefined = matches[0]
          if (workspace === undefined && pathAvailable === false) {
            // A worktree whose directory no longer exists (externally deleted
            // worktree with surviving git metadata) cannot canonical-match —
            // the workspace at that path also failed realpath and is NOT in
            // the canonical group. Fall back to a RAW registry-path
            // comparison so the orphan stays associated with its workspace
            // row instead of leaking into the unregistered block
            // (cross-review P1-1: it would otherwise show twice — as an
            // orphan workspace AND as an unregistered 'missing' row — and the
            // badge delete could not converge).
            workspace = state.workspaces.find(candidate => candidate.path === entry.path)
          }
          if (workspace !== undefined) associated.add(workspace.workspaceId)

          let dirty: boolean | null = null
          let upstream: string | null = null
          let ahead = 0
          let behind = 0
          let statusUnhealthy: Extract<GitWorktreeState, 'not-a-repo' | 'invalid'> | null = null
          if (pathAvailable && !entry.bare) {
            if (this.now() >= deadline) {
              if (!statusDeadlineReported) {
                statusDeadlineReported = true
                sourceError ??= {
                  code: 'snapshot-deadline',
                  message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`,
                }
                errors.push({
                  code: 'snapshot-deadline',
                  operation: 'status',
                  message: 'remaining dirty checks were skipped after the snapshot deadline',
                  path,
                  ...(workspace === undefined ? {} : { workspaceId: workspace.workspaceId }),
                })
              }
            } else {
              try {
                const statusOutput = (await this.snapshotGitChecked(path, [
                  'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal',
                ], deadline, SNAPSHOT_STATUS_TIMEOUT_MS)).stdout
                // With --branch the first NUL-terminated field is the header;
                // anything after it is a real porcelain entry (dirty).
                const nul = statusOutput.indexOf('\0')
                const headerLine = nul >= 0 ? statusOutput.slice(0, nul) : statusOutput
                // INVARIANT: `--branch` always emits the header NUL-terminated
                // (verified against git 2.50.1: clean = `## main\0`). A
                // header without a trailing NUL is therefore treated as clean
                // (a lone bare header), never dirty — fail in the safe
                // direction (review P2-1).
                dirty = nul >= 0 && statusOutput.length > nul + 1
                const branchFacts = parseBranchLine(headerLine)
                upstream = branchFacts.upstream
                ahead = branchFacts.ahead
                behind = branchFacts.behind
              } catch (error) {
                if (error instanceof GitWorktreeError && error.code === 'snapshot-deadline') {
                  statusDeadlineReported = true
                  sourceError ??= { code: 'snapshot-deadline', message: error.message }
                }
                errors.push({
                  code: error instanceof GitWorktreeError ? error.code : 'git-status-failed',
                  operation: 'status',
                  message: safeErrorMessage(error),
                  path,
                  ...(workspace === undefined ? {} : { workspaceId: workspace.workspaceId }),
                })
                statusUnhealthy = isNotARepositoryError(error) ? 'not-a-repo' : 'invalid'
              }
            }
          }

          const status: GitWorktreeState = !pathAvailable
            ? 'missing'
            : statusUnhealthy ?? 'ready'
          const headState: 'branch' | 'detached' | 'unborn' = entry.branch === null
            ? 'detached'
            : ZERO_HEAD.test(entry.head)
              ? 'unborn'
              : 'branch'
          let attention: GitAttentionReason[] = []
          if (pathAvailable && !entry.bare && this.now() < deadline) {
            try {
              const gitDir = await worktreeGitDir(path, this.fs)
              if (gitDir !== null) {
                attention = await detectAttention(gitDir, this.fs, () => this.now() < deadline)
              }
            } catch {
              // Attention is best-effort; a probe failure must not fail the row.
            }
          }

          const sessionIds = workspace === undefined ? [] : [...workspace.sessionIds]
          const runningSessionIds = sessionIds.filter(id => state.runningSessionIds.has(id))
          for (const id of this.runningAtSnapshotPath(path, runningLocations)) {
            if (!runningSessionIds.includes(id)) runningSessionIds.push(id)
          }
          // The BLOCKING subset (design 08 §5.2 amendment 2026-09): the running
          // sessions that actually gate removal. An old client that reads only
          // runningSessionIds stays conservative (blocks on any running
          // session); a new client uses this field.
          const blockingRunningSessionIds = runningSessionIds.filter(id => state.blockingRunningIds.has(id))
          worktrees.push({
            worktreeId: opaqueId('worktree', commonDir, path),
            path,
            head: entry.head,
            branch: entry.branch,
            isMain: index === 0,
            dirty,
            locked: entry.locked,
            status,
            headState,
            upstream,
            ahead,
            behind,
            attention,
            workspaceId: workspace?.workspaceId ?? null,
            sessionIds,
            runningSessionIds,
            blockingRunningSessionIds,
          })
        }

        for (const workspace of group.workspaces) {
          if (!associated.has(workspace.workspaceId)) {
            errors.push({
              code: 'workspace-not-worktree-root',
              operation: 'associate',
              message: `workspace '${workspace.workspaceId}' is inside the repository but is not a worktree root`,
              path: workspace.path,
              workspaceId: workspace.workspaceId,
            })
          }
        }

        repos.push({
          repoId: opaqueId('repo', commonDir),
          commonDir,
          mainPath: worktrees[0]!.path,
          worktrees,
          branches,
        })
      } catch (error) {
        errors.push({
          code: error instanceof GitWorktreeError ? error.code : 'git-list-failed',
          operation: 'list',
          message: safeErrorMessage(error),
          path: group.cwd,
        })
        if (error instanceof GitWorktreeError && error.code === 'snapshot-deadline') {
          sourceError ??= { code: 'snapshot-deadline', message: error.message }
          break
        }
      }
    }

    return { repos, errors, ...(sourceError === undefined ? {} : { sourceError }) }
  }

  /** Issue a short-lived, in-memory preview after a coherent repository read. */
  /** Create-path facade (B5): the body lives in core-ops-create.ts. */
  async previewCreate(untrusted: PreviewCreateInput): Promise<PreviewCreateResult> {
    return await this.createOps.previewCreate(untrusted)
  }

  /** Create-path facade (B5): the body lives in core-ops-create.ts. */
  async create(untrusted: CreateInput): Promise<CreateResult> {
    return await this.createOps.create(untrusted)
  }

  /** Create-path facade (B5): the body lives in core-ops-create.ts. */
  async rollbackCreate(untrusted: RollbackCreateInput): Promise<RollbackCreateResult> {
    return await this.createOps.rollbackCreate(untrusted)
  }

  async remove(untrusted: RemoveInput): Promise<RemoveResult> {
    const input = parseRemoveInput(untrusted)
    const fingerprint = objectFingerprint(input)
    this.clearDiscoveryCaches()
    this.pruneCaches()
    const existing = this.removeOperations.get(input.operationId)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) fail('operation-conflict', 'operationId is bound to another removal')
      if (existing.state === 'removing') {
        const result = await existing.promise!
        return { ...result, replayed: true }
      }
      if (existing.state === 'removed') return await this.verifyRemovedReplay(existing)
    }

    if (existing === undefined) {
      this.evictOldestRemoveOperationIfFull()
      if (this.removeOperations.size >= this.operationCapacity) {
        fail('operation-capacity', 'too many retained worktree operations')
      }
    }
    const record: RemoveOperationRecord = existing ?? {
      fingerprint,
      state: 'ready',
      updatedAt: this.now(),
      attemptedRemove: false,
      branchDeleteAttempted: false,
    }
    this.removeOperations.set(input.operationId, record)
    record.state = 'removing'
    record.updatedAt = this.now()
    const promise = this.performRemove(input, record, existing !== undefined)
    record.promise = promise
    try {
      const result = await promise
      record.state = 'removed'
      record.updatedAt = this.now()
      record.result = result
      return result
    } catch (error) {
      // A host-proven pre-mutation refusal (explicit retryable: false — the
      // gate or the reclassification, both after proving the target still
      // exists) leaves NO uncertainty to reconcile: label the record 'ready'
      // exactly like the pre-mutation guard failures, even though a git
      // mutation attempt was made. Every other failure after the attempt
      // stays 'uncertain' (same-operation replay reconciles it).
      record.state = record.attemptedRemove
        && !(error instanceof GitWorktreeError && error.retryable === false)
        ? 'uncertain'
        : 'ready'
      record.updatedAt = this.now()
      record.promise = undefined
      throw error
    }
  }

  /** A terminal result is a receipt, not a substitute for current Git facts. */
  private async verifyRemovedReplay(record: RemoveOperationRecord): Promise<RemoveResult> {
    const intent = record.intent
    const result = record.result
    if (intent === undefined || result === undefined) {
      throw new Error('removed operation is missing its terminal receipt')
    }
    return await this.mutex.run(intent.commonDir, async () => {
      const topology = await this.topology(intent.mainPath)
      if (topology.commonDir !== intent.commonDir
        || topology.mainPath !== intent.mainPath
        || opaqueId('repo', topology.commonDir) !== intent.repoId) {
        fail('operation-conflict', 'removed operation repository changed before terminal replay')
      }
      if (topology.worktrees.some(worktree => worktree.path === intent.path)) {
        fail('operation-conflict', 'removed worktree path reappeared before terminal replay')
      }

      const state = await this.readSource()
      await this.assertRemovedWorkspaceReceipt(intent, state)
      return { ...result, replayed: true }
    })
  }

  private async assertRemovedWorkspaceReceipt(intent: RemoveIntent, state: SourceSnapshot): Promise<void> {
    const workspace = state.workspaces.find(candidate => candidate.workspaceId === intent.workspaceId)
    if (workspace === undefined) return
    if (workspace.path !== intent.workspacePath
      || !sameMembership(workspace.sessionIds, intent.sessionIds)) {
      fail('operation-conflict', 'workspace receipt changed after Git-first removal')
    }
    this.assertNoRunningSessions(workspace, state)
    await this.assertNoRunningAtPath(intent.path, state)
  }

  private async performRemove(
    input: RemoveInput,
    operation: RemoveOperationRecord,
    replayed: boolean,
  ): Promise<RemoveResult> {
    if (operation.intent !== undefined) {
      return await this.mutex.run(operation.intent.commonDir, async () => {
        return await this.reconcileBoundRemove(input, operation, operation.intent!, true)
      })
    }

    // UNREGISTERED removal (Plan A): the worktree has no dsh workspace —
    // discover from the explicit path, keep every git-level guard, skip the
    // workspace preflight/session guards and return next: 'none'.
    if (input.workspaceId === undefined) {
      const unregisteredPath = input.path
      if (unregisteredPath === undefined) fail('invalid-input', 'input.path is required for an unregistered removal')
      try {
        const canonicalPath = await this.existingPath(unregisteredPath)
        const discovered = await this.discover(canonicalPath)
        return await this.mutex.run(discovered.commonDir, async () => {
          const state = await this.readSource()
          const currentPath = await this.existingPath(unregisteredPath)
          await this.assertNoRunningAtPath(currentPath, state)
          // Fail-closed mirror of the registered branch (P1-3): the target must
          // NOT be registered as a workspace — a workspace AT the path or
          // INSIDE it blocks the unregistered removal (an adoption between the
          // snapshot and this action must not be silently deleted).
          for (const candidate of state.workspaces) {
            const candidatePath = await this.existingPath(candidate.path).catch(() => null)
            if (candidatePath === null) continue
            if (candidatePath === currentPath || candidatePath.startsWith(`${currentPath}${sep}`)) {
              fail('workspace-registered', 'the target worktree is already registered as a workspace')
            }
          }
          const topology = await this.topology(currentPath)
          if (topology.commonDir !== discovered.commonDir) fail('expected-mismatch', 'worktree changed repositories')
          const repoId = opaqueId('repo', topology.commonDir)
          if (repoId !== input.expected.repoId) fail('expected-mismatch', 'repository identity changed')
          const target = topology.worktrees.find(worktree => worktree.path === currentPath)
          if (target === undefined) fail('worktree-not-found', 'path is not an exact worktree root')
          const worktreeId = opaqueId('worktree', topology.commonDir, target.path)
          if (worktreeId !== input.expected.worktreeId) fail('expected-mismatch', 'worktree identity changed')
          this.assertRemovableTarget(target === topology.worktrees[0], target.locked, target.branch, target.head, input.expected)
          if (target.missing === true) {
            // The row was resolved MISSING (its directory vanished between the
            // in-lock preflight and this topology read). No filesystem probe
            // may touch a missing row — a git status spawn on the gone cwd
            // fails with a spawn error the outer catch cannot route. Degrade
            // ON THIS ATTEMPT: fail path-unavailable inside the mutex so the
            // catch below (which runs removeMissingUnregistered after the lock
            // is released — it re-acquires the common-dir mutex itself) routes
            // to the leftover-record cleanup, re-verifying every guard from
            // scratch.
            fail('path-unavailable', `cannot resolve '${target.path}': the worktree directory is gone`)
          }
          if (await this.isDirty(target.path) && input.discardChanges !== true) {
            fail('worktree-dirty', 'dirty worktrees cannot be removed')
          }
          const intent: RemoveIntent = {
            repoId,
            worktreeId,
            commonDir: topology.commonDir,
            mainPath: topology.mainPath,
            path: target.path,
            branch: target.branch,
            head: target.head,
            sessionIds: [],
            deleteBranch: input.deleteBranch,
            discardChanges: input.discardChanges,
          }
          operation.intent = intent
          return await this.commitBoundRemove(input.operationId, operation, intent, replayed)
        })
      } catch (error) {
        // A directory that is GONE (externally deleted without `git worktree
        // remove`) cannot be discovered or removed like a live worktree — only
        // its admin record survives in `git worktree list`, and the sidebar
        // shows the row as missing. The removal then degrades to clearing the
        // leftover record (removeMissingUnregistered); a path-unavailable ANYWHERE
        // in the live flow above (TOCTOU: the directory vanished after the
        // probe) routes there too, where every guard is re-run from scratch.
        // Every other failure keeps its semantics.
        if (!(error instanceof GitWorktreeError) || error.code !== 'path-unavailable') throw error
        return await this.removeMissingUnregistered(input, operation, replayed)
      }
    }

    // Registered branch: workspaceId is present (narrowed for the checks).
    const registeredWorkspaceId = input.workspaceId
    const initialState = await this.readSource()
    const initialWorkspace = this.workspace(initialState, registeredWorkspaceId)
    const discovered = await this.discover(initialWorkspace.path)
    return await this.mutex.run(discovered.commonDir, async () => {
      let state = await this.readSource()
      let workspace = this.workspace(state, registeredWorkspaceId)
      const workspacePath = await this.existingPath(workspace.path)
      await this.assertNoOtherWorkspaceWithin(state, workspacePath, registeredWorkspaceId)
      this.assertNoRunningSessions(workspace, state)
      await this.assertNoRunningAtPath(workspacePath, state)

      const topology = await this.topology(workspace.path)
      if (topology.commonDir !== discovered.commonDir) fail('expected-mismatch', 'workspace changed repositories')
      const repoId = opaqueId('repo', topology.commonDir)
      if (repoId !== input.expected.repoId) fail('expected-mismatch', 'repository identity changed')
      const target = topology.worktrees.find(worktree => worktree.path === workspacePath)
      if (target === undefined) fail('worktree-not-found', 'workspace is not an exact worktree root')
      const worktreeId = opaqueId('worktree', topology.commonDir, target.path)
      if (worktreeId !== input.expected.worktreeId) fail('expected-mismatch', 'worktree identity changed')
      this.assertRemovableTarget(target === topology.worktrees[0], target.locked, target.branch, target.head, input.expected)
      if (await this.isDirty(target.path) && input.discardChanges !== true) {
        fail('worktree-dirty', 'dirty worktrees cannot be removed')
      }

      // Git-first protocol: capture the final durable membership, reject a
      // running associated agent, remove only Git state, and return enough
      // identity for the client to perform workspace.delete next.
      state = await this.readSource()
      workspace = this.workspace(state, registeredWorkspaceId)
      if (await this.existingPath(workspace.path) !== workspacePath) {
        fail('expected-mismatch', 'workspace path changed during removal')
      }
      await this.assertNoOtherWorkspaceWithin(state, workspacePath, registeredWorkspaceId)
      this.assertNoRunningSessions(workspace, state)
      await this.assertNoRunningAtPath(workspacePath, state)
      const sessionIds = [...workspace.sessionIds]

      const intent: RemoveIntent = {
        workspaceId: input.workspaceId,
        workspacePath: workspace.path,
        repoId,
        worktreeId,
        commonDir: topology.commonDir,
        mainPath: topology.mainPath,
        path: target.path,
        branch: target.branch,
        head: target.head,
        sessionIds,
        deleteBranch: input.deleteBranch,
        discardChanges: input.discardChanges,
      }
      operation.intent = intent
      return await this.commitBoundRemove(input.operationId, operation, intent, replayed)
    })
  }

  /** UNREGISTERED removal of a leftover record whose directory is GONE
   *  (externally deleted without `git worktree remove`; `git worktree list`
   *  keeps the admin record and the sidebar shows the row as missing). There
   *  is no filesystem content left to protect or probe — the removal clears
   *  the surviving admin record with a plain `git worktree remove` (verified
   *  to succeed on a missing directory against git 2.50). The owning
   *  repository cannot be discovered from the (absent) path, so it is
   *  located from the source's registered workspaces instead, and every
   *  surviving guard (record identity, main/locked, ghost workspace) still
   *  applies before anything is mutated. */
  /** Single main/locked/branch/head precondition shared by every removal
   *  entry (B5 convergence): the registered, missing-record and
   *  unregistered-locate paths used to repeat these four checks with
   *  identical codes and messages. `isMain` is precomputed by the caller
   *  (topology row vs located record); the rollback path keeps its own
   *  wording because it refuses a different operation. */
  private assertRemovableTarget(
    isMain: boolean,
    locked: boolean,
    branch: string | null,
    head: string,
    expected: { readonly branch: string | null; readonly head: string },
  ): void {
    if (isMain) fail('main-worktree', 'the main checkout cannot be removed')
    if (locked) fail('worktree-locked', 'locked worktrees cannot be removed')
    if (branch !== expected.branch) fail('expected-mismatch', 'worktree branch changed')
    if (head !== expected.head) fail('expected-mismatch', 'worktree HEAD changed')
  }

  /** Pure re-comparison of one resolved topology row against the bound removal
   *  intent (2026-12 convergence): the three replay/commit guards used to
   *  inline the identical repository/worktree-id/branch/head/main/locked
   *  comparisons. This comparison performs no I/O and never reads the state
   *  source — the caller already resolved `topology` and `target`. Each call
   *  site keeps its own `fail(code, message)` mapping, so the historical wire
   *  codes and texts stay byte-identical. Precedence mirrors the historical
   *  check order: repository identity, worktree id, branch, head, then main,
   *  then locked. */
  private boundTargetDiff(
    topology: WorktreeTopology,
    target: RawWorktree,
    intent: RemoveIntent,
  ): 'repo' | 'main' | 'locked' | 'worktree-id' | 'branch' | 'head' | null {
    if (opaqueId('repo', topology.commonDir) !== intent.repoId) return 'repo'
    if (opaqueId('worktree', topology.commonDir, target.path) !== intent.worktreeId) return 'worktree-id'
    if (target.branch !== intent.branch) return 'branch'
    if (target.head !== intent.head) return 'head'
    if (target === topology.worktrees[0]) return 'main'
    if (target.locked) return 'locked'
    return null
  }

  private async removeMissingUnregistered(
    input: RemoveInput,
    operation: RemoveOperationRecord,
    replayed: boolean,
  ): Promise<RemoveResult> {
    const targetPath = input.path!
    const located = await this.locateMissingRecord(input.expected.repoId, targetPath)
    const worktreeId = opaqueId('worktree', located.commonDir, located.row.path)
    if (worktreeId !== input.expected.worktreeId) fail('expected-mismatch', 'worktree identity changed')
    this.assertRemovableTarget(located.isMain, located.row.locked, located.row.branch, located.row.head, input.expected)
    const intent: RemoveIntent = {
      repoId: located.repoId,
      worktreeId,
      commonDir: located.commonDir,
      mainPath: located.mainPath,
      path: targetPath,
      branch: located.row.branch,
      head: located.row.head,
      sessionIds: [],
      deleteBranch: input.deleteBranch,
      discardChanges: input.discardChanges,
    }
    operation.intent = intent
    return await this.mutex.run(located.commonDir, async () => {
      return await this.commitMissingRecordRemove(input.operationId, operation, intent, replayed)
    })
  }

  /** Locate the repository whose `git worktree list` still carries the stale
   *  record for `targetPath`. The path itself is gone, so discovery walks the
   *  source's registered workspaces (the same discovery the snapshot uses) —
   *  a vanished workspace is skipped (its repository still surfaces through
   *  its surviving workspaces; one failed entity must not block unrelated
   *  ones). Fails `expected-mismatch` when the record was found but belongs
   *  to a different repository than the caller claims, and
   *  `worktree-not-found` when no repository lists the path at all. */
  private async locateMissingRecord(
    expectedRepoId: string,
    targetPath: string,
  ): Promise<{ commonDir: string; mainPath: string; repoId: string; row: RawWorktree; isMain: boolean }> {
    const state = await this.readSource()
    const walked = new Set<string>()
    let sawPathOnWrongRepository = false
    for (const workspace of state.workspaces) {
      let canonicalPath: string
      try {
        canonicalPath = await this.existingPath(workspace.path)
      } catch (error) {
        if (!(error instanceof GitWorktreeError) || error.code !== 'path-unavailable') throw error
        continue
      }
      let discovered: { commonDir: string; topLevel: string }
      const cached = this.workspaceDiscoverCache.get(canonicalPath)
      if (cached !== undefined && this.now() - cached.at < DISCOVERY_TTL_MS) {
        discovered = { commonDir: cached.commonDir, topLevel: cached.topLevel }
      } else {
        try {
          discovered = await this.discover(canonicalPath)
          this.workspaceDiscoverCache.set(canonicalPath, { ...discovered, at: this.now() })
        } catch (error) {
          // A non-Git or otherwise undiscoverable workspace: its discovery
          // failures belong to the snapshot — keep walking (the git
          // executable would have failed every discovery and the caller
          // still gets a deterministic not-found).
          if (error instanceof GitWorktreeError) continue
          throw error
        }
      }
      if (walked.has(discovered.commonDir)) continue
      walked.add(discovered.commonDir)
      const rows = await this.listWorktreesWith(async args => this.gitCommand(discovered.topLevel, args, false))
      if (rows.length === 0) continue
      const row = rows.find(candidate => resolve(candidate.path) === targetPath)
      if (row === undefined) continue
      const repoId = opaqueId('repo', discovered.commonDir)
      if (repoId !== expectedRepoId) {
        sawPathOnWrongRepository = true
        continue
      }
      // The main checkout is listed first and its directory exists whenever
      // the repository is reachable — canonicalize for a stable commit cwd.
      const mainPath = await this.existingPath(resolve(rows[0]!.path))
      return {
        commonDir: discovered.commonDir,
        mainPath,
        repoId,
        row: { ...row, path: resolve(row.path) },
        isMain: resolve(rows[0]!.path) === resolve(row.path),
      }
    }
    if (sawPathOnWrongRepository) {
      fail('expected-mismatch', 'repository identity changed')
    }
    fail('worktree-not-found', `no repository in the source lists a missing worktree at '${targetPath}'`)
  }

  /** Best-effort optional branch deletion after a removal, once per
   *  operation (design 08 §5.3 user decision). Called from every terminal
   *  removal path — including the target-absent replay paths — so a removal
   *  that committed before a failure still reports the branch outcome
   *  honestly (branchDeleted / branchDeleteFailed on the result). */
  private async attemptBranchDelete(
    operation: RemoveOperationRecord,
    intent: RemoveIntent,
    mainPath: string,
  ): Promise<void> {
    if (intent.deleteBranch === undefined || operation.branchDeleteAttempted) return
    operation.branchDeleteAttempted = true
    try {
      await this.assertBranchFormat(mainPath, intent.deleteBranch)
      await this.gitChecked(mainPath, ['branch', '-D', intent.deleteBranch], true)
      intent.branchDeleted = true
    } catch (error) {
      intent.branchDeleteFailed = true
      intent.branchDeleteError = safeErrorMessage(error)
    }
  }

  /** Reconcile a removal whose Git subprocess may have committed before failure. */
  private async reconcileBoundRemove(
    input: RemoveInput,
    operation: RemoveOperationRecord,
    intent: RemoveIntent,
    replayed: boolean,
  ): Promise<RemoveResult> {
    const topology = await this.topology(intent.mainPath)
    if (topology.commonDir !== intent.commonDir || topology.mainPath !== intent.mainPath) {
      fail('operation-conflict', 'bound removal repository identity changed')
    }
    const target = topology.worktrees.find(worktree => worktree.path === intent.path)
    if (target === undefined) {
      // Git-first success may precede both the response and the postcondition
      // read. Re-read the registry so a recycled workspace id cannot make the
      // client delete a different durable record.
      const state = await this.readSource()
      await this.assertRemovedWorkspaceReceipt(intent, state)
      await this.attemptBranchDelete(operation, intent, topology.mainPath)
      return this.removeResult(input.operationId, intent, true)
    }

    // One shared pure comparison; this replay keeps its own code/message map.
    const boundDiff = this.boundTargetDiff(topology, target, intent)
    if (boundDiff === 'main') fail('operation-conflict', 'bound linked worktree became the main checkout')
    if (boundDiff === 'locked') fail('worktree-locked', 'locked worktrees cannot be removed')
    if (boundDiff !== null) fail('operation-conflict', 'bound removal target changed while its outcome was uncertain')

    if (input.workspaceId === undefined) {
      // UNREGISTERED replay: no workspace — skip the registry/workspace
      // guards, keep the path-level running check and the identity checks.
      const state = await this.readSource()
      let canonicalPath: string | null = null
      try {
        canonicalPath = await this.existingPath(intent.path)
      } catch (error) {
        if (!(error instanceof GitWorktreeError) || error.code !== 'path-unavailable') throw error
      }
      if (canonicalPath === null) {
        // The directory is STILL gone: replay the record-only cleanup of the
        // leftover admin record (guards re-verified under this held mutex).
        operation.intent = intent
        return await this.commitMissingRecordRemove(input.operationId, operation, intent, replayed)
      }
      await this.assertNoRunningAtPath(canonicalPath, state)
      operation.intent = intent
      return await this.commitBoundRemove(input.operationId, operation, intent, replayed)
    }

    // Registered replay: a target whose row is resolved MISSING (directory
    // externally gone since the pre-mutation attempt) has no working-tree
    // content to protect — and no filesystem probe may touch it: a git status
    // spawn on the vanished cwd fails with a spawn error instead of the
    // path-unavailable the client can route. Skipping the probe lets this
    // replay converge exactly like the first attempt's preflight: the
    // workspace path can no longer be re-resolved, so the replay fails
    // path-unavailable below and the workspace's orphan (registration-only)
    // flows take over.
    if (target.missing !== true && await this.isDirty(target.path) && intent.discardChanges !== true) {
      fail('worktree-dirty', 'dirty worktrees cannot be removed')
    }

    const state = await this.readSource()
    const workspace = this.workspace(state, input.workspaceId)
    const workspacePath = await this.existingPath(workspace.path)
    if (workspacePath !== intent.path) fail('operation-conflict', 'workspace path changed during removal recovery')
    await this.assertNoOtherWorkspaceWithin(state, workspacePath, input.workspaceId)
    this.assertNoRunningSessions(workspace, state)
    await this.assertNoRunningAtPath(workspacePath, state)
    const refreshed: RemoveIntent = {
      ...intent,
      workspacePath: workspace.path,
      sessionIds: [...workspace.sessionIds],
    }
    operation.intent = refreshed
    return await this.commitBoundRemove(input.operationId, operation, refreshed, replayed)
  }

  /** Commit the record-only cleanup of a directory-less worktree (2026-09:
   *  externally deleted worktrees leave a stale admin record in `git worktree
   *  list`; the sidebar shows the row as missing). Every guard is re-verified
   *  inside the held common-dir mutex: record identity, main/locked, and the
   *  ghost-workspace raw-path check. No dirty/submodule/running probe is
   *  possible or needed — the working directory does not exist, so a plain
   *  `git worktree remove` only clears the admin record (verified against
   *  git 2.50; no --force is ever used here). Shared by the first attempt
   *  (removeMissingUnregistered) and the uncertain-outcome replay
   *  (reconcileBoundRemove). */
  private async commitMissingRecordRemove(
    operationIdValue: string,
    operation: RemoveOperationRecord,
    intent: RemoveIntent,
    replayed: boolean,
  ): Promise<RemoveResult> {
    // Registry/ghost-workspace re-check FIRST (review follow-up F3): reading
    // the source registry between the final topology read and the git call
    // would let the guards evaluate an older listing. Reordering narrows the
    // reappearance window to the final topology read itself (still disclosed
    // in design 08 §5.5); the mutation below is the record-only cleanup of a
    // row verified missing at that read.
    const state = await this.readSource()
    if (state.workspaces.some(candidate => resolve(candidate.path) === intent.path)) {
      fail('workspace-registered', 'the missing worktree path is still registered as a workspace')
    }
    const finalTopology = await this.topology(intent.mainPath)
    if (finalTopology.commonDir !== intent.commonDir || finalTopology.mainPath !== intent.mainPath) {
      fail('operation-conflict', 'removal repository changed immediately before mutation')
    }
    // A ghost workspace at the RAW path owns the record (its registration
    // must be deleted registration-first through the workspace flows — never
    // silently behind it). Containment checks are moot: the directory is gone.
    const finalTarget = finalTopology.worktrees.find(worktree => worktree.path === intent.path)
    if (finalTarget === undefined) {
      // An external `git worktree prune`/remove converged the leftover record
      // first — the cleanup goal is already achieved (receipt semantics,
      // mirroring commitBoundRemove's absent-target convergence).
      await this.attemptBranchDelete(operation, intent, finalTopology.mainPath)
      return this.removeResult(operationIdValue, intent, replayed)
    }
    if (finalTarget.missing !== true) {
      // The directory REAPPEARED (moved back / restored): the record is a
      // live worktree again, so the record-only cleanup no longer applies —
      // and nothing was mutated. Deterministic refusal: refresh and retry
      // the ordinary removal instead (never delete a restored tree).
      fail('worktree-invalid', 'the missing worktree directory reappeared; refresh and retry')
    }
    const boundDiff = this.boundTargetDiff(finalTopology, finalTarget, intent)
    if (boundDiff !== null) {
      fail('operation-conflict', 'missing worktree record changed immediately before removal')
    }
    operation.attemptedRemove = true
    try {
      await this.gitChecked(finalTopology.mainPath, ['worktree', 'remove', '--', intent.path], true)
    } catch (error) {
      // git refused the record-only cleanup (unexpected — a plain remove
      // succeeds on a missing directory). When the VERY SAME record is still
      // listed and still missing, git provably removed nothing: reclassify as
      // a deterministic refusal (no endless uncertain replay), mirroring
      // commitBoundRemove's post-failure reconciliation.
      if (!(error instanceof GitWorktreeError) || error.code !== 'git-command-failed') throw error
      const reconciled = await this.topology(finalTopology.mainPath).catch(() => undefined)
      const target = reconciled?.worktrees.find(candidate => candidate.path === intent.path)
      const unchangedAndStillMissing = reconciled !== undefined
        && reconciled.commonDir === intent.commonDir
        && reconciled.mainPath === intent.mainPath
        && target !== undefined
        && target.branch === intent.branch
        && target.head === intent.head
        && target.missing === true
      if (!unchangedAndStillMissing) throw error
      // Deterministic terminal (2026-09 lock note): a lock that raced in
      // between the final guards and this git call also refuses PRE-mutation
      // — nothing was deleted, so a terminal error (dismiss + fresh removal
      // after unlock) beats an uncertain-retry wedge, exactly as in
      // commitBoundRemove's reconcile above.
      throw new GitWorktreeError(error.code, error.message, { retryable: false })
    }
    const after = await this.topology(finalTopology.mainPath)
    if (after.commonDir !== intent.commonDir
      || after.worktrees.some(worktree => worktree.path === intent.path)) {
      fail('postcondition-failed', 'Git still reports the removed worktree or repository identity changed')
    }
    await this.attemptBranchDelete(operation, intent, finalTopology.mainPath)
    return this.removeResult(operationIdValue, intent, replayed)
  }

  private async commitBoundRemove(
    operationIdValue: string,
    operation: RemoveOperationRecord,
    intent: RemoveIntent,
    replayed: boolean,
  ): Promise<RemoveResult> {
    // Close the controllable TOCTOU window left by registry/agent scans. The
    // common-dir mutex serializes this plugin, not an external Git process, so
    // identity and cleanliness are checked again immediately before mutation.
    const finalTopology = await this.topology(intent.mainPath)
    if (finalTopology.commonDir !== intent.commonDir || finalTopology.mainPath !== intent.mainPath) {
      fail('operation-conflict', 'removal repository changed immediately before mutation')
    }
    const finalTarget = finalTopology.worktrees.find(worktree => worktree.path === intent.path)
    if (finalTarget === undefined) {
      // An external Git actor may have removed the target after our registry
      // preflight. Goal convergence is safe only if the workspace receipt did
      // not gain membership or liveness during that window.
      const state = await this.readSource()
      await this.assertRemovedWorkspaceReceipt(intent, state)
      await this.attemptBranchDelete(operation, intent, finalTopology.mainPath)
      return this.removeResult(operationIdValue, intent, true)
    }
    const boundDiff = this.boundTargetDiff(finalTopology, finalTarget, intent)
    if (boundDiff !== null) {
      fail('operation-conflict', 'removal target changed immediately before mutation')
    }
    // The final pre-mutation re-read may resolve the target row MISSING (its
    // directory vanished after the caller's last probe). A missing row has no
    // working-tree content to protect or probe — the plain `git worktree
    // remove` below then only clears the leftover admin record (git 2.50,
    // same record cleanup the missing-record path uses under these in-lock
    // guards); a git status spawn on the gone cwd would instead fail with a
    // spawn error no caller can route. Never probe a missing row.
    if (finalTarget.missing !== true && await this.isDirty(finalTarget.path) && intent.discardChanges !== true) {
      fail('worktree-dirty', 'worktree became dirty immediately before removal')
    }
    // Git refuses a plain `git worktree remove` on a worktree containing
    // submodule checkouts — git's own guard (builtin/worktree.c
    // validate_no_submodules) dies PRE-mutation; only `--force` bypasses it.
    // Mirror that guard as a typed DETERMINISTIC refusal (2026-09): without
    // an explicit discard authorization the removal can never succeed, so the
    // client must get a dismissible error — never an endless "uncertain
    // outcome" recovery replaying the same refusal forever. Submodule gitdirs
    // of a linked worktree live under its admin git dir (`<gitdir>/modules`),
    // the same criterion git checks first. Best-effort: an unreadable `.git`
    // pointer reads as "no submodules", and git's own refusal is then
    // reclassified deterministically by the catch below instead. A MISSING
    // row cannot host submodule checkouts — skip the probe entirely.
    if (intent.discardChanges !== true
      && finalTarget.missing !== true
      && await this.worktreeHasSubmodules(finalTarget.path)) {
      throw new GitWorktreeError('worktree-submodules', SUBMODULE_REFUSAL_MESSAGE, { retryable: false })
    }
    operation.attemptedRemove = true
    // `--force` is used ONLY under explicit user authorization
    // (input.discardChanges); it discards the working-tree files but never
    // touches the branch, commits or HEAD (design 08 §5.3 amendment 2026-08;
    // a submodule checkout inside the worktree is discarded the same way —
    // its files are re-cloneable from the committed gitlink).
    const removeArgs = intent.discardChanges === true
      ? ['worktree', 'remove', '--force', '--', intent.path]
      : ['worktree', 'remove', '--', intent.path]
    try {
      await this.gitChecked(finalTopology.mainPath, removeArgs, true)
    } catch (error) {
      // A `git worktree remove` failure can be a PRE-MUTATION refusal (git
      // dies before deleting anything — e.g. its own submodule guard when
      // the best-effort preflight above missed it, or another die() in the
      // command) or a post-mutation partial failure. Only git-command-failed
      // exits (die()/partial-delete error returns) are candidates; timeouts
      // and spawn failures keep their semantics without paying for the
      // probes below. Re-read the topology: when the VERY SAME target (same
      // repository identity AND same branch/HEAD) is still listed, its
      // directory still exists AND the worktree is still clean, git provably
      // removed nothing — replaying the same refusal can never converge, so
      // surface a DETERMINISTIC error (retryable: false) that the client may
      // dismiss instead of wedging the source in an endless "uncertain
      // outcome" recovery (design 08 §6.2; 2026-09 submodule report). Any
      // failed probe keeps the original retryable error.
      if (!(error instanceof GitWorktreeError) || error.code !== 'git-command-failed') throw error
      const reconciled = await this.topology(finalTopology.mainPath).catch(() => undefined)
      const target = reconciled?.worktrees.find(candidate => candidate.path === intent.path)
      const targetStillThere = reconciled !== undefined
        && reconciled.commonDir === intent.commonDir
        && reconciled.mainPath === intent.mainPath
        && target !== undefined
        && target.branch === intent.branch
        && target.head === intent.head
        && await this.fs.exists(intent.path).catch(() => false)
      const stillClean = targetStillThere
        && !(await this.isDirty(intent.path).catch(() => true))
      if (!stillClean) throw error
      // git's own die text identifies the submodule refusal when the
      // best-effort preflight missed it (gitdir layouts without the admin
      // `modules` dir, races): upgrade to the typed code so the client's
      // dialog offers the discard authorization instead of a bare error.
      // The git runner pins LC_ALL=C (see below), so the message is stable
      // English; a false positive would only route the user to --force,
      // which git itself allows and which converges.
      // A lock that raced in between the final topology read and the git
      // call is covered by the same deterministic reclassification: git's
      // lock refusal is PRE-mutation (nothing was deleted), so replaying the
      // same operation can never converge — the terminal error lets the
      // client dismiss and start a FRESH removal after the user unlocks
      // (deliberately NOT made retryable; retryability would wedge the
      // source in the uncertain-outcome recovery for a refusal git proves
      // was inert).
      if (/submodule/i.test(error.message)) {
        throw new GitWorktreeError('worktree-submodules', SUBMODULE_REFUSAL_MESSAGE, { retryable: false })
      }
      throw new GitWorktreeError(error.code, error.message, { retryable: false })
    }
    const after = await this.topology(finalTopology.mainPath)
    if (after.commonDir !== intent.commonDir
      || after.worktrees.some(worktree => worktree.path === intent.path)) {
      fail('postcondition-failed', 'Git still reports the removed worktree or repository identity changed')
    }
    // Optional branch deletion (design 08 §5.3 user decision): best-effort,
    // once per operation. A failure is honest (the worktree removal stands).
    await this.attemptBranchDelete(operation, intent, finalTopology.mainPath)
    return this.removeResult(operationIdValue, intent, replayed)
  }

  private removeResult(operationIdValue: string, intent: RemoveIntent, replayed: boolean): RemoveResult {
    return {
      operationId: operationIdValue,
      removed: true,
      replayed,
      ...(intent.workspaceId === undefined ? {} : { workspaceId: intent.workspaceId }),
      repoId: intent.repoId,
      worktreeId: intent.worktreeId,
      commonDir: intent.commonDir,
      path: intent.path,
      branch: intent.branch,
      head: intent.head,
      sessionIds: [...intent.sessionIds],
      next: intent.workspaceId === undefined ? 'none' : 'delete-workspace',
      branchPreserved: true,
      ...(intent.branchDeleted === true ? { branchDeleted: true } : {}),
      ...(intent.branchDeleteFailed === true ? { branchDeleteFailed: true } : {}),
      ...(intent.branchDeleteError === undefined ? {} : { branchDeleteError: intent.branchDeleteError }),
    }
  }

  /** Repo-specific worktree subdirectory: `<root>/<repo-name>-<hash12>` — a
   *  unified location keyed by the repository identity (common dir), so two
   *  same-named repositories never block each other, and never inside a
   *  working tree (git status stays clean). */
  private worktreeRootFor(mainPath: string, commonDir: string): string {
    const repoName = basename(mainPath) || 'repo'
    const digest = createHash('sha256').update(commonDir).digest('hex').slice(0, 12)
    return join(this.worktreesRoot, `${repoName}-${digest}`)
  }

  /** Ensure the unified worktree root exists before `git worktree add`
   *  (git requires the parent directory; mkdir is recursive + idempotent). */
  private async ensureWorktreeRoot(root: string): Promise<void> {
    try {
      await this.fs.mkdir(root)
    } catch {
      // mkdir failure surfaces at the actual git worktree add; the root may
      // legitimately exist already (recursive mkdir is idempotent).
    }
  }

  private clearDiscoveryCaches(): void {
    this.workspaceDiscoverCache.clear()
    this.repoTopologyCache.clear()
  }

  private async readSource(): Promise<SourceSnapshot> {
    let rawWorkspaces: readonly WorkspaceFact[]
    let rawAgents: readonly AgentFact[]
    let rawArchived: readonly string[]
    try {
      [rawWorkspaces, rawAgents, rawArchived] = await Promise.all([
        this.source.listWorkspaces(),
        this.source.listAgents(),
        this.source.listArchivedSessionIds(),
      ])
    } catch (error) {
      if (error instanceof GitWorktreeError) throw error
      fail('state-source-unavailable', `host state source is unavailable: ${safeErrorMessage(error)}`)
    }
    if (!Array.isArray(rawWorkspaces) || !Array.isArray(rawAgents) || !Array.isArray(rawArchived)) {
      fail('state-source-invalid', 'host state source returned a non-array')
    }
    if (rawWorkspaces.length > MAX_WORKSPACES) {
      fail('state-source-capacity', `host returned more than ${MAX_WORKSPACES} workspaces`)
    }
    if (rawAgents.length > MAX_AGENTS) {
      fail('state-source-capacity', `host returned more than ${MAX_AGENTS} agents`)
    }
    let totalSessionMemberships = 0
    const workspaces = rawWorkspaces.map((raw, index): WorkspaceFact => {
      assertRecord(raw, `workspaces[${index}]`)
      const workspaceId = requiredString(raw.workspaceId, `workspaces[${index}].workspaceId`, 256)
      const path = absoluteExpectedPath(raw.path, `workspaces[${index}].path`)
      if (!Array.isArray(raw.sessionIds) || raw.sessionIds.some(id => typeof id !== 'string')) {
        fail('state-source-invalid', `workspaces[${index}].sessionIds is invalid`)
      }
      if (raw.sessionIds.length > MAX_SESSIONS_PER_WORKSPACE) {
        fail(
          'state-source-capacity',
          `workspace '${workspaceId}' has more than ${MAX_SESSIONS_PER_WORKSPACE} sessions`,
        )
      }
      totalSessionMemberships += raw.sessionIds.length
      if (totalSessionMemberships > MAX_TOTAL_SESSION_MEMBERSHIPS) {
        fail(
          'state-source-capacity',
          `host returned more than ${MAX_TOTAL_SESSION_MEMBERSHIPS} total workspace/session memberships`,
        )
      }
      const sessionIds = raw.sessionIds.map((id, sessionIndex) => requiredString(
        id,
        `workspaces[${index}].sessionIds[${sessionIndex}]`,
        256,
      ))
      return { workspaceId, path, sessionIds }
    })
    const runningSessionIds = new Set<string>()
    const runningAgents: AgentFact[] = []
    const parentBySession = new Map<string, string>()
    const subagentOriginSessions = new Set<string>()
    const originDrift: AgentRowDrift[] = []
    const statusDrift: AgentRowDrift[] = []
    const cwdDrift: AgentRowDrift[] = []
    for (let index = 0; index < rawAgents.length; index += 1) {
      const raw = rawAgents[index]
      assertRecord(raw, `agents[${index}]`)
      const sessionId = requiredString(raw.sessionId, `agents[${index}].sessionId`, 256)
      // Status and cwd are handled PER ROW (2026-09 robustness fix, the same
      // rule as `origin` below): upstream declares exactly
      // `'idle' | 'running'` and a normalized absolute `header.cwd`, but a
      // pinned-vendor drift on ONE row must not refuse the WHOLE source read —
      // that darkens the entire git-worktree domain (no snapshot, no removal)
      // for one row, which AGENTS forbids ("one failed entity must not erase or
      // block unrelated complete entities"). Both drifts are read
      // CONSERVATIVELY: an unrecognized status counts as RUNNING, and a cwd
      // that cannot be used as a normalized absolute path leaves the row's
      // location UNKNOWN, so the row keeps blocking (runningAtPath). Each drift
      // gets a loud snapshot diagnostic, so it is never silent.
      const unknownStatus = raw.status !== 'idle' && raw.status !== 'running'
      if (unknownStatus) {
        statusDrift.push({
          sessionId,
          value: typeof raw.status === 'string' ? raw.status.slice(0, 64) : `(${typeof raw.status})`,
        })
      }
      let cwd: string | undefined
      if (raw.cwd !== undefined) {
        try {
          cwd = absoluteExpectedPath(raw.cwd, `agents[${index}].cwd`)
        } catch {
          // `absoluteExpectedPath` accepts only a normalized absolute bounded
          // string, so every throw here is the same drift; the diagnostic names
          // the row and echoes the offending value (never the read failure).
          cwdDrift.push({
            sessionId,
            value: typeof raw.cwd === 'string' ? raw.cwd.slice(0, 128) : `(${typeof raw.cwd})`,
          })
        }
      }
      const parentSessionId = raw.parentSessionId === undefined
        ? undefined
        : requiredString(raw.parentSessionId, `agents[${index}].parentSessionId`, 256)
      // Origin is handled PER ROW (2026-09 robustness fix): upstream declares
      // exactly `'subagent'` or absent, and ONLY `'subagent'` enables
      // inertness. Any other present value is a pinned-vendor drift — the row
      // is treated as NOT subagent-origin (its edge terminates, so the session
      // keeps blocking: fail-closed), and the drift is recorded for a loud
      // snapshot diagnostic. Refusing the WHOLE source read would darken the
      // entire git-worktree domain (no snapshot, no removal) for one drifted
      // row, which AGENTS forbids ("one failed entity must not erase or block
      // unrelated complete entities").
      if (raw.origin !== undefined && raw.origin !== 'subagent') {
        originDrift.push({
          sessionId,
          value: typeof raw.origin === 'string' ? raw.origin.slice(0, 64) : `(${typeof raw.origin})`,
        })
      }
      if (raw.origin === 'subagent') subagentOriginSessions.add(sessionId)
      // The chain link is recorded for EVERY loaded agent (idle included): the
      // archived-aware guard may need to walk through an idle ancestor.
      if (parentSessionId !== undefined && parentSessionId !== sessionId) {
        parentBySession.set(sessionId, parentSessionId)
      }
      if (raw.status === 'running' || unknownStatus) {
        // An unrecognized status counts as running: liveness is the fact that
        // blocks a removal, so an unreadable one must never read as idle. A
        // drifted cwd is simply absent from the row, which keeps the session
        // counted here (blocking) while its location stays unknown.
        runningSessionIds.add(sessionId)
        runningAgents.push({ sessionId, status: 'running', ...(cwd === undefined ? {} : { cwd }) })
      }
    }
    const archivedSessionIds = new Set<string>()
    for (let index = 0; index < rawArchived.length; index += 1) {
      // Explicit element shape guard (state-source-invalid, mirroring the
      // workspaces[].sessionIds leg): the archived set is the ONLY fact that
      // can make a running session inert, so a drifted element must fail the
      // read loudly instead of being coerced or skipped — "unreadable" must
      // never degrade to "nothing archived".
      const rawId = rawArchived[index]
      if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > 256) {
        fail('state-source-invalid', `archivedSessionIds[${index}] is not a bounded non-empty string`)
      }
      archivedSessionIds.add(rawId)
    }
    return {
      workspaces,
      runningSessionIds,
      runningAgents,
      archivedSessionIds,
      parentBySession,
      subagentOriginSessions,
      originDrift,
      statusDrift,
      cwdDrift,
      blockingRunningIds: this.blockingRunningIds(
        runningSessionIds,
        archivedSessionIds,
        parentBySession,
        subagentOriginSessions,
      ),
    }
  }

  private workspace(state: SourceSnapshot, id: string): WorkspaceFact {
    const workspace = state.workspaces.find(candidate => candidate.workspaceId === id)
    if (workspace === undefined) fail('workspace/not-found', `workspace '${id}' does not exist`)
    return workspace
  }

  /** Membership leg of the RUNNING guard: only NON-INERT running sessions
   *  block (an archived member, or a SUBAGENT-origin descendant of an archived
   *  ancestor, is inert — see isInertRunningSession). */
  private assertNoRunningSessions(workspace: WorkspaceFact, state: SourceSnapshot): void {
    const blocked = workspace.sessionIds.filter(id => state.blockingRunningIds.has(id))
    if (blocked.length > 0) {
      fail('running-agent', `worktree has running associated session(s): ${blocked.join(', ')}`)
    }
  }

  /**
   * TRUE when a running session is INERT for the running guards (design 08 §5.2
   * amendment, 2026-09 user decision): the session itself is ARCHIVED, or a
   * SUBAGENT-origin ancestor in its lineage is. An archived session is done —
   * its run must not block a worktree removal, and the removal never touches
   * it (stopping a run and purging content is the archive manager's job,
   * design 24 §5). The chain is walked over the loaded agent rows (any
   * status), so a running subagent under an archived root is inert too.
   *
   * LINEAGE IS SUBAGENT-ORIGIN EDGES ONLY: `session.header.parentSession` is
   * recorded by BOTH delegation children (`origin: 'subagent'`) and forks
   * (upstream `session/fork` / `SessionStore.fork` set `parentSession` with NO
   * `origin`). A fork is an independent session — archiving the session it was
   * forked from says nothing about the fork's own run, and the purge tree
   * (design 24) never contains a fork descendant. So a fork edge (a node
   * without `origin: 'subagent'`) TERMINATES the walk: it proves no
   * subagent-ancestor inertness and the session blocks. This mirrors
   * `dsh-chamber-seed-archive-cleanup`'s `indexChildren`, which follows only
   * `origin === 'subagent'`.
   *
   * FAIL CLOSED: a recorded parent that is neither loaded nor archived leaves
   * the chain unresolvable, and an unresolvable chain is NEVER inert — the
   * session blocks exactly as before.
   *
   * CYCLE RULE (parent decision, 2026-09): the archived test runs BEFORE the
   * cycle guard, so a cycle that CONTAINS an archived member is inert exactly
   * like any other archived ancestor (the walk reaches that member first),
   * while a cycle with NO archived member is never inert. The order is
   * deliberate: an archived member is positive proof that the run is done,
   * while a cycle is only evidence that the recorded lineage is malformed —
   * malformed evidence must never excuse a live run (fail closed).
   */
  private isInertRunningSession(
    sessionId: string,
    archived: ReadonlySet<string>,
    parents: ReadonlyMap<string, string>,
    subagentOrigins: ReadonlySet<string>,
  ): boolean {
    const seen = new Set<string>()
    let current: string | undefined = sessionId
    while (current !== undefined) {
      // Archived first (see CYCLE RULE): positive proof beats cycle evidence.
      if (archived.has(current)) return true
      // A malformed cycle proves nothing: fail closed.
      if (seen.has(current)) return false
      seen.add(current)
      // Fork lineage (or a top-level row) ends the walk: only a
      // subagent-origin edge is an inertness-carrying lineage step.
      if (!subagentOrigins.has(current)) return false
      const parent: string | undefined = parents.get(current)
      // Subagent origin without a recorded parent cannot be resolved to an
      // ancestor: fail closed (never guess inertness).
      if (parent === undefined) return false
      // A recorded parent we cannot resolve is an unknown chain → fail closed
      // (an archived-but-unloaded parent is still authoritative).
      if (!parents.has(parent) && !archived.has(parent)) return false
      current = parent
    }
    return false
  }

  /** The running sessions that actually BLOCK a removal (non-inert). */
  private blockingRunningIds(
    running: ReadonlySet<string>,
    archived: ReadonlySet<string>,
    parents: ReadonlyMap<string, string>,
    subagentOrigins: ReadonlySet<string>,
  ): Set<string> {
    return new Set([...running].filter(
      sessionId => !this.isInertRunningSession(sessionId, archived, parents, subagentOrigins),
    ))
  }

  /** Canonicalize each distinct live cwd at most once for the whole snapshot. */
  private async snapshotRunningLocations(
    state: SourceSnapshot,
    deadline: number,
    errors: SnapshotError[],
  ): Promise<{ locations: SnapshotRunningLocation[]; deadlineExceeded: boolean }> {
    const canonicalByCwd = new Map<string, string | null>()
    const locations: SnapshotRunningLocation[] = []
    let deadlineExceeded = false
    for (const agent of state.runningAgents) {
      if (agent.cwd === undefined) continue
      const paths = [resolve(agent.cwd)]
      if (this.now() >= deadline) {
        deadlineExceeded = true
      } else {
        let canonical = canonicalByCwd.get(agent.cwd)
        if (canonical === undefined && !canonicalByCwd.has(agent.cwd)) {
          try {
            canonical = await this.existingPath(agent.cwd)
            canonicalByCwd.set(agent.cwd, canonical)
          } catch (error) {
            canonical = null
            canonicalByCwd.set(agent.cwd, null)
            errors.push({
              code: error instanceof GitWorktreeError ? error.code : 'running-agent-path-failed',
              operation: 'associate',
              message: `cannot canonicalize running session '${agent.sessionId}': ${safeErrorMessage(error)}`,
              path: agent.cwd,
            })
          }
        }
        if (canonical !== null && canonical !== undefined && !paths.includes(canonical)) paths.push(canonical)
      }
      locations.push({ sessionId: agent.sessionId, paths })
    }
    return { locations, deadlineExceeded }
  }

  private runningAtSnapshotPath(
    target: string,
    locations: readonly SnapshotRunningLocation[],
  ): string[] {
    const matches = new Set<string>()
    for (const location of locations) {
      if (location.paths.some(path => this.containsPath(target, path))) matches.add(location.sessionId)
    }
    return [...matches]
  }

  private async runningAtPath(
    target: string,
    state: SourceSnapshot,
    strict: boolean,
  ): Promise<string[]> {
    const matches = new Set<string>()
    // A BLOCKING running session whose cwd could not be established (a drifted
    // `header.cwd`, reported as `agent-cwd-unknown`) has an UNKNOWN location:
    // no removal can prove the target does not contain it, so the destructive
    // leg refuses — exactly like an existing cwd that cannot be canonicalized
    // below. Non-strict callers still get the snapshot projection, so one
    // drifted row never darkens the whole domain.
    if (strict) {
      const unresolved = state.cwdDrift.find(row => state.blockingRunningIds.has(row.sessionId))
      if (unresolved !== undefined) {
        fail(
          'running-agent-cwd-unavailable',
          `cannot safely resolve running session '${unresolved.sessionId}' cwd: this dsh build reports '${unresolved.value}'`,
        )
      }
    }
    for (const agent of state.runningAgents) {
      if (agent.cwd === undefined) continue
      // Only non-inert running sessions can block (archived ones are inert).
      if (!state.blockingRunningIds.has(agent.sessionId)) continue
      if (this.containsPath(target, agent.cwd)) {
        matches.add(agent.sessionId)
        continue
      }
      try {
        const canonical = await this.existingPath(agent.cwd)
        if (this.containsPath(target, canonical)) matches.add(agent.sessionId)
      } catch (error) {
        if (strict) {
          fail(
            'running-agent-cwd-unavailable',
            `cannot safely resolve running session '${agent.sessionId}' cwd: ${safeErrorMessage(error)}`,
          )
        }
      }
    }
    return [...matches]
  }

  private async assertNoRunningAtPath(target: string, state: SourceSnapshot): Promise<void> {
    const blocked = await this.runningAtPath(target, state, true)
    if (blocked.length > 0) {
      fail('running-agent', `worktree contains running session cwd(s): ${blocked.join(', ')}`)
    }
  }

  private containsPath(root: string, candidate: string): boolean {
    const suffix = relative(root, candidate)
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  }

  private async anyWorkspaceOwnsPath(state: SourceSnapshot, target: string): Promise<boolean> {
    for (const workspace of state.workspaces) {
      if (this.containsPath(target, resolve(workspace.path))) return true
      let canonical: string
      try {
        canonical = await this.existingPath(workspace.path)
      } catch (error) {
        fail(
          'workspace-path-unavailable',
          `cannot prove workspace '${workspace.workspaceId}' is unrelated to rollback target: ${safeErrorMessage(error)}`,
        )
      }
      if (this.containsPath(target, canonical)) return true
    }
    return false
  }

  private async assertNoOtherWorkspaceWithin(
    state: SourceSnapshot,
    target: string,
    allowedWorkspaceId: string,
  ): Promise<void> {
    for (const workspace of state.workspaces) {
      if (workspace.workspaceId === allowedWorkspaceId) continue
      let canonical: string
      try {
        canonical = await this.existingPath(workspace.path)
      } catch {
        // A VANISHED workspace (externally deleted worktree left a ghost
        // registration) can neither contain the target nor be contained by
        // it — skip it instead of failing the whole removal. One failed
        // entity must not block unrelated ones (AGENTS); the unregistered
        // removal branch already tolerates this exact case (review 2026-08:
        // an orphan workspace was blocking EVERY registered removal on the
        // source, and the retryable error wedged the source in recovery).
        continue
      }
      if (this.containsPath(target, canonical)) {
        fail('nested-workspace', `worktree contains workspace '${workspace.workspaceId}'`)
      }
    }
  }

  private async existingPath(path: string): Promise<string> {
    if (path.length === 0 || path.length > MAX_PATH_LENGTH || /[\0\r\n]/u.test(path) || !isAbsolute(path)) {
      fail('unsafe-path', 'filesystem path must be a bounded absolute path')
    }
    let canonical: string
    try {
      canonical = await this.fs.realpath(path)
    } catch (error) {
      fail('path-unavailable', `cannot resolve '${path}': ${safeErrorMessage(error)}`)
    }
    if (canonical.length === 0 || canonical.length > MAX_PATH_LENGTH
      || /[\0\r\n]/u.test(canonical) || !isAbsolute(canonical)) {
      fail('unsafe-path', 'realpath returned an invalid or overlong absolute path')
    }
    return resolve(canonical)
  }

  private async assertPathAbsent(path: string): Promise<void> {
    try {
      await this.fs.lstat(path)
    } catch (error) {
      if (this.isNotFound(error)) return
      fail('path-check-failed', `cannot inspect target path: ${safeErrorMessage(error)}`)
    }
    fail('target-exists', `target path '${path}' already exists`)
  }

  private isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT'
  }

  private async discover(cwd: string): Promise<{ commonDir: string; topLevel: string }> {
    const canonicalCwd = await this.existingPath(cwd)
    const [topLevelResult, commonResult] = await Promise.all([
      this.gitChecked(canonicalCwd, ['rev-parse', '--show-toplevel']),
      this.gitChecked(canonicalCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
    const topLevel = await this.existingPath(this.singleLine(topLevelResult.stdout, 'worktree root'))
    const commonDir = await this.existingPath(this.singleLine(commonResult.stdout, 'Git common directory'))
    return { commonDir, topLevel }
  }

  private async snapshotDiscover(
    cwd: string,
    deadline: number,
  ): Promise<{ commonDir: string; topLevel: string }> {
    if (this.now() >= deadline) {
      fail('snapshot-deadline', `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`)
    }
    const canonicalCwd = await this.existingPath(cwd)
    const [topLevelResult, commonResult] = await Promise.all([
      this.snapshotGitChecked(canonicalCwd, ['rev-parse', '--show-toplevel'], deadline),
      this.snapshotGitChecked(
        canonicalCwd,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        deadline,
      ),
    ])
    const topLevel = await this.existingPath(this.singleLine(topLevelResult.stdout, 'worktree root', MAX_PATH_LENGTH))
    const commonDir = await this.existingPath(this.singleLine(
      commonResult.stdout,
      'Git common directory',
      MAX_PATH_LENGTH,
    ))
    return { commonDir, topLevel }
  }

  private async topology(cwd: string): Promise<WorktreeTopology> {
    const discovered = await this.discover(cwd)
    const parsed = await this.listWorktreesWith(async args => this.gitCommand(discovered.topLevel, args, false))
    const worktrees: RawWorktree[] = []
    const paths = new Set<string>()
    for (const entry of parsed) {
      let path: string
      let missing: boolean
      try {
        path = await this.existingPath(entry.path)
        missing = false
      } catch (error) {
        // A listed worktree whose directory no longer exists (externally
        // deleted without `git worktree remove`) must not fail every
        // mutation on the repository (2026-09 live report: a merge drill's
        // leftover record blocked ALL create/remove/rollback with
        // path-unavailable). Keep the RAW normalized record path and mark
        // the row missing: no filesystem probe may touch it, and it can be
        // cleaned by the missing-record removal path.
        if (!(error instanceof GitWorktreeError) || error.code !== 'path-unavailable') throw error
        path = resolve(entry.path)
        missing = true
      }
      if (paths.has(path)) fail('git-protocol-error', `Git returned duplicate worktree path '${path}'`)
      paths.add(path)
      worktrees.push({ ...entry, path, missing })
    }
    if (worktrees[0]!.bare) fail('bare-repository', 'bare repositories cannot own this lifecycle')
    if (!paths.has(discovered.topLevel)) fail('git-protocol-error', 'Git omitted the current worktree from its topology')
    return { commonDir: discovered.commonDir, mainPath: worktrees[0]!.path, worktrees }
  }

  private singleLine(output: string, label: string, maxLength = 4_096): string {
    const value = output.replace(/\r?\n$/u, '')
    if (value.length === 0 || value.length > maxLength || /[\r\n\0]/u.test(value)) {
      fail('git-protocol-error', `Git returned an invalid or overlong ${label}`)
    }
    return value
  }

  private async assertBranchFormat(cwd: string, branch: string): Promise<void> {
    const result = await this.gitCommand(cwd, ['check-ref-format', '--branch', branch])
    if (result.exitCode !== 0) fail('invalid-branch', `Git rejected local branch '${branch}'`)
  }

  /** Local branch head, or null when the branch does not exist. Git versions
   *  disagree on the missing-ref exit code (`show-ref --verify` exits 1 in
   *  some, 128 with `fatal: ... not a valid ref` in others) — ANY non-zero
   *  exit means "branch absent" for this fixed invocation; a genuinely broken
   *  git would have failed the earlier rev-parse/worktree reads already.
   *  (2026-08 fix: exit 128 was misreported as a hard git-command-failed.) */
  private async localBranchHead(cwd: string, branch: string): Promise<string | null> {
    const result = await this.gitCommand(cwd, ['show-ref', '--hash', '--verify', `refs/heads/${branch}`])
    if (result.exitCode !== 0) return null
    const head = this.singleLine(result.stdout, 'local branch head').toLowerCase()
    if (!/^[0-9a-f]{40,64}$/u.test(head)) fail('git-protocol-error', 'Git returned an invalid local branch head')
    return head
  }

  private async isDirty(path: string): Promise<boolean> {
    const result = await this.gitChecked(path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    return result.stdout.length > 0
  }

  /** Git's own removal guard mirrored (see commitBoundRemove): does this
   *  worktree's admin git dir host a `modules` directory (submodule gitdirs)?
   *  Best-effort — an unreadable `.git` pointer reads as false, and git's own
   *  refusal is then reclassified deterministically by the caller instead. */
  private async worktreeHasSubmodules(path: string): Promise<boolean> {
    const gitDir = await worktreeGitDir(path, this.fs)
    if (gitDir === null) return false
    try {
      return await this.fs.exists(join(gitDir, 'modules'))
    } catch {
      return false
    }
  }

  private async gitChecked(cwd: string, args: readonly string[], mutation = false): Promise<GitCommandResult> {
    const result = await this.gitCommand(cwd, args, mutation)
    if (result.exitCode !== 0) this.gitExitError(result, args[0] ?? 'unknown')
    return result
  }

  private async snapshotGitChecked(
    cwd: string,
    args: readonly string[],
    deadline: number,
    perCommandLimit = READ_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    const remaining = deadline - this.now()
    if (remaining <= 0) {
      fail('snapshot-deadline', `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`)
    }
    const result = await this.gitCommand(cwd, args, false, Math.max(1, Math.min(perCommandLimit, remaining)))
    if (result.exitCode !== 0) this.gitExitError(result, args[0] ?? 'unknown')
    return result
  }

  /** List a repository's worktrees from the snapshot path, honoring the probe
   *  deadline. Delegates to the shared `-z`/newline fallback below. */
  private async listWorktrees(cwd: string, deadline: number): Promise<RawWorktree[]> {
    return this.listWorktreesWith(async args => {
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        fail('snapshot-deadline', `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`)
      }
      return this.gitCommand(cwd, args, false, Math.max(1, Math.min(READ_TIMEOUT_MS, remaining)))
    })
  }

  /**
   * Read `git worktree list --porcelain`, preferring the NUL-delimited `-z`
   * form and falling back to the newline-delimited form when the running Git
   * predates `-z` (added in Git 2.47). An older Git rejects the unknown
   * `-z` switch with a usage error — exit 129 — which is unambiguous here
   * because the `-z` invocation is valid on every Git that recognizes it.
   */
  private async listWorktreesWith(
    run: (args: readonly string[]) => Promise<GitCommandResult>,
  ): Promise<RawWorktree[]> {
    const withZ = await run(['worktree', 'list', '--porcelain', '-z'])
    if (withZ.exitCode === 129) {
      const withoutZ = await run(['worktree', 'list', '--porcelain'])
      if (withoutZ.exitCode !== 0) this.gitExitError(withoutZ, 'worktree')
      return parseWorktreePorcelain(withoutZ.stdout, '\n')
    }
    if (withZ.exitCode !== 0) this.gitExitError(withZ, 'worktree')
    return parseWorktreePorcelain(withZ.stdout, '\0')
  }

  /** Local branch names for the existing-branch picker (`show-ref --heads`).
   *  A convenience read: any failure (git down, budget exhausted) yields an
   *  empty list and must never fail or stall the snapshot. */
  private async listBranches(cwd: string, deadline: number): Promise<string[]> {
    if (this.now() >= deadline) return []
    let result: GitCommandResult
    try {
      result = await this.gitCommand(cwd, ['show-ref', '--heads'], false, READ_TIMEOUT_MS)
    } catch {
      return []
    }
    if (result.exitCode !== 0) return []
    const branches: string[] = []
    for (const line of result.stdout.split('\n')) {
      const match = /^[0-9a-fA-F]{40,64}\s+refs\/heads\/(.+)$/u.exec(line)
      if (match !== null && match[1] !== '' && !match[1]!.startsWith('-')) branches.push(match[1]!)
    }
    return branches
  }

  private async gitCommand(
    cwd: string,
    args: readonly string[],
    mutation = false,
    readTimeoutMs = READ_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    if (!isAbsolute(cwd)) fail('unsafe-git-cwd', 'Git cwd must be absolute')
    assertSafeGitArgv(args)
    const maxOutputBytes = mutation ? MUTATION_OUTPUT_CAP : READ_OUTPUT_CAP
    const result = await this.git({
      cwd,
      args: [...args],
      timeoutMs: mutation ? MUTATION_TIMEOUT_MS : readTimeoutMs,
      maxOutputBytes,
    })
    if (!Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      fail('git-runner-invalid', 'Git runner returned an invalid result')
    }
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxOutputBytes) {
      fail('git-output-limit', 'Git runner exceeded the bounded response limit')
    }
    return result
  }

  private gitExitError(result: GitCommandResult, operation: string): never {
    const detail = result.stderr.trim() || result.stdout.trim()
    fail('git-command-failed', `Git ${operation} failed with exit ${result.exitCode}${detail ? `: ${safeErrorMessage(detail)}` : ''}`)
  }

  private evictOldestRemoveOperationIfFull(): void {
    if (this.removeOperations.size < this.operationCapacity) return
    let oldest: { id: string; updatedAt: number } | undefined
    for (const [id, record] of this.removeOperations) {
      // A bound intent or attempted removal is a safety tombstone until TTL;
      // only a pre-admission ready failure is safe to forget early.
      if (record.state !== 'ready'
        || record.attemptedRemove
        || record.intent !== undefined
        || record.result !== undefined) continue
      if (oldest === undefined || record.updatedAt < oldest.updatedAt) {
        oldest = { id, updatedAt: record.updatedAt }
      }
    }
    if (oldest !== undefined) this.removeOperations.delete(oldest.id)
  }

  private pruneCaches(): void {
    const now = this.now()
    for (const [token, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(token)
    }
    const terminalCutoff = now - OPERATION_TTL_MS
    for (const [id, record] of this.createOperations) {
      if (record.state !== 'creating'
        && record.state !== 'rolling-back'
        && record.updatedAt <= terminalCutoff) {
        this.createOperations.delete(id)
      }
    }
    for (const [id, record] of this.removeOperations) {
      if (record.state !== 'removing' && record.updatedAt <= terminalCutoff) {
        this.removeOperations.delete(id)
      }
    }
  }
}

