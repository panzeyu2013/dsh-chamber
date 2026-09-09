/**
 * Per-instance archived-session content cleanup host gateway (design 24).
 *
 * TRUST MODEL — this service runs inside each dsh host process. The browser
 * submits no path or command: `preview` answers counts and `purge` deletes
 * every member of the instance's authoritative archived set
 * (registry-global) plus its subagent-origin descendants, children-first,
 * skipping running subtrees whole. The only caller-supplied session ids are
 * purge's OPTIONAL subset filter (`purge(sessionIds?)` — 2026-09 wire
 * amendment for per-selection deletion): the domain intersects the filter
 * with the authoritative archived set at run start, so the filter can never
 * name a non-archived session (fail-closed invariant, enforced in core). The
 * domain never reads session content and never touches non-archived sessions
 * (design 24 §2 boundaries).
 *
 * Fixed wire namespace: `archiveCleanup/{preview,purge,probe}` — preview and
 * probe are zero-arg; purge takes an OPTIONAL `sessionIds` JSON parameter
 * (absent = delete the whole archived set, unchanged semantics; the SRC
 * descriptor treats a missing JSON field as `undefined`, so old zero-arg
 * clients keep working against new hosts). `probe` is the ZERO-COST
 * activation-probe method (presence + protocol only, no session data, no IO
 * — design 18 §3.4 probe contract, perf review 2026-12). Every method
 * returns an explicit `{ok,value}|{ok:false,error}` domain carrier because
 * the generic dsh gateway does not preserve thrown business-error fields;
 * only unexpected internal failures escape as throws.
 *
 * HOST BINDING (design 24 §10/§14, verified against the pinned vendor
 * dsh-v0.1.2-rc.1 a66e4702, 2026-12): implemented in ./binding.ts —
 *  - archived set: `workspaceRegistry.archivedSessionIds` (public getter);
 *  - session states: `sessionQuery.listSessions()` + live `sessions/agents`;
 *  - content location: `sessionPersistence.locate(header)` (official
 *    absolute artifact path, no layout knowledge copied);
 *  - archived-set member removal: NO public official primitive exists — the
 *    binding performs ONE single-state `setState` write INSIDE the official
 *    `enqueueOperation` chain (serialized; runtime-guarded; version-pinned;
 *    retired when upstream unarchive/delete wire lands — design 24 §11);
 *  - official events: none public in the pinned tree — the two emit
 *    capabilities are documented no-ops; projection refresh rides the
 *    client mutation-pull and the official startup header-index rebuild.
 *
 * Audit (security review 2026-12 Major-5): preview/purge lifecycle lines go
 * through the instance logger (purge = the product's only persistent content
 * destruction primitive; local anonymous-loopback hosts reach it — UI
 * confirm is click-protection, the wire itself is the trust boundary shared
 * with the official archiveSession wire).
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ArchiveCleanupCore,
  ArchiveCleanupError,
  domainResult,
  type ArchiveCleanupDomainResult,
  type PreviewResult,
  type PurgeResult,
} from './core.ts'
import {
  assertHostSurface,
  BUSY_MESSAGE,
  makeHostBinding,
  RunGate,
  type HostCtxServices,
} from './binding.ts'

export * from './core.ts'
export { BUSY_MESSAGE, assertHostSurface, makeHostBinding, RunGate }
export type { HostCtxServices } from './binding.ts'

/** Remote-only facade; all orchestration, validation and policy live in the pure core. */
export class ArchiveCleanupGateway extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'agents', 'sessions', 'sessionQuery', 'sessionPersistence']

  private readonly core: ArchiveCleanupCore
  private readonly gate = new RunGate()
  private readonly logger: Context['logger'] | undefined

  private readonly hostCtx: HostCtxServices

  constructor(ctx: Context) {
    super(ctx, 'archiveCleanup')
    this.hostCtx = ctx as unknown as HostCtxServices
    this.core = new ArchiveCleanupCore(makeHostBinding(this.hostCtx))
    const maybeLogger = (ctx as { logger?: Context['logger'] }).logger
    this.logger = maybeLogger
  }

  @Remote('preview')
  preview(): Promise<ArchiveCleanupDomainResult<PreviewResult>> {
    return domainResult(() => this.gate.run(async () => {
      const value = await this.core.preview()
      this.logger?.info?.('[archiveCleanup] preview answered', {
        archived: value.archived,
        deletable: value.deletableSessions,
        skippedRunning: value.skippedRunning,
        skippedLoaded: value.skippedLoaded,
      })
      return value
    }))
  }

  /** Delete the WHOLE archived set by default; with the optional `sessionIds`
   *  filter only the listed archived-set members (each as a deletable tree
   *  root). Zero-arg calls keep working — a missing JSON field reaches the
   *  method as undefined. `force` (2026-09 revision) additionally deletes
   *  subtrees that are merely LOADED in this process (the caller cancels the
   *  run first); a RUNNING member is still refused. NOTE: the generic gateway
   *  derives accepted arg names from this method's source text, so the
   *  signature must stay plain identifiers without defaults or rest. */
  @Remote('purge')
  purge(sessionIds?: readonly string[], force?: boolean): Promise<ArchiveCleanupDomainResult<PurgeResult>> {
    return domainResult(() => this.gate.run(async () => {
      this.logger?.info?.('[archiveCleanup] purge started', {
        ...(sessionIds === undefined ? {} : { filterCount: sessionIds.length }),
        ...(force === true ? { force: true } : {}),
      })
      const value = await this.core.purge(sessionIds, force === true)
      this.logger?.info?.('[archiveCleanup] purge finished', {
        deletedSessions: value.deletedSessions,
        deletedSubagents: value.deletedSubagents,
        skippedRunning: value.skippedRunning,
        skippedLoaded: value.skippedLoaded,
        forcedLoaded: value.forcedLoaded,
        errorCount: value.errors.length,
      })
      return value
    }))
  }

  /** Zero-cost activation-probe method (perf review 2026-12): presence +
   *  protocol only — NO session data, NO IO, never linear in the corpus.
   *  Not routed through RunGate (never contends with purge/preview). The
   *  carrier is single-layer like every other domain method (arch review
   *  m10): RPC value = {ok:true,value:{}}. */
  @Remote('probe')
  probe(): Promise<ArchiveCleanupDomainResult<Record<string, never>>> {
    // impl-review Minor-6: presence AND surface health — zero IO (structural
    // check only). A corrupt/unmounted registry surface answers ok:false →
    // the activation probe treats a mounted-but-abnormal domain as a
    // business failure (fail-closed), like the git-worktree deterministic
    // refusal.
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
