/**
 * The archiveCleanup host binding (design 24 §10/§14) and the per-domain
 * single-flight gate — decorator-free module so the REAL factory and gate
 * run under plain node:test (the gateway class in index.ts keeps the TS
 * decorators and is exercised by typecheck + M4 boot E2E).
 *
 * Trust model: this code runs inside each dsh host process. All capability
 * views are structural over the OFFICIAL ctx services (verified against the
 * pinned vendor dsh-v0.1.2-rc.1 a66e4702 — design 24 §14); an unavailable
 * surface refuses loudly with code `registry-unreadable`/`storage`, never a
 * guessed layout. Security-review dispositions (2026-12):
 *  - archived-set member removal runs INSIDE the registry's official
 *    `enqueueOperation` chain (serialized with create/delete/insertBefore/
 *    archiveSession and its pendingMutation recovery) — a plain out-of-chain
 *    setState could interleave with a two-phase delete and wipe its marker
 *    (review Major-3);
 *  - filesystem failures (EACCES/EMFILE/EISDIR…) map to item code `storage`
 *    so per-item isolation holds (review Major-2); symlinked session
 *    dirs/artifacts fail closed (review Minor m2);
 *  - per-delete live guard refuses sessions that turned running (contract).
 */

import { rm, rmdir, lstat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  ArchiveCleanupError,
  type ArchiveCleanupHost,
  type ArchivedSessionState,
} from './core.ts'

/** One purge/preview in flight (host single-flight, design 24 §3). */
export const BUSY_MESSAGE = 'archiveCleanup is already running on this instance — retry after it settles'

/* ------------------------------------------------------------------ */
/* Structural views of the official ctx services (design 24 §10 list). */
/* ------------------------------------------------------------------ */

export interface SessionHeaderLike {
  readonly id: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
}

interface SessionRecordLike {
  readonly header: SessionHeaderLike
}

interface RegistryWorkspaceLike {
  readonly id: unknown
}

/** The durable workspace domain state shape setState persists (registry
 *  `WorkspaceDomainState` minus the optional pendingMutation marker — the
 *  plain single-write shape its own `insertBefore` uses). */
interface RegistryDomainState {
  readonly initialized: boolean
  readonly workspaceIds: readonly string[]
  readonly archivedSessionIds: readonly string[]
}

interface RegistryLike {
  readonly archivedSessionIds?: readonly string[]
  list?(): readonly RegistryWorkspaceLike[]
  setState?(state: RegistryDomainState): Promise<unknown>
  /** Official per-instance mutation chain (private in the pinned tree but
   *  runtime-guarded; running inside it serializes against every registry
   *  write and its pendingMutation recovery — review Major-3). */
  enqueueOperation?<T>(operation: () => Promise<T>): Promise<T>
}

export interface HostCtxServices {
  readonly workspaceRegistry?: RegistryLike
  readonly sessionQuery?: { listSessions?(signal?: unknown): Promise<readonly SessionRecordLike[]> }
  readonly sessions?: { list?(): readonly { id: unknown }[] }
  readonly agents?: { list?(): readonly { id: unknown }[] }
  readonly sessionPersistence?: {
    list?(signal?: unknown): Promise<readonly SessionHeaderLike[]>
    locate?(header: SessionHeaderLike): { kind?: string; path?: string } | undefined
  }
}

/* ------------------------------------------------------------------ */
/* Binding implementation (design 24 §10/§14: branch b, verified).     */
/* ------------------------------------------------------------------ */

export function headerToState(header: SessionHeaderLike): ArchivedSessionState {
  return {
    sessionId: String(header.id),
    ...(header.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(typeof header.parentSession === 'string' && header.parentSession !== ''
      ? { parentSessionId: header.parentSession }
      : {}),
    ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
    running: false,
  }
}

/**
 * Zero-IO structural surface check (impl-review Minor-6): the activation
 * probe uses this so a mounted-but-corrupt/missing registry surface fails
 * the activation loudly instead of passing presence while the first preview
 * later 404s/registry-unreadables. Mirrors requireRegistry's checks; throws
 * ArchiveCleanupError('registry-unreadable', …) when the surface is wrong.
 */
export function assertHostSurface(ctx: HostCtxServices): void {
  const registry = ctx.workspaceRegistry
  if (registry === undefined || typeof registry.setState !== 'function'
    || !Array.isArray(registry.archivedSessionIds) || typeof registry.list !== 'function') {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: the workspaceRegistry service is not mounted with the expected surface',
    )
  }
}

