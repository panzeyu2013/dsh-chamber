/**
 * Per-instance Git worktree host gateway.
 *
 * TRUST MODEL - reads the host's authoritative `workspaceRegistry` and live `agents`;
 * the browser receives projections and submits lifecycle intent only. It never supplies
 * Git argv and cannot route an operation to another host. Display paths are not
 * capabilities: every mutation starts from `workspaceId`, re-reads host state and Git
 * topology, then compares opaque repo/worktree identities plus expected branch and HEAD.
 *
 * Wire namespace is fixed at `gitWorktree/{snapshot,branches,previewCreate,create,enter,remove}`.
 * This plugin owns no persistence: create produces only a checkout (no workspace/session
 * coupling); enter changes only the session's working directory through the host service;
 * remove is Git-first and returns the still-registered workspace identity. All methods
 * return an explicit `{ok,value}|{ok:false,error}` carrier.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { pickEffectiveCwd, readProjectedWorkingDirectory, type ProjectionSource } from './core-validation.ts'
import {
  GitWorktreeCore,
  GitWorktreeError,
  agentNotReady,
  domainResult,
  type BranchesInput,
  type BranchesResult,
  type CreateInput,
  type CreateResult,
  type EnterInput,
  type EnterResult,
  type PreviewCreateInput,
  type PreviewCreateResult,
  type RemoveInput,
  type RemoveResult,
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
    /** The live agent registry lookup enter needs; absent before the session is loaded. */
    get(sessionId: string): {
      readonly session: { readonly header: { readonly cwd?: string } }
    } | undefined
  }
}

/** Structural view of the host's working-directory service: `get` reads the committed
 *  directory without I/O, `set` commits a durable change and returns the canonical path. */
interface WorkingDirectoryHost {
  get(session: object): string
  set(agent: object, path: string, signal?: AbortSignal): Promise<string>
}

/** The cwd fact of one live agent: projection first, the immutable header cwd as fallback. */
function cwdFact(projections: ProjectionSource | undefined, agent: { session: { header: { cwd?: string } } }): object {
  const cwd = pickEffectiveCwd(
    readProjectedWorkingDirectory(projections, agent.session),
    agent.session.header.cwd,
  )
  return cwd === undefined ? {} : { cwd }
}

/** Remote-only facade; all validation, serialization and Git policy live in the pure core. */
export class GitWorktreeGateway extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'agents']

  private readonly core: GitWorktreeCore
  private readonly hostContext: Context
  private readonly host: GitWorktreeHostContext

  constructor(ctx: Context) {
    super(ctx, 'gitWorktree')
    const host = ctx as GitWorktreeHostContext
    this.hostContext = ctx
    this.host = host
    // Read lazily on every call: the projection registry is provided by a sibling plugin,
    // so a capture at construction time would freeze an undefined value for the whole
    // instance whenever this gateway activates first.
    const projections = (): ProjectionSource | undefined =>
      ctx.get('sessionProjections') as ProjectionSource | undefined
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
          ...(cwdFact(projections(), agent)),
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

  /**
   * On-demand branch candidates for the create dialog (design 08 §2.1/§4.1): the picker's
   * value at open time, never the polled snapshot's possibly one-wave-old list. Read-only;
   * the authoritative branch validation stays in `previewCreate`/`create`.
   */
  @Remote('branches')
  branches(input: BranchesInput): Promise<GitWorktreeDomainResult<BranchesResult>> {
    return domainResult(() => this.core.branches(input))
  }

  @Remote('create')
  create(input: CreateInput): Promise<GitWorktreeDomainResult<CreateResult>> {
    return domainResult(() => this.core.create(input))
  }

  @Remote('enter')
  enter(input: EnterInput): Promise<GitWorktreeDomainResult<EnterResult>> {
    return domainResult(() => this.enterSession(input))
  }

  /**
   * The thin enter body (design 08 §4.2): resolve the live agent, let the core validate
   * the claimed checkout against the session's IMMUTABLE header root plus fresh Git
   * facts, then commit the working directory. No idle/blank check, no common-dir check,
   * no session creation - the client owns create -> open -> enter ordering.
   */
  private async enterSession(input: EnterInput): Promise<EnterResult> {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : ''
    if (sessionId.length === 0 || sessionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
      throw agentNotReady(sessionId)
    }
    const agent = this.host.agents.get(sessionId)
    if (agent === undefined) throw agentNotReady(sessionId)
    // The sandbox root is the immutable header cwd, never the session's effective
    // directory (an already-entered session must still prove containment against its root).
    const headerCwd = agent.session.header.cwd
    if (typeof headerCwd !== 'string' || headerCwd.length === 0) {
      throw new GitWorktreeError(
        'outside-writable-root',
        `session '${sessionId}' has no recorded source root`,
        { retryable: false },
      )
    }
    const path = await this.core.enterTarget(headerCwd, typeof input.path === 'string' ? input.path : '')
    // Lazy read on every call: the working-directory service is a sibling plugin, so a
    // capture at construction time could freeze undefined for the whole instance.
    const workingDirectory = this.hostContext.get('workingDirectory') as WorkingDirectoryHost | undefined
    if (workingDirectory === undefined) {
      throw new GitWorktreeError(
        'state-source-unavailable',
        'the host working-directory service is unavailable',
        { retryable: true },
      )
    }
    // Idempotent: entering the directory the session already has commits no new change.
    if (workingDirectory.get(agent.session) !== path) {
      await workingDirectory.set(agent, path)
    }
    return { sessionId, path }
  }

  @Remote('remove')
  remove(input: RemoveInput): Promise<GitWorktreeDomainResult<RemoveResult>> {
    return domainResult(() => this.core.remove(input))
  }
}

export default GitWorktreeGateway
