/**
 * Preconditions shared by every runtime mutation (design 18 §9.3): the win32
 * read-only refusal and the env-pinned override refusal are one fact each, so
 * their code/message lives here once instead of at every mutation site. The
 * env-pinned guard takes the operation from the caller because the refusal
 * record carries it; the win32 guard is operation-independent.
 */
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
