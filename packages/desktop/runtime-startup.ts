/**
 * dsh runtime startup phase (design 16 §3.3/§3.4/§4) — the real-machine
 * wiring seam between the M3 pure logic (apply-phase / snapshot-store /
 * activation-gate) and the control plane's actual host spawn. This module is
 * orchestration-only: every side effect (cleanup, snapshot, pointer switch,
 * spawn+probe, restore, candidate record) is injected, so the sequence is
 * unit-testable without a live host.
 *
 * Sequence (startup, BEFORE the control plane spawns the local host):
 *   1. cleanupStaleInstalls (hard-killed .work-* residue) + evictVersions
 *      (three-version cache, §4 R3-2 F21);
 *   2. completeInterruptedRestore (a crashed mid-restore is finished before
 *      any new spawn, §3.3 crash-safety / §3.6「启动补完失败」);
 *   3. if override.pending is set, run applyPendingVersion (snapshot → switch
 *      pointer → spawn+probe → verdict → applied/rollback/snapshot-failed) —
 *      the state machine (§3.6) drives the phase through recordProbePass →
 *      applied / probe-fail → rollback / snapshot-fail → snapshot-failed.
 *
 * The `spawnAndProbe` dep is the only real-machine piece (control-plane spawn
 * + host.describe + smoke). Everything else is pure file/path logic already
 * covered by M3 unit tests.
 */
import { applyPendingVersion, type ApplyOutcome } from './apply-phase.ts';
import { cleanupStaleInstalls, evictVersions, readOverride } from './dsh-runtime-store.ts';
import { completeInterruptedRestore } from './snapshot-store.ts';
import { recordProbePass } from './known-good-monitor.ts';
import type { ProbeResult } from './activation-gate.ts';

export interface StartupDeps {
  /** Remove stale `.work-*` installs left by a hard kill (§4). */
  cleanupStaleInstalls: () => string[]
  /** Evict non-protected version trees down to the three-version cache. */
  evict: () => string[]
  /** Finish a crashed mid-restore (idempotent); 'none' when no marker. */
  completeInterruptedRestore: () => Promise<'none' | 'complete' | 'half' | 'incomplete'>
  /** Read the current override (null when absent). */
  readOverride: () => { pending: string | null } | null
  /** Snapshot DSH_HOME before switch (throws → no-snapshot-no-switch). */
  snapshot: (sourceVersion: string) => Promise<string>
  /** Atomically switch the current pointer. */
  switchPointer: (version: string) => void
  /** Spawn the host on the NEW pointer version and run read-only probes. */
  spawnAndProbe: (version: string) => Promise<ProbeResult[]>
  /** Restore a snapshot over DSH_HOME. */
  restore: (snapshotPath: string) => Promise<'complete' | 'half' | 'incomplete'>
  /** Record a probe-pass candidate (§3.4 sustained-health gate). */
  recordProbePass: (version: string) => void
}

export interface StartupResult {
  /** 'applied' (probe pass) / 'rolled-back' / 'failed' / 'skipped' (no pending). */
  applyOutcome: ApplyOutcome | null
  restored: 'none' | 'complete' | 'half' | 'incomplete'
  cleanedWorkDirs: string[]
  evicted: string[]
}

export async function runStartupPhase(deps: StartupDeps): Promise<StartupResult> {
  const cleanedWorkDirs = deps.cleanupStaleInstalls();
  const evicted = deps.evict();
  const restored = await deps.completeInterruptedRestore();

  const override = deps.readOverride();
  if (override === null || override.pending === null) {
    return { applyOutcome: null, restored, cleanedWorkDirs, evicted };
  }

  const pending = override.pending;
  const outcome = await applyPendingVersion({
    pendingVersion: pending,
    sourceVersion: null, // caller does not know the pre-switch version here; snapshot names it 'unknown'
    knownGoodVersion: null, // known-good read is the caller's wiring; rollbackTarget falls to builtin
    deps: {
      snapshot: deps.snapshot,
      switchPointer: deps.switchPointer,
      probe: () => deps.spawnAndProbe(pending),
      restore: deps.restore,
      recordProbePass: deps.recordProbePass,
    },
  });

  return { applyOutcome: outcome, restored, cleanedWorkDirs, evicted };
}

/** §4/M1 koffi probe: the installed tree's koffi must load from its prebuilt
 *  native binary WITHOUT a compiler toolchain. Returns false when the prebuilt
 *  is missing (the install would then need a source build). */
export async function probeKoffiLoadable(versionTreeDir: string): Promise<{ ok: boolean; detail: string }> {
  const { existsSync } = await import('node:fs');
  const path = await import('node:path');
  const prebuilt = path.join(versionTreeDir, 'node_modules', 'koffi', 'build', 'koffi');
  // The exact prebuilt filename is platform-specific; a missing `build/` dir is
  // the reliable signal that the optional prebuilt did not download.
  const hasBuildDir = existsSync(path.join(versionTreeDir, 'node_modules', 'koffi', 'build'));
  return {
    ok: hasBuildDir,
    detail: hasBuildDir ? 'koffi prebuilt present (no toolchain needed)' : 'koffi prebuilt missing (source build would need a toolchain)',
  };
}
