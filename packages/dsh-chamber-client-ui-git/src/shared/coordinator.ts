/**
 * Page-wide Git worktree coordinator.
 *
 * The chamber composite imports this module once and mounts the plugin in N
 * cordis contexts. All contexts therefore observe one polling/action state:
 * facts are fetched once per connected source, operations cannot be duplicated
 * by switching shells, and recovery remains visible after a view switch.
 */
import {
  chamberBridge, createSession, createWorkspace, deleteWorkspace, getInstanceClient, InstanceRpcError,
} from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import { GitActionLedger } from './action-ledger.ts'
import { SerializedRefreshes } from './refresh-flight.ts'
import { GitWorktreeRpcError, gitWorktreeApi, isAmbiguousGitRpcFailure } from './git-api.ts'
import { findWorktree, removeBlockReason } from './git-facts.ts'
import {
  GitSagaError, recoveryForFailure, runAdoptSessionSaga, runCreateSaga, runRemoveSaga,
  runRollbackRecovery, runWorkspaceAdoptRecovery, runWorkspaceDeleteRecovery,
} from './saga.ts'
import type {
  GitBusyState, GitRecovery, GitSourceError, GitSourceState, PreviewCreateInput, PreviewCreateResult,
} from './types.ts'

const POLL_MS = 30_000
const listeners = new Set<() => void>()
const states = new Map<string, GitSourceState>()
const refreshFlights = new SerializedRefreshes<GitSourceState>()
const actionLedger = new GitActionLedger()
/** Connection-generation fence: a response from before disconnect/reconnect is stale. */
const sourceEpochs = new Map<string, number>()
let revision = 0
let retainCount = 0
let stopBridge: (() => void) | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined

const SINGLETON_KEY = Symbol.for('dsh-chamber.git-worktree.coordinator')
const globalRegistry = globalThis as typeof globalThis & { [SINGLETON_KEY]?: boolean }
if (globalRegistry[SINGLETON_KEY] === true) {
  console.error('[dsh-chamber] Git worktree coordinator was instantiated more than once; N-ctx state may diverge.')
} else {
  globalRegistry[SINGLETON_KEY] = true
}

function nextId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emit(): void {
  revision += 1
  for (const listener of [...listeners]) listener()
}

function patchSource(sourceId: string, patch: Partial<GitSourceState>): GitSourceState {
  const current = states.get(sourceId) ?? {
    sourceId,
    connected: false,
    status: 'idle' as const,
  }
  const next = { ...current, ...patch }
  states.set(sourceId, next)
  emit()
  return next
}

function bumpSourceEpoch(sourceId: string): number {
  const next = (sourceEpochs.get(sourceId) ?? 0) + 1
  sourceEpochs.set(sourceId, next)
  return next
}

function connectedSource(sourceId: string): boolean {
  return chamberBridge.getServers().some(server => server.id === sourceId && server.connected)
}

function syncServers(): void {
  const roster = chamberBridge.getServers()
  const ids = new Set(roster.map(server => server.id))
  const refreshIds: string[] = []
  let changed = false
  for (const server of roster) {
    const current = states.get(server.id)
    if (server.connected) {
      if (current === undefined || !current.connected) {
        bumpSourceEpoch(server.id)
        states.set(server.id, {
          sourceId: server.id,
          connected: true,
          status: 'loading',
          busy: actionLedger.current(server.id),
          recovery: current?.recovery,
          actionError: current?.actionError,
        })
        refreshIds.push(server.id)
        changed = true
      }
    } else if (current === undefined || current.connected || current.snapshot !== undefined || current.sourceError !== undefined) {
      bumpSourceEpoch(server.id)
      states.set(server.id, {
        sourceId: server.id,
        connected: false,
        status: 'idle',
        busy: actionLedger.current(server.id),
        recovery: current?.recovery,
        actionError: current?.actionError,
      })
      changed = true
    }
  }
  for (const sourceId of [...states.keys()]) {
    if (!ids.has(sourceId)) {
      bumpSourceEpoch(sourceId)
      states.delete(sourceId)
      changed = true
    }
  }
  if (changed) emit()
  for (const sourceId of refreshIds) void refreshSource(sourceId, true)
}

