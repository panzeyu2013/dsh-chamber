import type { DesktopSshSurface, SshInstanceInput, SshInstanceSpec } from '../global.d.ts'

type SaveBridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_password'>

export type HostSaveResult =
  | { ok: true; instances: SshInstanceSpec[] }
  | { ok: false; instances: SshInstanceSpec[]; error: string; metadataCommitted: boolean }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function persistedInstance(instance: SshInstanceInput): SshInstanceInput {
  return {
    id: instance.id,
    label: instance.label,
    kind: instance.kind,
    host: instance.host,
    user: instance.user,
    sshPort: instance.sshPort,
    remotePort: instance.remotePort,
    serviceName: instance.serviceName,
    remoteDshHome: instance.remoteDshHome,
  }
}

function sameInstances(left: SshInstanceSpec[], right: SshInstanceSpec[]): boolean {
  return JSON.stringify(left.map(persistedInstance)) === JSON.stringify(right.map(persistedInstance))
}

/**
 * Whether the submitted change actually LANDED in the registry. instances_set
 * carries NO error channel (main.ts desktop_ssh_instances_set): a refused
 * save — non-array input, registry/state-dir write failure, instance-count
 * cap — returns the CURRENT registry unchanged instead of throwing, so a
 * save must verify its effect instead of trusting the resolved call (same
 * loud-failure invariant as the deletion path in ConnectionsSection).
 * For both NEW and EDIT, the stored row must reflect every submitted field
 * (label/host/remotePort/sshPort/user/serviceName/remoteDshHome;
 * undefined/null normalized before comparing). Presence-only acknowledgement
 * is unsafe for a same-id concurrent-create race.
 */
function landed(saved: SshInstanceSpec[], next: SshInstanceInput[], instanceId: string): boolean {
  const submitted = next.find(entry => entry.id === instanceId)
  const stored = saved.find(spec => spec.id === instanceId)
  if (submitted === undefined || stored === undefined) return false
  // Presence alone is insufficient for a NEW host: another caller may have
  // won a same-id race with different metadata. Writing this form's password
  // to that row would bind a secret to the wrong destination. New and edit
  // therefore use the same full-field acknowledgement.
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
 * operation. Metadata ALWAYS lands first and is verified before the secret
 * write. This order is required for both shapes:
 * - NEW host: the main process refuses passwords for unregistered ids;
 * - EXISTING host: writing the password first would leave an invisible
 *   partial commit when the later registry write is refused.
 * A subsequent password failure is compensated by restoring the previous
 * registry. `metadataCommitted` reports whether that rollback itself failed
 * (for a new host the form then turns the committed row into an edit target,
 * so a retry cannot be rejected by the duplicate check).
 */
export async function saveHostWithPassword(
  bridge: SaveBridge,
  before: SshInstanceSpec[],
  next: SshInstanceInput[],
  instanceId: string,
  password: string,
): Promise<HostSaveResult> {
  const proposal = next.map(persistedInstance)
  let saved: SshInstanceSpec[]
  try {
    saved = await bridge.instances_set(proposal)
  } catch (error) {
    return { ok: false, instances: before, error: message(error), metadataCommitted: false }
  }
  // A refused save returns the current registry (no error channel) — verify
  // the change landed BEFORE reporting success or committing the password.
  // The password error text would otherwise be fabricated by a save that
  // never happened (silent no-op); the refusal error keeps the form open.
  if (!landed(saved, proposal, instanceId)) {
    return {
      ok: false,
      instances: saved,
      error: '保存未生效：主进程拒绝了该变更（实例数量上限或状态目录不可写？）',
      metadataCommitted: false,
    }
  }
  if (password === '') return { ok: true, instances: saved }

  // The registry landed (set_password requires a registered id). Commit the
  // password only now; on failure restore the pre-operation registry. The
  // password error text survives even if compensation itself fails.
  try {
    const result = await bridge.set_password(instanceId, password)
    if ('error' in result) return await rollbackMetadata(result.error, saved)
    return { ok: true, instances: saved }
  } catch (error) {
    return await rollbackMetadata(message(error), saved)
  }

  /** Password-failure metadata compensation (design 05 §8). */
  async function rollbackMetadata(passwordError: string, saved: SshInstanceSpec[]): Promise<HostSaveResult> {
    try {
      // sourceFingerprint is an in-memory lifecycle proof signed by main,
      // never registry input. Roll back only persisted metadata.
      const rolledBack = await bridge.instances_set(before.map(persistedInstance))
      if (sameInstances(rolledBack, before)) {
        return { ok: false, instances: rolledBack, error: passwordError, metadataCommitted: false }
      }
      // instances_set has no error branch: the main process may refuse the
      // rollback and return the still-current registry. Verify compensation
      // exactly as strictly as the forward save.
      let authoritative = rolledBack
      try {
        authoritative = await bridge.instances_get()
      } catch {
        // The returned registry is still the strongest available fact.
      }
      return {
        ok: false,
        instances: authoritative,
        error: `${passwordError}; host metadata rollback was refused`,
        metadataCommitted: !sameInstances(authoritative, before),
      }
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
