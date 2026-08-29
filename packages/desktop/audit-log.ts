/**
 * Lightweight non-secret desktop audit log (design 17 §13.4.4, S24):
 * append-only JSONL with an owner-only (0600) file and size-based rotation to
 * `<file>.1`.
 *
 * Contract:
 *  - ONLY non-secret facts are accepted: time, source id, kind, transport and
 *    a caller-supplied non-secret detail. Credentials, cookies and session
 *    bodies must never be passed — and the serializer defends the file
 *    regardless: the written JSON is rebuilt from a fixed field whitelist, so
 *    a stray field a caller wrongly attaches (even `password`/`token`) can
 *    never reach disk (S24).
 *  - Appends are O_APPEND + fsync (the append-semantics option from design 17
 *    §13.4.4; a per-line fsync is the right cost for an audit trail). Modes
 *    are tightened to 0600 at open so a legacy/loose file cannot linger.
 *  - Rotation: when the active file reaches the cap it is renamed to
 *    `<file>.1` (the previous `.1` is deleted first), so the trail stays
 *    bounded at 2 × cap.
 *  - Audit failures are LOUD (console.error) but never fatal: a broken audit
 *    log must not break connection management or auth — the log is a record,
 *    not a gate.
 *
 * Pure Node (no electron import), so the unit tests run under plain node.
 */

import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Rotation cap of the active audit file (5 MiB; the trail is bounded at
 * 2 × cap including `<file>.1`). */
export const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024

/** One non-secret audit event. Every field is public metadata only; no field
 * may ever carry a credential, cookie or session body (S24). */
export interface AuditEvent {
  /** ISO-8601 timestamp (e.g. `new Date().toISOString()`). */
  ts: string
  /** Event name — e.g. `transport_phase`, `transport_registered`,
   * `transport_unregistered`, `credential_set`, `credential_cleared`. */
  event: string
  /** Registry instance id (non-secret). */
  sourceId?: string
  /** Target kind (`dsh` | `gateway`). */
  kind?: string
  /** Transport method (`ssh` | `http`). */
  transport?: string
  /** Non-secret detail (phase, auth-mode marker, …). */
  detail?: string
}

/** The ONLY fields ever written. A whitelist serializer defends S24 even
 * against a caller that attaches extra (secret) fields to the event. */
const WRITTEN_FIELDS: ReadonlyArray<keyof AuditEvent> = ['ts', 'event', 'sourceId', 'kind', 'transport', 'detail']

/** Rebuild the JSON line from the whitelist only; throw on a missing required
 * field (the caller passed an invalid event — the append is skipped loudly). */
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

/** DI seam (main.ts): point the desktop audit log at its file, once at
 * startup. Same shape as the other configure* seams — returns a loud notice
 * string or null. */
let auditFile: string | null = null
export function configureAuditLog(file: string): string | null {
  auditFile = file
  return null
}

/** Rotate the active file to `<file>.1` once it reaches `maxBytes` (the
 * previous `.1` is deleted first). No-op when the file does not exist yet. */
function rotateIfNeeded(file: string, maxBytes: number): void {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return // absent (ENOENT) → nothing to rotate; other errors surface in the append
  }
  if (size < maxBytes) return
  rmSync(`${file}.1`, { force: true })
  renameSync(file, `${file}.1`)
}

/** Append one non-secret audit event (JSONL). Never throws into the caller;
 * failures are loud (console.error) but non-fatal. */
export function appendAuditEvent(deps: { file: string; maxBytes?: number }, event: AuditEvent): void {
  const file = deps.file ?? auditFile
  if (file === null || file === undefined) return
  const maxBytes = deps.maxBytes ?? AUDIT_LOG_MAX_BYTES
  // Validate BEFORE touching the filesystem: an invalid event (missing
  // required fields) writes nothing — not even an empty file.
  let line: string
  try {
    line = `${JSON.stringify(serialize(event))}\n`
  } catch (error) {
    console.error(`[audit-log] ${file}: invalid audit event dropped: ${String(error)}`)
    return
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    rotateIfNeeded(file, maxBytes)
    const fd = openSync(file, 'a', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, line)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    console.error(`[audit-log] ${file}: append failed: ${String(error)}`)
  }
}
