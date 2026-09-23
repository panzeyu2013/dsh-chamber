/**
 * Preconditions shared by every runtime mutation (design 18 §9.3): the win32
 * read-only refusal and the env-pinned override refusal are one fact each, so
 * their code/message lives here once instead of at every mutation site. The
 * env-pinned guard takes the operation from the caller because the refusal
 * record carries it; the win32 guard is operation-independent.
 *
 * 2026-12 Phase B fail-closed authority consumption is single-sourced here too:
 * a corrupt or unreadable override/pointer/known-good read proves
 * neither absence nor a legal record, so every decision site refuses through
 * one shared constructor instead of projecting it as "no override" / builtin /
 * an empty protection set.
 */
import {
  readOverrideState,
  type CurrentPointerState,
  type KnownGoodVersionsState,
  type OverrideRecord,
  type OverrideState,
} from '@dsh-chamber/dsh-runtime'
import { envPinnedRefusal, refusalError, type EnvPinnedOperation } from '../runtime-refusals.ts'

/** Win32 exposes no runtime mutations: refuse with the recorded code/message. */
export function refuseRuntimeMutationOnWindows(platform: string): void {
  if (platform === 'win32') {
    throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
  }
}

/** An env override pins the operation it names: the mutation refuses. */
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
