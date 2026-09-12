/**
 * Per-instance archived-session content cleanup host gateway (design 24).
 *
 * TRUST MODEL — this service runs inside each dsh host process. The browser
 * submits no path or command: `preview` answers counts and `purge` deletes
 * every member of the instance's authoritative archived set
 * (registry-global) plus its subagent-origin descendants, children-first,
 * skipping running subtrees whole. The only caller-supplied session ids are
 * purge's OPTIONAL subset filter (`purge(sessionIds?)` — 2026-09 wire
 * amendment for per-selection deletion) and its OPTIONAL protected set
 * (`protectSessionIds?` — 2026-09 amendment for the session the calling client
 * is displaying): the domain intersects the filter with the authoritative
 * archived set at run start and only ever REMOVES protected trees from the
 * run, so neither input can name a non-archived session nor widen the
 * deletion set (fail-closed invariant, enforced in core). The
 * domain never RETURNS session content and never touches non-archived
 * sessions; its ONLY content read is the registry-global orphan sweep's
 * fail-closed existence probe (`sessionPersistence.stat`), consumed solely
 * as a boolean membership gate and never projected, logged or persisted —
 * the owner-approved exception recorded in design 24 §2 boundary 1.
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
 * HOST BINDING (design 24 §10, audited at the then-pin vendor
 * dsh-v0.1.5-alpha.2 b2e3b2a0 — surfaces unchanged at rc.1, 2026-12): implemented in ./binding.ts —
 *  - archived set: `workspaceRegistry.archivedSessionIds` (public getter);
 *  - session states: the UNION by id of `sessionQuery.listSessions()` and
 *    `sessionPersistence.list()` + live `sessions/agents` — neither
 *    enumeration is authoritative alone (the live-preferred corpus answers
 *    live-only with no error when its optional persistence binding is absent;
 *    the jsonl list skips unparseable artifacts and answers [] for an absent
 *    root), so a narrowed leg can never make a content-bearing member look
 *    like an orphan (2026-12 blocker fix);
 *  - content location: `sessionPersistence.locate(header)` (official
 *    absolute artifact path, no layout knowledge copied);
 *  - content EXISTENCE (the sweep's decisive gate): `sessionPersistence.
 *    stat(id)` — the official single-id observation resolves the artifact
 *    across all project dirs and generations with cwd unknown; only an
 *    `undefined` answer may mean "no content", every thrown failure fails
 *    closed to "has
 *    content" (2026-12 blocker fix);
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
   *  root). `force` (2026-09 revision) additionally deletes subtrees that are
   *  merely LOADED in this process (the caller cancels the run first); a
   *  RUNNING member is still refused. `protectSessionIds` (2026-09 protection
   *  amendment) names the ids the CALLING client may be displaying: any tree
   *  whose closure contains one is skipped whole, ahead of `force`, and is
   *  reported in `skippedProtected` — this is what lets a client delete
   *  archived content safely WITHOUT the retired pre-flight "I must know my
   *  current session" refusal, and it covers the full corpus (including
   *  cwd-less cold records a client-side lineage walk cannot see). NOTE: the
   *  generic gateway derives accepted arg names from this method's source
   *  text, so the signature must stay plain identifiers without defaults or
   *  rest. */
  @Remote('purge')
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
