/**
 * Gateway server-side audit projection: append-only JSONL of NON-SECRET events
 * (time, source, auth result). Credentials, cookies and session bodies never enter —
 * the written JSON is rebuilt from a fixed field whitelist, so a stray field can never
 * reach disk even if a caller wrongly attaches one (password/cookie included).
 * The append/rotate core is the control-plane shared audit-trail single source (the
 * desktop audit log too). Failures are LOUD but non-fatal: a broken trail must not
 * take the auth surface down — the log is a record, not a gate.
 */

import {
  appendAuditTrailLine,
  serializeAuditEvent,
  AUDIT_TRAIL_MAX_BYTES,
  type AuditTrailEvent,
} from '@dsh-chamber/control-plane'

/** Rotation cap of the active audit file (5 MiB; the trail is bounded at 2 × cap including `<file>.1`). */
const AUDIT_LOG_MAX_BYTES = AUDIT_TRAIL_MAX_BYTES

/** Append one non-secret audit event (JSONL). Never throws into the caller;
 * failures are loud but non-fatal. `maxBytes` overrides the rotation cap. */
export function appendAuditEvent(file: string, event: AuditTrailEvent, maxBytes: number = AUDIT_LOG_MAX_BYTES): void {
  if (file === '') return
  // Validate BEFORE touching the filesystem: an invalid event writes nothing, not even an empty file.
  let line: string
  try {
    line = `${JSON.stringify(serializeAuditEvent(event))}\n`
  } catch (error) {
    console.error(`[gateway audit] ${file}: invalid audit event dropped: ${String(error)}`)
    return
  }
  try {
    appendAuditTrailLine(file, line, maxBytes)
  } catch (error) {
    console.error(`[gateway audit] ${file}: append failed: ${String(error)}`)
  }
}
