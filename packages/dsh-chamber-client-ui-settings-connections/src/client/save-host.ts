import type { DesktopSshSurface, SshInstanceInput, SshInstanceSpec } from '../global.d.ts'

type SaveBridge = Pick<DesktopSshSurface, 'instances_set'>

export type HostSaveResult =
  | { ok: true; instances: SshInstanceSpec[] }
  | { ok: false; instances: SshInstanceSpec[]; error: string }

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

/**
 * Submit non-secret host metadata and its optional replacement password in
 * ONE IPC. Main validates the complete normalized registry/password owner,
 * durably prepares the registry, commits the write-through secret, and only
 * then publishes runtime state. A password-store failure rejects this call
 * after restoring the previous registry, so renderer-side compensation is
 * neither necessary nor safe.
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
    saved = await bridge.instances_set(
      proposal,
      password === '' ? undefined : { id: instanceId, password },
    )
  } catch (error) {
    return { ok: false, instances: before, error: message(error) }
  }
  return { ok: true, instances: saved }
}
