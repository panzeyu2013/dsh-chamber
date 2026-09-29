/**
 * Page-wide Git worktree coordinator.
 * The chamber composite imports this module once and mounts it in N cordis
 * contexts, so all contexts observe one polling/action state: facts are fetched
 * once per connected source, operations cannot be duplicated by switching
 * shells, and recovery stays visible after a view switch.
 */
import {
  chamberBridge,
  createSessionForSource, archiveSessionForSource,
  createWorkspaceForSource, deleteWorkspaceForSource, renameWorkspaceForSource,
  insertWorkspaceBefore,
  clearWorkspaceGitFlags, getSourceRepoLayouts, getWorkspaceGitFlag, markSourceGitFlagsLoaded, retainSourceWorkspaceFlags, setSourceRepoLayouts, setWorkspaceGitFlag,
  fetchInstanceSnapshot, getInstanceClient, InstanceRpcError,
} from '@dsh-chamber/dsh-chamber-client-core'
import { GitActionError, gitActionErrorCode } from './action-error.ts'
import { GitActionLedger } from './action-ledger.ts'
import { workspaceAfterAnchor } from './placement.ts'
import { SerializedRefreshes } from './refresh-flight.ts'
import { GitWorktreeRpcError, gitWorktreeApi, isAmbiguousGitRpcFailure, isDeterministicGitRejection } from './git-api.ts'
import { canTargetSession, findWorktree, removeBlockReason } from './git-facts.ts'
// Hidden-tab polling gate + injectable visibility face (dependency-free).
import { isPollEligible, visibilityEvents } from './visibility-gate.ts'
import {
  GitSagaError, isProvenPreMutationRefusal, recoveryForFailure, runAdoptSessionSaga, runCreateSaga, runPreRemoveArchive,
  runRemoveSaga, runRollbackRecovery, runWorkspaceAdoptRecovery, runWorkspaceDeleteRecovery,
} from './saga.ts'
import { basenameOf, createListenerSet, errorMessage as errorText } from '@dsh-chamber/dsh-chamber-client-core'
import type { WorkspaceCreationPlacement } from '@dsh-chamber/dsh-chamber-client-core'
import type {
  GitBusyState, GitRecovery, GitSourceError, GitSourceState, GitWorktreeInfo, GitWorktreeSnapshot, PreviewCreateInput, PreviewCreateResult, RemoveWorktreeResult, UnregisteredWorktreeInfo,
} from './types.ts'

const POLL_MS = 30_000
const listeners = createListenerSet()
const states = new Map<string, GitSourceState>()
const refreshFlights = new SerializedRefreshes<GitSourceState>()
const actionLedger = new GitActionLedger()

/** Connection-generation fence: a response from before disconnect/reconnect is stale. */
const sourceEpochs = new Map<string, number>()
let revision = 0
let retainCount = 0
let stopBridge: (() => void) | undefined
let onVisibilityChange: (() => void) | undefined
let stopVisibility: (() => void) | undefined
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

