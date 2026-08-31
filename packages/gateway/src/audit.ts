/**
 * Gateway server-side audit projection (design 17 §13.4.4, S24): append-only
 * JSONL of NON-SECRET events — time, source, auth result. Credentials,
 * cookies and session bodies never enter: the written JSON is rebuilt from a
 * fixed field whitelist, so a stray field a caller wrongly attaches (even a
 * password/cookie) can never reach disk.
 *
 * Same discipline as the desktop audit-log (packages/desktop/audit-log.ts):
 * O_APPEND + complete writes + fsync, 0600 (loose legacy modes tightened at
 * open), and rotation to `<file>.1` once the active file reaches the cap (the
 * previous `.1` is deleted first). Both leaves are no-follow, single-link
 * regular files with descriptor/path identity checks. Failures are LOUD but
 * non-fatal — a broken audit trail must not take the auth surface down with it
 * (the log is a record, not a gate).
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  removePrivateFileNoFollow,
  syncPrivateDirectoryNoFollow,
  type PrivateFileIdentity,
} from '@dsh-chamber/control-plane'

/** Rotation cap of the active audit file (5 MiB; the trail is bounded at
 * 2 × cap including `<file>.1`). */
export const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024

/** One non-secret audit event. Every field is public metadata only; no field
 * may ever carry a credential, cookie or session body (S24). */
export interface AuditEvent {
  /** ISO-8601 timestamp (e.g. `new Date().toISOString()`). */
  ts: string
  /** Event name — e.g. `login_success`, `login_invalid_credentials`,
   * `login_rate_limited`, `login_busy`, `login_rejected`. */
  event: string
  /** Non-secret source (instance id on the desktop side; gateway login
   * events use kind `gateway`). */
  sourceId?: string
  /** Target kind (`dsh` | `gateway`). */
  kind?: string
  /** Transport method (`ssh` | `http`). */
  transport?: string
  /** Non-secret detail (client address, auth-result code, …). */
  detail?: string
}

/** The ONLY fields ever written (whitelist serializer, S24). */
const WRITTEN_FIELDS: ReadonlyArray<keyof AuditEvent> = ['ts', 'event', 'sourceId', 'kind', 'transport', 'detail']

/** Rebuild the JSON line from the whitelist only; throw on a missing required
 * field (the append is then skipped loudly — never a partial line). */
function serialize(event: AuditEvent): Record<string, string> {
  if (typeof event.ts !== 'string' || typeof event.event !== 'string') {
    throw new TypeError('audit event requires string ts and event fields')
  }
  const line: Record<string, string> = { ts: event.ts, event: event.event }
  for (const key of WRITTEN_FIELDS) {
    if (key === 'ts' || key === 'event') continue
    const value = event[key]
    if (value !== undefined && value !== null && value !== '') line[key] = String(value)
  }
  return line
}

interface AuditLeaf {
  identity: PrivateFileIdentity
  size: number
}

function identityOf(stat: Stats): PrivateFileIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameIdentity(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertSafeStat(path: string, stat: Stats): AuditLeaf {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`audit leaf is not a single-link regular file: ${path}`)
  }
  return { identity: identityOf(stat), size: stat.size }
}

/** lstat is deliberate: an attacker-controlled symlink is evidence, never an
 * absent audit file. Only ENOENT is treated as absence. */
