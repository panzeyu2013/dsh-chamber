/**
 * Gateway runtime workspace resolution facts (design 18 §3.5/§9.3): the
 * read-only resolution chain — env → matching active override/current →
 * builtin anchor — plus the anchor version requirement and the activation
 * facts consumed by the startup transaction. Nothing here owns mutable state;
 * every function re-reads the durable core metadata at call time.
 */
import { join } from 'node:path'
import {
  listKnownGoodVersionsState,
  listValidVersionTrees,
  readAnchorVersion,
  readCurrentPointerState,
  readOverrideState,
  shouldInvalidate,
  validateVersionTree,
} from '@dsh-chamber/dsh-runtime'
import {
  overrideMetadataRefusal,
  pointerMetadataRefusal,
  knownGoodMetadataRefusal,
} from './guards.ts'

export interface ResolvedWorkspace {
  path: string
  /** Exact version read from the effective workspace/tree, or null when an
   * external env workspace does not expose a readable exact manifest. */
  version: string | null
  source: 'env' | 'override' | 'builtin'
}

export interface RuntimeWorkspaceFactsDeps {
  anchor: string
  stateRoot: string
  baseDir: string
  platform: NodeJS.Platform
  shellVersion: string
  builtinVersion: string | null
  getEnvPath(): string | null
}

export interface RuntimeWorkspaceFacts {
  requireBuiltinVersion(): string
  resolveWorkspace(): ResolvedWorkspace
  activationFacts(): { sourceVersion: string | null; sourceIsBuiltin: boolean; sourceWasKnownGood: boolean; knownGoodVersion: string | null }
  currentPointerVersion(): string | null
}

