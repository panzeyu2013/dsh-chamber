/**
 * binding-parts.ts — the decorator-free, this-free layer of the archiveCleanup
 * host binding: the structural views of the official ctx services,
 * the header/filename shape checks, the fail-closed liveness reader and the
 * registry-surface guard. binding.ts keeps the factory (content deletion +
 * archived-set writes) and the single-flight gate, and re-exports the public
 * names so the package/test import surface stays stable.
 */

import { ArchiveCleanupError, type ArchivedSessionState } from './core.ts'

export const BUSY_MESSAGE = 'archiveCleanup is already running on this instance — retry after it settles'

/* Structural views of the official ctx services (design 24 §10 list). */

export interface SessionHeaderLike {
  readonly id: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
}

export interface SessionRecordLike {
  readonly header: SessionHeaderLike
}

/** Official registry global handle. `setState` REPLACES the whole global, so this stays
 *  opaque on purpose: the binding spreads the live object and owns exactly one field
 *  (`archivedSessionIds`). Mirroring the official field list here would silently drop
 *  every field the pin adds (design 24 §4 step 9). */
export interface RegistryLike {
  readonly archivedSessionIds?: readonly string[]
  /** The registry-owned live global object — the same reference `setState` replaces. */
  readonly state?: unknown
  setState?(state: Record<string, unknown>): Promise<unknown>
  /** Official per-instance mutation chain (private in the pinned tree but
   *  runtime-guarded; running inside it serializes against every registry write). */
  enqueueOperation?<T>(operation: () => Promise<T>): Promise<T>
}

export interface HostCtxServices {
  readonly workspaceRegistry?: RegistryLike
  readonly sessionQuery?: { listSessions?(signal?: unknown): Promise<readonly SessionRecordLike[]> }
  readonly sessions?: { list?(): readonly { id: unknown }[] }
  readonly agents?: { list?(): readonly { id: unknown; status?: unknown }[] }
  readonly sessionPersistence?: {
    list?(signal?: unknown): Promise<readonly SessionHeaderLike[]>
    locate?(header: SessionHeaderLike): { kind?: string; path?: string } | undefined
    /** Official single-session observation: resolves the session across every
     *  project directory and every format generation, answering `undefined`
     *  when it does not exist — the sweep's DECISIVE content-existence probe.
     *  Optional so a drifted/older host degrades to "never sweep" instead of
     *  crashing (fail closed). */
    stat?(id: string, options?: unknown): Promise<unknown>
  }
}

/** One official session header runtime shape check: every binding cascade keys
 *  on these fields through STRUCTURAL types, so a vendor rename/retype must
 *  fail the read LOUDLY with `registry-unreadable`, never silently empty the
 *  lineage/deletion cascade. Absent OPTIONAL fields stay allowed. */
export function assertHeaderShape(header: unknown): void {
  if (header === null || typeof header !== 'object') {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: a session header is not an object — refusing the read (pinned-vendor header drift)',
    )
  }
  const h = header as { id?: unknown; cwd?: unknown; parentSession?: unknown; origin?: unknown }
  const who = typeof h.id === 'string' && h.id !== '' ? `session ${h.id}` : 'an unnamed session header'
  const malformed = (field: string, expected: string): never => {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      `archiveCleanup: ${who}: header.${field} must be ${expected} — refusing the read (pinned-vendor header drift would silently empty the cleanup cascade)`,
    )
  }
  if (typeof h.id !== 'string') malformed('id', 'a string')
  if (h.cwd !== undefined && typeof h.cwd !== 'string') malformed('cwd', 'a string when present')
  if (h.parentSession !== undefined && typeof h.parentSession !== 'string') {
    malformed('parentSession', 'a string when present')
  }
  if (h.origin !== undefined && h.origin !== 'subagent') malformed('origin', "exactly 'subagent' when present")
}

/** The jsonl backend's write-lease filename (vendor `LEASE_FILENAME`). */
export const LEASE_FILENAME = 'session.lock'

/**
 * Is this version component canonical? Mirrors the vendor
 * `parseSessionFormatLogFilename`: `[1-9][0-9]*` AND a safe integer. Without
 * the upper bound the whitelist would call an out-of-range version removable
 * while the vendor calls it non-canonical — the opposite of fail-closed.
 */
export function isCanonicalVersion(version: string | undefined): boolean {
  return version === undefined || Number.isSafeInteger(Number(version))
}

/**
 * Is this filename one canonical immutable generation artifact? Mirrors the
 * vendor `sessionFormatLogFilename` + compression suffix: `session.jsonl` and
 * `session.vN.jsonl` (N >= 1, no leading zero, safe integer), each optionally
 * with `.zstd`. Version-zero-tagged and non-canonical names do not match.
 */
export function isGenerationFilename(name: string): boolean {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/.exec(name)
  return match !== null && isCanonicalVersion(match[1])
}

/**
 * Is this filename a leftover generation temp file? The jsonl backend publishes
 * each generation via `link()`+`unlink()` from `<generation>.<12 hex>.tmp`, so
 * an interrupted write leaves one behind — this session's own artifact, which
 * belongs to the purge. The version bound matches {@link isGenerationFilename};
 * anything else in the directory still refuses the whole operation.
 */
export function isGenerationTempFilename(name: string): boolean {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?\.[0-9a-f]{12}\.tmp$/.exec(name)
  return match !== null && isCanonicalVersion(match[1])
}

/**
 * Is this filename a leftover MIGRATION staging file
 * (`session.migration.<16 hex>.jsonl[.zstd].tmp`)? An interrupted migration
 * leaves one behind; it holds this session's own content (the migrated log), so
 * the purge removes it. Anything else still refuses the whole operation.
 */
