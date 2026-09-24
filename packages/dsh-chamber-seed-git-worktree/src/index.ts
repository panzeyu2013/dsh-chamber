/**
 * Per-instance Git worktree host gateway.
 *
 * TRUST MODEL - reads the host's authoritative `workspaceRegistry` and live `agents`;
 * the browser receives projections and submits lifecycle intent only. It never supplies
 * Git argv and cannot route an operation to another host. Display paths are not
 * capabilities: every mutation starts from `workspaceId`, re-reads host state and Git
 * topology, then compares opaque repo/worktree identities plus expected branch and HEAD.
 *
 * Wire namespace is fixed at `gitWorktree/{snapshot,previewCreate,create,rollbackCreate,remove}`.
 * This plugin owns no persistence: create returns before workspace/session creation so the
 * client can compensate; remove is Git-first and returns the still-registered workspace
 * identity. All methods return an explicit `{ok,value}|{ok:false,error}` carrier.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  GitWorktreeCore,
  domainResult,
  type CreateInput,
  type CreateResult,
  type PreviewCreateInput,
  type PreviewCreateResult,
  type RemoveInput,
  type RemoveResult,
  type RollbackCreateInput,
  type RollbackCreateResult,
  type SnapshotResult,
  type GitWorktreeDomainResult,
} from './core.ts'

// Keep this gateway's compilation boundary narrow; runtime ownership is enforced by
// static injection. These structural views avoid dragging every transitive host package in.
interface GitWorktreeHostContext extends Context {
  readonly workspaceRegistry: {
    list(): ReadonlyArray<{
      readonly id: unknown
      readonly path: string
      readonly sessionIds: readonly unknown[]
    }>
    /** Authoritative archived-session set: an archived running session is INERT and must
     *  not block a worktree removal. A missing surface throws, never reads as empty. */
    readonly archivedSessionIds: readonly unknown[]
  }
  readonly agents: {
    list(): ReadonlyArray<{
      readonly id: unknown
      readonly status: 'idle' | 'running'
      readonly session: {
        readonly header: {
          readonly cwd?: string
          /** Recorded parent: FORK lineage when `origin` is absent, delegation when `'subagent'`. */
          readonly parentSession?: unknown
          /** Coarse durable child origin. `'subagent'` = delegation child; absent = fork
           *  edge. The core's source intake re-validates any other value loudly. */
          readonly origin?: 'subagent'
        }
      }
    }>
  }
}

/** Remote-only facade; all validation, serialization and Git policy live in the pure core. */
export class GitWorktreeGateway extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'agents']

  private readonly core: GitWorktreeCore

  constructor(ctx: Context) {
    super(ctx, 'gitWorktree')
    const host = ctx as GitWorktreeHostContext
    this.core = new GitWorktreeCore({
      source: {
        listWorkspaces: () => host.workspaceRegistry.list().map(workspace => ({
          workspaceId: String(workspace.id),
          path: workspace.path,
          sessionIds: workspace.sessionIds.map(String),
        })),
        // Agent-registry membership is live state; `origin` rides along for EVERY agent
        // because only `origin === 'subagent'` edges are lineage for the running guard.
        listAgents: () => host.agents.list().map(agent => ({
          sessionId: String(agent.id),
          status: agent.status,
          ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
          ...(agent.session.header.parentSession === undefined
            ? {}
            : { parentSessionId: String(agent.session.header.parentSession) }),
          ...(agent.session.header.origin === undefined
            ? {}
            : { origin: agent.session.header.origin }),
        })),
        // Authoritative archived set: a malformed/absent surface throws into a loud
        // `state-source-*` failure, and elements pass through RAW for core validation.
        listArchivedSessionIds: () => {
          const ids = host.workspaceRegistry.archivedSessionIds
          if (!Array.isArray(ids)) throw new Error('workspaceRegistry.archivedSessionIds is not an array')
          // Compile-time boundary only: the core re-validates every element.
          return ids as readonly string[]
        },
      },
    })
  }

  @Remote('snapshot')
  snapshot(): Promise<GitWorktreeDomainResult<SnapshotResult>> {
    return domainResult(() => this.core.snapshot())
  }

  @Remote('previewCreate')
  previewCreate(input: PreviewCreateInput): Promise<GitWorktreeDomainResult<PreviewCreateResult>> {
    return domainResult(() => this.core.previewCreate(input))
  }

  @Remote('create')
  create(input: CreateInput): Promise<GitWorktreeDomainResult<CreateResult>> {
    return domainResult(() => this.core.create(input))
  }

  @Remote('rollbackCreate')
  rollbackCreate(input: RollbackCreateInput): Promise<GitWorktreeDomainResult<RollbackCreateResult>> {
    return domainResult(() => this.core.rollbackCreate(input))
  }

  @Remote('remove')
  remove(input: RemoveInput): Promise<GitWorktreeDomainResult<RemoveResult>> {
    return domainResult(() => this.core.remove(input))
  }
}

export default GitWorktreeGateway
