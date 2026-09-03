/**
 * Durable third-party plugin-mutation journal + pre-mutation profile backups
 * (design 21 §6.2/§6.3, A1 write surface; plan Phase 4.2).
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
 */

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
} from '@dsh-chamber/control-plane'

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
/** The op kinds the journal can record. */
export type JournalOpKind = 'install' | 'remove' | 'materialize'
/** Lifecycle of one recorded op. */
export type JournalOpStatus = 'pending' | 'ok' | 'failed' | 'blocked'
/** Post-mutation restart outcome (recorded by the wiring layer, later). */
export type JournalRestartOutcome = 'ok' | 'failed' | 'skipped'

export interface JournalOp {
  /** Unique op id; also the name of the op's preImage backup directory. */
  id: string
  /** Epoch-ms record time (append time). */
  ts: number
  kind: JournalOpKind
  name: string
  /** Registry spec / materialized file path for install-materialize ops. */
  spec?: string
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
  /** Newest failed op, or null. */
  latestFailed(): JournalOp | null
  /** Startup reconciliation: pending → failed ('interrupted before
   * completion; preImage retained'), persisted once; idempotent (second call
   * rewrites nothing and returns []). Returns the ops it transitioned. */
  reconcile(): JournalOp[]
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPluginsJournal(stateDir: string, logger: JournalLogger): PluginsJournal {
  const root = thirdPartyRoot(stateDir)
  const filePath = journalFilePath(stateDir)
  const backupRoot = backupsRoot(stateDir)

  function ensureRoot(): void {
    ensurePrivateDirectoryNoFollow(root, 0o700)
  }

  function readFileText(): string | null {
    // ENOENT (absent file or absent root) means an empty journal; every other
    // failure is treated as corrupt evidence (see asideCorrupt).
    try {
      return readPrivateFileNoFollow(filePath, { tightenMode: 0o600, requiredMode: 0o600, maxBytes: JOURNAL_MAX_BYTES }).value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** Corrupt/unreadable journal → rename aside + warn + fresh start. Never
   * silent, never crash-looping: the next write creates a clean journal and
   * the aside keeps the evidence for the operator. */
  function asideCorrupt(cause: unknown): void {
    const aside = join(root, `journal.json.corrupt-${Date.now()}`)
    logger.warn(
      `plugins-journal: journal is corrupt or unreadable (${messageOf(cause)}); ` +
      `moving it aside to ${aside} and starting a fresh journal`,
    )
    try {
      renameSync(filePath, aside)
    } catch (error) {
      logger.warn(`plugins-journal: could not move corrupt journal aside: ${messageOf(error)}`)
    }
  }

  function loadOps(): JournalOp[] {
    let text: string | null
    try {
      text = readFileText()
    } catch (error) {
      asideCorrupt(error)
      return []
    }
    if (text === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      asideCorrupt(error)
      return []
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { ops?: unknown }).ops)) {
      asideCorrupt(new Error('journal payload is not a {version, ops} object'))
      return []
    }
    return (parsed as { ops: JournalOp[] }).ops
  }

  function persistOps(ops: JournalOp[]): void {
    ensureRoot()
    const text = `${JSON.stringify({ version: 1, ops }, undefined, 2)}\n`
    atomicWritePrivateFileNoFollow(filePath, text, { mode: 0o600 })
  }

  /** Newest-first; ties (same-ms appends) break toward later insertion. */
  function newestFirst(ops: JournalOp[]): JournalOp[] {
    return ops
      .map((op, index) => ({ op, index }))
      .sort((a, b) => b.op.ts - a.op.ts || b.index - a.index)
      .map(entry => entry.op)
  }

  /** Prune to the newest RETENTION_LIMIT ops (file keeps oldest-first
   * reading order) and drop backup dirs no retained op references. */
  function pruneAndClean(ops: JournalOp[]): JournalOp[] {
    const retained = newestFirst(ops).slice(0, JOURNAL_RETENTION_LIMIT)
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
      if (input.initiator !== undefined) op.initiator = input.initiator
      const ops = loadOps()
      ops.push(op)
      persistOps(ops)
      logger.log(`plugins-journal: recorded ${input.kind} ${input.name} (op ${op.id})`)
      return op.id
    },

    recordPreImage(opId) {
      const ops = loadOps()
      const op = ops.find(candidate => candidate.id === opId)
      if (op === undefined) return
      op.preImage = opId
      persistOps(ops)
    },

    markChildPid(opId, pid) {
      if (!Number.isInteger(pid) || pid <= 1) return
      const ops = loadOps()
      const op = ops.find(candidate => candidate.id === opId)
      if (op === undefined) return
      op.childPid = pid
      persistOps(ops)
    },

    markTerminal(opId, patch) {
      const ops = loadOps()
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
      return newestFirst(loadOps()).slice(0, limit)
    },

    latestFailed() {
      return newestFirst(loadOps()).find(op => op.status === 'failed') ?? null
    },

    reconcile() {
      const ops = loadOps()
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
  }
}