async function beginRefresh(sourceId: string): Promise<GitSourceState> {
  const epoch = sourceEpochs.get(sourceId) ?? 0
  const current = states.get(sourceId)
  if (!connectedSource(sourceId)) {
    return patchSource(sourceId, { connected: false, status: 'idle', snapshot: undefined, sourceError: undefined })
  }
  if (current?.snapshot === undefined) patchSource(sourceId, { connected: true, status: 'loading', sourceError: undefined })
  try {
    const snapshot = await gitWorktreeApi.snapshot(sourceId)
    if ((sourceEpochs.get(sourceId) ?? 0) !== epoch || !connectedSource(sourceId)) {
      return states.get(sourceId) ?? { sourceId, connected: false, status: 'idle' }
    }
    return patchSource(sourceId, {
      connected: true,
      status: snapshot.sourceError === undefined ? 'ready' : 'error',
      snapshot,
      sourceError: snapshot.sourceError,
      updatedAt: Date.now(),
    })
  } catch (error) {
    if ((sourceEpochs.get(sourceId) ?? 0) !== epoch || !connectedSource(sourceId)) {
      return states.get(sourceId) ?? { sourceId, connected: false, status: 'idle' }
    }
    const sourceError: GitSourceError = { code: 'snapshot-failed', message: errorText(error) }
    return patchSource(sourceId, {
      connected: true,
      status: 'error',
      // Keep the last valid snapshot visibly stale beside the explicit error.
      snapshot: states.get(sourceId)?.snapshot,
      sourceError,
      updatedAt: Date.now(),
    })
  }
}

/** Refresh one source. `force` waits out and supersedes an older in-flight pull. */
export async function refreshSource(sourceId: string, force = false): Promise<GitSourceState> {
  return refreshFlights.run(sourceId, force, () => beginRefresh(sourceId))
}

async function runBusy<T>(sourceId: string, busy: GitBusyState, operation: () => Promise<T>): Promise<T> {
  const current = states.get(sourceId)
  if (current?.recovery !== undefined && busy.kind !== 'recovery') throw new Error('请先完成当前 Git 恢复操作')
  const lease = actionLedger.begin(sourceId, busy)
  if (lease === undefined) throw new Error('该来源已有 Git 操作正在进行')
  try {
    patchSource(sourceId, { busy, actionError: undefined })
    const result = await operation()
    patchSource(sourceId, { actionError: undefined })
    return result
  } catch (error) {
    patchSource(sourceId, { actionError: errorText(error) })
    throw error
  } finally {
    if (actionLedger.end(lease)) patchSource(sourceId, { busy: undefined })
  }
}

function setRecovery(sourceId: string, recovery: GitRecovery | undefined): void {
  patchSource(sourceId, { recovery })
}

function finishMutation(sourceId: string): void {
  try {
    chamberBridge.requestRefresh(sourceId)
  } catch (error) {
    console.error('[dsh-chamber] Git mutation committed but aggregate refresh notification failed:', error)
  }
  void refreshSource(sourceId, true)
}

/** Opening is a one-way UI intent, never part of the durable saga outcome. */
function requestOpenSession(sourceId: string, sessionId: string): void {
  try {
    chamberBridge.requestOpenSession(sourceId, sessionId)
  } catch (error) {
    console.error('[dsh-chamber] Git session committed but open-session notification failed:', error)
  }
}

export async function previewCreate(sourceId: string, input: PreviewCreateInput): Promise<PreviewCreateResult> {
  const operationId = nextId('preview')
  return runBusy(sourceId, { kind: 'preview', operationId }, () => gitWorktreeApi.previewCreate(sourceId, input))
}

async function performCreateSaga(
  sourceId: string,
  preview: PreviewCreateResult,
  operationId: string,
  sessionId: string,
  previousRecovery?: Extract<GitRecovery, { kind: 'git-create' }>,
): Promise<string> {
  try {
    const result = await runCreateSaga({
      hostCreate: input => gitWorktreeApi.create(sourceId, input, preview),
      hostRollback: (input, expected) => gitWorktreeApi.rollbackCreate(sourceId, input, expected),
      workspaceCreate: path => createWorkspace(getInstanceClient(sourceId), path),
      sessionCreate: (workspaceId, id) => createSession(getInstanceClient(sourceId), workspaceId, id),
      isAmbiguousHostFailure: isAmbiguousGitRpcFailure,
    }, preview, { operationId, sessionId })
    setRecovery(sourceId, undefined)
    finishMutation(sourceId)
    requestOpenSession(sourceId, result.sessionId)
    return result.sessionId
  } catch (error) {
    if (error instanceof GitSagaError) {
      setRecovery(sourceId, recoveryForFailure(error, previousRecovery))
      if (error.refreshNeeded || previousRecovery !== undefined) finishMutation(sourceId)
    }
    throw error
  }
}

