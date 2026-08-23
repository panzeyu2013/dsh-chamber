/** Design 17 §3.4 sustained-health known-good promotion monitor. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertSafeVersion, isSafeVersion } from './version-safety.ts'
import { markKnownGood, validateVersionTree } from './dsh-runtime-store.ts'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export interface HealthPolicy {
  minUptimeMs: number
  minBoots: number
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  minUptimeMs: 24 * 60 * 60 * 1000,
  minBoots: 1,
}

export interface CandidateRecord {
  firstProbePassAt: number
  bootCount: number
  /** Start of the current uninterrupted healthy process window. A closed
   * window is deliberately represented as null: persisted wall-clock time
   * alone is never evidence that the runtime remained healthy. */
  healthWindowStartedAt: number | null
  /** Diagnostic/reset epoch. It also makes the on-disk v2 shape explicit so
   * legacy records cannot inherit a previously counted boot. */
  healthWindowResetAt: number | null
}

export function shouldPromote(candidate: CandidateRecord, nowMs: number, policy: HealthPolicy = DEFAULT_HEALTH_POLICY): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(candidate.firstProbePassAt)) return false
  if (!Number.isInteger(candidate.bootCount) || candidate.bootCount < 0) return false
  if (!Number.isFinite(policy.minUptimeMs) || policy.minUptimeMs < 0 || !Number.isInteger(policy.minBoots) || policy.minBoots < 0) return false
  if (candidate.healthWindowStartedAt === null || !Number.isFinite(candidate.healthWindowStartedAt)) return false
  return nowMs - candidate.healthWindowStartedAt >= policy.minUptimeMs && candidate.bootCount >= policy.minBoots
}

export function knownGoodCandidatesPath(baseDir: string): string {
  return join(baseDir, 'dsh-runtime', 'known-good-candidates.json')
}

