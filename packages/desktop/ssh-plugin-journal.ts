/**
 * Main-process ssh plugin undo journal (pure Node, unit-testable; desktop main passes
 * `app.getPath('userData')` and a console-like logger).
 *
 * Every executed remote plugin change (applyPlugins' add/remove rows) is recorded per instance. The
 * undoable fact is `specBefore` — the UNMASKED remote manifest spec of the touched name BEFORE the
 * change. Undo: absent-before add → remove again; replacing add → RESTORE the previous registry spec;
 * remove → re-add `name@specBefore`, except `file:`/x-wildcard/non-version (unavailable in v1).
 * Hygiene: `<dir>/ssh-plugin-journal.json` (`{version:1, ops:[…]}`, oldest-first, capped at
 * SSH_PLUGIN_JOURNAL_RETENTION); atomic 0600 writes; no-follow/inode-checked bounded reads; corrupt
 * journals are renamed aside `.corrupt-<ts>`; record() never throws.
 */

import { randomUUID } from 'node:crypto'
import { describeError } from './describe-error.ts'
import { renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
// The owner-private file primitives are single-sourced in control-plane (private-file.ts) and
// reached through the desktop dual-path facade (packaged → compiled dist, dev → workspace source).
import { atomicWritePrivateFileNoFollow, ensurePrivateDirectoryNoFollow, readPrivateFileNoFollow } from './control-plane-module.ts'
import { removeLegacyTmpResidue } from './store-file-hygiene.ts'

/** Journal file name (under the directory createSshPluginJournal receives). */
export const SSH_PLUGIN_JOURNAL_FILE = 'ssh-plugin-journal.json'

/** Bounded-read ceiling for journal.json (each op is ~200 bytes; 64 KiB admits ~200 ops). */
export const SSH_PLUGIN_JOURNAL_MAX_BYTES = 64 * 1024

/** Retention: the file keeps the newest N ops (per file, across instances). */
export const SSH_PLUGIN_JOURNAL_RETENTION = 50

/** The op kinds the ssh apply flow can journal. */
export type SshJournalOpKind = 'add' | 'remove'

/** One recorded ssh plugin change. */
export interface SshJournalOp {
  /** Unique op id (module-generated). */
  id: string
  /** Epoch-ms record time. */
  ts: number
  /** The ssh instance (connection id) the change was executed on. */
  instanceId: string
  /** The OPERATIONAL TARGET the change was executed on (main.ts operationalFingerprint:
   * name/kind/transport/host/user/ports/serviceName/remoteDshHome). Ops are undoable only when this
   * fingerprint equals the CURRENT target's — undo must never replay onto a DIFFERENT target that
   * reuses the same instance id after a connection edit. null = recorded unbound, never undoable. */
  fingerprint: string | null
  /** The touched plugin name. */
  name: string
  kind: SshJournalOpKind
  /** The UNMASKED remote manifest spec of `name` before the change (null = absent before or the
   *  snapshot could not be read). Stored main-process-internally, never projected; the undo IPC only
   *  re-submits a REGISTRY re-add spec derived from it. */
  specBefore: string | null
  /** Whether the remote row succeeded; failed rows are kept for audit but never undoable. */
  ok: boolean
  /** Row failure reason (sanitized); present only when ok === false. */
  error?: string
}

/** Console-like sink (the journal never logs secret material). */
export interface SshJournalLogger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
}

export interface SshJournalEntry {
  instanceId: string
  /** Operational target fingerprint at record time (see SshJournalOp); optional only so unbound
   *  call sites compile — main always passes it. */
  fingerprint?: string | null
  name: string
  kind: SshJournalOpKind
  specBefore: string | null
  ok: boolean
  error?: string
}

export interface SshPluginJournal {
  /** Durably record one executed remote plugin change. Never throws: a persistence failure is
   *  caught, warned and dropped (journaling must never break an apply). */
  record(entry: SshJournalEntry): void
  /** The newest OK op recorded for one instance, or null. */
  latestOk(instanceId: string): SshJournalOp | null
  /** The newest OK op recorded for one instance ON THE GIVEN OPERATIONAL TARGET, or null. Ops whose
   *  fingerprint differs (connection edit under the same id) or is null (unbound/legacy) are never
   *  returned — undo must not replay a change onto the wrong host. */
  latestOkForTarget(instanceId: string, fingerprint: string): SshJournalOp | null
  /** Newest-first projection of the retained ops (default: all retained). */
  recent(limit?: number): SshJournalOp[]
  /** Drop every op recorded for one instance (connection deletion hook). */
  clear(instanceId: string): void
}

/** journal.json path under the journal directory. */
export function sshPluginJournalFile(dir: string): string {
  return join(dir, SSH_PLUGIN_JOURNAL_FILE)
}

