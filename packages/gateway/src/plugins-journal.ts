/**
 * Durable third-party plugin-mutation journal + pre-mutation profile backups.
 *
 * Write order per mutation: ① appendPending (durable intent), ② the executor
 * places backups/<op-id>/ and calls recordPreImage, ③ the mutation runs,
 * ④ markTerminal. `preImage` is null until that backup is durably recorded, so
 * only ops whose preImage is set may be rolled back.
 *
 * Corruption ≠ emptiness: a present-but-unreadable journal is renamed aside
 * (evidence kept) and its pending set is UNKNOWN.
 */

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
} from '@dsh-chamber/control-plane'
import { readPrivateTextOrNull } from './private-read.ts'
import { messageOf, newestFirst } from './util.ts'

/** Third-party plugin state root (journal, backups, private pnpm env dirs) under the gateway stateDir. */
export const THIRD_PARTY_REL = join('chamber-plugins', 'third-party')
/** Journal file, relative to the gateway stateDir. */
export const JOURNAL_FILE_REL = join(THIRD_PARTY_REL, 'journal.json')
/** Backup dir root, relative to the gateway stateDir. */
export const JOURNAL_BACKUPS_REL = join(THIRD_PARTY_REL, 'backups')

/** Bounded-read ceiling for journal.json (well above the 50 retained ops). */
export const JOURNAL_MAX_BYTES = 256 * 1024
/** Retention: newest N terminal ops kept, with their backups. */
export const JOURNAL_RETENTION_LIMIT = 50
/** Aside-name prefix for corrupt-journal evidence. */
export const CORRUPT_ASIDE_PREFIX = 'journal.json.corrupt-'
/** The op kinds the journal can record. `undo` is first-class: it restores the
 * latest ok op's preImage pair and is itself backed up + journaled. */
export type JournalOpKind = 'install' | 'remove' | 'materialize' | 'undo'
/** Lifecycle of one recorded op. */
export type JournalOpStatus = 'pending' | 'ok' | 'failed' | 'blocked'
/** Post-mutation restart outcome (recorded by the wiring layer, later). */
export type JournalRestartOutcome = 'ok' | 'failed' | 'skipped'

/** Journal read integrity: "nothing recorded" and "record unreadable" are different facts, never collapsed. */
export type JournalIntegrity =
  | { state: 'ok' }
  | {
    state: 'corrupt'
    /** Why the journal was judged corrupt/unreadable (message only). */
    error: string
    /** Where the raw bytes were moved aside; null when the move failed (writes then fail closed). */
    asidePath: string | null
  }

export interface JournalOp {
  /** Unique op id; also the name of the op's preImage backup directory. */
  id: string
  /** Epoch-ms record time (append time). */
  ts: number
  kind: JournalOpKind
  name: string
  /** Registry spec / materialized file path for install-materialize ops. */
  spec?: string
  /** Declared package version (x-plugin-version header, not the `file:` spec): needed by the generation check. */
  version?: string
  /** Reference to the pre-mutation backup dir backups/<op-id>/, or null when none was placed. */
  preImage: string | null
  /** For `kind: 'undo'`: id of the op whose preImage pair this undo restored. */
  undoOf?: string
  /** Human attribution label (desktop connection label) when known. */
  initiator?: string
  /** Pid of the spawned `dsh plugin` child (detached process-group leader) while
   *  the mutation runs; cleared when the op goes terminal. A crash mid-mutation
   *  leaves the child writing DSH_HOME: the next boot's reconcile kills the pid. */
  childPid?: number
  status: JournalOpStatus
  /** Failure/blocked reason (already sanitized by the executor). */
  error?: string
  /** Restart outcome when the mutation was followed by a restart. */
  restarted?: JournalRestartOutcome
}

export interface JournalPending {
  kind: JournalOpKind
  name: string
  spec?: string
  /** Declared package version from the x-plugin-version header: needed by the generation check. */
  version?: string
  initiator?: string
  /** For `kind: 'undo'`: the id to restore; the executor re-verifies it is still undoable. */
  undoOf?: string
}

export interface JournalTerminalPatch {
  status: 'ok' | 'failed' | 'blocked'
  error?: string
  restarted?: JournalRestartOutcome
}

/** Console-like sink (the journal never logs secret material). */
export interface JournalLogger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
}

export interface PluginsJournal {
  /** Write order step ①: durably record a pending op and return its id (throws on persistence failure). */
  appendPending(input: JournalPending): string
  /** Write order step ②: durably record that backups/<op-id>/ holds the pre-mutation files. */
  recordPreImage(opId: string): void
  /** Crash-orphan reaping support: durably record the spawned child pid of a pending op. */
  markChildPid(opId: string, pid: number): void
  /** Write order step ④: terminal state for an op; null when no such op exists.
   *  A terminal op may be re-marked; clears childPid; retention pruning runs here. */
  markTerminal(opId: string, patch: JournalTerminalPatch): JournalOp | null
  /** Newest-first projection (default newest 50). */
  recent(limit?: number): JournalOp[]
  /** Startup reconciliation: pending → failed ('interrupted before completion;
   *  preImage retained'), persisted once; idempotent. A corrupt journal yields []
   *  but integrity() 'corrupt' — never read that [] as "no pending operations". */
  reconcile(): JournalOp[]
  /** Sticky integrity as of a real read: 'corrupt' until the operator resolves a
   *  present-unreadable file or unresolved aside evidence; pending set then UNKNOWN. */
  integrity(): JournalIntegrity
}

