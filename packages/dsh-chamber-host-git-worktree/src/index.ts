/**
 * Per-instance Git worktree host gateway.
 *
 * TRUST MODEL — this service runs inside each dsh host process and reads that
 * instance's authoritative `workspaceRegistry` and live `agents` services.
 * The browser receives projections and submits only lifecycle intent; it never
 * supplies Git argv and cannot route an operation to another host. Repository
 * paths returned for display are not capabilities: every mutation starts from
 * `workspaceId`, re-reads host state and Git topology, then compares opaque
 * repo/worktree identities plus expected branch and HEAD.
 *
 * Fixed wire namespace: `gitWorktree/{snapshot,previewCreate,create,
 * rollbackCreate,remove}`. This plugin owns no workspace/session persistence:
 * create returns before workspace/session creation so the client can
 * compensate, while remove is deliberately Git-first and returns the still-
 * registered workspace identity for the client's subsequent workspace.delete.
 * Every method returns an explicit `{ok,value}|{ok:false,error}` domain carrier
 * because the generic dsh gateway intentionally does not preserve thrown
 * business-error fields; only unexpected internal failures escape as throws.
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

export * from './core.ts'

// Keep this gateway's compilation boundary narrow. Runtime ownership is still
// enforced by static injection; these structural views avoid dragging every
// transitive host source package into this standalone plugin's typecheck.
interface GitWorktreeHostContext extends Context {
  readonly workspaceRegistry: {
    list(): ReadonlyArray<{
      readonly id: unknown
      readonly path: string
      readonly sessionIds: readonly unknown[]
    }>
  }
  readonly agents: {
    list(): ReadonlyArray<{
      readonly id: unknown
      readonly status: 'idle' | 'running'
      readonly session: { readonly header: { readonly cwd?: string } }
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
        // Agent-registry membership is live state; status narrows the
        // destructive guard to active drivers, while cwd also covers
        // ungrouped sessions and subagents below a worktree.
        listAgents: () => host.agents.list().map(agent => ({
          sessionId: String(agent.id),
          status: agent.status,
          ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
        })),
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
