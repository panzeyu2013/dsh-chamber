/** Design 18 §3.4 sustained-health known-good promotion monitor. */
import { join } from 'node:path'
import { assertSafeVersion, isSafeVersion } from './version-safety.ts'
import { markKnownGood, validateVersionTree } from './dsh-runtime-store.ts'
import {
  atomicWriteRuntimeFileNoFollow,
  ensureRuntimeRootNoFollow,
  readPrivateFileNoFollow,
} from './private-fs.ts'

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
  const read = readPrivateFileNoFollow(knownGoodCandidatesPath(baseDir), 256 * 1024)
  if (read.kind === 'missing') return {}
  if (read.kind === 'unsafe') throw new Error('known-good 候选元数据不安全，拒绝读取或覆盖')
  try {
    const parsed: unknown = JSON.parse(read.raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('known-good 候选元数据形状无效')
    }
    const versions = (parsed as Record<string, unknown>).versions
    if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) {
      throw new Error('known-good 候选版本表形状无效')
    }
    const out: Record<string, CandidateRecord> = {}
    for (const [version, value] of Object.entries(versions as Record<string, unknown>)) {
      if (!isSafeVersion(version) || value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('known-good 候选记录形状无效')
      }
      const rec = value as Record<string, unknown>
      if (typeof rec.firstProbePassAt !== 'number' || !Number.isFinite(rec.firstProbePassAt)) {
        throw new Error('known-good 候选首次探测时间无效')
      }
      if (typeof rec.bootCount !== 'number' || !Number.isInteger(rec.bootCount) || rec.bootCount < 0) {
        throw new Error('known-good 候选启动计数无效')
      }
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
      if (startedAt !== null && (typeof startedAt !== 'number' || !Number.isFinite(startedAt))) {
        throw new Error('known-good 候选健康窗口起点无效')
      }
      if (resetAt !== null && (typeof resetAt !== 'number' || !Number.isFinite(resetAt))) {
        throw new Error('known-good 候选健康窗口重置时间无效')
      }
      out[version] = {
        firstProbePassAt: rec.firstProbePassAt,
        bootCount: rec.bootCount,
        healthWindowStartedAt: startedAt,
        healthWindowResetAt: resetAt,
      }
    }
    return out
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('known-good 候选元数据 JSON 损坏')
    throw error
  }
}

function writeCandidates(baseDir: string, versions: Record<string, CandidateRecord>): void {
  const filePath = knownGoodCandidatesPath(baseDir)
  atomicWriteRuntimeFileNoFollow(baseDir, filePath, `${JSON.stringify({ versions }, null, 2)}\n`)
}

/** A candidate must point at a fully valid local version tree. */
export function recordProbePass(baseDir: string, version: string, nowMs = Date.now()): void {
  const safe = assertSafeVersion(version)
  if (!Number.isFinite(nowMs)) throw new Error('nowMs 必须是有限数')
  ensureRuntimeRootNoFollow(baseDir)
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
  if (!isSafeVersion(version)) return
  ensureRuntimeRootNoFollow(baseDir)
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
  ensureRuntimeRootNoFollow(baseDir)
  const versions = readCandidates(baseDir)
  if (Object.keys(versions).length === 0) return
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
  ensureRuntimeRootNoFollow(baseDir)
  const versions = readCandidates(baseDir)
  if (!Object.prototype.hasOwnProperty.call(versions, safe)) return
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
  ensureRuntimeRootNoFollow(baseDir)
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
