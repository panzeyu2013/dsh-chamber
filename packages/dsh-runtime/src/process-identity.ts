/**
 * Installer pid evidence identity — Linux /proc kernel facts, best-effort.
 *
 * The installer records the child pid in `<work>/pid` so the next startup can tell
 * "the install crashed" from "an install is still running". A bare number cannot
 * distinguish a live writer from a RECYCLED pid (hard crash + reboot + pid reuse
 * makes cleanup reject forever and the managed dsh cannot start). On Linux the
 * kernel answers both halves of the identity: the boot id (changes every boot)
 * and the process start ticks from `/proc/<pid>/stat` (field 22, changes on pid
 * reuse). Elsewhere the evidence stays the legacy bare number and the liveness
 * check — the residual is registered in STATUS.
 *
 * Not a second lease authority: control-plane's process-identity.ts owns the
 * design 17 §12 lease semantics; this module only answers the two facts the
 * installer evidence needs (design 18 §4).
 */
import { readFileSync } from 'node:fs'

/** The two kernel facts, each `null` when this platform/process cannot prove it. */
export interface ProcessIdentity {
  readonly bootId: string | null
  readonly startTicks: number | null
}

/** Parsed `<work>/pid` evidence: legacy bare pid, or pid + recorded identity. */
export type PidEvidence =
  | { readonly kind: 'legacy'; readonly pid: number }
  | {
    readonly kind: 'identity'
    readonly pid: number
    readonly bootId: string | null
    readonly startTicks: number | null
  }

const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'

/** Kernel boot id (Linux); null elsewhere or unreadable. */
export function readBootId(): string | null {
  try {
    const value = readFileSync(BOOT_ID_PATH, 'utf8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

/** `/proc/<pid>/stat` field 22 (start ticks); null when absent/unreadable/not Linux. */
export function readProcessStartTicks(pid: number): number | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm (field 2) may contain spaces and parens: the fields after the LAST ')'
    // start at field 3 (state); start ticks is field 22 ⇒ rest[19].
    const end = text.lastIndexOf(')')
    if (end < 0) return null
    const rest = text.slice(end + 1).trim().split(/\s+/)
    const ticks = Number(rest[19])
    return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null
  } catch {
    return null
  }
}

/** Read both halves for a pid (each may be null). */
export function readProcessIdentity(pid: number): ProcessIdentity {
  return { bootId: readBootId(), startTicks: readProcessStartTicks(pid) }
}

/**
 * `<work>/pid` content for a freshly spawned child: JSON identity when the kernel
 * can prove at least one half, else the legacy bare pid (old readers keep working).
 */
export function serializePidEvidence(pid: number): string {
  const identity = readProcessIdentity(pid)
  if (identity.bootId === null && identity.startTicks === null) return String(pid)
  return JSON.stringify({ v: 1, pid, bootId: identity.bootId, startTicks: identity.startTicks })
}

/** Parse `<work>/pid` content; null = corrupt (not a pid and not v1 identity JSON). */
export function parsePidEvidence(text: string): PidEvidence | null {
  const trimmed = text.trim()
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed)
    return Number.isSafeInteger(pid) && pid > 0 ? { kind: 'legacy', pid } : null
  }
  try {
    const raw: unknown = JSON.parse(trimmed)
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as Record<string, unknown>
    if (record.v !== 1) return null
    const pid = record.pid
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null
    const bootId = typeof record.bootId === 'string' && record.bootId !== '' ? record.bootId : null
    const ticks = record.startTicks
    const startTicks = typeof ticks === 'number' && Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null
    return { kind: 'identity', pid, bootId, startTicks }
  } catch {
    return null
  }
}

/** Live-identity probes the cleanup injects (tests substitute all three). */
export interface PidLiveness {
  readonly bootId: () => string | null
  readonly startTicks: (pid: number) => number | null
  readonly alive: (pid: number, group?: boolean) => boolean
}

/**
 * True when the recorded evidence can no longer describe a live writer:
 * - legacy: only the liveness probe can answer (previous behavior);
 * - identity recorded on another boot: that whole boot is gone;
 * - identity recorded on this boot but with different start ticks: the pid was
 *   RECYCLED — only a still-live process GROUP keeps the evidence (a leftover
 *   descendant may own it);
 * - identity matching: the recorded process is the live one.
 */
export function isPidEvidenceStale(evidence: PidEvidence, probe: PidLiveness): boolean {
  const groupAlive = probe.alive(evidence.pid, true)
  if (!probe.alive(evidence.pid) && !groupAlive) return true
  if (evidence.kind === 'legacy') return false
  const currentBoot = probe.bootId()
  if (evidence.bootId !== null && currentBoot !== null && evidence.bootId !== currentBoot) return true
  if (evidence.startTicks !== null) {
    const ticks = probe.startTicks(evidence.pid)
    if (ticks !== null && ticks !== evidence.startTicks) return !groupAlive
  }
  return false
}
