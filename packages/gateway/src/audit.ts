/**
 * Gateway server-side audit projection (design 17 §13.4.4, S24): append-only
 * JSONL of NON-SECRET events — time, source, auth result. Credentials,
 * cookies and session bodies never enter: the written JSON is rebuilt from a
 * fixed field whitelist, so a stray field a caller wrongly attaches (even a
 * password/cookie) can never reach disk.
 *
 * The full append/rotate core (no-follow single-link leaves, descriptor/path
 * identity checks, 0600 with loose legacy modes tightened at open, fsync +
 * directory fsync on creation) is the control-plane shared audit-trail
 * single source — the desktop audit log (packages/desktop/audit-log.ts)
 * runs the SAME core, so the two surfaces can no longer drift (dedupe audit
 * E-4/N11, 2026-09). This file keeps only the gateway-facing shape:
 * serialize-then-append with LOUD-but-non-fatal errors (a broken audit trail
 * must not take the auth surface down — the log is a record, not a gate).
 */

import {
  appendAuditTrailLine,
  serializeAuditEvent,
  AUDIT_TRAIL_MAX_BYTES,
  type AuditTrailEvent,
} from '@dsh-chamber/control-plane'

/** Rotation cap of the active audit file (5 MiB; the trail is bounded at
 * 2 × cap including `<file>.1`). */
export const AUDIT_LOG_MAX_BYTES = AUDIT_TRAIL_MAX_BYTES

/** One non-secret audit event. Every field is public metadata only; no field
 * may ever carry a credential, cookie or session body (S24). */
export type AuditEvent = AuditTrailEvent

/** Append one non-secret audit event (JSONL). Never throws into the caller;
 * failures are loud but non-fatal. `maxBytes` is the rotation-cap override
 * used by tests (defaults to AUDIT_LOG_MAX_BYTES). */
export function appendAuditEvent(file: string, event: AuditEvent, maxBytes: number = AUDIT_LOG_MAX_BYTES): void {
  if (file === '') return
  // Validate BEFORE touching the filesystem: an invalid event (missing
  // required fields) writes nothing — not even an empty file.
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