function messageOf(error: unknown): string {
  return describeError(error)
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

/**
 * Bounded no-follow read (control-plane read primitive: pinned real parent, single-link regular leaf
 * only, opened-inode compared, 0600-tightened before bytes enter memory, ≤ SSH_PLUGIN_JOURNAL_MAX_BYTES).
 * Returns null when the file does not exist (an empty journal); throws on any other failure (the
 * caller treats it as corrupt evidence).
 */
function readJournalText(file: string): string | null {
  try {
    return readPrivateFileNoFollow(file, {
      maxBytes: SSH_PLUGIN_JOURNAL_MAX_BYTES,
      tightenMode: 0o600,
    }).value
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
}

/** Corrupt/unreadable journal → rename aside + warn + fresh start. */
function asideCorrupt(file: string, cause: unknown, logger: SshJournalLogger): void {
  const aside = `${file}.corrupt-${Date.now()}`
  logger.warn(
    `ssh-plugin-journal: journal is corrupt or unreadable (${messageOf(cause)}); ` +
    `moving it aside to ${aside} and starting a fresh journal`,
  )
  try {
    renameSync(file, aside)
  } catch (error) {
    logger.warn(`ssh-plugin-journal: could not move corrupt journal aside: ${messageOf(error)}`)
  }
}

/** Keep entries our writer could produce; drop anything else defensively (a partial external edit must never crash a read). */
function sanitizeOps(parsed: unknown): SshJournalOp[] | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const rawOps = (parsed as { ops?: unknown }).ops
  if (!Array.isArray(rawOps)) return null
  const ops: SshJournalOp[] = []
  for (const raw of rawOps) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    if (typeof record.id !== 'string'
      || typeof record.ts !== 'number'
      || typeof record.instanceId !== 'string'
      || typeof record.name !== 'string'
      || (record.kind !== 'add' && record.kind !== 'remove')
      || typeof record.ok !== 'boolean') continue
    const op: SshJournalOp = {
      id: record.id,
      ts: record.ts,
      instanceId: record.instanceId,
      name: record.name,
      kind: record.kind,
      fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : null,
      specBefore: typeof record.specBefore === 'string' || record.specBefore === null
        ? record.specBefore
        : null,
      ok: record.ok,
    }
    if (typeof record.error === 'string') op.error = record.error
    ops.push(op)
  }
  return ops
}

export function createSshPluginJournal(dir: string, logger: SshJournalLogger): SshPluginJournal {
  const file = sshPluginJournalFile(dir)
  // One-time crash-residue sweep of the legacy fixed `${file}.tmp` residue.
  removeLegacyTmpResidue(file)

  function loadOps(): SshJournalOp[] {
    let text: string | null
    try {
      text = readJournalText(file)
    } catch (error) {
      asideCorrupt(file, error, logger)
      return []
    }
    if (text === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      asideCorrupt(file, error, logger)
      return []
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      asideCorrupt(file, new Error('journal payload is not an object'), logger)
      return []
    }
    const version = (parsed as { version?: unknown }).version
    if (version !== 1) {
      asideCorrupt(file, new Error(`journal schema version ${String(version)} is not supported`), logger)
      return []
    }
    const ops = sanitizeOps(parsed)
    if (ops === null) {
      asideCorrupt(file, new Error('journal payload has no ops array'), logger)
      return []
    }
    return ops
  }

  function persistOps(ops: SshJournalOp[]): void {
    // Atomic replace, 0600 — control-plane private-file primitive (random O_EXCL tmp + fsync +
    // rename + parent fsync, explicit { mode: 0o600 }); refuses a planted symlink / multi-link leaf
    // fail-closed. record() never throws (the caller warns and drops).
    ensurePrivateDirectoryNoFollow(dirname(file), 0o700)
    atomicWritePrivateFileNoFollow(file, `${JSON.stringify({ version: 1, ops }, undefined, 2)}\n`, { mode: 0o600 })
  }

  /** Newest-first; ties (same-ms appends) break toward later insertion. */
  function newestFirst(ops: SshJournalOp[]): SshJournalOp[] {
    return ops
      .map((op, index) => ({ op, index }))
      .sort((a, b) => b.op.ts - a.op.ts || b.index - a.index)
      .map(entry => entry.op)
  }

  function safeRecord(entry: SshJournalEntry, ops: SshJournalOp[]): SshJournalOp {
    const op: SshJournalOp = {
      id: randomUUID(),
      ts: Date.now(),
      instanceId: entry.instanceId,
      name: entry.name,
      kind: entry.kind,
      fingerprint: entry.fingerprint === undefined ? null : entry.fingerprint,
      specBefore: entry.specBefore,
      ok: entry.ok,
    }
    if (entry.error !== undefined && entry.error !== '') op.error = entry.error
    ops.push(op)
    return op
  }

  return {
    record(entry) {
      try {
        const ops = loadOps()
        const op = safeRecord(entry, ops)
        // Retention: keep the newest RETENTION ops (file stays OLDEST-first).
        const retained = newestFirst(ops).slice(0, SSH_PLUGIN_JOURNAL_RETENTION).reverse()
        persistOps(retained)
        logger.log(
          `ssh-plugin-journal: recorded ${entry.kind} ${entry.name} on ${entry.instanceId} ` +
          `(${op.id}, ok=${String(entry.ok)})`,
        )
      } catch (error) {
        logger.warn(`ssh-plugin-journal: could not persist record: ${messageOf(error)}`)
      }
    },

    latestOk(instanceId) {
      const ops = loadOps()
      for (const op of newestFirst(ops)) {
        if (op.instanceId === instanceId && op.ok) return op
      }
      return null
    },

    latestOkForTarget(instanceId, fingerprint) {
      const ops = loadOps()
      for (const op of newestFirst(ops)) {
        if (op.instanceId === instanceId && op.ok && op.fingerprint === fingerprint) return op
      }
      return null
    },

    recent(limit = SSH_PLUGIN_JOURNAL_RETENTION) {
      return newestFirst(loadOps()).slice(0, limit)
    },

    clear(instanceId) {
      try {
        const ops = loadOps()
        const retained = ops.filter(op => op.instanceId !== instanceId)
        if (retained.length === ops.length) return
        persistOps(retained)
        logger.log(`ssh-plugin-journal: cleared ops for ${instanceId}`)
      } catch (error) {
        logger.warn(`ssh-plugin-journal: could not clear ops for ${instanceId}: ${messageOf(error)}`)
      }
    },
  }
}
