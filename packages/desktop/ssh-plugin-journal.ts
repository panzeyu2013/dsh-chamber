/**
 * Main-process ssh plugin undo journal (design 21 §6.4/§6.8 r2 + plan Phase 5
 * ssh 统一增量). Pure Node — no Electron import — so the whole module is
 * unit-testable standalone; the desktop main passes `app.getPath('userData')`
 * as the directory and a console-like logger.
 *
 * Purpose: every executed remote plugin change (the registry add/remove rows
 * applyPlugins executes) is durably recorded per instance so the UI can offer
 * 「撤销最近变更」(undo the latest ok change). The undoable fact per op is
 * `specBefore` — the UNMASKED remote manifest dependency spec of the touched
 * name BEFORE the change (captured by a pre-change remote `cat`, see
 * applyPlugins' journal wiring). Undo semantics (v1, decided in
 * ssh-apply-rows.ts buildSshUndoDecision — design 21 §6.4 「撤销=恢复」):
 *   - undoing an ok `add` whose name was ABSENT before (specBefore null) =
 *     remove that name again;
 *   - undoing an ok `add` that REPLACED an existing row (specBefore
 *     non-null, an in-place upgrade) = RESTORE the previous registry spec
 *     (re-add `name@specBefore`) — a plain remove would delete a plugin
 *     that existed before the change;
 *   - undoing an ok `remove` = re-add `name@specBefore` — locked registry
 *     version values only; a previous `file:` spec (a remote materialized
 *     tarball path) is not re-addable in v1 (`unavailable: 'file-backed'`)
 *     and x-wildcard/non-version values are refused (`unavailable: 'none'`).
 *
 * The journal never stores the pre-change manifest text beyond the touched
 * row (`specBefore`); the full pre-change remote package.json backup design
 * (design 21 §6.4 「变更前远端 package.json 备份」) is represented in v1 by
 * this per-row snapshot value (the mechanism is the same pre-change remote
 * read; the full-text backup for the r2 profile_corrupt recovery ladder is a
 * later phase).
 *
 * Hygiene (mirrors the gateway plugins-journal + the desktop private-file
 * discipline):
 *   - one journal file `<dir>/ssh-plugin-journal.json`, schema {version:1,
 *     ops:[…]} — ops are kept OLDEST-first, bounded to the newest
 *     SSH_PLUGIN_JOURNAL_RETENTION entries per file (a busy other instance
 *     can evict an old op of this instance — same global budget the gateway
 *     journal uses);
 *   - writes are atomic (tmp + fsync + rename) and 0600;
 *   - reads are no-follow, inode-checked, tightened to 0600 and bounded to
 *     ≤ SSH_PLUGIN_JOURNAL_MAX_BYTES;
 *   - a corrupt/unreadable journal is renamed aside as
 *     `ssh-plugin-journal.json.corrupt-<ts>` (evidence retained, warn logged)
 *     and a fresh journal starts — never silent, never crash-looping;
 *   - record() never throws (persistence failures are caught, warned and
 *     dropped) so journaling can never break an apply.
 */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Journal file name (under the directory createSshPluginJournal receives —
 *  the desktop passes `app.getPath('userData')`). */
export const SSH_PLUGIN_JOURNAL_FILE = 'ssh-plugin-journal.json'

/** Bounded-read ceiling for journal.json (each op is ~200 bytes; 64 KiB
 *  admits ~200 ops while the retention keeps the file far below that). */
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
  /** The OPERATIONAL TARGET the change was executed on (main.ts
   * operationalFingerprint: kind/transport/host/user/ports/serviceName/
   * remoteDshHome). Undo must never replay an op onto a DIFFERENT target
   * that happens to reuse the same instance id after a connection edit
   * (design 21 §6.4 review P1): ops are undoable only when this fingerprint
   * equals the CURRENT target's. null = recorded without a binding (legacy/
   * unbound callers) — such ops are never undoable (the target cannot be
   * proven). */
  fingerprint: string | null
  /** The touched plugin name. */
  name: string
  kind: SshJournalOpKind
  /**
   * The UNMASKED remote manifest dependency spec of `name` before the change
   * (null when the name was absent before — the normal case for an add — or
   * when the pre-change snapshot could not be read). Stored main-process-
   * internally and never projected to the renderer; the undo IPC only ever
   * re-submits a REGISTRY re-add spec derived from it.
   */
  specBefore: string | null
  /** Whether the remote change row itself succeeded. Failed rows are kept
   *  (audit) but are never undoable — latestOk filters them. */
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
  /** Operational target fingerprint at record time (see SshJournalOp).
   *  Optional so unbound call sites/tests compile; main always passes it. */
  fingerprint?: string | null
  name: string
  kind: SshJournalOpKind
  specBefore: string | null
  ok: boolean
  error?: string
}

export interface SshPluginJournal {
  /**
   * Durably record one executed remote plugin change. Never throws: a
   * persistence failure is caught, warned and dropped (journaling is
   * best-effort and must never break an apply).
   */
  record(entry: SshJournalEntry): void
  /** The newest OK op recorded for one instance, or null. */
  latestOk(instanceId: string): SshJournalOp | null
  /** The newest OK op recorded for one instance ON THE GIVEN OPERATIONAL
   * TARGET, or null. Ops whose recorded fingerprint differs (a connection
   * edit under the same id) or is null (unbound/legacy) are never returned —
   * undo must not replay a change onto the wrong host (design 21 §6.4). */
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
  return error instanceof Error ? error.message : String(error)
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

/**
 * Bounded no-follow read of the journal (regular file only, opened-inode
 * compared, 0600-tightened before bytes enter memory, ≤ MAX_BYTES). Returns
 * null when the file does not exist (an empty journal); throws on any other
 * failure (the caller treats it as corrupt evidence).
 */
function readJournalText(file: string): string | null {
  let pathStat: Stats
  try {
    pathStat = lstatSync(file)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`journal path must be a regular file (symlinks are refused): ${file}`)
  }
  if (pathStat.size > SSH_PLUGIN_JOURNAL_MAX_BYTES) {
    throw new Error(`journal exceeds the ${SSH_PLUGIN_JOURNAL_MAX_BYTES}-byte read bound`)
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const fd = openSync(file, fsConstants.O_RDONLY | noFollow)
  try {
    const openedStat = fstatSync(fd)
    if (!openedStat.isFile()
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino) {
      throw new Error(`journal path changed while opening: ${file}`)
    }
    fchmodSync(fd, 0o600)
    if (openedStat.size > SSH_PLUGIN_JOURNAL_MAX_BYTES) {
      throw new Error(`journal exceeds the ${SSH_PLUGIN_JOURNAL_MAX_BYTES}-byte read bound`)
    }
    const bytes = Buffer.alloc(openedStat.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (read <= 0) break
      offset += read
    }
    return bytes.toString('utf8')
  } finally {
    closeSync(fd)
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

/** Keep entries our writer could produce; drop anything else defensively
 *  (a partial external edit must never crash a journal read). */
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
    // Atomic write (tmp + fsync + rename), 0600 — the same pattern the
    // desktop credential mirrors use (open/fchmod/write/fsync/close; the
    // fchmod forces owner-only permissions on a pre-existing wider tmp file
    // — hard-crash residue — before any bytes are written, and the rename
    // replaces a planted symlink rather than following it).
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, `${JSON.stringify({ version: 1, ops }, undefined, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
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
