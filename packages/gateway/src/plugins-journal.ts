/**
 * Durable third-party plugin-mutation journal + pre-mutation profile backups
 * (design 21 §6.2/§6.3).
 *
 * Write order for every profile mutation (design 21 §6.3):
 *   ① appendPending — durable intent record (ts/kind/name/spec/initiator);
 *   ② the executor atomically copies `<stateDir>/dsh-home/profiles/web/
 *      package.json` (+ pnpm-lock.yaml when present) into
 *      backups/<op-id>/ and calls recordPreImage;
 *   ③ the mutation runs;
 *   ④ markTerminal — ok/failed/blocked (+ sanitized error + restart outcome).
 *
 * preImage semantics: `preImage` is the op id of a backup directory
 * `<stateDir>/chamber-plugins/third-party/backups/<op-id>/` holding the
 * pre-mutation package.json and (when the profile had one) pnpm-lock.yaml.
 * It is null until the executor actually placed and durably recorded the
 * backup — a rollback/undo surface must only be offered for ops whose
 * preImage is set.
 *
 * Startup reconciliation (reconcile): ops still pending after a crash or
 * shutdown are marked failed — never silent, never crash-looping — and their
 * preImage is retained for the later undo/rollback surface. A pending op's
 * recorded childPid (crash-orphan reaping) rides the RETURNED copies so the
 * caller (plugins-tasks reconcileJournal) can kill the detached child; the
 * persisted failed record drops it.
 *
 * Retention: on every terminal mark the journal is pruned to the newest 50
 * ops and backup directories not referenced by any retained op are removed
 * (best effort).
 *
 * Security/hygiene: journal.json sits under the gateway-owned 0700
 * chamber-plugins/third-party tree and is written with the same owner-private
 * atomic no-follow primitives plugins.ts uses (0600 leaves); reads are
 * bounded (≤ 256 KiB); a corrupt/unreadable journal is renamed aside as
 * journal.json.corrupt-<ts> (evidence retained, warn logged) and a fresh
 * journal starts.
 *
 * Corruption ≠ emptiness: a present file that cannot be
 * read/parsed must never be answered as "no ops recorded". `integrity()`
 * distinguishes the two; a corrupt read makes the pending-op set UNKNOWN, so
 * (a) reconcileJournal refuses the "no pending operations carried over"
 * judgement (there is nothing to reap and nothing to trust), (b) no backup
 * directory is ever reclaimed while corruption or its aside evidence is
 * unresolved (an unreferenced preImage may be the only rollback material of
 * an op whose record was lost), and (c) a write never overwrites an
 * unreadable original that could not be moved aside — it fails closed
 * instead of destroying the evidence.
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

/** Third-party plugin state root (journal, backups, private pnpm env dirs),
 * relative to the gateway stateDir. */
export const THIRD_PARTY_REL = join('chamber-plugins', 'third-party')
/** Journal file, relative to the gateway stateDir. */
export const JOURNAL_FILE_REL = join(THIRD_PARTY_REL, 'journal.json')
/** Backup dir root, relative to the gateway stateDir. */
export const JOURNAL_BACKUPS_REL = join(THIRD_PARTY_REL, 'backups')

/** Bounded-read ceiling for journal.json (design 21 §6.9: ≤50 ops retained). */
export const JOURNAL_MAX_BYTES = 256 * 1024
/** Retention: newest N terminal ops kept, with their backups. */
export const JOURNAL_RETENTION_LIMIT = 50
/** Aside-name prefix for corrupt-journal evidence. */
export const CORRUPT_ASIDE_PREFIX = 'journal.json.corrupt-'
/** The op kinds the journal can record. */
export type JournalOpKind = 'install' | 'remove' | 'materialize'
/** Lifecycle of one recorded op. */
export type JournalOpStatus = 'pending' | 'ok' | 'failed' | 'blocked'
/** Post-mutation restart outcome (recorded by the wiring layer, later). */
export type JournalRestartOutcome = 'ok' | 'failed' | 'skipped'

/** Journal read integrity: "nothing was ever recorded" and "the record could
 *  not be read" are different facts and must never collapse into one. */
