/**
 * The archiveCleanup host binding (design 24 §10) and the per-domain
 * single-flight gate — decorator-free module so the REAL factory and gate
 * run under plain node:test (the gateway class in index.ts keeps the TS
 * decorators and is exercised by typecheck + M4 boot E2E).
 *
 * Trust model: this code runs inside each dsh host process. All capability
 * views are structural over the OFFICIAL ctx services (audited at the then-pin
 * dsh-v0.1.5-alpha.2 b2e3b2a0, whose session surfaces are unchanged at the
 * current pin rc.1 183f08e9c6dd — design 24 §10); an unavailable
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
 *  - per-delete live guard refuses sessions that turned running (contract);
 *    a merely LOADED (idle) session is refused with code `loaded` unless the
 *    caller authorized `force` (2026-09 revision, design 24 §3);
 *  - COMPLETENESS UNION (2026-12 blocker fix): neither official enumeration is
 *    authoritative alone — `SessionCorpus.listSessions` answers LIVE-ONLY with
 *    no error when its optional persistence binding is absent (vendor
 *    session-query/session-query/src/corpus.ts:68-87) and the jsonl
 *    `listArtifacts` skips unparseable/empty artifacts and returns [] for an
 *    absent sessions root (vendor session/session-persistence-jsonl/src/
 *    index.ts:507-544,893-904) — so `listHeaders` unions both surfaces by id
 *    and never drops a record either side reports;
 *  - AUTHORITATIVE EXISTENCE PROBE (2026-12 blocker fix; surface re-anchored
 *    2026-09 to `stat(id)`): `hasStoredContent` asks the official
 *    `sessionPersistence.stat(id)` — the jsonl backend resolves an id across
 *    ALL project directories and ALL format generations when cwd is unknown
 *    — and fails closed to `true` on every error except the official
 *    not-found carrier.
 */

import { rm, rmdir, lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
  readonly agents?: { list?(): readonly { id: unknown; status?: unknown }[] }
  readonly sessionPersistence?: {
    list?(signal?: unknown): Promise<readonly SessionHeaderLike[]>
    locate?(header: SessionHeaderLike): { kind?: string; path?: string } | undefined
    /** Official single-session observation (`SessionPersistence.stat(id)`,
     *  dsh >= 0.1.3-alpha.1): resolves the session across every project
     *  directory and every immutable format generation, and answers
     *  `undefined` when it does not exist — the sweep's DECISIVE
     *  content-existence probe. Optional in this structural view so a
     *  drifted/older host degrades to "never sweep" instead of crashing
     *  (fail closed; see hasStoredContent below). */
    stat?(id: string, options?: unknown): Promise<unknown>
  }
}

/** One official session header runtime shape check (review follow-up F3):
 *  every binding cascade keys on these fields through STRUCTURAL types — a
 *  vendor rename/retype (cwd/parentSession/origin) must fail the read LOUDLY
 *  with `registry-unreadable` (naming the session and field), never silently
 *  empty the lineage/deletion cascade. Absent OPTIONAL fields stay allowed
 *  (older records legitimately lack them). */