/** Execute the create saga. Navigation is fire-and-forget and never a rollback boundary. */
export async function createFromPreview(sourceId: string, preview: PreviewCreateResult): Promise<string> {
  const operationId = nextId('create')
  const sessionId = nextId('session')
  return runBusy(sourceId, { kind: 'create', operationId }, () => (
    performCreateSaga(sourceId, preview, operationId, sessionId)
  ))
}

/**
 * Create a new session in an EXISTING worktree (adopt-only, no Git mutation).
 * The workspace at `path` is registered or reused via workspace.create, then a
 * preallocated session is committed. On failure the same session id is reused.
 */
export async function createSessionHere(sourceId: string, path: string): Promise<string> {
  const operationId = nextId('adopt')
  const sessionId = nextId('session')
  return runBusy(sourceId, { kind: 'adopt-session', operationId }, async () => {
    const fresh = await refreshSource(sourceId, true)
    if (fresh.snapshot === undefined || fresh.sourceError !== undefined) {
      throw new Error(fresh.sourceError?.message ?? '无法取得最新 Git 工作树事实')
    }
    const known = fresh.snapshot.repos.some(repo => repo.worktrees.some(worktree => worktree.path === path))
    if (!known) throw new Error('目标工作树不在当前来源拓扑中')
    try {
      const result = await runAdoptSessionSaga({
        workspaceCreate: targetPath => createWorkspace(getInstanceClient(sourceId), targetPath),
        sessionCreate: (workspaceId, id) => createSession(getInstanceClient(sourceId), workspaceId, id),
      }, path, sessionId)
      setRecovery(sourceId, undefined)
      finishMutation(sourceId)
      requestOpenSession(sourceId, result.sessionId)
      return result.sessionId
    } catch (error) {
      if (error instanceof GitSagaError) setRecovery(sourceId, recoveryForFailure(error))
      throw error
    }
  })
}

export interface RemoveTarget {
  repoId: string
  worktreeId: string
}

type RemoveRecoveryInput = Omit<Extract<GitRecovery, { kind: 'git-remove' }>, 'kind' | 'message'>

async function performRemoveSaga(
  sourceId: string,
  request: RemoveRecoveryInput,
  previousRecovery?: Extract<GitRecovery, { kind: 'git-remove' }>,
): Promise<void> {
  try {
    await runRemoveSaga({
      hostRemove: () => gitWorktreeApi.remove(sourceId, {
        operationId: request.operationId,
        workspaceId: request.workspaceId,
        expected: request.expected,
      }, request.path),
      verifyTerminalRemove: () => gitWorktreeApi.remove(sourceId, {
        operationId: request.operationId,
        workspaceId: request.workspaceId,
        expected: request.expected,
      }, request.path),
      workspaceDelete: id => deleteWorkspace(getInstanceClient(sourceId), id),
      ambiguousRecovery: error => isAmbiguousGitRpcFailure(error)
        ? { kind: 'git-remove', ...request, message: errorText(error) }
        : undefined,
    })
    setRecovery(sourceId, undefined)
    finishMutation(sourceId)
  } catch (error) {
    if (error instanceof GitSagaError) {
      setRecovery(sourceId, recoveryForFailure(error, previousRecovery))
      if (error.refreshNeeded || previousRecovery !== undefined) finishMutation(sourceId)
    }
    throw error
  }
}

/** Git-first safe remove; workspace-delete failure becomes explicit recovery. */
export async function removeWorktree(sourceId: string, target: RemoveTarget): Promise<void> {
  const operationId = nextId('remove')
  return runBusy(sourceId, { kind: 'remove', operationId }, async () => {
    const fresh = await refreshSource(sourceId, true)
    if (fresh.snapshot === undefined || fresh.sourceError !== undefined) {
      throw new Error(fresh.sourceError?.message ?? '无法取得最新 Git 工作树事实')
    }
    const found = findWorktree(fresh.snapshot, target.repoId, target.worktreeId)
    if (found === undefined) throw new Error('工作树已不存在；请刷新后重试')
    const current = chamberBridge.getServers().find(server => server.id === sourceId)?.runtime?.current
    const blocked = removeBlockReason(found.worktree, current)
    if (blocked === 'main') throw new Error('主工作树不能删除')
    if (blocked === 'unregistered') throw new Error('该工作树未关联 dsh workspace，不能从此处删除')
    if (blocked === 'running') throw new Error('该工作树仍有运行中的会话')
    if (blocked === 'current') throw new Error('该工作树包含当前正在查看的会话')
    if (blocked === 'locked') throw new Error('已锁定的工作树不能删除')
    if (blocked === 'dirty') throw new Error('有未提交改动的工作树不能删除')
    if (blocked === 'status-unknown') throw new Error('无法确认工作树是否干净，不能删除')
    const workspaceId = found.worktree.workspaceId
    if (workspaceId === null) throw new Error('工作树缺少 workspace id')

    await performRemoveSaga(sourceId, {
      operationId,
      workspaceId,
      expected: {
        repoId: found.repo.repoId,
        worktreeId: found.worktree.worktreeId,
        branch: found.worktree.branch,
        head: found.worktree.head,
      },
      path: found.worktree.path,
    })
  })
}

