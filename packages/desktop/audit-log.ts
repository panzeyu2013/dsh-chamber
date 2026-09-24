/**
 * Desktop audit log: append-only JSONL of NON-SECRET events with an owner-only
 * (0600) file and size-based rotation to `<file>.1`.
 *
 * The serializer and the hardened append/rotate core (no-follow single-link
 * leaves, descriptor/path identity checks, loose legacy modes tightened at
 * open, fsync + directory fsync on creation) is the control-plane audit-trail
 * SINGLE SOURCE, shared with the gateway server audit so the two surfaces
 * cannot drift. This file is only the desktop-facing shape: the append
 * contract is loud but non-fatal — a broken audit log must not break
 * connection management or auth (the log is a record, not a gate).
 */

import {
  appendAuditTrailLine,
  serializeAuditEvent,
  AUDIT_TRAIL_MAX_BYTES,
  type AuditTrailEvent,
} from './control-plane-module.ts'

/** Rotation cap of the active audit file (5 MiB; the whole trail is bounded at 2 × cap including `<file>.1`). */
export const AUDIT_LOG_MAX_BYTES = AUDIT_TRAIL_MAX_BYTES

/** One non-secret audit event: every field is public metadata only; no field may ever carry a credential, cookie or session body. */
export type AuditEvent = AuditTrailEvent

/** Append one non-secret audit event (JSONL). Never throws into the caller; failures are loud (console.error) but non-fatal. */
export function appendAuditEvent(deps: { file: string; maxBytes?: number }, event: AuditEvent): void {
  const file = deps.file
  const maxBytes = deps.maxBytes ?? AUDIT_LOG_MAX_BYTES
  // Validate before touching the filesystem: an invalid event writes nothing, not even an empty file.
  let line: string
  try {
    line = `${JSON.stringify(serializeAuditEvent(event))}\n`
  } catch (error) {
    console.error(`[audit-log] ${file}: invalid audit event dropped: ${String(error)}`)
    return
  }
  try {
    appendAuditTrailLine(file, line, maxBytes)
  } catch (error) {
    console.error(`[audit-log] ${file}: append failed: ${String(error)}`)
  }
}