function inspectLeaf(path: string): AuditLeaf | null {
  try {
    return assertSafeStat(path, lstatSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function inspectExpectedLeaf(path: string, expected: PrivateFileIdentity): AuditLeaf {
  const current = inspectLeaf(path)
  if (current === null || !sameIdentity(current.identity, expected)) {
    throw new Error(`audit leaf identity changed: ${path}`)
  }
  return current
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

/** Open the exact active identity (or exclusively create a missing leaf),
 * tighten it through the descriptor, then prove the namespace still names
 * that same single-link inode. */
function openForAppend(file: string, expected: PrivateFileIdentity | null): {
  fd: number
  identity: PrivateFileIdentity
  created: boolean
} {
  const created = expected === null
  const flags = constants.O_WRONLY | constants.O_APPEND | noFollowFlag()
    | (created ? constants.O_CREAT | constants.O_EXCL : 0)
  const fd = openSync(file, flags, 0o600)
  try {
    const opened = assertSafeStat(file, fstatSync(fd))
    if (expected !== null && !sameIdentity(opened.identity, expected)) {
      throw new Error(`audit leaf changed while opening: ${file}`)
    }
    const atPath = inspectExpectedLeaf(file, opened.identity)
    if (!sameIdentity(atPath.identity, opened.identity)) {
      throw new Error(`audit leaf path does not match its descriptor: ${file}`)
    }
    const descriptor = fstatSync(fd)
    if ((descriptor.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
    const tightened = assertSafeStat(file, fstatSync(fd))
    if (!sameIdentity(tightened.identity, opened.identity)
      || (fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error(`audit leaf became unsafe while tightening mode: ${file}`)
    }
    inspectExpectedLeaf(file, opened.identity)
    return { fd, identity: opened.identity, created }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function writeAll(fd: number, value: string): void {
  const bytes = Buffer.from(value)
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written === 0) throw new Error('audit append made no write progress')
    offset += written
  }
}

/** Rotate the active file to `<file>.1` once it reaches `maxBytes`. Unsafe
 * active/archive evidence aborts the whole append without modifying either
 * namespace entry. Returns the identity to append to, or null when the active
 * file is absent after a successful rotation. */
function rotateIfNeeded(file: string, maxBytes: number): PrivateFileIdentity | null {
  const active = inspectLeaf(file)
  if (active === null || active.size < maxBytes) return active?.identity ?? null

  const archivePath = `${file}.1`
  // Validate the archive BEFORE touching the active file. A pre-planted
  // symlink/hardlink is preserved as evidence and its victim is untouched.
  const archive = inspectLeaf(archivePath)

  // Tighten and fsync the exact active inode before it becomes the archive.
  const opened = openForAppend(file, active.identity)
  try {
    fsyncSync(opened.fd)
  } finally {
    closeSync(opened.fd)
  }
  inspectExpectedLeaf(file, active.identity)

  if (archive !== null) removePrivateFileNoFollow(archivePath, archive.identity)
  inspectExpectedLeaf(file, active.identity)
  renameSync(file, archivePath)
  inspectExpectedLeaf(archivePath, active.identity)
  if (inspectLeaf(file) !== null) throw new Error(`audit active leaf still exists after rotation: ${file}`)
  syncPrivateDirectoryNoFollow(dirname(file))
  return null
}

function appendLine(file: string, line: string, expected: PrivateFileIdentity | null): void {
  const opened = openForAppend(file, expected)
  let committed = false
  try {
    writeAll(opened.fd, line)
    fsyncSync(opened.fd)
    const after = assertSafeStat(file, fstatSync(opened.fd))
    if (!sameIdentity(after.identity, opened.identity)) {
      throw new Error(`audit descriptor identity changed after append: ${file}`)
    }
    inspectExpectedLeaf(file, opened.identity)
    committed = true
  } finally {
    closeSync(opened.fd)
  }
  // Creating the active file changes the directory namespace; make that
  // publication durable only after the exact file data is fsynced.
  if (committed && opened.created) syncPrivateDirectoryNoFollow(dirname(file))
}

/** Append one non-secret audit event (JSONL). Never throws into the caller;
 * failures are loud but non-fatal. `maxBytes` is the rotation-cap override
 * used by tests (defaults to AUDIT_LOG_MAX_BYTES). */
export function appendAuditEvent(file: string, event: AuditEvent, maxBytes: number = AUDIT_LOG_MAX_BYTES): void {
  if (file === '') return
  // Validate BEFORE touching the filesystem: an invalid event (missing
  // required fields) writes nothing — not even an empty file.
  let line: string
  try {
    line = `${JSON.stringify(serialize(event))}\n`
  } catch (error) {
    console.error(`[gateway audit] ${file}: invalid audit event dropped: ${String(error)}`)
    return
  }
  try {
    const parent = dirname(file)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    const parentStat = lstatSync(parent)
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error(`audit parent is not a real directory: ${parent}`)
    }
    const expected = rotateIfNeeded(file, maxBytes)
    appendLine(file, line, expected)
  } catch (error) {
    console.error(`[gateway audit] ${file}: append failed: ${String(error)}`)
  }
}
