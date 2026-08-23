/**
 * dsh runtime known-good promotion monitor (design 16 §3.4) — the sustained-
 * health gate that turns a probe-pass CANDIDATE into a rollback-target known-
 * good version. A single probe pass must NOT immediately become a rollback
 * target (a delayed-crash version would then be the next rollback target,
 * violating「绝不在坏树间交替」): promotion requires BOTH a minimum uptime
 * (24h) and a minimum successful-boot count.
 *
 * Pure logic, no electron, no IPC — the clock is injected for tests. The
 * actual known-good write is delegated to dsh-runtime-store's `markKnownGood`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertSafeVersion } from './version-safety.ts';
import { markKnownGood } from './dsh-runtime-store.ts';

export interface HealthPolicy {
  /** Minimum ms since the first probe pass (default 24h). */
  minUptimeMs: number
  /** Minimum successful-boot count (default 1). */
  minBoots: number
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  minUptimeMs: 24 * 60 * 60 * 1000,
  minBoots: 1,
};

export interface CandidateRecord {
  firstProbePassAt: number
  bootCount: number
}

/** Pure decision: has this candidate satisfied the sustained-health gate? */
export function shouldPromote(
  candidate: CandidateRecord,
  nowMs: number,
  policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
): boolean {
  return nowMs - candidate.firstProbePassAt >= policy.minUptimeMs && candidate.bootCount >= policy.minBoots;
}

function candidatesPath(baseDir: string): string {
  return join(baseDir, 'dsh-runtime', 'known-good-candidates.json');
}

function readCandidates(baseDir: string): Record<string, CandidateRecord> {
  let raw: string;
  try {
    raw = readFileSync(candidatesPath(baseDir), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const versions = (parsed as Record<string, unknown>).versions;
    if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) return {};
    const out: Record<string, CandidateRecord> = {};
    for (const [key, value] of Object.entries(versions as Record<string, unknown>)) {
      const rec = value as Record<string, unknown> | null;
      if (rec === null || typeof rec !== 'object') continue;
      if (typeof rec.firstProbePassAt !== 'number' || typeof rec.bootCount !== 'number') continue;
      out[key] = { firstProbePassAt: rec.firstProbePassAt, bootCount: rec.bootCount };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCandidates(baseDir: string, versions: Record<string, CandidateRecord>): void {
  const filePath = candidatesPath(baseDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ versions }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup; the original error must propagate.
    }
    throw error;
  }
}

/** Record a probe pass as a promotion candidate (§3.4 recordProbePass). */
export function recordProbePass(baseDir: string, version: string, nowMs = Date.now()): void {
  const safe = assertSafeVersion(version);
  const versions = readCandidates(baseDir);
  versions[safe] = {
    firstProbePassAt: versions[safe]?.firstProbePassAt ?? nowMs,
    bootCount: versions[safe]?.bootCount ?? 0,
  };
  writeCandidates(baseDir, versions);
}

/** Count one successful boot for a candidate (called at startup after spawn). */
export function noteBoot(baseDir: string, version: string): void {
  if (!existsSync(candidatesPath(baseDir))) return;
  const safe = version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(safe)) return;
  const versions = readCandidates(baseDir);
  const rec = versions[safe];
  if (rec === undefined) return;
  versions[safe] = { firstProbePassAt: rec.firstProbePassAt, bootCount: rec.bootCount + 1 };
  writeCandidates(baseDir, versions);
}

/**
 * Promote due candidates and return the promoted versions. A promoted version
 * is written to known-good (rollback target) and removed from the candidate
 * set. `assertSafeVersion` on a bad version → skipped (never promoted).
 */
export function promoteDueCandidates(
  baseDir: string,
  nowMs = Date.now(),
  policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
): string[] {
  const versions = readCandidates(baseDir);
  const promoted: string[] = [];
  const remaining: Record<string, CandidateRecord> = {};
  for (const [version, rec] of Object.entries(versions)) {
    if (shouldPromote(rec, nowMs, policy)) {
      try {
        markKnownGood(baseDir, version);
        promoted.push(version);
      } catch {
        remaining[version] = rec; // unsafe version → never promote
      }
    } else {
      remaining[version] = rec;
    }
  }
  writeCandidates(baseDir, remaining);
  return promoted;
}
