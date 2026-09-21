/**
 * Page-wide Git worktree coordinator.
 *
 * The chamber composite imports this module once and mounts the plugin in N
 * cordis contexts. All contexts therefore observe one polling/action state:
 * facts are fetched once per connected source, operations cannot be duplicated
 * by switching shells, and recovery remains visible after a view switch.
 */
import {
  chamberBridge,
  createSessionForSource, archiveSessionForSource,
  createWorkspaceForSource, deleteWorkspaceForSource, renameWorkspaceForSource,
  insertWorkspaceBefore,
  clearWorkspaceGitFlags, getSourceRepoLayouts, getWorkspaceGitFlag, markSourceGitFlagsLoaded, retainSourceWorkspaceFlags, setSourceRepoLayouts, setWorkspaceGitFlag,
  fetchInstanceSnapshot, getInstanceClient, InstanceRpcError,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import { GitActionError, gitActionErrorCode } from './action-error.ts'
import { GitActionLedger } from './action-ledger.ts'
import { SerializedRefreshes } from './refresh-flight.ts'
import { GitWorktreeRpcError, gitWorktreeApi, isAmbiguousGitRpcFailure, isDeterministicGitRejection } from './git-api.ts'
import { canTargetSession, findWorktree, removeBlockReason } from './git-facts.ts'
// Hidden-tab polling gate + injectable visibility face (P1, 2026-11) — the
// module is dependency-free so the node suite covers it (see
// test/shared/visibility-gate.test.ts).
import { isPollEligible, visibilityEvents } from './visibility-gate.ts'
import {
  GitSagaError, isProvenPreMutationRefusal, recoveryForFailure, runAdoptSessionSaga, runCreateSaga, runPreRemoveArchive,
  runRemoveSaga, runRollbackRecovery, runWorkspaceAdoptRecovery, runWorkspaceDeleteRecovery,
} from './saga.ts'
import type { WorkspaceCreationPlacement } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import type {
  GitBusyState, GitRecovery, GitSourceError, GitSourceState, GitWorktreeInfo, GitWorktreeSnapshot, PreviewCreateInput, PreviewCreateResult, RemoveWorktreeResult, UnregisteredWorktreeInfo,
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

/** Publish per-workspace git flags to the sidebar's neutral registry
 *  (design 08 §3.2): which workspaces are worktrees / the main checkout.
 *  Workspaces with no git association get their flag cleared. */
function pathBasename(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

function publishWorkspaceGitFlags(
  sourceId: string,
  snapshot: GitWorktreeSnapshot,
  previous?: GitWorktreeSnapshot,
): void {
  // Refresh per snapshot WITHOUT a leading full clear: the worktree flags are
  // re-set, the orphan markers MERGE onto the previous identity (an
  // externally-deleted worktree leaves its workspace orphaned but still a
  // worktree — branch glyph + "已消失" badge, review 2026-08), then the
  // truly-stale flags are pruned by the keep set.
  const keep = new Set<string>()
  const layouts: Array<{ repoKey: string; mainWorkspaceId: string | null; unregistered: UnregisteredWorktreeInfo[] }> = []
  for (const repo of snapshot.repos) {
    const mainWorkspaceId = repo.worktrees.find(worktree => worktree.isMain)?.workspaceId ?? null
    const unregistered: UnregisteredWorktreeInfo[] = []
    for (const worktree of repo.worktrees) {
      if (worktree.workspaceId === null) {
        // The MAIN checkout is never an unregistered worktree — it may
        // simply have no dsh workspace of its own (user report 2026-08).
        if (worktree.isMain) continue
        unregistered.push({
          name: pathBasename(worktree.path) || worktree.path,
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
  // Orphaned workspaces: inside a repository whose path no longer exists
  // (externally deleted worktree left a registration) — surfaced by the
  // snapshot's discovery failures. MERGE onto the PREVIOUS flag (which
  // survived — no leading clear): the orphan keeps its worktree identity
  // (branch glyph / no kebab / git title) + the "已消失" badge.
  // NOTE (2026-08): the host reports a missing path as 'path-unavailable'
  // (a GitWorktreeError code); 'workspace-path-failed' is only the fallback
  // for NON-GitWorktreeError failures. Both must mark the workspace orphaned.
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
  // Repo-level failure inheritance (cross-review P2-2): when a repository's
  // worktree listing fails/absents this round, its worktree workspaces would
  // be pruned by the keep set (branch glyphs / delete buttons flicker away).
  // Inherit the PREVIOUS snapshot's associations for repos missing now — the
  // flags survive until a good snapshot re-publishes them.
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
  // 2026-10 review (design 06 §2.4): the snapshot (even an empty one) is
  // the source's identity resolution — the sidebar gates the workspace
  // accent on this so a git workspace never first renders an independent
  // hue that later flips to its family hue (one-time startup flash).
  markSourceGitFlagsLoaded(sourceId)
}

function connectedSource(sourceId: string): boolean {
  return chamberBridge.getServers().some(server => server.id === sourceId && server.connected)
}

/** Last-seen workspace id sets per source (design 08 §3.1): a workspace added
 *  or removed without a connection change (e.g. the sidebar's add-workspace,
 *  an adopt, or an external change) must trigger a git refresh immediately —
 *  otherwise the new workspace's git line waits for the 30s poll. */
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
          // A connected source whose workspace set changed: refresh now so the
          // git line for a new workspace appears without waiting for the poll.
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
    // An empty deadline result (snapshot-deadline) must never erase the last
    // complete facts: keep the previous valid snapshot visibly stale beside
    // the explicit error (AGENTS: one failed entity must not erase unrelated
    // complete entities). A PARTIAL result (repos present) replaces the old
    // one — fresh progress beats stale truth.
    const previous = states.get(sourceId)?.snapshot
    const staleEmpty = snapshot.sourceError !== undefined && snapshot.repos.length === 0 && previous !== undefined
    // A deadline-stale snapshot must not clear the flags of the still-valid
    // previous snapshot (drag boundaries / badges would vanish for up to 30s
    // while the state keeps the old snapshot) — publish the EFFECTIVE one
    // (review P2-4).
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
 * 此刻该行必须已经是 worktree 形态（分支图标 / 无 kebab / 删除动作），同一路径
 * 也不能还挂着一条"未注册工作树"行。两个 store 的写入都早于那次派生，因此不再
 * 依赖"两个 React 更新落在同一批次"这种调度层假设。
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

/** Best-effort post-adopt placement/identity (review 2026-08):
 *  - `workspace.insertBefore` moves the new workspace right after its main
 *    checkout (the registry PREPENDS by default, leaving the worktree
 *    stranded at the list head — "not associated with the original
 *    workspace");
 *  - the title derives from the branch (the directory basename can equal
 *    the main checkout's name).
 *  Flag + repo layout are NOT here any more: they ride the create funnel's
 *  `beforePublish` (see decorateWorktreeWorkspace), so the adopted row's first
 *  projected frame is already the real worktree row and the unregistered row is
 *  gone in the same derive pass.
 */
/** The workspace that currently follows `mainWorkspaceId` in the rendered
 *  order — the `insertWorkspaceBefore` anchor that lands a new/adopted
 *  worktree IMMEDIATELY BELOW its main checkout. `insertBefore` inserts
 *  BEFORE its anchor (DOM-like), so anchoring on the main itself would land
 *  the worktree ABOVE it; the correct anchor is the workspace AFTER the main
 *  (or undefined = append-to-end when the main is last). The order is read
 *  from the projection BEFORE the post-create refresh, i.e. the pre-create
 *  wire order, which is exactly the "who follows the main" fact we need. */
function workspaceAfterMain(sourceId: string, mainWorkspaceId: string | undefined): string | undefined {
  if (mainWorkspaceId === undefined) return undefined
  const order = chamberBridge.getServers().find(server => server.id === sourceId)
    ?.workspaces.filter(workspace => workspace.ungrouped !== true).map(workspace => workspace.id) ?? []
  const mainIndex = order.indexOf(mainWorkspaceId)
  return mainIndex !== -1 && mainIndex + 1 < order.length ? order[mainIndex + 1] : undefined
}

async function positionAdoptedWorkspace(
  sourceId: string,
  result: { workspaceId: string; path: string },
  mainWorkspaceId: string | undefined,
  branch: string | null,
): Promise<void> {
  // AWAITED (not fire-and-forget): the registry order must be correct BEFORE
  // the caller refreshes, so the adopted worktree does not first render at the
  // prepended head and only later jump below its main checkout.
  try {
    await insertWorkspaceBefore(
      getInstanceClient(sourceId),
      result.workspaceId,
      workspaceAfterMain(sourceId, mainWorkspaceId),
    )
  } catch (error) {
    console.error('[dsh-chamber] Git adopt workspace reposition failed (best-effort):', error)
  }
  if (branch === null) return
  // AWAITED (best-effort) too: the workspace title must be in place before the
  // caller's refresh, same as the order — otherwise the adopted row can
  // briefly show the stale directory-name title before it flips to the branch
  // name.
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
      // 2026-12（design 05 §2.2.1 第二入口）：workspace.create 必须走唯一出口，
      // 否则这个 0 会话的工作区行在未挂载来源上没有任何读通道，只能等用户点开
      // 那个服务器。位置锚点 = 本次创建的主 checkout（宿主上新 worktree 就摆在
      // 它后面）；worktree flag 走 beforePublish——**事实发布之前**写好，因为 App
      // 一收到事实就重派生投影，git 快照要等一次 RPC（见 decorateWorktreeWorkspace）。
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
    // Position the new worktree IMMEDIATELY BELOW its source (main) checkout
    // — the wire PREPENDS new workspaces to the registry head, and
    // `insertBefore` anchors on the workspace that must FOLLOW the moved id,
    // so the anchor is the workspace after the main (never the main itself).
    // AWAITED so the registry order is correct before the refresh below;
    // best-effort (a reposition failure never rolls back the committed worktree).
    if (sourceWorkspaceId !== undefined) {
      try {
        await insertWorkspaceBefore(getInstanceClient(sourceId), result.workspaceId, workspaceAfterMain(sourceId, sourceWorkspaceId))
      } catch (error) {
        console.error('[dsh-chamber] Git create workspace reposition failed (best-effort):', error)
      }
    }
    finishMutation(sourceId)
    // Opening is a one-way UI intent tied to a committed session — never when
    // the create was session-less (the empty workspace just appeared).
    if (commitSession) requestOpenSession(sourceId, result.sessionId)
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

/** adopt 的宿主事实：位置锚点（`path` 所属仓库主 checkout 自己的 workspace id，
 *  宿主把它摆在主 checkout 之后）+ 乐观装饰所需的仓库身份。仓库/主行未知时锚点
 *  为空对象 = 回声行按原行为追加到尾部（不丢行）。 */
interface AdoptPlacement {
  placement: WorkspaceCreationPlacement
  repoKey?: string
  mainWorkspaceId?: string
}

function adoptPlacementOf(snapshot: GitWorktreeSnapshot, path: string): AdoptPlacement {
  const repo = snapshot.repos.find(candidate => candidate.worktrees.some(worktree => worktree.path === path))
  const mainWorkspaceId = repo?.worktrees.find(worktree => worktree.isMain)?.workspaceId ?? undefined
  return {
    placement: mainWorkspaceId === undefined ? {} : { afterWorkspaceId: mainWorkspaceId },
    ...(repo === undefined ? {} : { repoKey: repo.repoId }),
    ...(mainWorkspaceId === undefined ? {} : { mainWorkspaceId }),
  }
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
      throw new GitActionError('fresh-facts-unavailable', 'The latest Git worktree facts are unavailable', fresh.sourceError)
    }
    // 锚点与装饰事实在这里（守卫之后、闭包之外）解析：`fresh.snapshot` 的窄化
    // 不会跨进下面的回调（属性访问在闭包内重新放宽为 `| undefined`）。
    const adopt = adoptPlacementOf(fresh.snapshot, path)
    const known = fresh.snapshot.repos.flatMap(repo => repo.worktrees).find(worktree => worktree.path === path)
    if (known === undefined) throw new GitActionError('worktree-not-found', 'The target worktree is not in the current source topology')
    // Re-check health against the FRESH snapshot: the UI button reflects an
    // older snapshot, and a session must never target a vanished/unhealthy path.
    if (!canTargetSession(known)) throw new GitActionError('unhealthy-target', 'The target worktree is unhealthy and cannot host a session')
    try {
      const result = await runAdoptSessionSaga({
        workspaceCreate: targetPath => createWorkspaceForSource(sourceId, targetPath, {
          ...adopt.placement,
          // adopt 随后会把宿主标题改成分支名（positionAdoptedWorkspace）：标题
          // 作为创作意图随事实一起带上，否则回声行先用路径 basename 出生、几个
          // RPC 之后才翻转。branch 为 null 时留给路径 basename 规则。
          ...(known.branch === null ? {} : { title: known.branch }),
          // adopt 的目标可能是未注册工作树：回声行与"未注册"行必须在同一次投影里
          // 换手，且行首帧就是 worktree 形态——flag/layout 因此随事实同一续体发布。
          // 主 checkout 例外：adopt 主行注册/复用的就是主行本身，写 isWorktree:true
          // 会把它临时渲染成派生行（分支图标、无 kebab、带删除动作）——那是一条
          // 既有缺陷，这里顺手挡掉。
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
      // Position + identity (review 2026-08): the wire PREPENDS new
      // workspaces (registry order head) — the adopted worktree must sit
      // right AFTER its main checkout, and its title should be the branch
      // (the directory basename can equal the main's name). Both are
      // best-effort: a failure never rolls back the committed workspace.
      // AWAITED so the refresh below reads the corrected registry order.
      await positionAdoptedWorkspace(sourceId, result, adopt.mainWorkspaceId, known.branch)
      finishMutation(sourceId)
      requestOpenSession(sourceId, result.sessionId)
      return result.sessionId
    } catch (error) {
      if (error instanceof GitSagaError) {
        setRecovery(sourceId, recoveryForFailure(error))
        // An ambiguous adopt left workspace/session facts the aggregate must
        // re-read; mirror the create path's refresh discipline.
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
        // UNREGISTERED removal: the input itself must carry the path (the
        // host fingerprints the whole input — a path-less replay mismatch
        // would permanently wedge recovery, review P1-2).
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
      // retryable: false — the host re-checked the topology and the target
      // still exists: git removed nothing, core.ts commitBoundRemove)
      // resolves a pending git-remove recovery replaying THIS same removal
      // as "not removed": clear the recovery instead of preserving an
      // endless same-reason retry with no dismiss (design 08 §6.2 bounded
      // exception, 2026-09 submodule report). Every genuinely ambiguous
      // failure and every saga-minted recovery keep their semantics.
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

/** Marker for the in-dialog dirty dead-end (review 2026-08 P2-1): the dialog
 *  shows the discard checkbox from its (possibly stale) row dirty fact; if
 *  the FRESH preflight snapshot discovers dirty after the dialog opened
 *  clean, the dialog must force-show the checkbox instead of leaving the
 *  user with a bare error and no way forward. */
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
    // NO IMPLICIT SESSION TOUCHING (2026-09 user decision, design 08 §5.2
    // amendment): a worktree removal never stops, cancels, or deletes a
    // session, and never archives one UNLESS the user opted in — the
    // 「归档工作区中会话」 checkbox is explicit, default-OFF, and drives the
    // pre-remove archive pass below (runPreRemoveArchive).
    // What blocks is decided by the HOST's archived-aware running fact
    // (`blockingRunningSessionIds`): a running session that is archived — or
    // whose ancestor is — is INERT and no longer blocks. `removeBlockReason`
    // reads that field and falls back to `runningSessionIds` on an older host
    // (conservative). The `current` hard block and the `runtime-unknown`
    // fail-closed block are NOT running guards and stay in force (removing the
    // cwd of the session being viewed would break its subsequent tool calls).
    // removeBlockReason evaluates BOTH before the running reason (review
    // G1-1), so a stale or archived-only running fact cannot bypass them —
    // this fresh preflight is the last client-side gate before the host's own
    // `running-agent` re-check.
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
    // Dirty is NOT an automatic throw here: the dialog collects an explicit
    // user checkbox (discardChanges) authorizing the host to force-remove —
    // the worktree's uncommitted files are discarded, the branch is kept
    // (design 08 §5.3 amendment 2026-08). The typed marker lets the dialog
    // force-show the checkbox even when its row fact was stale-clean.
    if (blocked === 'dirty' && options.discardChanges !== true) {
      throw new WorktreeDirtyError()
    }
    if (blocked === 'status-unknown') throw new GitActionError('worktree-status-unknown', 'The worktree cleanliness is unknown')
    const workspaceId = worktree.workspaceId
    // Internal invariant (no user fix exists, so no localized copy): English
    // message is the honest unmapped fallback.
    if (workspaceId === null) throw new Error('The worktree row has no workspace id')

    // Optional soft-archive of the whole session tree BEFORE any Git mutation.
    // A failure aborts with nothing removed; the closure enumerates direct
    // workspace members plus every session transitively parented under them
    // (already-archived ids are skipped, so a retry after a partial failure
    // never re-archives).
    const directSessionIds = worktree.sessionIds
    if (options.archiveSessions === true && directSessionIds.length > 0) {
      try {
        await runPreRemoveArchive({
          fetchSessions: async () => {
            const snapshot = await fetchInstanceSnapshot(getInstanceClient(sourceId))
            return { sessions: snapshot.sessions, archivedSessionIds: snapshot.archivedSessionIds }
          },
          archiveSession: sessionId => archiveSessionForSource(sourceId, sessionId),
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

/** Remove an UNREGISTERED worktree (no dsh workspace — Plan A): git-first
 *  removal via the host's path-based variant, no workspace.delete, no
 *  archive step (there are no sessions). NOTE: the unregistered row's delete
 *  button stays hard-disabled for dirty worktrees (no discard checkbox in
 *  its window.confirm flow — review 2026-08 P2-2); the host-side
 *  `discardChanges` path exists but is not wired from this UI yet. */
export async function removeUnregisteredWorktree(
  sourceId: string,
  target: { repoId: string; worktreeId: string; path: string; branch: string | null; head: string },
  options: { deleteBranch?: string } = {},
): Promise<void> {
  const operationId = nextId('remove')
  // Fresh refresh first (P2-3): the row identity may be up to 30s stale —
  // an expected-mismatch on a stale snapshot would needlessly fail.
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
      // Ambiguous failures must become a durable git-remove recovery (the
      // host may have committed the removal) — never a one-shot actionError
      // that would force a fresh operationId next time (review P1-3).
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
          // recovery 路径随后会 requestOpenSession（切到该来源 ⇒ 挂载 ⇒ follow
          // 基线），锚点收益有限，这里只保证事实不漏发。
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
        // I10 归因：恢复路径仍属用户发起的 worktree saga（不是 boot 交接）。
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
  // Hidden-tab polling gate (design 08 §3.1): a backgrounded page must not keep
  // refreshing every 30s — the timer keeps running but skips while hidden, and
  // becoming visible re-syncs the roster AND immediately refreshes every
  // connected source (not only sources whose workspace key changed).
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
