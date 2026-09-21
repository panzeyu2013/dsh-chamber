/**
 * Gateway runtime status projection (2026-12 audit F2 split): the metadata
 * health disk-facts cache (F4) and the desktop-shaped projection, moved out of
 * runtime-manager.ts. The in-memory recoverability gate is injected as getters,
 * so writer-busy / disposed transitions stay immediate on every call.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  activationJournalPath,
  currentPointerPath,
  detectRuntimeMetadataHealth,
  inspectCorruptMetadataRecoveryMarker,
  isSafeVersion,
  overridePath,
} from '@dsh-chamber/dsh-runtime'
import { RECOVERABLE_METADATA_BLOCKS } from './runtime-refusals.ts'

export type MetadataHealthStatus =
  | 'unknown'
  | 'healthy'
  | 'selection-corrupt'
  | 'recovery-in-progress'
  | 'recovery-finalized'
  | 'recovery-marker-corrupt'

export interface MetadataStatusProjectionDeps {
  platform: NodeJS.Platform
  baseDir: string
  shellVersion: string
  getStartupBlockReason(): string | null
  getEnvPath(): string | null
  getBuiltinVersion(): string | null
  isWriterBusy(): boolean
  isDisposed(): boolean
}

export interface MetadataStatusProjection {
  projection(): { metadataHealth: MetadataHealthStatus; metadataComponents: string[]; canRecoverMetadata: boolean }
  invalidate(): void
}

export function createMetadataStatusProjection(deps: MetadataStatusProjectionDeps): MetadataStatusProjection {
  const { platform, baseDir, shellVersion } = deps
  /** Disk-derived metadata health facts (2026-12 audit F4): detectRuntimeMetadataHealth
   *  scans CURRENT/OVERRIDE/JOURNAL/recovery evidence on every /status call
   *  (probed every 3s by the UI). Only the DISK facts are cached — the
   *  in-memory recoverability gate is recomputed per call, so a writer becoming
   *  busy still stops advertising recovery immediately. Every transaction
   *  boundary invalidates through invalidateDiskCache(). */
  const METADATA_HEALTH_TTL_MS = 5_000
  let metadataHealthCache: {
    checkedAt: number
    /** Cheap change detector: a direct on-disk corruption (fault injection,
     *  operator repair) must be reflected on the NEXT status call, not after
     *  the TTL — four stats replace the full scan in the common case. */
    fingerprint: string
    facts: {
      status: MetadataHealthStatus
      components: string[]
      needsRecovery: boolean
    } | null
  } | null = null

  /** stat-only fingerprint of the metadata files + their directory. */
  function metadataFingerprint(): string {
    const parts: string[] = []
    for (const path of [
      join(baseDir, 'dsh-runtime'),
      currentPointerPath(baseDir),
      overridePath(baseDir),
      activationJournalPath(baseDir),
    ]) {
      try {
        const stat = statSync(path, { throwIfNoEntry: false })
        parts.push(stat === undefined ? '-' : `${stat.ino}:${stat.size}:${stat.mtimeMs}`)
      } catch {
        parts.push('?')
      }
    }
    return parts.join('|')
  }

  /** Disk-derived metadata facts behind a short TTL (the scan the audit F4
   *  finding targets): status + category-only components + whether any
   *  recovery condition is on disk. null = unavailable (win32 or unreadable).
   *  Cached ONLY here; invalidated by every writer transaction. */
  function metadataHealthFacts(): {
    status: MetadataHealthStatus
    components: string[]
    needsRecovery: boolean
  } | null {
    if (platform === 'win32') return null
    const now = Date.now()
    const fingerprint = metadataFingerprint()
    if (metadataHealthCache !== null
      && metadataHealthCache.fingerprint === fingerprint
      && now - metadataHealthCache.checkedAt < METADATA_HEALTH_TTL_MS) {
      return metadataHealthCache.facts
    }
    let facts: ReturnType<typeof metadataHealthFacts> = null
    try {
      const health = detectRuntimeMetadataHealth(baseDir, shellVersion)
      const components = new Set<string>()
      if (health.current.kind === 'corrupt'
        || health.corruptEvidence.some(name => name.startsWith('current.'))) components.add('current')
      if (health.override.kind === 'corrupt'
        || health.corruptEvidence.some(name => name.startsWith('override.json.'))) components.add('override')
      if (health.activationJournal.kind === 'corrupt'
        || health.corruptEvidence.some(name => name.startsWith('activation-journal.json.'))) components.add('activation-journal')
      if (health.recovery.kind === 'corrupt'
        || (health.recovery.kind === 'valid' && health.recovery.record.phase !== 'finalized')) {
        components.add('recovery-marker')
      }
      if (health.corruptEvidence.length > 0) components.add('retained-evidence')
      const markerRescueAvailable = health.status === 'recovery-marker-corrupt'
        && inspectCorruptMetadataRecoveryMarker(baseDir).recoverable
      const needsRecovery = health.status === 'selection-corrupt'
        || health.status === 'recovery-in-progress'
        || markerRescueAvailable
      facts = { status: health.status, components: [...components], needsRecovery }
    } catch {
      facts = null
    }
    metadataHealthCache = { checkedAt: now, fingerprint, facts }
    return facts
  }

  /** Desktop-shaped metadata health projection (main.ts 3422-3470 mirror) for
   *  /status: category-only components + explicit recover eligibility. The
   *  disk facts are cached (TTL); the recoverability gate mixes them with LIVE
   *  in-memory writer state on every call. */
  function metadataProjection(): {
    metadataHealth: MetadataHealthStatus
    metadataComponents: string[]
    canRecoverMetadata: boolean
  } {
    const facts = metadataHealthFacts()
    if (facts === null) {
      return { metadataHealth: 'unknown', metadataComponents: [], canRecoverMetadata: false }
    }
    const startupBlockReason = deps.getStartupBlockReason()
    // The recover route may act only on a FATAL metadata block (or a
    // recovery attempt whose builtin probe failed and kept its durable
    // record, or a finalized recovery whose resume start failed) —
    // restore/swap recovery phases resume through their retry.
    const recoverableBlock = startupBlockReason === null
      || RECOVERABLE_METADATA_BLOCKS.has(startupBlockReason)
    // L4 review fix: no busy-phase/task gate may advertise recovery while an
    // activation/install/restart owns the writer.
    const writerBusy = deps.isWriterBusy()
    const builtinVersion = deps.getBuiltinVersion()
    const canRecoverMetadata = (facts.needsRecovery || startupBlockReason === 'metadata-start-failed')
      && recoverableBlock
      && !writerBusy
      && deps.getEnvPath() === null
      && builtinVersion !== null
      && isSafeVersion(builtinVersion)
      && !deps.isDisposed()
    return {
      metadataHealth: facts.status,
      metadataComponents: facts.components,
      canRecoverMetadata,
    }
  }

  return {
    projection: metadataProjection,
    invalidate() {
      metadataHealthCache = null
    },
  }
}