export type JournalIntegrity =
  | { state: 'ok' }
  | {
    state: 'corrupt'
    /** Why the journal was judged corrupt/unreadable (message only). */
    error: string
    /** Where the raw bytes were moved aside; null when the move itself failed
     *  (the original then stays in place and writes fail closed). */
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
  /** Declared package version (materialize carries it in the x-plugin-version
   *  header rather than in the `file:` spec) — the submission-time generation
   *  judgement needs it, and a deferred intent that lost it can never drain
   *  (design 21 §6.11.3 R2). */
  version?: string
  /** Reference to the pre-mutation backup dir: backups/<op-id>/ when the
   * executor successfully placed one, null otherwise. */
  preImage: string | null
  /** Human attribution label (desktop connection label) when known. */
  initiator?: string
  /** Pid of the spawned `dsh plugin` child (the detached process-group
   * leader) while the mutation runs; cleared when the op goes terminal.
   * Written by the executor at spawn (design 21 §6.3 crash-orphan reaping):
   * a gateway crash mid-mutation leaves this child alive and writing
   * DSH_HOME — the next boot's reconcileJournal() kills the recorded pid
   * before any new mutation can start. */
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
  /** Declared package version (materialize uploads carry it in the
   *  x-plugin-version header, not in the `file:` spec) — the generation check
   *  (design 21 §6.11.3 R2) needs it for official-scope installs. */
  version?: string
  initiator?: string
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
  /** Write order step ①: durably record a pending op and return its id.
   * Throws on persistence failure (the caller maps it). */
  appendPending(input: JournalPending): string
  /** Write order step ②: durably record that backups/<op-id>/ now holds the
   * pre-mutation profile files. Throws on persistence failure. */
  recordPreImage(opId: string): void
  /** Crash-orphan reaping support: durably record the spawned child pid of a
   * pending op (design 21 §6.3). Throws on persistence failure. */
  markChildPid(opId: string, pid: number): void
  /** Write order step ④: terminal state for an op. No-op (null, no write)
   * when no such op exists; a terminal op may be re-marked (e.g. to attach
   * the restart outcome later). Clears the recorded childPid (the op's child
   * no longer runs). Retention pruning runs on this path. */
  markTerminal(opId: string, patch: JournalTerminalPatch): JournalOp | null
  /** Newest-first projection (default newest 50). */
  recent(limit?: number): JournalOp[]
  /** Startup reconciliation: pending → failed ('interrupted before
   * completion; preImage retained'), persisted once; idempotent (second call
   * rewrites nothing and returns []). Returns the ops it transitioned. On a
   * corrupt journal nothing is readable: the result is [] but integrity()
   * reports 'corrupt' — the caller must never read that [] as "no pending
   * operations". */
  reconcile(): JournalOp[]
  /** Integrity of the journal as of a real read, sticky for this instance:
   *  'corrupt' from the moment a present file cannot be read/parsed (or
   *  unresolved `journal.json.corrupt-*` evidence exists) until the operator
   *  resolves it. While 'corrupt' the pending-op set is UNKNOWN: no orphan
   *  pid may be judged and no preImage may be reclaimed. */
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

  /** Corruption observed by THIS instance. Sticky on purpose: once the bad file
   * is moved aside and a fresh journal starts, "no pending op" is still not a
   * fact about the records that were lost. */
  let corruption: { error: string; asidePath: string | null } | null = null
  /** Unresolved corrupt-journal evidence from earlier runs, scanned once. */
  let priorEvidence: string[] | null = null
  let warnedCleanupBlocked = false

  function ensureRoot(): void {
    ensurePrivateDirectoryNoFollow(root, 0o700)
  }

  function readFileText(): string | null {
    // ENOENT (absent file or absent root) means an empty journal; every other
    // failure is treated as corrupt evidence (see noteCorruption) — the shared
    // wrapper rethrows everything but ENOENT.
    return readPrivateTextOrNull(filePath, { tightenMode: 0o600, requiredMode: 0o600, maxBytes: JOURNAL_MAX_BYTES })
  }

  /** `journal.json.corrupt-*` asides left by earlier runs: unresolved evidence
   * that the record set is incomplete. While one exists the journal must never
   * be read as "empty" for cleanup purposes. */
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

  /** No backup cleanup may run while the journal's record set is unknown:
   * a dir that "looks unreferenced" may be the only rollback material of an
   * op whose record was lost. */
  function cleanupBlocked(): boolean {
    return corruption !== null || corruptEvidence().length > 0
  }

  /** Corrupt/unreadable journal → rename aside + warn + fresh start. Never
   * silent, never crash-looping: the next write creates a clean journal and
   * the aside keeps the evidence for the operator. Never the same answer as
   * "empty": the caller reads integrity() and the lost-op consequences are
   * suppressed (no cleanup, no write over the evidence). */
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

  /** One read outcome: parsed ops, or "unreadable" (corruption already noted
   * and made sticky). An absent file is a genuinely empty journal. */
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

  /** Op list for projections/writes; an unreadable journal yields none (its
   * corruption is sticky and surfaced separately by integrity()). */
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

  /** Prune to the newest RETENTION_LIMIT ops (file keeps oldest-first
   * reading order) and drop backup dirs no retained op references. While the
   * record set is unknown (corruption, or its unresolved aside evidence) the
   * record pruning still runs but NOTHING is deleted: the ops' records are
   * gone, so no dir can be proven unreferenced. */
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
      // The op's child no longer runs once the op is terminal — a stale pid
      // must never be reaped as an orphan by a later boot's reconcile.
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
        // The returned copy keeps the recorded childPid so the caller's
        // crash-orphan kill step can reap the still-running child; the
        // PERSISTED record drops it (the op is failed — a stale pid must
        // never be reaped by a later run).
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
      // Force one real read: an unread journal file must never report 'ok'
      // merely because nothing has looked at it yet.
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