export async function retryRecovery(sourceId: string): Promise<void> {
  const recovery = states.get(sourceId)?.recovery
  if (recovery === undefined) return
  const busyId = nextId('recovery')
  return runBusy(sourceId, { kind: 'recovery', operationId: busyId }, async () => {
    if (recovery.kind === 'git-create') {
      await performCreateSaga(
        sourceId, recovery.preview, recovery.operationId, recovery.sessionId, recovery,
      )
      return
    }
    if (recovery.kind === 'git-remove') {
      await performRemoveSaga(sourceId, recovery, recovery)
      return
    }
    try {
      if (recovery.kind === 'rollback-create') {
        const result = await runRollbackRecovery({
          hostRollback: (operationId, expected) => (
            gitWorktreeApi.rollbackCreate(sourceId, { operationId }, expected)
          ),
          workspaceCreate: path => createWorkspace(getInstanceClient(sourceId), path),
          sessionCreate: (workspaceId, sessionId) => createSession(getInstanceClient(sourceId), workspaceId, sessionId),
          isWorkspaceOwnershipConflict: error => (
            error instanceof GitWorktreeRpcError && error.code === 'rollback-has-workspace'
          ),
        }, recovery)
        if (result.committed) requestOpenSession(sourceId, result.sessionId)
      } else if (recovery.kind === 'workspace-adopt' || recovery.kind === 'session-adopt') {
        const result = await runWorkspaceAdoptRecovery({
          workspaceCreate: path => createWorkspace(getInstanceClient(sourceId), path),
          sessionCreate: (workspaceId, sessionId) => createSession(getInstanceClient(sourceId), workspaceId, sessionId),
        }, recovery)
        requestOpenSession(sourceId, result.sessionId)
      } else if (recovery.kind === 'session-create') {
        await createSession(getInstanceClient(sourceId), recovery.workspaceId, recovery.sessionId)
        requestOpenSession(sourceId, recovery.sessionId)
      } else {
        await runWorkspaceDeleteRecovery(
          () => gitWorktreeApi.remove(sourceId, {
            operationId: recovery.operationId,
            workspaceId: recovery.workspaceId,
            expected: recovery.expected,
          }, recovery.path),
          () => deleteWorkspace(getInstanceClient(sourceId), recovery.workspaceId),
          error => error instanceof InstanceRpcError && error.code === 'workspace-not-found',
        )
      }
      setRecovery(sourceId, undefined)
      finishMutation(sourceId)
    } catch (error) {
      setRecovery(sourceId, recoveryForFailure(error, recovery) ?? { ...recovery, message: errorText(error) })
      if (recovery.kind === 'rollback-create' || recovery.kind === 'workspace-adopt') finishMutation(sourceId)
      throw error
    }
  })
}

export function clearActionError(sourceId: string): void {
  if (states.get(sourceId)?.actionError !== undefined) patchSource(sourceId, { actionError: undefined })
}

function start(): void {
  stopBridge = chamberBridge.subscribe(syncServers)
  syncServers()
  pollTimer = globalThis.setInterval(() => {
    for (const server of chamberBridge.getServers()) {
      if (server.connected && states.get(server.id)?.busy === undefined) void refreshSource(server.id)
    }
  }, POLL_MS)
}

function stop(): void {
  stopBridge?.()
  stopBridge = undefined
  if (pollTimer !== undefined) globalThis.clearInterval(pollTimer)
  pollTimer = undefined
}

export const gitCoordinator = {
  attach(): () => void {
    retainCount += 1
    if (retainCount === 1) start()
    let detached = false
    return () => {
      if (detached) return
      detached = true
      retainCount = Math.max(0, retainCount - 1)
      if (retainCount === 0) stop()
    }
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getVersion(): number {
    return revision
  },
  getSource(sourceId: string): GitSourceState {
    return states.get(sourceId) ?? { sourceId, connected: false, status: 'idle' }
  },
}
