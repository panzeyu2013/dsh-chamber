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
 * Whether the submitted change actually LANDED in the registry. instances_set
 * carries NO error channel (main.ts desktop_ssh_instances_set): a refused
 * save — non-array input, registry/state-dir write failure, instance-count
 * cap — returns the CURRENT registry unchanged instead of throwing, so a
 * save must verify its effect instead of trusting the resolved call (same
 * loud-failure invariant as the deletion path in ConnectionsSection).
 * - NEW host: the registry must contain an entry with id === instanceId.
 * - EDIT: the stored entry must reflect the submitted fields
 *   (label/host/remotePort/sshPort/user/serviceName/remoteDshHome;
 *   undefined/null normalized before comparing).
 */
function landed(saved: SshInstanceSpec[], next: SshInstanceInput[], instanceId: string, exists: boolean): boolean {
  const submitted = next.find(entry => entry.id === instanceId)
  const stored = saved.find(spec => spec.id === instanceId)
  if (submitted === undefined || stored === undefined) return false
  if (!exists) return true // 新主机：注册表出现该 id 即落地
  return (
    stored.label === submitted.label &&
    stored.host === submitted.host &&
    stored.remotePort === submitted.remotePort &&
    stored.user === (submitted.user ?? null) &&
    stored.sshPort === (submitted.sshPort ?? null) &&
    stored.serviceName === (submitted.serviceName ?? null) &&
    stored.remoteDshHome === (submitted.remoteDshHome ?? null)
  )
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
  // A refused save returns the current registry (no error channel) — verify
  // the change landed BEFORE reporting success or committing the password.
  // The password error text would otherwise be fabricated by a save that
  // never happened (silent no-op); the refusal error keeps the form open.
  if (!landed(saved, next, instanceId, exists)) {
    return {
      ok: false,
      instances: saved,
      error: '保存未生效：主进程拒绝了该变更（实例数量上限或状态目录不可写？）',
      metadataCommitted: false,
    }
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
