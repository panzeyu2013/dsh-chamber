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
 * operation. ORDER DEPENDS ON REGISTRY EXISTENCE (2026 final review fix):
 * - EXISTING host: password FIRST, registry SECOND — a password failure
 *   leaves the registry untouched and the form can retry directly.
 * - NEW host: the main process REFUSES `set_password` for unregistered ids
 *   (desktop_ssh_set_password → 'invalid or unknown instance id'), so the
 *   registry MUST land first; a subsequent password failure is compensated
 *   by restoring the previous registry (design 05 §8 rollback), and
 *   `metadataCommitted` reports whether that rollback itself failed (the
 *   form then turns the committed row into an edit target so a retry can
 *   never be rejected by the duplicate check).
 */
export async function saveHostWithPassword(
  bridge: SaveBridge,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  password: string,
): Promise<HostSaveResult> {
  const exists = before.some(spec => spec.id === instanceId)
  if (exists && password !== '') {
    // Edit: password first — a refusal leaves the registry untouched.
    try {
      const result = await bridge.set_password(instanceId, password)
      if ('error' in result) return { ok: false, instances: before, error: result.error, metadataCommitted: false }
    } catch (error) {
      return { ok: false, instances: before, error: message(error), metadataCommitted: false }
    }
  }
  let saved: SshInstanceSpec[]
  try {
    saved = await bridge.instances_set(next)
  } catch (error) {
    return { ok: false, instances: before, error: message(error), metadataCommitted: false }
  }
  if (password === '') return { ok: true, instances: saved }
  if (exists) return { ok: true, instances: saved }

  // New host: the registry landed (set_password requires a registered id);
  // commit the password, rolling the registry back on failure so a retry
  // never hits the duplicate check with a half-committed row. The password
  // error text survives even when the rollback itself fails (2026 round-3
  // review — the rollback failure must never masquerade as the password error).
  try {
    const result = await bridge.set_password(instanceId, password)
    if ('error' in result) return await rollbackNewHost(result.error, saved)
    return { ok: true, instances: saved }
  } catch (error) {
    return await rollbackNewHost(message(error), saved)
  }

  /** New-host password failure compensation (design 05 §8). */
  async function rollbackNewHost(passwordError: string, saved: SshInstanceSpec[]): Promise<HostSaveResult> {
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
}