/** Third-party plugin state root under the gateway stateDir. */
export function thirdPartyRoot(stateDir: string): string {
  return join(stateDir, THIRD_PARTY_REL)
}

/** journal.json path under the gateway stateDir. */
export function journalFilePath(stateDir: string): string {
  return join(stateDir, JOURNAL_FILE_REL)
}

/** backups/ root under the gateway stateDir. */
export function backupsRoot(stateDir: string): string {
  return join(stateDir, JOURNAL_BACKUPS_REL)
}

/** backups/<op-id>/ directory for one op (may not exist yet). */
export function backupDirFor(stateDir: string, opId: string): string {
  return join(backupsRoot(stateDir), opId)
}

export function createPluginsJournal(stateDir: string, logger: JournalLogger): PluginsJournal {
  const root = thirdPartyRoot(stateDir)
  const filePath = journalFilePath(stateDir)
  const backupRoot = backupsRoot(stateDir)

  /** Corruption observed by THIS instance; sticky: "no pending op" is still not a fact about lost records. */
  let corruption: { error: string; asidePath: string | null } | null = null
  /** Unresolved corrupt-journal evidence from earlier runs, scanned once. */
  let priorEvidence: string[] | null = null
  let warnedCleanupBlocked = false

  function ensureRoot(): void {
    ensurePrivateDirectoryNoFollow(root, 0o700)
  }

  function readFileText(): string | null {
    // ENOENT (absent file or root) means an empty journal; every other failure
    // is corrupt evidence (see noteCorruption) — the wrapper rethrows all but ENOENT.
    return readPrivateTextOrNull(filePath, { tightenMode: 0o600, requiredMode: 0o600, maxBytes: JOURNAL_MAX_BYTES })
  }

  /** `journal.json.corrupt-*` asides from earlier runs: while one exists the journal must never read as "empty". */
  function corruptEvidence(): string[] {
    if (priorEvidence === null) {
      try {
        priorEvidence = readdirSync(root).filter(name => name.startsWith(CORRUPT_ASIDE_PREFIX))
      } catch {
        // No third-party root yet: nothing was ever recorded, nothing to keep.
        priorEvidence = []
      }
    }
    return priorEvidence
  }

  /** No backup cleanup while the record set is unknown: a "looks unreferenced" dir may be a lost op's only rollback material. */
  function cleanupBlocked(): boolean {
    return corruption !== null || corruptEvidence().length > 0
  }

  /** Corrupt journal → rename aside + warn + fresh start (never silent, never
   * crash-looping), and never the same answer as "empty" for the caller. */
  function noteCorruption(cause: unknown): void {
    if (corruption !== null) return
    const aside = join(root, `${CORRUPT_ASIDE_PREFIX}${Date.now()}`)
    logger.warn(
      `plugins-journal: journal is corrupt or unreadable (${messageOf(cause)}); moving it aside to ${aside} ` +
      'and starting a fresh journal — the pending-operation set is UNKNOWN, no preImage is reclaimed and ' +
      'no orphan child is judged from these records',
    )
    let asidePath: string | null = aside
    try {
      renameSync(filePath, aside)
    } catch (error) {
      asidePath = null
      logger.warn(`plugins-journal: could not move corrupt journal aside: ${messageOf(error)}`)
    }
    corruption = { error: messageOf(cause), asidePath }
  }

  /** One read outcome: parsed ops, or "unreadable" (corruption noted and sticky); absent file = empty journal. */
  function loadOps(): { ok: true; ops: JournalOp[] } | { ok: false } {
    let text: string | null
    try {
      text = readFileText()
    } catch (error) {
      noteCorruption(error)
      return { ok: false }
    }
    if (text === null) return { ok: true, ops: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      noteCorruption(error)
      return { ok: false }
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { ops?: unknown }).ops)) {
      noteCorruption(new Error('journal payload is not a {version, ops} object'))
      return { ok: false }
    }
    return { ok: true, ops: (parsed as { ops: JournalOp[] }).ops }
  }

  /** Op list for projections/writes; an unreadable journal yields none (surfaced by integrity()). */
  function loadOpsOrEmpty(): JournalOp[] {
    const loaded = loadOps()
    return loaded.ok ? loaded.ops : []
  }

  function persistOps(ops: JournalOp[]): void {
    ensureRoot()
    if (corruption !== null && corruption.asidePath === null) {
      // The unreadable original could not be moved aside: overwriting it would
      // destroy the only evidence of the lost records. Fail closed.
      throw new Error(`plugins-journal: refusing to overwrite an unreadable journal (${corruption.error})`)
    }
    const text = `${JSON.stringify({ version: 1, ops }, undefined, 2)}\n`
    atomicWritePrivateFileNoFollow(filePath, text, { mode: 0o600 })
  }

  /** Prune to the newest RETENTION_LIMIT ops and drop backup dirs no retained op
   * references; while the record set is unknown NOTHING is deleted. */
  function pruneAndClean(ops: JournalOp[]): JournalOp[] {
    const retained = newestFirst(ops).slice(0, JOURNAL_RETENTION_LIMIT)
    if (cleanupBlocked()) {
      if (!warnedCleanupBlocked) {
        warnedCleanupBlocked = true
        logger.warn(
          'plugins-journal: journal integrity is unknown (corrupt journal evidence on disk); skipping ' +
          'backup-directory cleanup — every preImage is retained until the operator resolves the evidence',
        )
      }
      return [...retained].reverse()
    }
    if (!existsSync(backupRoot)) return [...retained].reverse()
    const referenced = new Set(retained.map(op => op.preImage).filter((value): value is string => value !== null))
    for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || referenced.has(entry.name)) continue
      try {
        rmSync(join(backupRoot, entry.name), { recursive: true, force: true })
      } catch (error) {
        logger.warn(`plugins-journal: could not remove unreferenced backup ${entry.name}: ${messageOf(error)}`)
      }
    }
    return [...retained].reverse()
  }

  return {
    appendPending(input) {
      const op: JournalOp = {
        id: randomUUID(),
        ts: Date.now(),
        kind: input.kind,
        name: input.name,
        preImage: null,
        status: 'pending',
      }
      if (input.spec !== undefined) op.spec = input.spec
      if (input.version !== undefined) op.version = input.version
      if (input.initiator !== undefined) op.initiator = input.initiator
      if (input.undoOf !== undefined) op.undoOf = input.undoOf
      const ops = loadOpsOrEmpty()
      ops.push(op)
      persistOps(ops)
      logger.log(`plugins-journal: recorded ${input.kind} ${input.name} (op ${op.id})`)
      return op.id
    },

    recordPreImage(opId) {
      const ops = loadOpsOrEmpty()
      const op = ops.find(candidate => candidate.id === opId)
      if (op === undefined) return
      op.preImage = opId
      persistOps(ops)
    },

    markChildPid(opId, pid) {
      if (!Number.isInteger(pid) || pid <= 1) return
      const ops = loadOpsOrEmpty()
      const op = ops.find(candidate => candidate.id === opId)
      if (op === undefined) return
      op.childPid = pid
      persistOps(ops)
    },

    markTerminal(opId, patch) {
      const ops = loadOpsOrEmpty()
      const op = ops.find(candidate => candidate.id === opId)
      if (op === undefined) return null
      op.status = patch.status
      if (patch.error === undefined) delete op.error
      else op.error = patch.error
      if (patch.restarted === undefined) delete op.restarted
      else op.restarted = patch.restarted
      // Terminal op: a stale pid must never be reaped as an orphan by a later boot.
      delete op.childPid
      const retained = pruneAndClean(ops)
      persistOps(retained)
      return op
    },

    recent(limit = JOURNAL_RETENTION_LIMIT) {
      return newestFirst(loadOpsOrEmpty()).slice(0, limit)
    },

    reconcile() {
      const ops = loadOpsOrEmpty()
      const reconciled: JournalOp[] = []
      for (const op of ops) {
        if (op.status !== 'pending') continue
        op.status = 'failed'
        op.error = 'interrupted before completion; preImage retained'
        // The returned copy keeps childPid so the caller can reap the
        // still-running child; the PERSISTED failed record drops it.
        reconciled.push({ ...op })
        delete op.childPid
      }
      if (reconciled.length > 0) {
        persistOps(ops)
        logger.warn(
          `plugins-journal: reconciled ${reconciled.length} interrupted operation(s) from a previous run ` +
          '(marked failed; preImage retained)',
        )
      }
      return reconciled
    },

    integrity() {
      // Force one real read: an unread journal file must never report 'ok' unwatched.
      const loaded = loadOps()
      if (!loaded.ok || corruption !== null) {
        const known = corruption ?? { error: 'journal is unreadable', asidePath: null }
        return { state: 'corrupt', error: known.error, asidePath: known.asidePath }
      }
      const evidence = corruptEvidence()
      if (evidence.length > 0) {
        return {
          state: 'corrupt',
          error: `unresolved corrupt-journal evidence from a previous run: ${evidence.join(', ')}`,
          asidePath: join(root, evidence[evidence.length - 1]!),
        }
      }
      return { state: 'ok' }
    },
  }
}
