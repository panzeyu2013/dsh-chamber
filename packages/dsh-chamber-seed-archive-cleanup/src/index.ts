/**
 * Per-instance archived-session content cleanup host gateway (design 24).
 * TRUST MODEL: callers submit no path or command. The only caller-supplied ids are purge's
 * OPTIONAL subset filter and protected set; the domain intersects the filter with the
 * authoritative archived set read at run start, and a protected id only ever REMOVES trees
 * (fail-closed invariant, enforced in core). It never returns session content and never
 * touches non-archived sessions; its only content read is the orphan sweep's fail-closed
 * existence probe (`sessionPersistence.stat`), consumed solely as a boolean membership gate.
 * Fixed wire namespace `archiveCleanup/{purge,probe}` is single-sourced in `./wire.ts` (the
 * sidebar client imports it); the lockstep test pins the host method signature to that table.
 * `probe` is the zero-cost activation probe (presence + protocol only). Every method returns
 * an explicit `{ok,value}|{ok:false,error}` carrier (thrown business-error fields survive no
 * transport).
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ArchiveCleanupCore,
  ArchiveCleanupError,
  domainResult,
  type ArchiveCleanupDomainResult,
  type PurgeResult,
} from './core.ts'
import {
  ARCHIVE_CLEANUP_DOMAIN,
  ARCHIVE_CLEANUP_PROBE_METHOD,
  ARCHIVE_CLEANUP_PURGE_METHOD,
} from '@dsh-chamber/dsh-chamber-wire'
import {
  assertHostSurface,
  makeHostBinding,
  RunGate,
  type HostCtxServices,
} from './binding.ts'

/** Remote-only facade; all orchestration, validation and policy live in the pure core. */
export class ArchiveCleanupGateway extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'agents', 'sessions', 'sessionQuery', 'sessionPersistence']

  private readonly core: ArchiveCleanupCore
  private readonly gate = new RunGate()
  private readonly logger: Context['logger'] | undefined

  private readonly hostCtx: HostCtxServices

  constructor(ctx: Context) {
    super(ctx, ARCHIVE_CLEANUP_DOMAIN)
    this.hostCtx = ctx as unknown as HostCtxServices
    this.core = new ArchiveCleanupCore(makeHostBinding(this.hostCtx))
    const maybeLogger = (ctx as { logger?: Context['logger'] }).logger
    this.logger = maybeLogger
  }

  /** Delete the WHOLE archived set by default; with `sessionIds` only the
   *  listed archived-set members. `force` also deletes merely LOADED subtrees
   *  (the caller cancels the run first); a RUNNING member is still refused.
   *  `protectSessionIds` names ids the CALLING client may be displaying: any
   *  tree whose closure contains one is skipped whole, ahead of `force`, and
   *  reported in `skippedProtected` — this lets a client delete safely without
   *  a pre-flight current-session refusal, covering the full corpus (including
   *  cwd-less cold records a client-side walk cannot see). NOTE: the generic
   *  gateway derives accepted arg names from this method's source text, so the
   *  signature must stay plain identifiers without defaults or rest; its names
   *  and order ARE the wire contract declared in ./wire.ts and pinned by
   *  test/wire-lockstep.test.ts. */
  // @Remote takes the protocol's single SEGMENT name, never the client
  // envelope path: the client calls `archiveCleanup/purge`, while the decorator
  // export name must satisfy the pinned grammar [A-Za-z0-9_$.-]+ — a '/' here
  // rejects the whole plugin tree at load.
  @Remote(ARCHIVE_CLEANUP_PURGE_METHOD)
  purge(
    sessionIds?: readonly string[],
    force?: boolean,
    protectSessionIds?: readonly string[],
  ): Promise<ArchiveCleanupDomainResult<PurgeResult>> {
    return domainResult(() => this.gate.run(async () => {
      this.logger?.info?.('[archiveCleanup] purge started', {
        ...(sessionIds === undefined ? {} : { filterCount: sessionIds.length }),
        ...(force === true ? { force: true } : {}),
        ...(protectSessionIds === undefined ? {} : { protectCount: protectSessionIds.length }),
      })
      const value = await this.core.purge(sessionIds, force === true, protectSessionIds)
      this.logger?.info?.('[archiveCleanup] purge finished', {
        deletedSessions: value.deletedSessions,
        deletedSubagents: value.deletedSubagents,
        skippedRunning: value.skippedRunning,
        skippedLoaded: value.skippedLoaded,
        skippedProtected: value.skippedProtected,
        forcedLoaded: value.forcedLoaded,
        // 常驻保留：内容删了但会话仍活在本进程 ⇒ 成员关系保留、行继续隐藏；宿主审计必须可见。
        residentRetained: value.residentRetainedRoots?.length ?? 0,
        errorCount: value.errors.length,
      })
      return value
    }))
  }

  /** Zero-cost activation-probe method: presence + protocol only — NO session
   *  data, NO IO, never linear in the corpus. Not routed through RunGate. */
  @Remote(ARCHIVE_CLEANUP_PROBE_METHOD)
  probe(): Promise<ArchiveCleanupDomainResult<Record<string, never>>> {
    // Presence AND surface health, zero IO (structural check only): a
    // corrupt/unmounted registry surface answers ok:false, so a mounted-but-abnormal
    // domain is a business failure (fail-closed).
    try {
      assertHostSurface(this.hostCtx)
      return Promise.resolve({ ok: true, value: {} })
    } catch (error) {
      if (error instanceof ArchiveCleanupError) {
        return Promise.resolve({
          ok: false,
          error: { code: error.code, message: error.message, ...(error.retryable === true ? { retryable: true } : {}) },
        })
      }
      throw error
    }
  }
}

export default ArchiveCleanupGateway
