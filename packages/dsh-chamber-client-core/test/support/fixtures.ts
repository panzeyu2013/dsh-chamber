/**
 * Shared fixtures for the client-core PR2 suite (checkout placement / derive /
 * view-prefs / unary rows). Plain data only: the modules under test are pure.
 */
import type { SessionRow, WorkspaceRow } from '../../src/instance-snapshot-rows.ts'
import type { InstanceSnapshot } from '../../src/instance-api.ts'
import type { RepoGitLayout, UnregisteredWorktreeInfo } from '../../src/workspace-git-flags.ts'

/** One session row; cwd/workingDirectory/projection facts are opts. */
export function session(id: string, extra: Partial<SessionRow> = {}): SessionRow {
  return { sessionId: id, running: false, blank: false, ...extra }
}

/** One host workspace row (path defaults to '/<id>'). */
export function workspace(
  workspaceId: string,
  path = `/${workspaceId}`,
  sessionIds: string[] = [],
  extra: Partial<WorkspaceRow> = {},
): WorkspaceRow {
  return {
    workspaceId,
    path,
    title: workspaceId,
    sessionIds,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

/** Snapshot with the mounted-producer pin shape (known empty set). */
export function snapshot(
  workspaces: WorkspaceRow[],
  sessions: SessionRow[],
  extra: Partial<InstanceSnapshot> = {},
): InstanceSnapshot {
  return { workspaces, sessions, archivedSessionIds: [], archiveSetKnown: true, pinnedSessionIds: [], pinSetKnown: true, ...extra }
}

/** One unregistered worktree fact (path/locked required by the PR2 contract). */
export function worktree(
  path: string,
  extra: Partial<UnregisteredWorktreeInfo> = {},
): UnregisteredWorktreeInfo {
  return {
    name: path.split('/').filter(segment => segment !== '').pop() ?? path,
    worktreeId: `wt:${path}`,
    path,
    branch: null,
    status: 'ready',
    headState: 'branch',
    attention: [],
    dirty: false,
    locked: false,
    head: 'deadbeef',
    ...extra,
  }
}

/** One repo layout (main workspace id + its unregistered checkouts). */
export function layout(
  repoKey: string,
  mainWorkspaceId: string | null,
  unregistered: UnregisteredWorktreeInfo[],
): RepoGitLayout {
  return { repoKey, mainWorkspaceId, unregistered }
}