/** Live session id set (agents ∪ live store) — O(agents+live) per call. */
function liveSessionIds(ctx: HostCtxServices): Set<string> {
  const live = new Set<string>()
  for (const agent of ctx.agents?.list?.() ?? []) {
    if (agent !== null && typeof agent === 'object' && typeof (agent as { id?: unknown }).id === 'string') {
      live.add(String((agent as { id: string }).id))
    }
  }
  // A session attached to the live store is never a deletion candidate
  // (it may be open/current even without a running agent).
  for (const session of ctx.sessions?.list?.() ?? []) {
    if (session !== null && typeof session === 'object' && typeof (session as { id?: unknown }).id === 'string') {
      live.add(String((session as { id: string }).id))
    }
  }
  return live
}

export function makeHostBinding(ctx: HostCtxServices): ArchiveCleanupHost {
  const registry = ctx.workspaceRegistry
  const query = ctx.sessionQuery
  const persistence = ctx.sessionPersistence

  const requireRegistry = (): RegistryLike => {
    if (registry === undefined || typeof registry.setState !== 'function'
      || !Array.isArray(registry.archivedSessionIds) || typeof registry.list !== 'function') {
      throw new ArchiveCleanupError(
        'registry-unreadable',
        'archiveCleanup: the workspaceRegistry service is not mounted with the expected surface',
      )
    }
    return registry
  }

  const listHeaders = async (): Promise<readonly SessionHeaderLike[]> => {
    // Live-preferred official corpus first; fall back to the persistence
    // listing when sessionQuery is not mounted (fresh host shape).
    if (query?.listSessions !== undefined) {
      const records = await query.listSessions()
      if (Array.isArray(records)) return records.map(record => record.header)
    }
    if (persistence?.list !== undefined) {
      const headers = await persistence.list()
      if (Array.isArray(headers)) return headers
    }
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: no session enumeration service (sessionQuery/sessionPersistence) is mounted',
    )
  }

  return {
    async listArchivedSessionIds() {
      const reg = requireRegistry()
      return [...reg.archivedSessionIds as readonly string[]]
    },

    async listSessionStates() {
      const headers = await listHeaders()
      const byId = new Map<string, ArchivedSessionState>()
      for (const header of headers) {
        if (typeof header?.id !== 'string') continue
        byId.set(header.id, headerToState(header))
      }
      return [...byId.values()]
    },

    async listLiveAgentIds() {
      return [...liveSessionIds(ctx)]
    },

    async deleteSessionContent(sessionId: string, cwd?: string) {
      try {
        // Live guard at deletion time (interface contract): never delete a
        // session that is open/running — the core also pre-checks per member.
        if (liveSessionIds(ctx).has(sessionId)) {
          throw new ArchiveCleanupError('running', `archiveCleanup: ${sessionId} is running`)
        }
        const locate = persistence?.locate
        if (typeof locate !== 'function') {
          throw new ArchiveCleanupError(
            'storage',
            `archiveCleanup: sessionPersistence.locate is not mounted — cannot resolve content of ${sessionId}`,
          )
        }
        let header: SessionHeaderLike | undefined
        if (typeof cwd === 'string') {
          // Snapshot path (perf review): the official jsonl locate needs
          // only id + cwd (format.ts logPath) — no corpus re-enumeration.
          header = { id: sessionId, cwd }
        } else {
          const headers = await listHeaders()
          header = headers.find(candidate => candidate.id === sessionId)
        }
        if (header === undefined) return 'missing'
        const location = locate(header)
        const artifactPath = location?.path
        if (typeof artifactPath !== 'string' || artifactPath === '') {
          // A backend with no per-session artifact owns nothing removable.
          return 'missing'
        }
        const dir = dirname(artifactPath)
        // A session dir that is already gone is the idempotent 'missing'
        // outcome (concurrent purge/race), never an error (impl-review
        // Minor-2).
        const dirStat = await lstat(dir).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        })
        if (dirStat === undefined) return 'missing'
        // Fail closed on symlinked session dirs/artifacts (security review
        // m2): the artifact path is resolved by the OFFICIAL backend under a
        // root owned by the instance user; a symlink component would make a
        // same-user writable redirection delete an unrelated file.
        
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
          throw new ArchiveCleanupError('storage', `archiveCleanup: refusing a non-directory/symlinked session path for ${sessionId}`)
        }
        const artifactStat = await lstat(artifactPath).catch(() => undefined)
        if (artifactStat === undefined) return 'missing'
        if (artifactStat.isSymbolicLink() || artifactStat.isDirectory()) {
          throw new ArchiveCleanupError('storage', `archiveCleanup: refusing a symlinked/non-file artifact for ${sessionId}`)
        }
        // Remove the exact official artifact (absolute path from locate — no
        // layout knowledge copied). The parent directory is then reclaimed
        // ONLY when it empties (non-recursive, best-effort): the artifact is
        // the enumeration key, so its removal makes the session disappear
        // from every official list; leftover session-local files never cause
        // a project-root removal and a later purge re-runs as 'missing'.
        await rm(artifactPath, { force: false })
        if (basename(dir) !== '' && basename(dir) !== '.' && basename(dir) !== '..') {
          try {
            // rmdir removes ONLY an empty directory: leftover session-local
            // files fail closed (ENOTEMPTY) and the directory stays.
            await rmdir(dir)
          } catch {
            // Non-empty leftover or race — fail closed by leaving the
            // directory; the log artifact is already gone and the session no
            // longer lists.
          }
        }
        return 'deleted'
      } catch (error) {
        // Item isolation (security review Major-2): real filesystem/storage
        // failures must surface as item code `storage` so the core keeps
        // deleting the rest of the run instead of aborting wholesale.
        if (error instanceof ArchiveCleanupError) throw error
        throw new ArchiveCleanupError(
          'storage',
          `archiveCleanup: ${sessionId} content removal failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },

    async removeArchivedSessionIds(ids: readonly string[]) {
      const reg = requireRegistry()
      const mutate = async (): Promise<void> => {
        const current = [...reg.archivedSessionIds as readonly string[]]
        const wanted = new Set(ids)
        const next = current.filter(id => !wanted.has(id))
        if (next.length === current.length) return
        const workspaceIds = reg.list!().map(workspace => String(workspace.id))
        // ONE plain single-state write (perf review: N per-tree fsyncs → 1),
        // mirroring the registry's own insertBefore mutation; official
        // persistence + publication path (in-process, no out-of-process edit
        // — todo-12-B risk does not apply). Guarded at runtime; version-
        // pinned to dsh-v0.1.2-rc.1 (design 24 §10/§11).
        await reg.setState!({ initialized: true, workspaceIds, archivedSessionIds: next })
      }
      try {
        // Security review Major-3: run INSIDE the official mutation chain —
        // serialized against every registry write AND its pendingMutation
        // recovery, so the single-state write can never interleave with a
        // two-phase create/delete and wipe its recovery marker. A host whose
        // registry lacks the chain REFUSES LOUDLY (impl-review Minor-1): a
        // silent fallback to an out-of-chain write would resurrect the exact
        // interleave the chain seals. The chain is TS-private in the pinned
        // tree but runtime-visible and version-guarded here.
        if (typeof reg.enqueueOperation !== 'function') {
          throw new ArchiveCleanupError(
            'registry-unreadable',
            'archiveCleanup: the workspaceRegistry mutation chain is not mounted — refusing an out-of-chain archived-set write',
          )
        }
        await reg.enqueueOperation(mutate)
      } catch (error) {
        if (error instanceof ArchiveCleanupError) throw error
        throw new ArchiveCleanupError(
          'storage',
          `archiveCleanup: archived-set removal failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },

    async emitSessionRemoved() {
      // No official public event surface in the pinned tree — documented
      // no-op (design 24 §10/§14; projection refresh rides the client
      // mutation-pull and the official startup header-index rebuild).
    },

    async emitArchivedSessionsChanged() {
      // Same documented no-op (no official archived-set event emitter).
    },
  }
}

/* ------------------------------------------------------------------ */
/* Single-flight gate (domain-level; the wire keeps zero-arg methods, so  */
/* concurrency control is the host's job — design 24 §3).               */
/* ------------------------------------------------------------------ */

export class RunGate {
  private inFlight = false

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.inFlight) throw new ArchiveCleanupError('busy', BUSY_MESSAGE, true)
    this.inFlight = true
    try {
      return await operation()
    } finally {
      this.inFlight = false
    }
  }
}
