/**
 * Owner-only append-only audit trail core (design 17 §13.4.4, S24) — the
 * single source for BOTH audit surfaces:
 *
 *  - packages/gateway/src/audit.ts (public request boundary), and
 *  - packages/desktop/audit-log.ts (desktop main process), reached through
 *    the desktop control-plane facade (control-plane-module.ts).
 *
 * Shared here (dedupe audit E-4/N11, 2026-09): the rotation cap, the
 * non-secret event shape, the whitelist serializer (S24 — the written JSON
 * is rebuilt from a fixed field whitelist so a stray secret field a caller
 * wrongly attaches can never reach disk), and the hardened append/rotate
 * mechanics (no-follow single-link leaves with descriptor/path identity
 * checks, 0600 with loose legacy modes tightened at open, fsync + directory
 * fsync on first creation). Failures propagate to the caller: each surface
 * wrapper keeps its own loud-but-non-fatal contract (an audit trail must
 * never take auth/connection management down with it).
 *
 * Pure Node built-ins + the control-plane private-file helpers — no
 * electron, no IPC.
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
} from './private-file.ts'

/** Rotation cap of the active audit file (5 MiB; the trail is bounded at
 * 2 × cap including `<file>.1`). */
export const AUDIT_TRAIL_MAX_BYTES = 5 * 1024 * 1024

/** One non-secret audit event. Every field is public metadata only; no field
 * may ever carry a credential, cookie or session body (S24). */
export interface AuditTrailEvent {
  /** ISO-8601 timestamp (e.g. `new Date().toISOString()`). */
  ts: string
  /** Event name — e.g. `transport_phase`, `login_success`,
   * `login_invalid_credentials`, `credential_set`. */
  event: string
  /** Non-secret source (registry instance id; gateway login events use
   * kind `gateway`). */
  sourceId?: string
  /** Target kind (`dsh` | `gateway`). */
  kind?: string
  /** Transport method (`ssh` | `http`). */
  transport?: string
  /** Non-secret detail (phase, auth-result code, client address, …). */
  detail?: string
}

/** The ONLY fields ever written (whitelist serializer, S24). */
const WRITTEN_FIELDS: ReadonlyArray<keyof AuditTrailEvent> = ['ts', 'event', 'sourceId', 'kind', 'transport', 'detail']

/** Rebuild the JSON line from the whitelist only; throw on a missing required
 * field (the append is then skipped loudly — never a partial line). */
export function serializeAuditEvent(event: AuditTrailEvent): Record<string, string> {
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
 * that same single-link inode.
 *
 * POSIX mode discipline only: Windows chmod/stat can express just the
 * read-only attribute, so a mode can never equal 0o600 there — enforcing and
 * re-verifying it would fail EVERY append on win32 (same platform policy as
 * the private-file helpers; audit-trail review 2026-09). */
function openForAppend(file: string, expected: PrivateFileIdentity | null): {
  fd: number
  identity: PrivateFileIdentity
  created: boolean
} {
  const posixModeSemantics = process.platform !== 'win32'
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
    if (posixModeSemantics) {
      const descriptor = fstatSync(fd)
      if ((descriptor.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
      const tightened = assertSafeStat(file, fstatSync(fd))
      if (!sameIdentity(tightened.identity, opened.identity)
        || (fstatSync(fd).mode & 0o777) !== 0o600) {
        throw new Error(`audit leaf became unsafe while tightening mode: ${file}`)
      }
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

/** Append one pre-serialized audit line (a complete JSONL line INCLUDING its
 * trailing newline — serialization lives in the caller so each surface keeps
 * its own prefix/error wording) under the full no-follow/identity/rotation
 * discipline. Throws on failure; surfaces keep their own
 * loud-but-non-fatal wrapper contracts. */
export function appendAuditTrailLine(file: string, line: string, maxBytes: number): void {
  if (!line.endsWith('\n')) {
    // The historical double-newline bug (2026-09) appended a second newline
    // here; the contract is: the line arrives COMPLETE from the serializer
    // wrapper. Assert it so a future wrapper cannot reintroduce the bug.
    throw new Error('audit line must be a complete JSONL line ending with a newline')
  }
  const parent = dirname(file)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const parentStat = lstatSync(parent)
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`audit parent is not a real directory: ${parent}`)
  }
  const expected = rotateIfNeeded(file, maxBytes)
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
