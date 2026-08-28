/**
 * Gateway server-side audit projection (design 17 §13.4.4, S24): append-only
 * JSONL of NON-SECRET events — time, source, auth result. Credentials,
 * cookies and session bodies never enter: the written JSON is rebuilt from a
 * fixed field whitelist, so a stray field a caller wrongly attaches (even a
 * password/cookie) can never reach disk.
 *
 * Same discipline as the desktop audit-log (packages/desktop/audit-log.ts):
 * O_APPEND + fsync, 0600 (loose legacy modes tightened at open), and rotation
 * to `<file>.1` once the active file reaches the cap (the previous `.1` is
 * deleted first). Failures are LOUD but non-fatal — a broken audit trail must
 * not take the auth surface down with it (the log is a record, not a gate).
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
    console.error(`[gateway audit] ${file}: append failed: ${String(error)}`)
  }
}
