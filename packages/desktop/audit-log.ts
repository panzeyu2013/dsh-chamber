/**
 * Desktop audit log (design 17 §13.4.4, S24): append-only JSONL of
 * NON-SECRET events with an owner-only (0600) file and size-based rotation
 * to `<file>.1`.
 *
 * The serializer and the hardened append/rotate core (no-follow single-link
 * leaves, descriptor/path identity checks, loose legacy modes tightened at
 * open, fsync + directory fsync on creation) are the control-plane
 * audit-trail SINGLE SOURCE — the gateway server audit runs the same core,
 * so the two surfaces can no longer drift (dedupe audit E-4/N11, 2026-09).
 * This file keeps only the desktop-facing shape: the configure* DI seam and
 * the loud-but-non-fatal append contract (a broken audit log must not break
 * connection management or auth — the log is a record, not a gate).
 *
 * Pure Node (no electron import), so the unit tests run under plain node.
 */

import {
  appendAuditTrailLine,
  serializeAuditEvent,
  AUDIT_TRAIL_MAX_BYTES,
  type AuditTrailEvent,
} from './control-plane-module.ts'

/** Rotation cap of the active audit file (5 MiB; the trail is bounded at
 * 2 × cap including `<file>.1`). */
export const AUDIT_LOG_MAX_BYTES = AUDIT_TRAIL_MAX_BYTES

/** One non-secret audit event. Every field is public metadata only; no field
 * may ever carry a credential, cookie or session body (S24). */
export type AuditEvent = AuditTrailEvent

/** DI seam (main.ts): point the desktop audit log at its file, once at
 * startup. Same shape as the other configure* seams — returns a loud notice
 * string or null. */
let auditFile: string | null = null
export function configureAuditLog(file: string): string | null {
  auditFile = file
  return null
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