function emit(): void {
  revision += 1
  listeners.notify()
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

/** Publish per-workspace git flags to the sidebar's neutral registry (design 08):
 *  which workspaces are worktrees / the main checkout; unassociated workspaces
 *  get their flag cleared. */
function publishWorkspaceGitFlags(
  sourceId: string,
  snapshot: GitWorktreeSnapshot,
  previous?: GitWorktreeSnapshot,
): void {
  // Refresh per snapshot WITHOUT a leading full clear: worktree flags are
  // re-set, orphan markers MERGE onto the previous identity, then truly-stale
  // flags are pruned by the keep set.
  const keep = new Set<string>()
  const layouts: Array<{ repoKey: string; mainWorkspaceId: string | null; unregistered: UnregisteredWorktreeInfo[] }> = []
  for (const repo of snapshot.repos) {
    const mainWorkspaceId = repo.worktrees.find(worktree => worktree.isMain)?.workspaceId ?? null
    const unregistered: UnregisteredWorktreeInfo[] = []
    for (const worktree of repo.worktrees) {
      if (worktree.workspaceId === null) {
        // The MAIN checkout is never an unregistered worktree.
        if (worktree.isMain) continue
        unregistered.push({
          name: basenameOf(worktree.path) || worktree.path,
          worktreeId: worktree.worktreeId,
          branch: worktree.branch,
          status: worktree.status,
          headState: worktree.headState,
          attention: [...worktree.attention],
          dirty: worktree.dirty,
          head: worktree.head,
        })
        continue
      }
      setWorkspaceGitFlag(sourceId, worktree.workspaceId, {
        isWorktree: !worktree.isMain,
        isMain: worktree.isMain,
        repoKey: repo.repoId,
        ...(!worktree.isMain && mainWorkspaceId !== null ? { mainWorkspaceId } : {}),
      })
      keep.add(worktree.workspaceId)
    }
    layouts.push({ repoKey: repo.repoId, mainWorkspaceId, unregistered })
  }
  // Orphaned workspaces: a repository path that no longer exists (externally
  // deleted worktree) MERGES onto the PREVIOUS flag so the orphan keeps its
  // worktree identity + the "已消失" badge. 'path-unavailable' and the fallback
  // 'workspace-path-failed' must both mark the workspace orphaned.
  for (const error of snapshot.errors) {
    if ((error.code === 'path-unavailable' || error.code === 'workspace-path-failed')
      && error.workspaceId !== undefined) {
      const existing = getWorkspaceGitFlag(sourceId, error.workspaceId)
      setWorkspaceGitFlag(sourceId, error.workspaceId, {
        isWorktree: existing?.isWorktree === true,
        isMain: existing?.isMain === true,
        ...(existing?.mainWorkspaceId === undefined ? {} : { mainWorkspaceId: existing.mainWorkspaceId }),
        ...(existing?.repoKey === undefined ? {} : { repoKey: existing.repoKey }),
        orphaned: true,
      })
      keep.add(error.workspaceId)
    }
  }
  // Repo-level failure inheritance: repos missing from this round inherit the
  // PREVIOUS snapshot's associations, so branch glyphs / delete buttons do not
  // flicker away until a good snapshot re-publishes them.
  if (previous !== undefined) {
    const currentRepoKeys = new Set(snapshot.repos.map(repo => repo.repoId))
    for (const repo of previous.repos) {
      if (currentRepoKeys.has(repo.repoId)) continue
      for (const worktree of repo.worktrees) {
        if (worktree.workspaceId !== null) keep.add(worktree.workspaceId)
      }
    }
  }
  retainSourceWorkspaceFlags(sourceId, keep)
  setSourceRepoLayouts(sourceId, layouts)
  // The snapshot (even an empty one) is the source's identity resolution: the
  // sidebar gates the workspace accent on it so no independent hue flashes first.
  markSourceGitFlagsLoaded(sourceId)
}

function connectedSource(sourceId: string): boolean {
  return chamberBridge.getServers().some(server => server.id === sourceId && server.connected)
}

/** Last-seen workspace id sets per source: a workspace added or removed without
 *  a connection change must trigger a git refresh immediately, not wait 30s. */
const lastWorkspaceKeys = new Map<string, string>()

function workspaceKeyOf(server: { id: string; workspaces: ReadonlyArray<{ id: string }> }): string {
  return server.workspaces.map(workspace => workspace.id).sort().join(',')
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
          actionErrorCode: current?.actionErrorCode,
        })
        refreshIds.push(server.id)
        changed = true
      } else {
        const key = workspaceKeyOf(server)
        const previous = lastWorkspaceKeys.get(server.id)
        if (previous !== key) {
          // Workspace set changed: refresh now so the new workspace's git line appears.
          lastWorkspaceKeys.set(server.id, key)
          refreshIds.push(server.id)
        }
      }
    } else if (current === undefined || current.connected || current.snapshot !== undefined || current.sourceError !== undefined) {
      bumpSourceEpoch(server.id)
      clearWorkspaceGitFlags(server.id)
      states.set(server.id, {
        sourceId: server.id,
        connected: false,
        status: 'idle',
        busy: actionLedger.current(server.id),
        recovery: current?.recovery,
        actionError: current?.actionError,
        actionErrorCode: current?.actionErrorCode,
      })
      lastWorkspaceKeys.delete(server.id)
      changed = true
    }
  }
  for (const sourceId of [...states.keys()]) {
    if (!ids.has(sourceId)) {
      bumpSourceEpoch(sourceId)
      states.delete(sourceId)
      lastWorkspaceKeys.delete(sourceId)
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
    // An empty deadline result must never erase the last complete facts: keep the
    // previous snapshot visibly stale beside the explicit error; a PARTIAL result
    // (repos present) replaces it — fresh progress beats stale truth.
    const previous = states.get(sourceId)?.snapshot
    const staleEmpty = snapshot.sourceError !== undefined && snapshot.repos.length === 0 && previous !== undefined
    // A deadline-stale snapshot must not clear the still-valid previous flags
    // (badges/drag boundaries would vanish) — publish the EFFECTIVE snapshot.
    publishWorkspaceGitFlags(sourceId, staleEmpty ? previous : snapshot, previous)
    return patchSource(sourceId, {
      connected: true,
      status: snapshot.sourceError === undefined ? 'ready' : 'error',
      snapshot: staleEmpty ? previous : snapshot,
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
  if (current?.recovery !== undefined && busy.kind !== 'recovery') {
    throw new GitActionError('recovery-pending', 'Finish the pending Git recovery before starting another action')
  }
  const lease = actionLedger.begin(sourceId, busy)
  if (lease === undefined) {
    throw new GitActionError('action-in-progress', 'Another Git operation is already running on this source')
  }
  try {
    patchSource(sourceId, { busy, actionError: undefined, actionErrorCode: undefined })
    const result = await operation()
    patchSource(sourceId, { actionError: undefined, actionErrorCode: undefined })
    return result
  } catch (error) {
    // The code is what the source-level strip localizes; the raw message stays
    // for diagnostics and as the unmapped fallback (English by construction).
    patchSource(sourceId, { actionError: errorText(error), actionErrorCode: gitActionErrorCode(error) })
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

/**
 * 乐观 worktree 形态 + 未注册块收敛，**必须在回声事实发布之前**跑
 * （`beforePublish`，见 workspace-mutations.ts）：事实一到，App 立刻重派生投影，
 * 此刻该行必须已经是 worktree 形态，同一路径也不能还挂着"未注册工作树"行。
 * 两个 store 的写入都早于那次派生，因此不依赖"两个 React 更新落在同一批次"的调度假设。
 */
function decorateWorktreeWorkspace(
  sourceId: string,
  workspaceId: string,
  facts: { repoKey: string | undefined; mainWorkspaceId?: string | undefined; worktreeId?: string },
): void {
  if (facts.repoKey === undefined) return
  setWorkspaceGitFlag(sourceId, workspaceId, {
    isWorktree: true,
    isMain: false,
    repoKey: facts.repoKey,
    ...(facts.mainWorkspaceId === undefined ? {} : { mainWorkspaceId: facts.mainWorkspaceId }),
  })
  // 未注册块收敛（adopt 才有：新 worktree 从未进过该块）。
  if (facts.worktreeId === undefined) return
  setSourceRepoLayouts(sourceId, getSourceRepoLayouts(sourceId).map(layout => layout.repoKey === facts.repoKey
    ? { ...layout, unregistered: layout.unregistered.filter(info => info.worktreeId !== facts.worktreeId) }
    : layout))
}

/** Best-effort post-adopt placement/identity: `insertBefore` puts the new
 *  workspace right after its main checkout (the registry PREPENDS by default),
 *  and the title derives from the branch (the basename can equal the main's).
 *  Flag + repo layout ride `beforePublish` instead. */
/** 来源在发布投影里的 workspace id 序（合成"未分组"桶除外）。**读取窗口**：
 *  这个序已经套用了回声与位置意图——它们把新行放在锚点后，而宿主此刻仍是
 *  PREPEND 头部，所以调用方必须显式排除"正在被搬的那一行"（见 workspaceAfterMain）。
 *  这也正是意图在 create 之前发布、而不是靠读序决定锚点的原因。 */
function workspaceOrder(sourceId: string): string[] {
  return chamberBridge.getServers().find(server => server.id === sourceId)
    ?.workspaces
    // 合成行（synthetic 的 cwd 派生分组）也在宿主 id 空间之外：拿它当 insertBefore 锚点会被宿主
    // 当未知 id 处理（落点与投影分歧，且挂载首推时锚点即消失）。滤掉即退化为 append，与本意同址。
    .filter(workspace => workspace.ungrouped !== true && workspace.synthetic !== true)
    .map(workspace => workspace.id) ?? []
}

/** 作废事实（`reportWorkspacePlacementFailed`）能带的宿主 id：saga 死时若已学到 workspace id
 *  就带上——恢复记录是唯一载体。realpath 拼写分歧下只按请求路径退不掉那条已被回声升级成宿主
 *  路径的 id 键条目，行会被按在锚点后直到 TTL 才跳回（正是失败侧要消灭的迟到一跳）。 */
function placementVoidWorkspaceId(error: unknown): string | undefined {
  const recovery = error instanceof GitSagaError ? error.recovery : undefined
  if (recovery === undefined) return undefined
  switch (recovery.kind) {
    case 'session-create':
    case 'workspace-adopt':
    case 'rollback-create':
      return recovery.workspaceId
    default:
      return undefined
  }
}

/** The workspace that must FOLLOW the moved row: `insertBefore` anchors on the
 *  workspace that must follow the moved id, so anchoring on the main itself would
 *  land the worktree ABOVE it; read from the pre-refresh order.
 *  `movedWorkspaceId` is skipped on purpose: the published projection ALREADY
 *  renders the new row right after its anchor (echo + placement intent) while the
 *  host still has it prepended, so anchoring on it would send
 *  `insertBefore(id, id)` — which the host answers with a silent no-op
 *  (vendor workspace/src/index.ts: `if (beforeId === id) return state.workspaceIds`).
 *  The registry order would never converge, the placement intent would stay pinned
 *  until its TTL, and the on-disk order would keep the worktree above its main. */
function workspaceAfterMain(sourceId: string, mainWorkspaceId: string | undefined, movedWorkspaceId: string): string | undefined {
  return workspaceAfterAnchor(workspaceOrder(sourceId), mainWorkspaceId, movedWorkspaceId)
}

async function positionAdoptedWorkspace(
  sourceId: string,
  result: { workspaceId: string; path: string },
  mainWorkspaceId: string | undefined,
  branch: string | null,
): Promise<void> {
  // AWAITED: the registry order must be correct BEFORE the caller refreshes.
  try {
    await insertWorkspaceBefore(
      getInstanceClient(sourceId),
      result.workspaceId,
      workspaceAfterMain(sourceId, mainWorkspaceId, result.workspaceId),
    )
  } catch (error) {
    console.error('[dsh-chamber] Git adopt workspace reposition failed (best-effort):', error)
    // 位置意图就此作废：宿主序（PREPEND）已是最终序，继续按住会让行停在锚点后直到 TTL 才跳回。
    chamberBridge.reportWorkspacePlacementFailed({
      sourceId,
      workspaceId: result.workspaceId,
      path: result.path,
    })
  }
  if (branch === null) return
  // AWAITED (best-effort): the title must be in place before the caller's refresh.
  try {
    await renameWorkspaceForSource(sourceId, result.workspaceId, branch)
  } catch (error) {
    console.error('[dsh-chamber] Git adopt workspace rename failed (best-effort):', error)
  }
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
  commitSession = true,
  sourceWorkspaceId?: string,
): Promise<string> {
  try {
    const result = await runCreateSaga({
      hostCreate: input => gitWorktreeApi.create(sourceId, input, preview),
      hostRollback: (input, expected) => gitWorktreeApi.rollbackCreate(sourceId, input, expected),
      // workspace.create 必须走唯一出口（design 05）：位置锚点 = 本次创建的主
      // checkout，worktree flag 走 beforePublish——事实发布之前写好。
      workspaceCreate: path => createWorkspaceForSource(sourceId, path, {
        ...(sourceWorkspaceId === undefined ? {} : { afterWorkspaceId: sourceWorkspaceId }),
        beforePublish: created => decorateWorktreeWorkspace(sourceId, created.workspaceId, {
          repoKey: preview.repoId,
          ...(sourceWorkspaceId === undefined ? {} : { mainWorkspaceId: sourceWorkspaceId }),
        }),
      }),
      sessionCreate: (workspaceId, id) => createSessionForSource(sourceId, workspaceId, { sessionId: id, origin: 'user' }),
      isAmbiguousHostFailure: isAmbiguousGitRpcFailure,
    }, preview, { operationId, sessionId }, {
      createSession: commitSession,
      ...(sourceWorkspaceId === undefined ? {} : { sourceWorkspaceId }),
    })
    setRecovery(sourceId, undefined)
    // Position the new worktree IMMEDIATELY BELOW its source (main) checkout:
    // the wire PREPENDS, so the anchor is the workspace after the main. AWAITED
    // so the order is correct before the refresh; best-effort (never rolls back).
    if (sourceWorkspaceId !== undefined) {
      try {
        await insertWorkspaceBefore(getInstanceClient(sourceId), result.workspaceId, workspaceAfterMain(sourceId, sourceWorkspaceId, result.workspaceId))
      } catch (error) {
        console.error('[dsh-chamber] Git create workspace reposition failed (best-effort):', error)
        // 同上：作废位置意图（只发失败侧；成功侧靠"行已离开列表头部"的位置判据退休，不会与权威
        // push 抢时序）。
        chamberBridge.reportWorkspacePlacementFailed({
          sourceId,
          workspaceId: result.workspaceId,
          path: result.path,
        })
      }
    }
    finishMutation(sourceId)
    // Open the committed session — never when the create was session-less.
    if (commitSession) requestOpenSession(sourceId, result.sessionId)
    return result.sessionId
  } catch (error) {
    // saga 在重排之前就放弃 ⇒ 宿主的 PREPEND 序就是最终序：位置意图必须立刻作废，否则行会停在
    // 锚点后直到 TTL 才跳回（迟到一跳）。create 可能根本没提交 ⇒ 请求路径是基本键；但回声升级
    // 已把条目改键成宿主 realpath（拼写可与请求路径不同）⇒ 恢复记录带得出宿主 id 时一并带上
    // （adopt 中止 catch 同款），否则拼写分歧下只按路径退不掉那条已升级的意图。
    if (sourceWorkspaceId !== undefined) {
      const workspaceId = placementVoidWorkspaceId(error)
      chamberBridge.reportWorkspacePlacementFailed({
        sourceId,
        path: preview.targetPath,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      })
    }
    if (error instanceof GitSagaError) {
      setRecovery(sourceId, recoveryForFailure(error, previousRecovery))
      if (error.refreshNeeded || previousRecovery !== undefined) finishMutation(sourceId)
    }
    throw error
  }
}

/** Execute the create saga. Navigation is fire-and-forget and never a rollback boundary. */
export async function createFromPreview(
  sourceId: string,
  preview: PreviewCreateResult,
  options?: { createSession?: boolean; sourceWorkspaceId?: string },
): Promise<string> {
  const operationId = nextId('create')
  const sessionId = nextId('session')
  return runBusy(sourceId, { kind: 'create', operationId }, () => (
    performCreateSaga(sourceId, preview, operationId, sessionId, undefined, options?.createSession, options?.sourceWorkspaceId)
  ))
}

/** adopt 的宿主事实：位置锚点（主 checkout 的 workspace id）+ 仓库身份。 */
interface AdoptPlacement {
  placement: WorkspaceCreationPlacement
  repoKey?: string
  mainWorkspaceId?: string
}

/** 主 checkout 未注册时的锚点：当前**最后一个** workspace——宿主对无锚 adopt 的落点就是
 *  尾部（`insertBefore(id, undefined)` = append），所以"排在最后一个之后"与宿主收敛到同
 *  一处，新行不再"从最顶端入场再滑到尾部"。create 之前读取，此时新行还不可能在列表里。 */
function lastWorkspaceId(sourceId: string): string | undefined {
  const order = workspaceOrder(sourceId)
  return order.length === 0 ? undefined : order[order.length - 1]
}

function adoptPlacementOf(sourceId: string, snapshot: GitWorktreeSnapshot, path: string): AdoptPlacement {
  const repo = snapshot.repos.find(candidate => candidate.worktrees.some(worktree => worktree.path === path))
  const mainWorkspaceId = repo?.worktrees.find(worktree => worktree.isMain)?.workspaceId ?? undefined
  // 主行已注册 ⇒ 紧跟主 checkout；主行未注册（未注册块正是为这类仓库存在）⇒ 尾部锚点。
  const anchor = mainWorkspaceId ?? lastWorkspaceId(sourceId)
  return {
    placement: anchor === undefined ? {} : { afterWorkspaceId: anchor },
    ...(repo === undefined ? {} : { repoKey: repo.repoId }),
    ...(mainWorkspaceId === undefined ? {} : { mainWorkspaceId }),
  }
}

/**
 * Create a session in an EXISTING worktree (adopt-only, no Git mutation): the
 * workspace at `path` is registered or reused, then a preallocated session is
 * committed; the same session id is reused on failure.
 */
export async function createSessionHere(sourceId: string, path: string): Promise<string> {
  const operationId = nextId('adopt')
  const sessionId = nextId('session')
  return runBusy(sourceId, { kind: 'adopt-session', operationId }, async () => {
    const fresh = await refreshSource(sourceId, true)
    if (fresh.snapshot === undefined || fresh.sourceError !== undefined) {
      throw new GitActionError('fresh-facts-unavailable', 'The latest Git worktree facts are unavailable', fresh.sourceError)
    }
    // 锚点在守卫之后、闭包之外解析（闭包内 `fresh.snapshot` 重新放宽为 `| undefined`）。
    const adopt = adoptPlacementOf(sourceId, fresh.snapshot, path)
    const known = fresh.snapshot.repos.flatMap(repo => repo.worktrees).find(worktree => worktree.path === path)
    if (known === undefined) throw new GitActionError('worktree-not-found', 'The target worktree is not in the current source topology')
    // Re-check health against the FRESH snapshot: never target a vanished/unhealthy path.
    if (!canTargetSession(known)) throw new GitActionError('unhealthy-target', 'The target worktree is unhealthy and cannot host a session')
    try {
      const result = await runAdoptSessionSaga({
        workspaceCreate: targetPath => createWorkspaceForSource(sourceId, targetPath, {
          ...adopt.placement,
          // adopt 随后会把宿主标题改成分支名（positionAdoptedWorkspace）：标题随事实
          // 带上，否则回声行先用路径 basename 出生再翻转。branch 为 null 时留给 basename。
          ...(known.branch === null ? {} : { title: known.branch }),
          // adopt 的目标可能是未注册工作树：回声行与"未注册"行必须在同一次投影里换手，
          // flag/layout 随事实同一续体发布。主 checkout 例外（写 isWorktree:true 会把它
          // 临时渲染成派生行）。
          beforePublish: created => {
            if (known.isMain) return
            decorateWorktreeWorkspace(sourceId, created.workspaceId, {
              repoKey: adopt.repoKey,
              ...(adopt.mainWorkspaceId === undefined ? {} : { mainWorkspaceId: adopt.mainWorkspaceId }),
              worktreeId: known.worktreeId,
            })
          },
        }),
        sessionCreate: (workspaceId, id) => createSessionForSource(sourceId, workspaceId, { sessionId: id, origin: 'user' }),
      }, path, sessionId)
      setRecovery(sourceId, undefined)
      // Position + identity: the wire PREPENDS workspaces, so the adopted
      // worktree must sit right AFTER its main checkout and its title should be
      // the branch. Both best-effort; AWAITED so the refresh sees the fixed order.
      await positionAdoptedWorkspace(sourceId, result, adopt.mainWorkspaceId, known.branch)
      finishMutation(sourceId)
      requestOpenSession(sourceId, result.sessionId)
      return result.sessionId
    } catch (error) {
      // adopt 的 saga 在**重排之前**中止（workspace 已建、session.create 失败）⇒ 没有 insertBefore
      // 会再来，宿主序（PREPEND / 尾部 append）就是最终序：位置意图立刻作废，否则行会停在锚点后
      // 直到 TTL 才跳回。宿主 id 只在恢复记录带得出来时给（session-create 变体），否则按请求路径作键。
      if (adopt.placement.afterWorkspaceId !== undefined) {
        const workspaceId = placementVoidWorkspaceId(error)
        chamberBridge.reportWorkspacePlacementFailed({
          sourceId,
          path,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        })
      }
      if (error instanceof GitSagaError) {
        setRecovery(sourceId, recoveryForFailure(error))
        // An ambiguous adopt left workspace/session facts the aggregate must re-read.
        if (error.refreshNeeded) finishMutation(sourceId)
      }
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
): Promise<RemoveWorktreeResult> {
  const discardChanges = request.discardChanges === true ? { discardChanges: true } : {}
  try {
    return await runRemoveSaga({
      hostRemove: () => gitWorktreeApi.remove(sourceId, {
        operationId: request.operationId,
        workspaceId: request.workspaceId,
        expected: request.expected,
        // UNREGISTERED removal: the input itself must carry the path (the host
        // fingerprints the whole input — a path-less replay mismatch would wedge recovery).
        ...(request.workspaceId === undefined ? { path: request.path } : {}),
        ...(request.deleteBranch === undefined ? {} : { deleteBranch: request.deleteBranch }),
        ...discardChanges,
      }, request.path),
      verifyTerminalRemove: () => gitWorktreeApi.remove(sourceId, {
        operationId: request.operationId,
        workspaceId: request.workspaceId,
        expected: request.expected,
        ...(request.workspaceId === undefined ? { path: request.path } : {}),
        ...(request.deleteBranch === undefined ? {} : { deleteBranch: request.deleteBranch }),
        ...discardChanges,
      }, request.path),
      workspaceDelete: id => deleteWorkspaceForSource(sourceId, id, request.path),
      deleteBranch: request.deleteBranch,
      discardChanges: request.discardChanges,
      ambiguousRecovery: error => isAmbiguousGitRpcFailure(error) && !isDeterministicGitRejection(error)
        ? { kind: 'git-remove', ...request, message: errorText(error) }
        : undefined,
    }).then(result => {
      setRecovery(sourceId, undefined)
      finishMutation(sourceId)
      return result
    })
  } catch (error) {
    if (error instanceof GitSagaError) {
      // A host-PROVEN pre-mutation refusal (original serialized with
      // retryable: false — the host re-checked the topology and the target still
      // exists) resolves a pending replay as "not removed": clear the recovery
      // instead of preserving an endless same-reason retry with no dismiss.
      setRecovery(sourceId, isProvenPreMutationRefusal(error)
        ? undefined
        : recoveryForFailure(error, previousRecovery))
      if (error.refreshNeeded || previousRecovery !== undefined) finishMutation(sourceId)
    }
    throw error
  }
}

/** True when `sessionId` is the source's current session AND it is a BLANK
 *  (never-submitted) session — a blank current session must not block worktree
 *  removal (it carries no content worth protecting). */
export function currentSessionIsBlank(sourceId: string, sessionId: string | undefined): boolean {
  if (sessionId === undefined) return false
  const server = chamberBridge.getServers().find(candidate => candidate.id === sourceId)
  if (server === undefined) return false
  return server.workspaces.some(workspace =>
    workspace.sessions.some(session => session.id === sessionId && session.blank === true))
}

/** Marker for the in-dialog dirty dead-end: the dialog shows the discard
 *  checkbox from its possibly-stale row fact, so a FRESH preflight that discovers
 *  dirty must force-show it instead of leaving a bare error with no way forward. */
export class WorktreeDirtyError extends GitActionError {
  constructor() {
    // Same code as the host's own dirty refusal: one user-facing situation,
    // one code→copy entry (shared/action-error.ts).
    super('worktree-dirty', 'The worktree has uncommitted changes and cannot be removed without an explicit discard')
    this.name = 'WorktreeDirtyError'
  }
}

/** Git-first safe remove; workspace-delete failure becomes explicit recovery. */
export async function removeWorktree(
  sourceId: string,
  target: RemoveTarget,
  options: {
    archiveSessions?: boolean
    deleteBranch?: string
    discardChanges?: boolean
  } = {},
): Promise<RemoveWorktreeResult> {
  const operationId = nextId('remove')
  return runBusy(sourceId, { kind: 'remove', operationId }, async () => {
    const fresh = await refreshSource(sourceId, true)
    if (fresh.snapshot === undefined || fresh.sourceError !== undefined) {
      throw new GitActionError('fresh-facts-unavailable', 'The latest Git worktree facts are unavailable', fresh.sourceError)
    }
    const found = findWorktree(fresh.snapshot, target.repoId, target.worktreeId)
    if (found === undefined) throw new GitActionError('worktree-not-found', 'The worktree no longer exists')
    const server = chamberBridge.getServers().find(candidate => candidate.id === sourceId)
    const current = server?.runtime?.current
    // NO IMPLICIT SESSION TOUCHING: removal never stops, cancels or deletes a
    // session by itself, and archives only under the explicit default-OFF
    // checkbox. That checkbox authorizes the host's archive-time stop
    // (`stopActivity`) on the archived sessions, because archive admission
    // refuses a session whose background work is still running. What blocks is
    // the HOST's archived-aware running fact (an archived running session is
    // INERT); `removeBlockReason` falls back to `runningSessionIds` on an older host
    // (conservative). The `current` hard block and the
    // `runtime-unknown` fail-closed block are NOT running guards and stay in
    // force (removing the viewed session's cwd would break its tool calls); both
    // are evaluated before the running reason.
    const blockOf = (worktree: GitWorktreeInfo): ReturnType<typeof removeBlockReason> => removeBlockReason(
      worktree,
      current,
      currentSessionIsBlank(sourceId, current),
      server?.runtime !== undefined,
    )
    const worktree = found.worktree
    const blocked = blockOf(worktree)
    if (blocked === 'main') throw new GitActionError('main-worktree', 'The main checkout cannot be removed')
    if (blocked === 'unregistered') throw new GitActionError('worktree-unregistered', 'The worktree has no dsh workspace; use the unregistered removal path')
    if (blocked === 'current') throw new GitActionError('worktree-current', 'The worktree holds the session currently on screen')
    if (blocked === 'runtime-unknown') throw new GitActionError('worktree-runtime-unknown', 'The current session state is unknown while the source reconnects')
    if (blocked === 'locked') throw new GitActionError('worktree-locked', 'A locked worktree cannot be removed')
    if (blocked === 'unhealthy') throw new GitActionError('worktree-unhealthy', 'The worktree is unusable (missing, invalid or not a Git repository)')
    // Dirty is NOT an automatic throw: the dialog's explicit checkbox authorizes
    // force-remove (files discarded, branch kept); the typed marker force-shows the
    // checkbox even when the row fact was stale-clean.
    if (blocked === 'dirty' && options.discardChanges !== true) {
      throw new WorktreeDirtyError()
    }
    if (blocked === 'status-unknown') throw new GitActionError('worktree-status-unknown', 'The worktree cleanliness is unknown')
    const workspaceId = worktree.workspaceId
    // Internal invariant (no user fix exists): English message is the honest unmapped fallback.
    if (workspaceId === null) throw new Error('The worktree row has no workspace id')

    // Optional soft-archive of the whole session tree BEFORE any Git mutation; a
    // failure aborts with nothing removed. The already-archived skip is
    // best-effort — the unary snapshot fallback reports an empty archive set (a
    // registered degradation, see STATUS) — but a retry still never re-archives:
    // the HOST's archiveSession is idempotent for an id already in the set. Each
    // archive carries
    // `stopActivity`: the host stops that session's still-running work (jobs,
    // schedules, subagent descendants) instead of refusing the admission — the
    // checkbox is the user's authorization for exactly that (dialog copy says so).
    const directSessionIds = worktree.sessionIds
    if (options.archiveSessions === true && directSessionIds.length > 0) {
      try {
        await runPreRemoveArchive({
          fetchSessions: async () => {
            const snapshot = await fetchInstanceSnapshot(getInstanceClient(sourceId))
            return { sessions: snapshot.sessions, archivedSessionIds: snapshot.archivedSessionIds }
          },
          archiveSession: (sessionId, archiveOptions) => archiveSessionForSource(sourceId, sessionId, archiveOptions),
        }, directSessionIds)
      } catch (error) {
        throw new GitActionError('archive-failed', 'Archiving sessions failed; no worktree was removed', error)
      }
    }

    return await performRemoveSaga(sourceId, {
      operationId,
      workspaceId,
      expected: {
        repoId: found.repo.repoId,
        worktreeId: worktree.worktreeId,
        branch: worktree.branch,
        head: worktree.head,
      },
      path: worktree.path,
      ...(options.deleteBranch === undefined ? {} : { deleteBranch: options.deleteBranch }),
      ...(options.discardChanges === true ? { discardChanges: true } : {}),
    })
  })
}

/** Remove an UNREGISTERED worktree (no dsh workspace — Plan A): git-first via
 *  the host's path-based variant, no workspace.delete, no archive step. The row's
 *  delete button stays hard-disabled for dirty worktrees (no discard path wired). */
export async function removeUnregisteredWorktree(
  sourceId: string,
  target: { repoId: string; worktreeId: string; path: string; branch: string | null; head: string },
  options: { deleteBranch?: string } = {},
): Promise<void> {
  const operationId = nextId('remove')
  // Fresh refresh first: the row identity may be up to 30s stale.
  const refreshFailure = await refreshSource(sourceId, true).catch((error: unknown) => error)
  if (refreshFailure !== undefined) {
    throw new GitActionError('refresh-failed', 'Refreshing the Git worktree state failed', refreshFailure)
  }
  return runBusy(sourceId, { kind: 'remove', operationId }, async () => {
    const input = {
      operationId,
      path: target.path,
      expected: {
        repoId: target.repoId,
        worktreeId: target.worktreeId,
        branch: target.branch,
        head: target.head,
      },
      ...(options.deleteBranch === undefined ? {} : { deleteBranch: options.deleteBranch }),
    }
    try {
      await runRemoveSaga({
        hostRemove: () => gitWorktreeApi.remove(sourceId, input, target.path),
        verifyTerminalRemove: () => gitWorktreeApi.remove(sourceId, input, target.path),
        workspaceDelete: id => deleteWorkspaceForSource(sourceId, id, target.path),
        ambiguousRecovery: error => isAmbiguousGitRpcFailure(error) && !isDeterministicGitRejection(error)
          ? { kind: 'git-remove', ...input, message: errorText(error) }
          : undefined,
      })
      finishMutation(sourceId)
    } catch (error) {
      // Ambiguous failures become a durable git-remove recovery (the host may have
      // committed the removal) — never a one-shot actionError.
      if (error instanceof GitSagaError) {
        setRecovery(sourceId, recoveryForFailure(error, undefined))
        if (error.refreshNeeded) finishMutation(sourceId)
      }
      throw error
    }
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
        recovery.createSession,
        recovery.sourceWorkspaceId,
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
          // recovery 路径随后会 requestOpenSession，锚点收益有限，这里只保证事实不漏发。
          workspaceCreate: path => createWorkspaceForSource(sourceId, path),
          sessionCreate: (workspaceId, sessionId) => createSessionForSource(sourceId, workspaceId, { sessionId, origin: 'user' }),
          isWorkspaceOwnershipConflict: error => (
            error instanceof GitWorktreeRpcError && error.code === 'rollback-has-workspace'
          ),
        }, recovery)
        if (result.committed) requestOpenSession(sourceId, result.sessionId)
      } else if (recovery.kind === 'workspace-adopt' || recovery.kind === 'session-adopt') {
        const result = await runWorkspaceAdoptRecovery({
          workspaceCreate: path => createWorkspaceForSource(sourceId, path),
          sessionCreate: (workspaceId, sessionId) => createSessionForSource(sourceId, workspaceId, { sessionId, origin: 'user' }),
        }, recovery)
        requestOpenSession(sourceId, result.sessionId)
      } else if (recovery.kind === 'session-create') {
        // 恢复路径仍属用户发起的 worktree saga（不是 boot 交接）。
        await createSessionForSource(sourceId, recovery.workspaceId, { sessionId: recovery.sessionId, origin: 'user' })
        requestOpenSession(sourceId, recovery.sessionId)
      } else {
        await runWorkspaceDeleteRecovery(
          () => gitWorktreeApi.remove(sourceId, {
            operationId: recovery.operationId,
            workspaceId: recovery.workspaceId,
            expected: recovery.expected,
            ...(recovery.deleteBranch === undefined ? {} : { deleteBranch: recovery.deleteBranch }),
            ...(recovery.discardChanges === true ? { discardChanges: true } : {}),
          }, recovery.path),
          () => deleteWorkspaceForSource(sourceId, recovery.workspaceId, recovery.path),
          error => error instanceof InstanceRpcError && error.code === 'workspace/not-found',
        )
      }
      setRecovery(sourceId, undefined)
      finishMutation(sourceId)
    } catch (error) {
      setRecovery(sourceId, recoveryForFailure(error, recovery) ?? { ...recovery, message: errorText(error) })
      if (recovery.kind === 'rollback-create' || recovery.kind === 'workspace-adopt' || recovery.kind === 'session-adopt') {
        finishMutation(sourceId)
      }
      throw error
    }
  })
}

export function clearActionError(sourceId: string): void {
  const current = states.get(sourceId)
  if (current?.actionError !== undefined || current?.actionErrorCode !== undefined) {
    patchSource(sourceId, { actionError: undefined, actionErrorCode: undefined })
  }
}

/** Refresh every connected, action-idle source; existing pulls are joined. */
function refreshConnectedSources(): void {
  for (const server of chamberBridge.getServers()) {
    if (server.connected && states.get(server.id)?.busy === undefined) void refreshSource(server.id)
  }
}

function start(): void {
  stopBridge = chamberBridge.subscribe(syncServers)
  syncServers()
  // Hidden-tab polling gate: the timer keeps running but skips while hidden, and
  // becoming visible re-syncs the roster AND refreshes every connected source.
  onVisibilityChange = () => {
    if (visibilityEvents.read() !== 'visible') return
    syncServers()
    refreshConnectedSources()
  }
  stopVisibility = visibilityEvents.onChange(onVisibilityChange)
  pollTimer = globalThis.setInterval(() => {
    if (!isPollEligible(visibilityEvents.read())) return
    refreshConnectedSources()
  }, POLL_MS)
}

function stop(): void {
  stopBridge?.()
  stopBridge = undefined
  stopVisibility?.()
  stopVisibility = undefined
  onVisibilityChange = undefined
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
  subscribe: listeners.subscribe,
  getVersion(): number {
    return revision
  },
  getSource(sourceId: string): GitSourceState {
    return states.get(sourceId) ?? { sourceId, connected: false, status: 'idle' }
  },
}
