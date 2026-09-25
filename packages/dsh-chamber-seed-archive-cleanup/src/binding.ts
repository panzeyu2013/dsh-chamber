/**
 * The archiveCleanup host binding (design 24 §10) + per-domain single-flight gate —
 * decorator-free so the real factory and gate run under plain node:test. Capability views
 * are structural over the OFFICIAL ctx services; an unavailable/drifted surface refuses
 * loudly, never guesses. Invariants: archived-set removal runs INSIDE the registry's
 * official `enqueueOperation` chain (an out-of-chain setState could interleave with a
 * two-phase delete and wipe its marker); fs failures map to item code `storage`; symlinked
 * dirs/artifacts fail closed; the delete-time live guard refuses running/loaded sessions and
 * reports residency, and a drifted liveness shape refuses the read (a dropped entry would
 * fail OPEN); the two official enumerations are UNIONed by id — dropping a record is the
 * unsafe direction; `hasStoredContent` fails closed to TRUE on every `stat` error except
 * the official not-found carrier.
 */

import { rm, rmdir, lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  ArchiveCleanupError,
  errorText,
  type ArchiveCleanupHost,
  type ArchivedSessionState,
  type SessionContentDeletion,
} from './core.ts'
import {
  BUSY_MESSAGE,
  LEASE_FILENAME,
  assertHeaderShape,
  headerToState,
  isGenerationFilename,
  isGenerationTempFilename,
  isMigrationTempFilename,
  liveSessionFacts,
  requireRegistrySurface,
  type HostCtxServices,
  type RegistryLike,
  type SessionHeaderLike,
} from './binding-parts.ts'

export { BUSY_MESSAGE, assertHostSurface } from './binding-parts.ts'
export type { HostCtxServices } from './binding-parts.ts'