function readCandidates(baseDir: string): Record<string, CandidateRecord> {
  let raw: string
  try { raw = readFileSync(knownGoodCandidatesPath(baseDir), 'utf8') } catch { return {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const versions = (parsed as Record<string, unknown>).versions
    if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) return {}
    const out: Record<string, CandidateRecord> = {}
    for (const [version, value] of Object.entries(versions as Record<string, unknown>)) {
      if (!isSafeVersion(version) || value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const rec = value as Record<string, unknown>
      if (typeof rec.firstProbePassAt !== 'number' || !Number.isFinite(rec.firstProbePassAt)) continue
      if (typeof rec.bootCount !== 'number' || !Number.isInteger(rec.bootCount) || rec.bootCount < 0) continue
      const hasV2Window = Object.prototype.hasOwnProperty.call(rec, 'healthWindowStartedAt')
        && Object.prototype.hasOwnProperty.call(rec, 'healthWindowResetAt')
      if (!hasV2Window) {
        // Legacy candidates measured `now - firstProbePassAt`, so an app that
        // was closed for 24h could be promoted immediately on reopening. Keep
        // the candidate for diagnosis, but close its trust window and discard
        // the legacy boot count. A fresh successful probe/boot starts v2 data.
        out[version] = {
          firstProbePassAt: rec.firstProbePassAt,
          bootCount: 0,
          healthWindowStartedAt: null,
          healthWindowResetAt: null,
        }
        continue
      }
      const startedAt = rec.healthWindowStartedAt
      const resetAt = rec.healthWindowResetAt
      if (startedAt !== null && (typeof startedAt !== 'number' || !Number.isFinite(startedAt))) continue
      if (resetAt !== null && (typeof resetAt !== 'number' || !Number.isFinite(resetAt))) continue
      out[version] = {
        firstProbePassAt: rec.firstProbePassAt,
        bootCount: rec.bootCount,
        healthWindowStartedAt: startedAt,
        healthWindowResetAt: resetAt,
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeCandidates(baseDir: string, versions: Record<string, CandidateRecord>): void {
  const filePath = knownGoodCandidatesPath(baseDir)
  mkdirSync(dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE })
  chmodSync(dirname(filePath), PRIVATE_DIR_MODE)
  const tmp = `${filePath}.tmp-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, `${JSON.stringify({ versions }, null, 2)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
    chmodSync(tmp, PRIVATE_FILE_MODE)
    renameSync(tmp, filePath)
    chmodSync(filePath, PRIVATE_FILE_MODE)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

/** A candidate must point at a fully valid local version tree. */
export function recordProbePass(baseDir: string, version: string, nowMs = Date.now()): void {
  const safe = assertSafeVersion(version)
  if (!Number.isFinite(nowMs)) throw new Error('nowMs 必须是有限数')
  const valid = validateVersionTree(baseDir, safe)
  if (!valid.ok) throw new Error(`不能记录无效运行时为 known-good 候选：${valid.error}`)
  const versions = readCandidates(baseDir)
  const existing = versions[safe]
  const existingWindow = existing?.healthWindowStartedAt
  const keepExistingWindow = typeof existingWindow === 'number' && existingWindow <= nowMs
  versions[safe] = {
    firstProbePassAt: existing?.firstProbePassAt ?? nowMs,
    bootCount: existing?.bootCount ?? 0,
    healthWindowStartedAt: keepExistingWindow ? existingWindow : nowMs,
    healthWindowResetAt: existing?.healthWindowResetAt ?? null,
  }
  writeCandidates(baseDir, versions)
}

/** Count a successful boot only for an existing, still-valid candidate. */
export function noteBoot(baseDir: string, version: string, nowMs = Date.now()): void {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs 必须是有限数')
  if (!existsSync(knownGoodCandidatesPath(baseDir)) || !isSafeVersion(version)) return
  if (!validateVersionTree(baseDir, version).ok) return
  const versions = readCandidates(baseDir)
  const rec = versions[version]
  if (rec === undefined) return
  const keepExistingWindow = rec.healthWindowStartedAt !== null && rec.healthWindowStartedAt <= nowMs
  versions[version] = {
    ...rec,
    bootCount: rec.bootCount + 1,
    healthWindowStartedAt: keepExistingWindow ? rec.healthWindowStartedAt : nowMs,
  }
  writeCandidates(baseDir, versions)
}

/** Close every candidate's current trust window.
 *
 * Main calls this before the first startup probe and whenever the local
 * runtime becomes degraded/restarting/error. The next successful probe or
 * boot opens a new window; elapsed wall time while the app/host was offline is
 * therefore never carried into known-good promotion. Boot qualification is
 * reset with the window so a boot from an earlier failed window cannot count.
 */
export function resetCandidateHealthWindow(baseDir: string, nowMs = Date.now()): void {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs 必须是有限数')
  if (!existsSync(knownGoodCandidatesPath(baseDir))) return
  const versions = readCandidates(baseDir)
  for (const [version, rec] of Object.entries(versions)) {
    versions[version] = {
      ...rec,
      bootCount: 0,
      healthWindowStartedAt: null,
      healthWindowResetAt: nowMs,
    }
  }
  writeCandidates(baseDir, versions)
}

/** Remove a failed/abandoned candidate so it cannot later be promoted. */
export function removeKnownGoodCandidate(baseDir: string, version: string): void {
  const safe = assertSafeVersion(version)
  if (!existsSync(knownGoodCandidatesPath(baseDir))) return
  const versions = readCandidates(baseDir)
  delete versions[safe]
  writeCandidates(baseDir, versions)
}

/** Promote only due candidates whose immutable tree still validates. Invalid
 * trees remain candidates/fields for diagnosis but never become rollback
 * targets. */
export function promoteDueCandidates(
  baseDir: string,
  nowMs = Date.now(),
  policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
): string[] {
  const versions = readCandidates(baseDir)
  const promoted: string[] = []
  const remaining: Record<string, CandidateRecord> = {}
  for (const [version, rec] of Object.entries(versions)) {
    if (shouldPromote(rec, nowMs, policy) && validateVersionTree(baseDir, version).ok) {
      markKnownGood(baseDir, version, new Date(nowMs))
      promoted.push(version)
    } else {
      remaining[version] = rec
    }
  }
  writeCandidates(baseDir, remaining)
  return promoted
}
