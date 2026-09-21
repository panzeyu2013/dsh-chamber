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
 * Since 2026-12 the no-follow/identity/mode/fsync primitives themselves are
 * single-sourced in private-file.ts (inspectPrivateLeafNoFollow,
 * openPrivateAppendNoFollow, writePrivateFdAll, removePrivateFileNoFollow,
 * ensurePrivateDirectoryNoFollow); this module keeps only the audit-specific
 * policy (one-slot rotation, evidence-preserving abort, whitelist serializer)
 * on top of them.
 *
 * Pure Node built-ins + the control-plane private-file helpers — no
 * electron, no IPC.
 */
import { closeSync, fstatSync, fsyncSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  assertPrivateLeafStatNoFollow,
  ensurePrivateDirectoryNoFollow,
  inspectPrivateLeafNoFollow,
  openPrivateAppendNoFollow,
  removePrivateFileNoFollow,
  samePrivateIdentity,
  syncPrivateDirectoryNoFollow,
  writePrivateFdAll,
  type PrivateFileIdentity,
} from './private-file.ts'

/** Rotation cap of the active audit file (5 MiB; the trail is bounded at
 * 2 × cap including the `"<file>.1"` archive). */
export const AUDIT_TRAIL_MAX_BYTES = 5 * 1024 * 1024

/** One non-secret audit event. Every field is public metadata only; no field
 * may ever carry a credential, cookie or session body (S24). */
export interface AuditTrailEvent {
  /** ISO-8601 timestamp (e.g. new Date().toISOString()). */
  ts: string
  /** Event name — e.g. transport_phase, login_success,
   * login_invalid_credentials, credential_set. */
  event: string
  /** Non-secret source (registry instance id; gateway login events use
   * kind gateway). */
  sourceId?: string
  /** Target kind (dsh | gateway). */
  kind?: string
  /** Transport method (ssh | http). */
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

/** Rotate the active file to the .1 archive once it reaches maxBytes. Unsafe
 * active/archive evidence aborts the whole append without modifying either
 * namespace entry. Returns the identity to append to, or null when the active
 * file is absent after a successful rotation. */
function rotateIfNeeded(file: string, maxBytes: number): PrivateFileIdentity | null {
  const active = inspectPrivateLeafNoFollow(file)
  if (active === null || active.size < maxBytes) return active?.identity ?? null

  const archivePath = file + '.1'
  // Validate the archive BEFORE touching the active file. A pre-planted
  // symlink/hardlink is preserved as evidence and its victim is untouched.
  const archive = inspectPrivateLeafNoFollow(archivePath)

  // Tighten and fsync the exact active inode before it becomes the archive.
  const opened = openPrivateAppendNoFollow(file, {
    create: false,
    exclusive: false,
    expected: active.identity,
    verifyPathIdentity: true,
    tightenMode: 0o600,
    strictTighten: true,
  })
  try {
    fsyncSync(opened.fd)
  } finally {
    closeSync(opened.fd)
  }
  if (inspectPrivateLeafNoFollow(file, { expected: active.identity }) === null) {
    throw new Error('audit leaf identity changed: ' + file)
  }

  if (archive !== null) removePrivateFileNoFollow(archivePath, archive.identity)
  if (inspectPrivateLeafNoFollow(file, { expected: active.identity }) === null) {
    throw new Error('audit leaf identity changed: ' + file)
  }
  renameSync(file, archivePath)
  if (inspectPrivateLeafNoFollow(archivePath, { expected: active.identity }) === null) {
    throw new Error('audit archive identity changed after rotation: ' + file)
  }
  if (inspectPrivateLeafNoFollow(file) !== null) {
    throw new Error('audit active leaf still exists after rotation: ' + file)
  }
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
  // Parent discipline single-sourced: create 0700 (real final component,
  // no-follow) and verify an existing parent without mutating its mode — the
  // exported contract is unchanged; a symlinked/file parent still fails loud.
  ensurePrivateDirectoryNoFollow(parent, 0o700, { existingMode: 'preserve' })
  const expected = rotateIfNeeded(file, maxBytes)
  const opened = openPrivateAppendNoFollow(file, {
    create: expected === null,
    exclusive: expected === null,
    expected: expected ?? null,
    verifyPathIdentity: true,
    tightenMode: 0o600,
    strictTighten: true,
  })
  let committed = false
  try {
    writePrivateFdAll(opened.fd, line)
    fsyncSync(opened.fd)
    const after = assertPrivateLeafStatNoFollow(file, fstatSync(opened.fd))
    if (!samePrivateIdentity(after.identity, opened.identity)) {
      throw new Error('audit descriptor identity changed after append: ' + file)
    }
    if (inspectPrivateLeafNoFollow(file, { expected: opened.identity }) === null) {
      throw new Error('audit leaf identity changed: ' + file)
    }
    committed = true
  } finally {
    closeSync(opened.fd)
  }
  // Creating the active file changes the directory namespace; make that
  // publication durable only after the exact file data is fsynced.
  if (committed && opened.created) syncPrivateDirectoryNoFollow(parent)
}
