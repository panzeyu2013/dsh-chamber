/**
 * Pure per-server source derivation (design 18 §3.6 修订): no JSX so the
 * node test harness can import it directly. local → local; gateway-<id> →
 * gateway; ssh-<id> → ssh; anything else falls back to local.
 */
export type DshRuntimeSource = 'local' | 'gateway' | 'ssh'

export function deriveRuntimeSource(instanceId: string | undefined): DshRuntimeSource {
  if (instanceId === 'local') return 'local'
  if (instanceId !== undefined && instanceId.startsWith('gateway-')) return 'gateway'
  if (instanceId !== undefined && instanceId.startsWith('ssh-')) return 'ssh'
  return 'local'
}
