/**
 * Page-wide Git worktree coordinator.
 * The chamber composite imports this module once and mounts it in N cordis
 * contexts, so all contexts observe one polling/action state: facts are fetched
 * once per connected source, operations cannot be duplicated by switching
 * shells, and recovery stays visible after a view switch.
 */
import {
  chamberBridge,
  createSessionForSource,
  clearWorkspaceGitFlags, getWorkspaceGitFlag, markSourceGitFlagsLoaded, retainSourceWorkspaceFlags, setSourceRepoLayouts, setWorkspaceGitFlag,
} from '@dsh-chamber/dsh-chamber-client-core'
import { GitActionError, gitActionErrorCode } from './action-error.ts'
import { NOT_DISPATCHED_CODE } from './not-dispatched.ts'
import { GitActionLedger } from './action-ledger.ts'
import { refreshedSince } from './freshness.ts'
import { selectPollWave } from './poll-wave.ts'
import { notDispatchedRetryDelay } from './retry-budget.ts'
import { unregisteredRemoveInput } from './remove-input.ts'
import { SerializedRefreshes } from './refresh-flight.ts'
import {
  GitWorktreeRpcError, gitWorktreeApi, isAgentNotReady, isAmbiguousGitRpcFailure, isDeterministicGitRejection,
} from './git-api.ts'
import { canTargetSession, effectiveSnapshot } from './git-facts.ts'
import { repoLayouts } from './layout.ts'
// Hidden-tab polling gate + injectable visibility face (dependency-free).
import { isPollEligible, visibilityEvents } from './visibility-gate.ts'
import { GitSagaError, recoveryAfterSagaFailure, recoveryForFailure, runCreateSaga, runRemoveSaga } from './saga.ts'
import { createListenerSet, errorMessage as errorText } from '@dsh-chamber/dsh-chamber-client-core'
import type {
  GitBusyState, GitRecovery, GitSourceError, GitSourceState, GitWorktreeSnapshot, PreviewCreateInput, PreviewCreateResult,
  RemoveWorktreeResult,
} from './types.ts'

