import type { DesktopSshSurface, SshInstanceInput, SshInstanceSpec } from '../global.d.ts'

type SaveBridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_password'>

export type HostSaveResult =
  | { ok: true; instances: SshInstanceSpec[] }
  | { ok: false; instances: SshInstanceSpec[]; error: string; metadataCommitted: boolean }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameInstances(left: SshInstanceSpec[], right: SshInstanceSpec[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Save non-secret host metadata and its optional secret as one user-visible
 * operation. The stores are intentionally separate, so a password failure is
 * compensated by restoring the previous registry. If compensation itself
 * rejects, re-read the authoritative registry before reporting whether the
 * metadata actually committed; this avoids duplicate retries for a new host.
 */
export async function saveHostWithPassword(
  bridge: SaveBridge,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  password: string,
): Promise<HostSaveResult> {
  const saved = await bridge.instances_set(next)
  if (password === '') return { ok: true, instances: saved }

  let passwordError: string | null = null
  try {
    const result = await bridge.set_password(instanceId, password)
    if ('error' in result) passwordError = result.error
  } catch (error) {
    passwordError = message(error)
  }
  if (passwordError === null) return { ok: true, instances: saved }

  try {
    const rolledBack = await bridge.instances_set(before)
    return { ok: false, instances: rolledBack, error: passwordError, metadataCommitted: false }
  } catch (rollbackError) {
    let authoritative = saved
    try {
      authoritative = await bridge.instances_get()
    } catch {
      // Keep the known post-save snapshot if even the authoritative read is
      // unavailable; the error remains loud and the form stays open.
    }
    return {
      ok: false,
      instances: authoritative,
      error: `${passwordError}; host metadata rollback failed: ${message(rollbackError)}`,
      metadataCommitted: !sameInstances(authoritative, before),
    }
  }
}