function assertHeaderShape(header: unknown): void {
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
const LEASE_FILENAME = 'session.lock'

/**
 * Is this version component canonical? Mirrors the vendor
 * `parseSessionFormatLogFilename` exactly: `[1-9][0-9]*` AND a safe integer
 * (vendor `Number.isSafeInteger` rejects an out-of-range version as
 * non-canonical). Without the upper bound the whitelist would call
 * `session.v99999999999999999999.jsonl` removable while the vendor calls it
 * non-canonical — the opposite of the fail-closed direction the surrounding
 * refusal relies on (2026-09 二轮 W1 N13).
 */
function isCanonicalVersion(version: string | undefined): boolean {
  return version === undefined || Number.isSafeInteger(Number(version))
}

/**
 * Is this filename one canonical immutable generation artifact? Mirrors the
 * vendor `sessionFormatLogFilename` + compression suffix: `session.jsonl`,
 * `session.vN.jsonl` (N >= 1, no leading zero, safe integer) and either with a
 * trailing `.zstd`. Version-zero-tagged and non-canonical names do not match.
 */
function isGenerationFilename(name: string): boolean {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/.exec(name)
  return match !== null && isCanonicalVersion(match[1])
}

/**
 * Is this filename a leftover generation temp file? The jsonl backend
 * publishes each generation via `link()`+`unlink()` from
 * `<generation>.<12 hex>.tmp` in the same directory, so an interrupted write
 * leaves one behind. It is this session's own artifact and belongs to the
 * purge; anything else in the directory still refuses the whole operation.
 * The version bound matches {@link isGenerationFilename}.
 */
function isGenerationTempFilename(name: string): boolean {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?\.[0-9a-f]{12}\.tmp$/.exec(name)
  return match !== null && isCanonicalVersion(match[1])
}

/**
 * Is this filename a leftover MIGRATION staging file? The jsonl backend stages
 * a vN->vM migration as `session.migration.<16 hex>.jsonl[.zstd].tmp` in the
 * same Session directory (vendor `generation.ts` migration path; the token is
 * `randomBytes(8).toString('hex')`), so an interrupted migration leaves one
 * behind. It holds this session's own content (the migrated log), so the purge
 * removes it with the rest; anything else still refuses the whole operation.
 * 2026-09 二轮 (W2 F5): without this recognition a crashed migration made the
 * session permanently unpurgeable (fail-closed refusal).
 */
function isMigrationTempFilename(name: string): boolean {
  return /^session\.migration\.[0-9a-f]{16}\.jsonl(?:\.zstd)?\.tmp$/.test(name)
}

/* ------------------------------------------------------------------ */
/* Binding implementation (design 24 §10: branch b, verified).     */
/* ------------------------------------------------------------------ */

export function headerToState(header: SessionHeaderLike): ArchivedSessionState {
  // F3: standalone-entry shape guard — a drifted header must throw here too
  // (listHeaders validates the raw intake; this keeps headerToState itself a
  // loud boundary for any direct consumer).
  assertHeaderShape(header)
  return {
    sessionId: header.id,
    ...(header.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(typeof header.parentSession === 'string' && header.parentSession !== ''
      ? { parentSessionId: header.parentSession }
      : {}),
    ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
    running: false,
  }
}

/**
 * Zero-IO structural surface check (impl-review Minor-6 + merge-round
 * Minor-3): the activation probe uses this so a mounted-but-corrupt/missing
 * registry OR enumeration/storage surface fails the activation loudly
 * instead of passing presence while the first preview/purge later
 * registry-unreadables/storages. Mirrors requireRegistry's checks; throws
 * ArchiveCleanupError('registry-unreadable', …) when a surface is wrong.
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
  // Merge-round Minor-3: surface health of the enumeration + storage legs
  // too — a host whose registry is intact but whose session enumeration or
  // locate surface is missing must not pass the probe. Zero-IO structural
  // checks only (no list call).
  const query = ctx.sessionQuery
  const persistence = ctx.sessionPersistence
  const canEnumerate = (query !== undefined && typeof query.listSessions === 'function')
    || (persistence !== undefined && typeof persistence.list === 'function')
  // `locate` resolves the artifact directory and `stat` is the sweep's decisive
  // existence probe; both are required by this domain (see hasStoredContent).
  if (!canEnumerate || persistence === undefined || typeof persistence.locate !== 'function'
    || typeof persistence.stat !== 'function') {
    throw new ArchiveCleanupError(
      'registry-unreadable',
      'archiveCleanup: the session enumeration/storage surface is not mounted with the expected shape',
    )
  }
}

/** Live-session facts (agents ∪ live store), split by WHY a session is live
 *  (2026-09 revision): `running` = the agent is executing a turn (never
 *  deletable); `loaded` = attached but idle (deletable only under `force`).
 *  A drifted agent status fails the read loudly instead of silently
 *  reclassifying a running agent as idle. */
function liveSessionFacts(ctx: HostCtxServices): { running: Set<string>; loaded: Set<string> } {
  const running = new Set<string>()
  const loaded = new Set<string>()
  for (const agent of ctx.agents?.list?.() ?? []) {
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
  // default (it may be open/current even without a running agent); an
  // explicit force purge may delete it after the caller stopped the run.
  for (const session of ctx.sessions?.list?.() ?? []) {
    if (session !== null && typeof session === 'object' && typeof (session as { id?: unknown }).id === 'string') {
      loaded.add(String((session as { id: string }).id))
    }
  }
  return { running, loaded }
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
    // COMPLETENESS UNION (2026-12 blocker fix). Neither official enumeration
    // is authoritative on its own, and the sweep's whole decision is "this id
    // has no record":
    //  - `sessionQuery.listSessions()` returns the LIVE-ONLY corpus with NO
    //    error when its optional persistence binding is absent (vendor
    //    session-query/session-query/src/corpus.ts:68-87 — `persisted = []`
    //    when `_persistence === undefined`);
    //  - the jsonl `listArtifacts` skips unparseable/empty artifacts and
    //    returns `[]` when the sessions root is absent, also with NO error
    //    (vendor session/session-persistence-jsonl/src/index.ts:507-544,
    //    893-904).
    // So when BOTH surfaces answer, the result is their UNION by id: an id
    // either side still lists keeps its record and can therefore never look
    // like an orphan. Dropping a record is the unsafe direction; adding one
    // only makes the sweep more conservative. Every header from BOTH legs is
    // shape-validated with the same loud F3 policy before it enters the union
    // (a drifted record refuses the whole read, never a silent per-item skip).
    //
    // A leg that THROWS is never silently dropped: the failure propagates and
    // the caller maps it to `registry-unreadable` before mutating anything,
    // because "one leg is broken" is indistinguishable from "the other leg is
    // narrowed" — a partial corpus must never become the sweep's evidence.
    const byId = new Map<string, SessionHeaderLike>()
    let sawEnumeration = false
    if (query?.listSessions !== undefined) {
      const records = await query.listSessions()
      // A non-array answer is a drifted surface, NOT an empty corpus: taking
      // it as "no sessions" would narrow the union silently and could clear a
      // membership whose content still exists.
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
      // dsh >= 0.1.3-alpha.1: list() answers SessionPersistenceSnapshot[] —
      // the header is the snapshot's `header` field, not the record itself.
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
        // F3: intake already validated every header loudly — no silent skip
        // of a drifted record (a vendor field rename must never empty the
        // lineage/deletion cascade one record at a time).
        byId.set(header.id, headerToState(header))
      }
      return [...byId.values()]
    },

    async listLiveSessionFacts() {
      const facts = liveSessionFacts(ctx)
      return { running: [...facts.running], loaded: [...facts.loaded] }
    },

    async hasStoredContent(sessionId: string) {
      // DECISIVE per-candidate existence probe (2026-12 blocker fix; re-anchored
      // 2026-09 to dsh-v0.1.5-alpha.2). The official `sessionPersistence.stat(id)`
      // resolves the session through the backend's own id -> artifact lookup
      // across every project directory and every immutable format generation,
      // and answers `undefined` when the id has no materialized log — an
      // unknown cwd is therefore NOT a reason to report "no content".
      //
      // Fail-closed mapping:
      //  - a resolved snapshot => true (the id still materializes);
      //  - `undefined` => false — the ONLY answer that may clear a membership.
      //    Upstream (jsonl backend) answers undefined for an absent log
      //    (ENOENT) and for a head it cannot materialize (unparseable JSON /
      //    malformed header) — NOT for every unreadable artifact: a corrupt
      //    zstd frame, a generation/header version mismatch, a too-new stored
      //    format version, or a non-ENOENT IO error all THROW (2026-09 二轮
      //    vendor read; design 24 §13 item 7). So this gate is fail-closed against
      //    thrown errors, while an artifact upstream itself calls "no session"
      //    clears the membership (its bytes are never deleted by this purge);
      //  - ANY failure (corrupt zstd, unsupported/too-new format, transport/IO,
      //    absent service, drifted method shape) => true;
      //  - no stat surface at all => true (the sweep then skips entirely).
      // A false negative here would clear the membership of a session whose
      // content still exists — the exact blocker this probe closes.
      //
      // The pre-alpha.1 `inspect(id)` surface this probe originally used no
      // longer exists upstream; `stat` carries the same semantics (see the
      // service face above).
      const stat = persistence?.stat
      if (typeof stat !== 'function') return true
      try {
        // Call AS A METHOD on the service object: the official persistence
        // implementations are instance-state classes (the same `this` trap
        // that broke a destructured `locate` on a real machine in 2026-09).
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
    ) {
      try {
        // INVARIANT GUARD (2026-09 protection amendment): the core's plan
        // already skips every tree whose closure contains a protected id, so
        // this can only fire on a core bug — and then it MUST abort, never
        // delete. It sits on the deletion primitive itself so no future caller
        // can route around the skip.
        if (protectedIds?.has(sessionId) === true) {
          throw new ArchiveCleanupError(
            'protected',
            `archiveCleanup: refusing to delete ${sessionId}: it is in the run's protected set (client-displayed session)`,
          )
        }
        // Live guard at deletion time (interface contract): never delete a
        // session that is RUNNING; a merely loaded (idle) session is refused
        // unless the caller authorized `force` (2026-09 revision — the caller
        // cancelled the run first, so no live writer can recreate the
        // artifact). This is the caller's per-member live gate — the core
        // keeps only the per-tree recheck (review F2), so a mid-tree running
        // flip is refused HERE as an item `running` error that aborts the
        // remaining members of that tree (review F1).
        const facts = liveSessionFacts(ctx)
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
          // Snapshot path (perf review): the official jsonl locate needs
          // only id + cwd (format.ts logPath) — no corpus re-enumeration.
          header = { id: sessionId, cwd }
          // F3: this header is consumed by the OFFICIAL locate — shape-check
          // it loudly too (guards a drifted sessionId/cwd instead of
          // silently resolving nothing).
          assertHeaderShape(header)
        } else {
          const headers = await listHeaders()
          header = headers.find(candidate => candidate.id === sessionId)
        }
        if (header === undefined) return 'missing'
        // CRITICAL: call locate AS A METHOD on the service object. The
        // official SessionPersistence implementations are instance-state
        // classes (`locate` reads this.root / this.compression, format.ts
        // logPath) — a destructured `const locate = persistence.locate` and
        // detached invocation would lose `this` and crash every deletion
        // with "Cannot read properties of undefined (reading 'root')"
        // (2026-09 real-machine E2E find; regression test in binding.test.ts
        // pins this with a this-sensitive locate fake).
        const location = persistence.locate(header)
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
        // CROSS-PROCESS NOTE (design 24 §4 step 10): removing `session.lock` forfeits
        // the jsonl lease's cross-process exclusion (vendor lease.ts:17-19), so
        // this purge must never run while another process is writing the
        // session. The in-process live gate above covers RUNNING/LOADED agents;
        // a second dsh process on the same sessions root is out of reach and is
        // the caller's responsibility (the domain's contract says "stop the
        // run first").
        //
        // dsh >= 0.1.3-alpha.1 keeps ONE FILE PER IMMUTABLE FORMAT GENERATION
        // in this directory (`session.jsonl`, `session.vN.jsonl`, each with an
        // optional `.zstd`) plus the write lease `session.lock`; `locate()`
        // resolves only the CURRENT generation. Removing that single artifact
        // would leave every older generation on disk while the session
        // disappears from every official list — the opposite of a content
        // purge. Delete every canonical generation file plus the lease and the
        // two recognized temp classes (publish temp `<gen>.<12hex>.tmp`,
        // migration staging `session.migration.<16hex>.jsonl[.zstd].tmp`), and
        // refuse the whole operation on any OTHER entry so a drifted layout
        // fails closed instead of half-deleting.
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
        if (removable.length === 0) return 'missing'
        for (const path of removable) {
          try {
            await rm(path, { force: false })
          } catch (error) {
            // Merge-round Nit N3: the artifact vanished between the readdir
            // above and this rm (TOCTOU race with a concurrent purge in
            // another ctx shell, or an external deletion) — an already-gone
            // generation is not an error; the directory is reclaimed below.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            throw error
          }
        }
        if (basename(dir) !== '' && basename(dir) !== '.' && basename(dir) !== '..') {
          try {
            // rmdir removes ONLY an empty directory: leftover session-local
            // files fail closed (ENOTEMPTY) and the directory stays.
            await rmdir(dir)
          } catch {
            // Non-empty leftover or race — fail closed by leaving the
            // directory; every canonical artifact is already gone and the
            // session no longer lists.
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
        // pinned to dsh-v0.1.5-alpha.2 (unchanged at rc.1; design 24 §10/§11).
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
      // no-op (design 24 §10; projection refresh rides the client
      // mutation-pull and the official startup header-index rebuild).
    },

    async emitArchivedSessionsChanged() {
      // Same documented no-op (no official archived-set event emitter).
    },
  }
}

/* ------------------------------------------------------------------ */
/* Single-flight gate (domain-level; the wire methods stay arg-free or   */
/* optional-arg — preview is zero-arg, purge takes an OPTIONAL sessionIds */
/* filter — so concurrency control is the host's job — design 24 §3,     */
/* 2026-09 revision).                                                    */
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
