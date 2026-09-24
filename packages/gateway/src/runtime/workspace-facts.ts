/**
 * Gateway runtime workspace resolution facts: the read-only chain env → matching
 * active override/current → builtin anchor, plus the anchor version requirement
 * and the activation facts. Nothing here owns mutable state.
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
  /** Exact version from the effective tree; null when an external env workspace exposes none. */
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

  /** env → matching active override/current → builtin anchor; corrupt metadata is never treated as absent (callers fail loud). */
  function resolveWorkspace(): ResolvedWorkspace {
    const envPath = deps.getEnvPath()
    if (envPath !== null) return { path: envPath, version: readAnchorVersion(envPath), source: 'env' }
    if (platform === 'win32') {
      return { path: anchor, version: builtinVersion, source: 'builtin' }
    }
    const pointerState = readCurrentPointerState(baseDir)
    const overrideState = readOverrideState(baseDir)
    // 'unknown' (EACCES/EIO) proves neither absence nor corruption: block it.
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
      // Select and apply are separate actions: `selectedOnly` is the
      // crash-durable proof of a merely staged choice; absence/false fails closed.
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
    // ACTIVATION-FACTS DIVERGENCE: the desktop twin excludes
    // journalIntent.targetVersion ?? override.pending and validates the tree;
    // this side excludes the POINTER and win32 returns null knownGoodVersion.
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
    // D5a: the retired latestKnownGood projection, inlined against the ledger above.
    const knownGoodVersion = knownGood.find((version) => version !== pointer
      && validateVersionTree(baseDir, version, `${process.platform}-${process.arch}`).ok) ?? null
    return {
      // The builtin anchor contributes its REAL semver: apply-phase rejects a
      // null sourceVersion, so the first install from it would never switch.
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
    // Corrupt/unreadable material is not "no pointer": callers read null as
    // "builtin is active", bypassing the downgrade guard. Fail closed.
    throw pointerMetadataRefusal(state)
  }

  return { requireBuiltinVersion, resolveWorkspace, activationFacts, currentPointerVersion }
}
