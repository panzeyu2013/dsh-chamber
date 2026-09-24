/**
 * Preconditions shared by every runtime mutation: the win32 read-only refusal
 * and the env-pinned override refusal live here once, not at every mutation
 * site. A corrupt or unreadable override/pointer/known-good read proves neither
 * absence nor a legal record, so decision sites refuse through the shared
 * constructor below instead of projecting "no override" / builtin / an empty set.
 */
import {
  readOverrideState,
  type CurrentPointerState,
  type KnownGoodVersionsState,
  type OverrideRecord,
  type OverrideState,
} from '@dsh-chamber/dsh-runtime'
import { envPinnedRefusal, refusalError, type EnvPinnedOperation } from '../runtime-refusals.ts'

export function refuseRuntimeMutationOnWindows(platform: string): void {
  if (platform === 'win32') {
    throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
  }
}

export function refuseOnEnvPinned(envPath: string | null, operation: EnvPinnedOperation): void {
  if (envPath !== null) throw refusalError(envPinnedRefusal(operation))
}

export function overrideMetadataRefusal(state: Extract<OverrideState, { kind: 'corrupt' } | { kind: 'unknown' }>): Error {
  return refusalError({
    code: 'runtime_recovery_required',
    error: state.kind === 'corrupt'
      ? 'gateway runtime override metadata is corrupt'
      : 'gateway runtime override metadata is unreadable: ' + state.detail,
  })
}

export function pointerMetadataRefusal(state: Extract<CurrentPointerState, { kind: 'corrupt' } | { kind: 'unknown' }>): Error {
  return refusalError({
    code: 'runtime_recovery_required',
    error: state.kind === 'corrupt'
      ? 'gateway runtime current pointer is corrupt'
      : 'gateway runtime current pointer is unreadable: ' + state.detail,
  })
}

export function knownGoodMetadataRefusal(state: Extract<KnownGoodVersionsState, { kind: 'corrupt' } | { kind: 'unknown' }>): Error {
  return refusalError({
    code: 'runtime_recovery_required',
    error: state.kind === 'corrupt'
      ? 'gateway runtime known-good metadata is corrupt'
      : 'gateway runtime known-good metadata is unreadable: ' + state.detail,
  })
}

/** Decision-time override read: corrupt/unknown never aliases "no override". */
export function readOverrideForDecision(baseDir: string): OverrideRecord | null {
  const state = readOverrideState(baseDir)
  if (state.kind === 'valid') return state.record
  if (state.kind === 'missing') return null
  throw overrideMetadataRefusal(state)
}