export function isMigrationTempFilename(name: string): boolean {
  return /^session\.migration\.[0-9a-f]{16}\.jsonl(?:\.zstd)?\.tmp$/.test(name)
}

/* Binding implementation (design 24 §10: branch b, verified).     */

export function headerToState(header: SessionHeaderLike): ArchivedSessionState {
  // Standalone shape guard: a drifted header must throw here too, so
  // headerToState stays a loud boundary for any direct consumer.
  assertHeaderShape(header)
  return {
    sessionId: header.id,
    ...(header.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(typeof header.parentSession === 'string' && header.parentSession !== ''
      ? { parentSessionId: header.parentSession }
      : {}),
    ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
  }
}

/**
 * Zero-IO structural surface check used by the activation probe: a
 * mounted-but-corrupt/missing registry OR enumeration/storage surface fails
 * activation loudly instead of passing presence and failing at the first purge.
 * Mirrors requireRegistry's checks; throws `registry-unreadable`. `state` is required
 * because the archived-set write read-modify-writes the live global — a registry
 * exposing `setState` without its live object cannot be written safely.
 */
export function requireRegistrySurface(registry: RegistryLike | undefined): RegistryLike {
  if (registry === undefined || typeof registry.setState !== 'function'
    || !Array.isArray(registry.archivedSessionIds)
    || registry.state === null || typeof registry.state !== 'object' || Array.isArray(registry.state)) {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: the workspaceRegistry service is not mounted with the expected surface',
    )
  }
  return registry
}

export function assertHostSurface(ctx: HostCtxServices): void {
  requireRegistrySurface(ctx.workspaceRegistry)
  // The liveness faces are load-bearing for the deletion guard: a
  // mounted-but-methodless agents/sessions surface must fail HERE, not at the first purge.
  if (typeof ctx.agents?.list !== 'function' || typeof ctx.sessions?.list !== 'function') {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: the agents/sessions liveness surface is not mounted with list()',
    )
  }
  // Surface health of the enumeration + storage legs too; zero-IO structural
  // checks only (no list call).
  const query = ctx.sessionQuery
  const persistence = ctx.sessionPersistence
  const canEnumerate = (query !== undefined && typeof query.listSessions === 'function')
    || (persistence !== undefined && typeof persistence.list === 'function')
  // `locate` resolves the artifact directory and `stat` is the decisive existence probe.
  if (!canEnumerate || persistence === undefined || typeof persistence.locate !== 'function'
    || typeof persistence.stat !== 'function') {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: the session enumeration/storage surface is not mounted with the expected shape',
    )
  }
}

/** Live-session facts (agents ∪ live store), split by WHY a session is live:
 *  `running` = executing a turn (never deletable); `loaded` = attached but idle
 *  (deletable only under `force`).
 *
 *  FAIL-CLOSED DRIFT POLICY (both legs): a drifted agent status or an entry this
 *  read silently DROPS would fail OPEN — reclassifying running as idle, removing
 *  the loaded guard, and hiding an attached session from the residency report
 *  (letting the core un-hide a just-deleted row). Any drift, or a missing face,
 *  refuses the whole read (`registry-unreadable`, nothing deleted). */
export function liveSessionFacts(ctx: HostCtxServices): { running: Set<string>; loaded: Set<string> } {
  const running = new Set<string>()
  const loaded = new Set<string>()
  // Surface presence is part of the policy: degrading a mounted-but-methodless
  // face to "nobody is live" would silently fail-open on the destructive path.
  const listAgents = ctx.agents?.list
  if (typeof listAgents !== 'function') {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: the agents service is not mounted with list() — refusing the read (a missing liveness face must never read as idle)',
    )
  }
  const agentRows = listAgents.call(ctx.agents)
  if (!Array.isArray(agentRows)) {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: agents.list() did not answer an array — refusing the read (a drifted liveness shape must never read as idle)',
    )
  }
  for (const agent of agentRows) {
    if (agent === null || typeof agent !== 'object' || typeof (agent as { id?: unknown }).id !== 'string') {
      throw new ArchiveCleanupError(
        'registry-unreadable',
        'archiveCleanup: an agent entry has no string id — refusing the read (pinned-vendor drift)',
      )
    }
    const id = String((agent as { id: string }).id)
    const status = (agent as { status?: unknown }).status
    if (status !== 'idle' && status !== 'running') {
      throw new ArchiveCleanupError(
        'registry-unreadable',
        `archiveCleanup: agent ${id} reports an unknown status ${JSON.stringify(status)} — refusing the read (a drifted status would silently reclassify a running agent as idle)`,
      )
    }
    loaded.add(id)
    if (status === 'running') running.add(id)
  }
  // A session attached to the live store is never a deletion candidate by
  // default; an explicit force purge may delete it after the caller stopped the run.
  const listSessions = ctx.sessions?.list
  if (typeof listSessions !== 'function') {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: the sessions service is not mounted with list() — refusing the read (a missing live-store face would hide attached sessions from the loaded guard)',
    )
  }
  const sessions = listSessions.call(ctx.sessions)
  if (!Array.isArray(sessions)) {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: sessions.list() did not answer an array — refusing the read (a drifted live-store shape would hide attached sessions from the loaded guard)',
    )
  }
  for (const session of sessions) {
    if (session === null || typeof session !== 'object' || typeof (session as { id?: unknown }).id !== 'string') {
      throw new ArchiveCleanupError(
        'registry-unreadable',
        'archiveCleanup: a live-store session entry has no string id — refusing the read (pinned-vendor drift)',
      )
    }
    loaded.add(String((session as { id: string }).id))
  }
  return { running, loaded }
}

