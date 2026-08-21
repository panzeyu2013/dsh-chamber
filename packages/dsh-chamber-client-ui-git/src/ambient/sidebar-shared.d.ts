/**
 * Narrow typecheck mirror of the sidebar's neutral shared face. Runtime Vite
 * resolves the real module; this path keeps the Git package's standalone
 * program from compiling the whole sibling package under its local ambients.
 */
export interface ChamberServerWorkspace {
  id: string
  title: string
  ungrouped?: boolean
  sessions: { id: string; title: string; running?: boolean; updatedAt?: number; blank?: boolean }[]
}

export interface ChamberServerAggregate {
  id: string
  connected: boolean
  workspaces: ChamberServerWorkspace[]
  runtime?: { current?: string }
}

export const chamberBridge: {
  getServers(): ChamberServerAggregate[]
  subscribe(listener: () => void): () => void
  requestOpenSession(sourceId: string, sessionId: string): void
  requestRefresh(sourceId: string): void
}

export class InstanceRpcError extends Error {
  readonly code: string
  readonly details: unknown
}

export function getInstanceClient(instanceId: string): unknown
export function createWorkspace(client: unknown, path: string): Promise<{ workspaceId: string; path: string; created: boolean }>
export function insertWorkspaceBefore(client: unknown, workspaceId: string, beforeWorkspaceId?: string): Promise<void>
export function renameWorkspace(client: unknown, workspaceId: string, title: string): Promise<void>
export function createSession(client: unknown, workspaceId: string, sessionId?: string): Promise<string>
export function deleteWorkspace(client: unknown, workspaceId: string): Promise<void>
export function archiveSession(client: unknown, sessionId: string): Promise<void>
export interface SessionRow {
  sessionId: string
  parentSessionId?: string
  running: boolean
  blank: boolean
  origin?: 'subagent'
}
export interface InstanceSnapshot {
  workspaces: unknown[]
  sessions: SessionRow[]
  archivedSessionIds: string[]
}
export function fetchInstanceSnapshot(client: unknown): Promise<InstanceSnapshot>
export interface WorkspaceGitFlag {
  isWorktree: boolean
  isMain: boolean
  mainWorkspaceId?: string
  orphaned?: boolean
  repoKey?: string
}
export interface UnregisteredWorktreeInfo {
  name: string
  worktreeId: string
  branch: string | null
  status: 'ready' | 'missing' | 'invalid' | 'not-a-repo'
  headState: 'branch' | 'detached' | 'unborn'
  attention: string[]
  dirty: boolean | null
  head: string
}
export interface RepoGitLayout {
  repoKey: string
  mainWorkspaceId: string | null
  unregistered: UnregisteredWorktreeInfo[]
}
export function setSourceRepoLayouts(sourceId: string, layouts: RepoGitLayout[]): void
export function getSourceRepoLayouts(sourceId: string): RepoGitLayout[]
export function getWorkspaceGitFlagsVersion(): number
export function retainSourceWorkspaceFlags(sourceId: string, keep: ReadonlySet<string>): void
export function setWorkspaceGitFlag(sourceId: string, workspaceId: string, flag: WorkspaceGitFlag | undefined): void
export function clearWorkspaceGitFlags(sourceId: string): void
export function getWorkspaceGitFlag(sourceId: string, workspaceId: string): WorkspaceGitFlag | undefined
export function subscribeWorkspaceGitFlags(listener: () => void): () => void