export function makeHostBinding(ctx: HostCtxServices): ArchiveCleanupHost {
  const registry = ctx.workspaceRegistry
  const query = ctx.sessionQuery
  const persistence = ctx.sessionPersistence

  const requireRegistry = (): RegistryLike => requireRegistrySurface(registry)

  const listHeaders = async (): Promise<readonly SessionHeaderLike[]> => {
    // COMPLETENESS UNION: neither official enumeration is authoritative alone
    // (a live-only query without its persistence binding; a jsonl list that
    // skips unparseable/empty artifacts or an absent root), and dropping a
    // record is the unsafe direction — an id either side still lists keeps its
    // record and can never look like an orphan. Every header from both legs is
    // shape-validated loudly; a leg that THROWS propagates (a partial corpus
    // must never become the sweep's evidence). Adding a record only makes the
    // sweep more conservative.
    const byId = new Map<string, SessionHeaderLike>()
    let sawEnumeration = false
    if (query?.listSessions !== undefined) {
      const records = await query.listSessions()
      // A non-array answer is a drifted surface, NOT an empty corpus: taking it
      // as "no sessions" would narrow the union silently.
      if (!Array.isArray(records)) {
        throw new ArchiveCleanupError(
          'registry-unreadable',
          'archiveCleanup: sessionQuery.listSessions() did not answer an array — refusing the read (pinned-vendor surface drift)',
        )
      }
      for (const record of records) assertHeaderShape(record?.header)
      for (const record of records) {
        const header = record.header
        if (!byId.has(header.id)) byId.set(header.id, header)
      }
      sawEnumeration = true
    }
    if (persistence?.list !== undefined) {
      const snapshots = await persistence.list()
      if (!Array.isArray(snapshots)) {
        throw new ArchiveCleanupError(
          'registry-unreadable',
          'archiveCleanup: sessionPersistence.list() did not answer an array — refusing the read (pinned-vendor surface drift)',
        )
      }
      // list() answers SessionPersistenceSnapshot[] — the header is the snapshot's `header` field.
      const headers = snapshots.map(snapshot => (snapshot as { header?: unknown } | undefined)?.header)
      for (const header of headers) assertHeaderShape(header)
      for (const header of headers) {
        const typed = header as SessionHeaderLike
        if (!byId.has(typed.id)) byId.set(typed.id, typed)
      }
      sawEnumeration = true
    }
    if (!sawEnumeration) {
      throw new ArchiveCleanupError(
        'registry-unreadable',
        'archiveCleanup: no session enumeration service (sessionQuery/sessionPersistence) is mounted',
      )
    }
    return [...byId.values()]
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
        // Intake already validated every header loudly — no silent skip of a
        // drifted record (a vendor field rename must never empty the cascade).
        byId.set(header.id, headerToState(header))
      }
      return [...byId.values()]
    },

    async listLiveSessionFacts() {
      const facts = liveSessionFacts(ctx)
      return { running: [...facts.running], loaded: [...facts.loaded] }
    },

    async hasStoredContent(sessionId: string) {
      // DECISIVE existence probe: the official `sessionPersistence.stat(id)`
      // resolves the session across every project directory and format
      // generation, answering `undefined` when it has no materialized log — an
      // unknown cwd is NOT "no content". Fail-closed mapping: a resolved
      // snapshot => true; `undefined` => false (the ONLY answer that may clear a
      // membership — an absent or unmaterializable log upstream); ANY failure
      // (corrupt zstd, unsupported/too-new format, IO, absent/drifted service)
      // => true, and no stat surface at all => true (the sweep skips entirely).
      // A false negative would clear a membership whose content still exists.
      const stat = persistence?.stat
      if (typeof stat !== 'function') return true
      try {
        // Call AS A METHOD on the service object: the official persistence
        // implementations are instance-state classes (a detached call loses `this`).
        const snapshot = await stat.call(persistence, sessionId)
        return snapshot !== undefined && snapshot !== null
      } catch {
        return true
      }
    },

    async deleteSessionContent(
      sessionId: string,
      cwd?: string,
      force = false,
      protectedIds?: ReadonlySet<string>,
    ): Promise<SessionContentDeletion> {
      try {
        // INVARIANT GUARD: the core's plan already skips such trees, so this
        // can only fire on a core bug — and then it MUST abort, never delete.
        if (protectedIds?.has(sessionId) === true) {
          throw new ArchiveCleanupError(
            'protected',
            `archiveCleanup: refusing to delete ${sessionId}: it is in the run's protected set (client-displayed session)`,
          )
        }
        // Delete-time live guard (interface contract): never delete a session that is
        // RUNNING; a merely loaded (idle) session is refused unless the caller authorized
        // `force` (the caller cancelled the run first, so no live writer can recreate the
        // artifact). This is the caller's per-member live gate — the core keeps only the
        // per-tree recheck, so a mid-tree running flip is refused HERE as an item `running`
        // error that aborts the remaining members of that tree.
        const facts = liveSessionFacts(ctx)
        // RESIDENCY AT THE DELETION INSTANT, read from the SAME facts: a session
        // the process still holds keeps being served after its files are gone,
        // so the core must retain its archived membership. Fail-closed: the
        // union of running ∪ loaded, and running never reaches a return.
        const resident = facts.loaded.has(sessionId)
        if (facts.running.has(sessionId)) {
          throw new ArchiveCleanupError('running', `archiveCleanup: ${sessionId} is running`)
        }
        if (!force && facts.loaded.has(sessionId)) {
          throw new ArchiveCleanupError(
            'loaded',
            `archiveCleanup: ${sessionId} is loaded in this process — delete it with force after stopping it, or restart dsh`,
          )
        }
        if (persistence === undefined || typeof persistence.locate !== 'function') {
          throw new ArchiveCleanupError(
            'storage',
            `archiveCleanup: sessionPersistence.locate is not mounted — cannot resolve content of ${sessionId}`,
          )
        }
        let header: SessionHeaderLike | undefined
        if (typeof cwd === 'string') {
          // Snapshot path: the official jsonl locate needs only id + cwd — no corpus re-enumeration.
          header = { id: sessionId, cwd }
          // This header feeds the OFFICIAL locate, so shape-check it loudly too.
          assertHeaderShape(header)
        } else {
          const headers = await listHeaders()
          header = headers.find(candidate => candidate.id === sessionId)
        }
        if (header === undefined) return { outcome: 'missing', resident }
        // CRITICAL: call locate AS A METHOD on the service object — the official
        // implementations are instance-state classes (a detached call loses
        // `this` and crashes every deletion).
        const location = persistence.locate(header)
        const artifactPath = location?.path
        if (typeof artifactPath !== 'string' || artifactPath === '') {
          // A backend with no per-session artifact owns nothing removable.
          return { outcome: 'missing', resident }
        }
        const dir = dirname(artifactPath)
        // A session dir already gone is the idempotent 'missing' outcome, never an error.
        const dirStat = await lstat(dir).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        })
        if (dirStat === undefined) return { outcome: 'missing', resident }
        // Fail closed on symlinked session dirs/artifacts: a symlink component
        // would let a same-user writable redirection delete an unrelated file.
        
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
          throw new ArchiveCleanupError('storage', `archiveCleanup: refusing a non-directory/symlinked session path for ${sessionId}`)
        }
        // CROSS-PROCESS NOTE: removing `session.lock` forfeits the jsonl lease's
        // cross-process exclusion, so this purge must never run while another
        // process writes the session — the in-process guard covers only THIS
        // process; the caller's "stop the run first" contract covers the rest.
        // dsh keeps ONE FILE PER IMMUTABLE FORMAT GENERATION (`session.jsonl`,
        // `session.vN.jsonl`, optional `.zstd`) plus the lease; `locate()`
        // resolves only the CURRENT generation, so the purge deletes every
        // canonical generation plus the lease and the two recognized temp
        // classes, refusing the whole operation on any OTHER entry (a drifted
        // layout fails closed instead of half-deleting).
        const entries = await readdir(dir, { withFileTypes: true })
        const removable: string[] = []
        for (const entry of entries) {
          if (entry.isSymbolicLink() || entry.isDirectory() || !entry.isFile()) {
            throw new ArchiveCleanupError(
              'storage',
              `archiveCleanup: refusing to purge ${sessionId}: unexpected ${entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'special file'} ${entry.name} in the session directory`,
            )
          }
          if (entry.name === LEASE_FILENAME || isGenerationFilename(entry.name)
            || isGenerationTempFilename(entry.name) || isMigrationTempFilename(entry.name)) {
            removable.push(join(dir, entry.name))
            continue
          }
          throw new ArchiveCleanupError(
            'storage',
            `archiveCleanup: refusing to purge ${sessionId}: unrecognized entry ${entry.name} in the session directory (pinned-vendor layout drift — a partial purge would leave content behind)`,
          )
        }
        if (removable.length === 0) return { outcome: 'missing', resident }
        for (const path of removable) {
          try {
            await rm(path, { force: false })
          } catch (error) {
            // The artifact vanished between readdir and rm (TOCTOU race with a
            // concurrent purge or external deletion) — not an error.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            throw error
          }
        }
        if (basename(dir) !== '' && basename(dir) !== '.' && basename(dir) !== '..') {
          try {
            // rmdir removes ONLY an empty directory: leftover files fail closed (ENOTEMPTY).
            await rmdir(dir)
          } catch {
            // Non-empty leftover or race — fail closed by leaving the directory.
          }
        }
        return { outcome: 'deleted', resident }
      } catch (error) {
        // Item isolation: real filesystem/storage failures surface as item code
        // `storage` so the core keeps deleting the rest of the run.
        if (error instanceof ArchiveCleanupError) throw error
        throw new ArchiveCleanupError(
          'storage',
          `archiveCleanup: ${sessionId} content removal failed: ${errorText(error)}`,
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
        // ONE write, and a read-modify-write of the official live global: `setState`
        // REPLACES the whole global, so spread it and own only `archivedSessionIds` —
        // rebuilding a field list silently drops whatever the pin adds (design 24 §4 step 9).
        const live = reg.state as Record<string, unknown>
        await reg.setState!({ ...live, archivedSessionIds: next })
      }
      try {
        // Run INSIDE the official mutation chain — serialized against every
        // registry write AND its pendingMutation recovery, so the write can never
        // interleave with a two-phase create/delete and wipe its marker. A
        // registry lacking the chain REFUSES LOUDLY (no out-of-chain fallback).
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
          `archiveCleanup: archived-set removal failed: ${errorText(error)}`,
        )
      }
    },

  }
}

/* Single-flight gate (domain-level): concurrency control is the host's job. */

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

