/**
 * Pure per-server source derivation (design 18 §3.6, design 17 §3): no JSX so
 * the node test harness can import it directly. Maps a canonical chamber
 * instance id to its dsh-runtime source kind:
 *
 *   - 'local'        → 'local'    full local management surface
 *   - 'gateway-<id>' → 'gateway'  proxied /chamber/runtime (design 17 §3)
 *   - 'ssh-<id>'     → 'ssh'      legacy v1 ssh-tunnel id (kind='ssh' migration
 *                                 keeps the ssh- prefix, design 17 §2.2)
 *   - 'dsh-<id>'     → 'ssh'      v2 dsh target (kind='dsh') over an ssh
 *                                 tunnel OR http direct. Neither shape exposes
 *                                 a /chamber/* management surface (design
 *                                 17 §3), so the section stays version
 *                                 read-only with the restart-service action.
 *                                 This revision carries no per-instance
 *                                 transport projection, so an http-direct dsh
 *                                 source cannot be told apart and is treated
 *                                 read-only as well — the safe side of the
 *                                 two: never a full management surface
 *                                 without a management channel.
 *
 * Unknown prefixes (and undefined) FAIL LOUD: the function returns null and
 * the caller must not mount any dsh-runtime surface. It never falls back to
 * 'local' — that would render the full local runtime management surface
 * against an unidentified target.
 */
export type DshRuntimeSource = 'local' | 'gateway' | 'ssh'

export function deriveRuntimeSource(instanceId: string | undefined): DshRuntimeSource | null {
  if (instanceId === undefined) return null
  if (instanceId === 'local') return 'local'
  if (instanceId.startsWith('gateway-')) return 'gateway'
  if (instanceId.startsWith('ssh-')) return 'ssh'
  if (instanceId.startsWith('dsh-')) return 'ssh'
  return null
}
