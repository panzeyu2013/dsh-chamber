/**
 * Gateway runtime status projection: the metadata health disk-facts cache plus the
 * desktop-shaped projection; injected getters keep writer-busy / disposed immediate.
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
  projectMetadataHealthFacts,
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
  /** Disk-derived metadata health facts: detectRuntimeMetadataHealth scans
   *  CURRENT/OVERRIDE/JOURNAL/recovery evidence, so only the DISK facts are cached
   *  (the UI probes /status every 3s). The in-memory recoverability gate is
   *  recomputed per call, so a writer becoming busy stops advertising recovery
   *  immediately; every transaction boundary invalidates through invalidateDiskCache(). */
  const METADATA_HEALTH_TTL_MS = 5_000
  let metadataHealthCache: {
    checkedAt: number
    /** Cheap change detector: direct on-disk corruption (fault injection, operator
     *  repair) must be visible on the NEXT status call, not after the TTL; four stats
     *  replace the full scan. */
    fingerprint: string
    facts: {
      status: MetadataHealthStatus
      components: string[]
      needsRecovery: boolean
    } | null
  } | null = null

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

  /** Disk-derived metadata facts behind a short TTL: status + category-only
   *  components + whether recovery is on disk; null = unavailable (win32 or
   *  unreadable). Invalidated by every writer transaction. */
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
      // The component set and needsRecovery are the shared projection; the marker
      // rescue stays here because it inspects THIS host's base directory.
      const projected = projectMetadataHealthFacts(health, {
        markerRescueAvailable: health.status === 'recovery-marker-corrupt'
          && inspectCorruptMetadataRecoveryMarker(baseDir).recoverable,
      })
      facts = { status: health.status, components: projected.components, needsRecovery: projected.needsRecovery }
    } catch {
      facts = null
    }
    metadataHealthCache = { checkedAt: now, fingerprint, facts }
    return facts
  }

  /** Desktop-shaped metadata health projection for /status: category-only components
   *  + explicit recover eligibility; the gate mixes disk facts with LIVE writer state. */
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
    // The recover route may act only on a FATAL metadata block (or a recovery
    // attempt that kept its durable record); restore/swap phases resume via retry.
    const recoverableBlock = startupBlockReason === null
      || RECOVERABLE_METADATA_BLOCKS.has(startupBlockReason)
    // No gate may advertise recovery while an activation/install/restart owns the writer.
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