const POLL_MS = 30_000
const listeners = createListenerSet()
const states = new Map<string, GitSourceState>()
const refreshFlights = new SerializedRefreshes<GitSourceState>()
const actionLedger = new GitActionLedger()
/** Bounded "not dispatched" retries: timer handle + attempts per source. */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const retryAttempts = new Map<string, number>()

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
  for (const repo of snapshot.repos) {
    const mainWorkspaceId = repo.worktrees.find(worktree => worktree.isMain)?.workspaceId ?? null
    for (const worktree of repo.worktrees) {
      // The layout projection owns the unregistered non-main checkouts (and the
      // MAIN checkout's unregistered state via mainWorkspaceId:null — I9).
      if (worktree.workspaceId === null) continue
      setWorkspaceGitFlag(sourceId, worktree.workspaceId, {
        isWorktree: !worktree.isMain,
        isMain: worktree.isMain,
        repoKey: repo.repoId,
        ...(!worktree.isMain && mainWorkspaceId !== null ? { mainWorkspaceId } : {}),
      })
      keep.add(worktree.workspaceId)
    }
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
  // The repository layout is the derived checkout rows' ONLY fact source: publish
  // it with the placement keys (path) and the removal guard's locked fact on every
  // round, including the empty one (a repository that disappeared clears its rows).
  setSourceRepoLayouts(sourceId, repoLayouts(snapshot))
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
        lastWorkspaceKeys.set(server.id, workspaceKeyOf(server))
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

/** One bounded retry chain per source for a page-budget refusal. The chain is
 *  tracked so detach() can clear it, and it stops after the budget (the 30s tick
 *  keeps covering the source afterwards). */
function scheduleNotDispatchedRetry(sourceId: string): void {
  // Detached coordinator: a refusal arriving after stop() must not resurrect a
  // retry chain (and the zombie state it would refresh).
  if (retainCount === 0) return
  if (retryTimers.has(sourceId)) return
  const attempt = retryAttempts.get(sourceId) ?? 0
  const delayMs = notDispatchedRetryDelay(attempt)
  if (delayMs === null) return
  retryAttempts.set(sourceId, attempt + 1)
  const timer = setTimeout(() => {
    retryTimers.delete(sourceId)
    void refreshSource(sourceId)
  }, delayMs)
  retryTimers.set(sourceId, timer)
}

/** A pull that STARTED makes any pending retry redundant. */
function clearNotDispatchedRetry(sourceId: string): void {
  const timer = retryTimers.get(sourceId)
  if (timer !== undefined) {
    clearTimeout(timer)
    retryTimers.delete(sourceId)
  }
}

async function beginRefresh(sourceId: string): Promise<GitSourceState> {
  clearNotDispatchedRetry(sourceId)
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
    // A deadline-stale snapshot must not clear the still-valid previous flags
    // (badges/drag boundaries would vanish) — publish the EFFECTIVE snapshot, which
    // still merges this round's FRESH path errors: a workspace whose path just
    // vanished must keep its orphan projection (see effectiveSnapshot).
    const effective = effectiveSnapshot(previous, snapshot)
    publishWorkspaceGitFlags(sourceId, effective, previous)
    // A completed pull spends the retry budget: the next refusal starts over.
    retryAttempts.delete(sourceId)
    return patchSource(sourceId, {
      connected: true,
      status: snapshot.sourceError === undefined ? 'ready' : 'error',
      snapshot: effective,
      sourceError: snapshot.sourceError,
      updatedAt: Date.now(),
    })
  } catch (error) {
    if ((sourceEpochs.get(sourceId) ?? 0) !== epoch || !connectedSource(sourceId)) {
      return states.get(sourceId) ?? { sourceId, connected: false, status: 'idle' }
    }
    // Page-local dispatch refusal: keep the last snapshot, retry shortly, and never
    // mark the source as failed (design 08: not-dispatched is deterministic).
    if (error instanceof GitWorktreeRpcError && error.code === NOT_DISPATCHED_CODE) {
      const current = states.get(sourceId)
      scheduleNotDispatchedRetry(sourceId)
      // No timestamp on the synthesized state: a deferred pull produced no facts,
      // and an action preflight reads updatedAt as the proof that it did.
      return current ?? { sourceId, connected: true, status: 'loading' }
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
    patchSource(sourceId, { busy, actionError: undefined, actionErrorCode: undefined, notice: undefined })
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

/** One bounded enter retry (P0-1): the agent may not exist the instant
 *  `session.create` returns. `agent-not-ready` is the host's explicit retryable
 *  refusal, so one retry after the open intent is enough; every other failure is
 *  final. */
const ENTER_READY_RETRY_MS = 500

async function enterCheckout(sourceId: string, sessionId: string, path: string): Promise<void> {
  try {
    await gitWorktreeApi.enter(sourceId, { sessionId, path })
  } catch (error) {
    if (!isAgentNotReady(error)) throw error
    await new Promise(resolve => setTimeout(resolve, ENTER_READY_RETRY_MS))
    await gitWorktreeApi.enter(sourceId, { sessionId, path })
  }
}

/** PR1 create boundary: host create + refresh ONLY. The checkout is not a
 *  workspace and no session is committed (session creation is createSessionHere).
 *  An ambiguous host answer keeps the preview/operation recovery for one same-id
 *  replay; nothing else is compensated. */
async function performCreateSaga(
  sourceId: string,
  preview: PreviewCreateResult,
  operationId: string,
  previousRecovery?: Extract<GitRecovery, { kind: 'git-create' }>,
): Promise<string> {
  try {
    const created = await runCreateSaga({
      hostCreate: input => gitWorktreeApi.create(sourceId, input, preview),
      isAmbiguousHostFailure: isAmbiguousGitRpcFailure,
    }, preview, { operationId })
    setRecovery(sourceId, undefined)
    finishMutation(sourceId)
    return created.path
  } catch (error) {
    if (error instanceof GitSagaError) {
      setRecovery(sourceId, recoveryForFailure(error, previousRecovery))
      if (error.refreshNeeded || previousRecovery !== undefined) finishMutation(sourceId)
    }
    throw error
  }
}

/** Execute the create saga: preview -> create -> refresh. Never opens a session. */
export async function createFromPreview(
  sourceId: string,
  preview: PreviewCreateResult,
): Promise<string> {
  const operationId = nextId('create')
  return runBusy(sourceId, { kind: 'create', operationId }, () => (
    performCreateSaga(sourceId, preview, operationId)
  ))
}

/**
 * Create a session in an EXISTING checkout (no Git mutation, no workspace
 * registration): commit a session in the repository's SOURCE workspace, then
 * move its working directory into `path` with the single chamber `enter` write.
 * The host's `agent-not-ready` refusal is retried once after the open intent;
 * every other refusal surfaces as-is (the session stays in the source root).
 */
export async function createSessionHere(sourceId: string, path: string): Promise<string> {
  const operationId = nextId('session-enter')
  const sessionId = nextId('session')
  return runBusy(sourceId, { kind: 'session-enter', operationId }, async () => {
    const refreshStartedAt = Date.now()
    const fresh = await refreshSource(sourceId, true)
    if (fresh.snapshot === undefined || fresh.sourceError !== undefined) {
      throw new GitActionError('fresh-facts-unavailable', 'The latest Git worktree facts are unavailable', fresh.sourceError)
    }
    // A page-dispatch-budget refusal RESOLVES with the previous state (the polling
    // path's deliberate behaviour, coordinator beginRefresh) instead of rejecting.
    // An action must not accept that old state as fresh facts (design 08/26 §D7).
    if (!refreshedSince(fresh, refreshStartedAt)) {
      throw new GitActionError('fresh-facts-unavailable', 'The latest Git worktree facts are unavailable')
    }
    const repo = fresh.snapshot.repos.find(candidate => candidate.worktrees.some(worktree => worktree.path === path))
    const known = repo?.worktrees.find(worktree => worktree.path === path)
    if (repo === undefined || known === undefined) {
      throw new GitActionError('worktree-not-found', 'The target worktree is not in the current source topology')
    }
    // Re-check health against the FRESH snapshot: never target a vanished/unhealthy path.
    if (!canTargetSession(known)) throw new GitActionError('unhealthy-target', 'The target worktree is unhealthy and cannot host a session')
    // The session root is the SOURCE workspace (I1): an unregistered main checkout
    // has no source workspace, so this repo offers no session entry (I9).
    const mainWorkspaceId = repo.worktrees.find(worktree => worktree.isMain)?.workspaceId ?? null
    if (mainWorkspaceId === null) {
      throw new GitActionError('source-workspace-missing', 'The repository main checkout is not a registered workspace')
    }
    let created: string | undefined
    try {
      created = await createSessionForSource(sourceId, mainWorkspaceId, { sessionId, origin: 'user', workingDirectory: path })
      if (created !== sessionId) throw new Error('session.create returned a different preallocated session id')
      // Opening is a one-way UI intent: request it BEFORE enter so the agent starts
      // loading while the working directory moves (design 08 PR1 order).
      requestOpenSession(sourceId, created)
      await enterCheckout(sourceId, created, path)
      finishMutation(sourceId)
      return created
    } catch (error) {
      // A committed session still needs the aggregate refresh. The create echo may
      // briefly place it in the checkout; the next authoritative refresh moves it
      // back to the source row when enter refused.
      if (created !== undefined) {
        // The placement intent will never land: void it BEFORE the refresh, so the
        // projection stops holding the row in the checkout and follows the host cwd
        // at once instead of parking it there until the echo's TTL (design 08 §4.2).
        chamberBridge.reportSessionPlacementFailed({ sourceId, sessionId: created })
        finishMutation(sourceId)
      }
      throw error
    }
  })
}

type RemoveRecoveryInput = Omit<Extract<GitRecovery, { kind: 'git-remove' }>, 'kind' | 'message'>

/** Replay one path-based removal. The host input is byte-identical to the
 *  original (the host fingerprints the whole input — a path-less replay mismatch
 *  would wedge recovery), and the saga never touches a workspace registry row. */
async function performRemoveSaga(
  sourceId: string,
  request: RemoveRecoveryInput,
  previousRecovery?: Extract<GitRecovery, { kind: 'git-remove' }>,
): Promise<void> {
  const discardChanges = request.discardChanges === true ? { discardChanges: true } : {}
  try {
    await runRemoveSaga({
      hostRemove: () => gitWorktreeApi.remove(sourceId, {
        operationId: request.operationId,
        path: request.path,
        expected: request.expected,
        ...(request.deleteBranch === undefined ? {} : { deleteBranch: request.deleteBranch }),
        ...discardChanges,
      }, request.path),
      ambiguousRecovery: error => isAmbiguousGitRpcFailure(error) && !isDeterministicGitRejection(error)
        ? { kind: 'git-remove', ...request, message: errorText(error) }
        : undefined,
    })
    setRecovery(sourceId, undefined)
    finishMutation(sourceId)
  } catch (error) {
    if (error instanceof GitSagaError) {
      // A host-PROVEN pre-mutation refusal (original serialized with
      // retryable: false — the target still exists) resolves a pending replay as
      // "not removed": clear the entry instead of retrying a doomed operationId.
      setRecovery(sourceId, recoveryAfterSagaFailure(error, previousRecovery))
      if (error.refreshNeeded || previousRecovery !== undefined) finishMutation(sourceId)
    }
    throw error
  }
}

/** Remove an UNREGISTERED checkout: git-first via the host's path-based variant,
 *  no workspace.delete, no archive step. A dirty worktree requires the row's
 *  explicit discard acknowledgement, which arrives here as `discardChanges: true`
 *  (build with `unregisteredRemoveInput`). */
export async function removeUnregisteredWorktree(
  sourceId: string,
  target: { repoId: string; worktreeId: string; path: string; branch: string | null; head: string },
  options: { deleteBranch?: string; discardChanges?: boolean } = {},
): Promise<RemoveWorktreeResult> {
  const operationId = nextId('remove')
  return runBusy(sourceId, { kind: 'remove', operationId }, async () => {
    // Fresh refresh first: the row identity may be up to 30s stale. Inside the busy
    // lease so a second click cannot spend another forced pull.
    const refreshStartedAt = Date.now()
    const fresh = await refreshSource(sourceId, true)
    if (fresh.sourceError !== undefined) {
      throw new GitActionError('fresh-facts-unavailable', 'The latest Git worktree facts are unavailable', fresh.sourceError)
    }
    // The pull may have resolved WITHOUT producing facts (page-budget refusal keeps
    // the previous state); the row identity below must not run on those.
    if (!refreshedSince(fresh, refreshStartedAt)) {
      throw new GitActionError('fresh-facts-unavailable', 'The latest Git worktree facts are unavailable')
    }
    // The host input (identity + the explicit discard/delete authorizations) is the
    // one shared builder, so the unregistered path cannot drift from the wire shape.
    const input = unregisteredRemoveInput(operationId, target, options)
    let result: RemoveWorktreeResult
    try {
      result = await runRemoveSaga({
        hostRemove: () => gitWorktreeApi.remove(sourceId, input, target.path),
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
    return result
  })
}

export async function retryRecovery(sourceId: string): Promise<void> {
  const recovery = states.get(sourceId)?.recovery
  if (recovery === undefined) return
  const busyId = nextId('recovery')
  return runBusy(sourceId, { kind: 'recovery', operationId: busyId }, async () => {
    if (recovery.kind === 'git-create') {
      // Same preview + operation id: the host create is idempotent per operation.
      await performCreateSaga(sourceId, recovery.preview, recovery.operationId, recovery)
      return
    }
    // recovery.kind === 'git-remove' (the only kind left after the create branch).
    await performRemoveSaga(sourceId, recovery, recovery)
  })
}

export function clearActionError(sourceId: string): void {
  const current = states.get(sourceId)
  if (current?.actionError !== undefined || current?.actionErrorCode !== undefined || current?.notice !== undefined) {
    patchSource(sourceId, { actionError: undefined, actionErrorCode: undefined, notice: undefined })
  }
}

/** Report a partial success the source strip must state: the worktree removal
 *  committed, but the optional local-branch deletion failed. The dialog's row
 *  unmounts with the checkout, so the notice rides the source state instead. */
export function reportBranchDeleteFailure(sourceId: string, message: string): void {
  patchSource(sourceId, { notice: message })
}

/** Per-poll wave: the 30s tick refreshes at most this many connected sources,
 *  rotating through the roster, so a wide fleet cannot fan out one unary per
 *  source against the shared same-origin pool (design 26 §D7). Existing pulls
 *  are still joined per source. */
const GIT_POLL_WAVE = 2
/** Visible-edge wave: wider than a tick, still far below the full fleet. */
const GIT_VISIBILITY_WAVE = 4
let pollCursor = 0

/** Refresh connected, action-idle sources in a bounded rotating wave; existing pulls are joined.
 *  `leading` (the active source) goes first when eligible — waking the page is about the source
 *  the user is looking at — and does not advance the rotation cursor. */
function refreshWave(cap: number, leading?: string): void {
  const eligible: string[] = []
  for (const server of chamberBridge.getServers()) {
    if (server.connected && states.get(server.id)?.busy === undefined) eligible.push(server.id)
  }
  if (eligible.length === 0) return
  let wave: readonly string[]
  if (leading !== undefined && eligible.includes(leading)) {
    const rest = eligible.filter(sourceId => sourceId !== leading)
    wave = [leading, ...selectPollWave(rest, 0, Math.max(0, cap - 1)).wave]
  } else {
    const plan = selectPollWave(eligible, pollCursor, cap)
    pollCursor = plan.cursor
    wave = plan.wave
  }
  for (const sourceId of wave) void refreshSource(sourceId)
}

function refreshConnectedSources(): void {
  refreshWave(GIT_POLL_WAVE)
}

function start(): void {
  stopBridge = chamberBridge.subscribe(syncServers)
  syncServers()
  // Hidden-tab polling gate: the timer keeps running but skips while hidden, and
  // becoming visible re-syncs the roster AND starts the next (wave-capped) refresh.
  onVisibilityChange = () => {
    if (visibilityEvents.read() !== 'visible') return
    syncServers()
    // Waking the page refreshes more than one beat's worth (the user expects the
    // source on screen to be current) but still not the whole fleet: the visible
    // edge takes a wider wave, active source first (design 08 §5).
    refreshWave(GIT_VISIBILITY_WAVE, chamberBridge.getActiveSource())
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
  for (const timer of retryTimers.values()) clearTimeout(timer)
  retryTimers.clear()
  retryAttempts.clear()
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