export function createRuntimeWorkspaceFacts(deps: RuntimeWorkspaceFactsDeps): RuntimeWorkspaceFacts {
  const { anchor, stateRoot, baseDir, platform, shellVersion, builtinVersion } = deps

  function requireBuiltinVersion(): string {
    const actual = readAnchorVersion(anchor)
    if (builtinVersion === null || actual !== builtinVersion) {
      throw new Error('gateway builtin dsh anchor does not expose a stable exact @deepseek-ai/dsh version')
    }
    return builtinVersion
  }

  /** env → matching active override/current → builtin anchor (design 18
   * §3.5/§9.3). Corrupt or contradictory selection metadata is never treated
   * as an absent override; callers fail loud instead of spawning builtin over
   * user-migrated DSH_HOME without a transaction. */
  function resolveWorkspace(): ResolvedWorkspace {
    const envPath = deps.getEnvPath()
    if (envPath !== null) return { path: envPath, version: readAnchorVersion(envPath), source: 'env' }
    if (platform === 'win32') {
      return { path: anchor, version: builtinVersion, source: 'builtin' }
    }
    const pointerState = readCurrentPointerState(baseDir)
    const overrideState = readOverrideState(baseDir)
    // 2026-12 Phase B: 'unknown' (EACCES/EIO) proves neither absence nor
    // corruption, so it blocks on exactly the corrupt path instead of falling
    // through to builtin / "no override".
    if (pointerState.kind === 'corrupt' || pointerState.kind === 'unknown') throw pointerMetadataRefusal(pointerState)
    if (overrideState.kind === 'corrupt' || overrideState.kind === 'unknown') throw overrideMetadataRefusal(overrideState)
    const pointer = pointerState.kind === 'valid' ? pointerState.version : null
    const override = overrideState.kind === 'valid' ? overrideState.record : null
    const overrideActive = override !== null && !shouldInvalidate(override, shellVersion)
    if (overrideActive && pointer !== null) {
      if (!listValidVersionTrees(baseDir).includes(pointer)) {
        throw new Error(`gateway runtime current tree ${pointer} is invalid`)
      }
      return { path: join(stateRoot, pointer), version: pointer, source: 'override' }
    }
    if (pointer !== null) {
      throw new Error('gateway runtime current pointer has no matching active override')
    }
    if (overrideActive) {
      // Gateway select and apply are separate actions. `selectedOnly` is the
      // crash-durable proof that a valid cached/installed choice is merely
      // staged while builtin remains active. Absence/false stays fail-closed:
      // an applied user override whose current pointer disappeared must never
      // silently boot builtin over potentially migrated DSH_HOME.
      const stagedSelection = override.selectedOnly === true
        && override.pending === null
        && override.chosenVersion !== null
        && override.resolvedVersion !== null
        && override.swapAttempted === false
        && override.lastOutcome == null
      const builtinIsAuthoritative = stagedSelection
        || override.pending !== null
        || override.chosenVersion === null
        || override.resolvedVersion === null
        || override.lastOutcome === 'rolled-back'
        || override.lastOutcome === 'failed'
      if (!builtinIsAuthoritative) {
        throw new Error('gateway user runtime override is missing its authoritative current pointer')
      }
    }
    return { path: anchor, version: builtinVersion, source: 'builtin' }
  }

  function activationFacts(): { sourceVersion: string | null; sourceIsBuiltin: boolean; sourceWasKnownGood: boolean; knownGoodVersion: string | null } {
    // ACTIVATION-FACTS DIVERGENCE: desktop twin
    // (main.ts readActivationFacts) excludes journalIntent.targetVersion ??
    // override.pending and validates the tree; this side excludes the POINTER
    // and the win32 shortcut below returns knownGoodVersion null. Unification
    // needs one core helper + one exclusion rule (deferred: new dsh-runtime
    // public export, dist locked).
    if (platform === 'win32') {
      return {
        sourceVersion: builtinVersion,
        sourceIsBuiltin: true,
        sourceWasKnownGood: true,
        knownGoodVersion: null,
      }
    }
    const pointerState = readCurrentPointerState(baseDir)
    if (pointerState.kind === 'corrupt' || pointerState.kind === 'unknown') throw pointerMetadataRefusal(pointerState)
    const overrideState = readOverrideState(baseDir)
    if (overrideState.kind === 'corrupt' || overrideState.kind === 'unknown') throw overrideMetadataRefusal(overrideState)
    // The known-good ledger decides rollback trust; corrupt/unreadable
    // material must refuse the snapshot facts, never report "not known good".
    const knownGoodState = listKnownGoodVersionsState(baseDir)
    if (knownGoodState.kind !== 'ok') throw knownGoodMetadataRefusal(knownGoodState)
    const pointer = pointerState.kind === 'valid' ? pointerState.version : null
    const knownGood = knownGoodState.versions
    const record = overrideState.kind === 'valid' ? overrideState.record : null
    // D5a: the retired latestKnownGood compatibility projection inlined against
    // the authoritative ledger already read above — same ledger, order,
    // exclusion and per-version validateVersionTree gate.
    const knownGoodVersion = knownGood.find((version) => version !== pointer
      && validateVersionTree(baseDir, version, `${process.platform}-${process.arch}`).ok) ?? null
    return {
      // The builtin anchor contributes its REAL semver as the snapshot source:
      // apply-phase rejects a null sourceVersion as snapshot-failed, so
      // the very first install from the anchor would otherwise never switch.
      sourceVersion: pointer === null ? builtinVersion : pointer,
      sourceIsBuiltin: pointer === null,
      sourceWasKnownGood: pointer === null || knownGood.includes(pointer)
        || (record?.lastOutcome === 'applied' && record.resolvedVersion === pointer),
      knownGoodVersion,
    }
  }

  function currentPointerVersion(): string | null {
    const state = readCurrentPointerState(baseDir)
    if (state.kind === 'valid') return state.version
    if (state.kind === 'missing') return null
    // Corrupt/unreadable material is not "no pointer": callers use null as
    // "builtin is active", which would bypass the downgrade guard and arm a
    // switch over unverified authority. Fail closed instead.
    throw pointerMetadataRefusal(state)
  }

  return { requireBuiltinVersion, resolveWorkspace, activationFacts, currentPointerVersion }
}
